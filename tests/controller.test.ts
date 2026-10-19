import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { build } from 'vite';
import { emptyQueue, transition } from '../src/core/queue.ts';
import { parseSettings, SETTINGS_CHANNEL, SETTINGS_KEY } from '../src/core/settings.ts';
import type { Action, Actor, QueueReply, Request } from '../src/core/types.ts';
import type { SettingsRequest } from '../src/core/settings.ts';

// Exercise the shipping content-script entry, including its DOM events and storage adapter.
const built = await build({ configFile: false, logLevel: 'silent', build: { write: false,
  target: 'chrome120', lib: { entry: 'src/content.ts', formats: ['iife'], name: 'QueueControllerTest' } } });
const output = Array.isArray(built) ? built[0] : built;
if (!('output' in output)) throw new Error('Expected an in-memory content-script bundle');
const code = output.output.find(part => part.type === 'chunk')!.code;
const flush = async () => { for (let n = 0; n < 5; n++) await new Promise<void>(resolve => setImmediate(resolve)); };

async function fixture(turn = 'incomplete', enabled?: boolean, pending = false, url = 'https://chatgpt.com/c/test', blank = false) {
  const dom = new JSDOM(`<!doctype html><html><head><style>*{margin:0;padding:0}</style></head><body>
    <main>${blank ? '' : `<div data-talvt-turn-state="${turn}"><div data-message-author-role="user" data-message-id="u1">question</div>
    <div data-message-author-role="assistant" data-message-id="a1">partial reply</div></div>`}</main>
    <form data-chatgpt-composer><div class="ProseMirror" role="textbox" contenteditable="true"></div><button aria-label="Send message">Send</button></form>
    <div role="status" aria-live="polite">Response complete</div></body></html>`,
    { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const window = dom.window;
  const stored: Record<string, unknown> = enabled === undefined ? {} : { [SETTINGS_KEY]: { enabled } };
  const queueName = 'cwq:v1:conversation:test';
  if (pending) stored[queueName] = { ...emptyQueue('conversation:test'),
    items: [{ id: 'saved', text: 'saved message', createdAt: 1, status: 'queued' }] };
  const subscribers = new Set<(changes: Record<string, unknown>, area: string) => void>();
  const commands: string[] = [];
  let failAction: string | null = null;
  let afterAction: ((message: Request, reply: QueueReply) => Promise<void> | void) | null = null;
  const intervals: (() => void)[] = [];
  const measures: { name: string; start: number; duration: number }[] = [];
  Object.defineProperty(window.performance, 'clearMeasures', { value: (name: string) => {
    for (let i = measures.length - 1; i >= 0; i--) if (measures[i]!.name === name) measures.splice(i, 1);
  } });
  Object.defineProperty(window.performance, 'measure', { value: (name: string, options: { start: number; end: number }) => {
    measures.push({ name, start: options.start, duration: options.end - options.start });
  } });
  function save(name: string, value: unknown) {
    stored[name] = structuredClone(value);
    subscribers.forEach(listener => listener({ [name]: { newValue: structuredClone(value) } }, 'local'));
  }
  Object.defineProperty(window, 'chrome', { value: {
    runtime: { async sendMessage(message: Request | SettingsRequest) {
      if (message.channel === SETTINGS_CHANNEL) {
        if (message.action.type === 'setEnabled') save(SETTINGS_KEY, { enabled: message.action.enabled });
        return { ok: true, settings: parseSettings(stored[SETTINGS_KEY]) };
      }
      commands.push(message.action.type);
      if (message.action.type === failAction) { failAction = null; throw new Error('Extension context invalidated'); }
      const state = (stored[queueName] as ReturnType<typeof emptyQueue> | undefined) ?? emptyQueue(message.key);
      if (!parseSettings(stored[SETTINGS_KEY]).enabled && ['enqueue', 'claim', 'submitted'].includes(message.action.type))
        return { ok: false, state, error: 'Queue 已关闭' };
      const reply = transition(state, message.action, { tabId: 1, documentId: message.documentId, now: Date.now() });
      if (reply.ok && reply.state.revision !== state.revision) save(queueName, reply.state);
      await afterAction?.(message, reply);
      return reply;
    } },
    storage: { onChanged: { addListener(listener: (changes: Record<string, unknown>, area: string) => void) { subscribers.add(listener); }, removeListener() {} } },
  } });
  Object.defineProperty(window, 'setInterval', { value: (callback: () => void) => { intervals.push(callback); return intervals.length; } });
  Object.defineProperty(window.document, 'execCommand', { value: (_command: string, _ui: boolean, text?: string) => {
    window.document.activeElement!.textContent = text ?? '';
    window.document.activeElement!.dispatchEvent(new window.Event('input', { bubbles: true })); return true;
  } });
  window.eval(code);
  await flush(); intervals.forEach(tick => tick()); await flush();
  const editor = window.document.querySelector<HTMLElement>('[contenteditable]')!;
  const root = () => window.document.querySelector('#chatgpt-web-queue')!.shadowRoot!;
  function enter(text: string, options: KeyboardEventInit = {}) {
    editor.textContent = text;
    const event = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options });
    editor.dispatchEvent(event); return event;
  }
  const setEnabled = async (enabled: boolean) => {
    await (window as unknown as { chrome: typeof chrome }).chrome.runtime.sendMessage({ channel: SETTINGS_CHANNEL, action: { type: 'setEnabled', enabled } });
    await flush();
  };
  const host = () => window.document.querySelector<HTMLElement>('#chatgpt-web-queue')!;
  const enqueueExternal = async (text: string) => {
    await (window as unknown as { chrome: typeof chrome }).chrome.runtime.sendMessage({
      channel: 'chatgpt-web-queue-v1', documentId: 'other-tab', key: 'conversation:test', action: { type: 'enqueue', text },
    });
    await flush();
  };
  return { dom, root, host, enter, editor, commands, stored, measures, setEnabled, enqueueExternal,
    afterAction: (hook: typeof afterAction) => { afterAction = hook; },
    external(action: Action, actor: Actor = { tabId: 2, documentId: 'tab-b', now: Date.now() }) {
      const reply = transition(stored[queueName] as ReturnType<typeof emptyQueue>, action, actor);
      if (reply.ok) save(queueName, reply.state);
      return reply;
    },
    failNext: (action: string) => { failAction = action; }, state: () => stored[queueName] as ReturnType<typeof emptyQueue> };
}

function captureNativeSends(f: Awaited<ReturnType<typeof fixture>>) {
  const document = f.dom.window.document;
  const sent: string[] = [];
  document.querySelector('form button')!.addEventListener('click', event => {
    event.preventDefault();
    const text = f.editor.textContent!; sent.push(text);
    const turn = document.createElement('div'); turn.dataset.talvtTurnState = 'in_progress';
    const user = document.createElement('div'); user.dataset.messageAuthorRole = 'user'; user.dataset.messageId = `sent-${sent.length}`; user.textContent = text;
    const reply = document.createElement('div'); reply.dataset.messageAuthorRole = 'assistant'; reply.dataset.messageId = `reply-${sent.length}`; reply.textContent = 'responding';
    turn.append(user, reply); document.querySelector('main')!.append(turn); f.editor.textContent = '';
  });
  return sent;
}

test('content script captures Enter for an incomplete reply without any Stop button', async () => {
  const f = await fixture();
  try {
    assert.equal(f.root().querySelector('[role=switch]'), null);
    assert.equal(f.host().hidden, true);
    const event = f.enter('next message'); await flush();
    assert.equal(event.defaultPrevented, true);
    assert.equal(f.state().items[0]!.text, 'next message'); assert.equal(f.editor.textContent, '');
    assert.equal(f.host().hidden, false);
    assert.equal(f.commands.includes('claim'), false);
  } finally { f.dom.window.close(); }
});
test('toolbar settings hide the tray, retain the queue, and stop intercepting Enter', async () => {
  const f = await fixture('incomplete', true, true);
  try {
    assert.equal(f.host().hidden, false);
    await f.setEnabled(false);
    assert.deepEqual(f.stored[SETTINGS_KEY], { enabled: false });
    const event = f.enter('leave this draft alone'); await flush();
    assert.equal(event.defaultPrevented, false); assert.equal(f.editor.textContent, 'leave this draft alone');
    assert.equal(f.state().items.length, 1); assert.equal(f.commands.includes('claim'), false);
    assert.equal(f.host().hidden, true);
    assert.equal(f.root().querySelector('[role=switch]'), null);
  } finally { f.dom.window.close(); }
});
test('a stored off setting is honored before the first shortcut, and re-enabling restores it', async () => {
  const f = await fixture('incomplete', false);
  try {
    assert.equal(f.enter('native draft').defaultPrevented, false);
    await f.setEnabled(true);
    assert.equal(f.enter('queued after enabling').defaultPrevented, true); await flush();
    assert.equal(f.state().items.length, 1); assert.equal(f.state().items[0]!.text, 'queued after enabling');
  } finally { f.dom.window.close(); }
});

test('more menu edits with a preserved selection, reorders, and reversibly removes messages', async () => {
  const f = await fixture('incomplete', true, true);
  const click = async (label: string) => {
    (f.root().querySelector(`[aria-label="${label}"]`) as HTMLElement).click(); await flush();
  };
  try {
    f.enter('second message'); await flush();
    await click('更多队列操作'); await click('编辑消息');
    const edit = f.root().querySelector<HTMLTextAreaElement>('textarea')!;
    edit.value = 'revised message'; edit.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    edit.focus(); edit.setSelectionRange(2, 5);
    await f.enqueueExternal('third message');
    const refreshed = f.root().querySelector<HTMLTextAreaElement>('textarea')!;
    assert.equal(refreshed.value, 'revised message'); assert.equal(refreshed.selectionStart, 2); assert.equal(refreshed.selectionEnd, 5);
    await click('保存消息');
    assert.equal(f.state().items[0]!.text, 'revised message'); assert.equal(f.state().editing, null);
    await click('更多队列操作'); await click('下移');
    assert.equal(f.state().items[1]!.text, 'revised message');
    await click('移除消息'); assert.equal(f.state().items.length, 2);
    await click('恢复最近移除的消息'); assert.equal(f.state().items.length, 3);
    assert.equal(f.root().querySelector('[role=switch]'), null);
  } finally { f.dom.window.close(); }
});

test('more menu supports keyboard navigation and restores trigger focus on Escape', async () => {
  const f = await fixture('incomplete', true, true);
  try {
    (f.root().querySelector('[aria-label="更多队列操作"]') as HTMLElement).click();
    assert.equal(f.root().activeElement?.getAttribute('aria-label'), '编辑消息');
    f.root().activeElement!.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(f.root().activeElement?.getAttribute('aria-label'), '暂停自动发送');
    f.root().activeElement!.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(f.root().querySelector('[role=menu]'), null);
    assert.equal(f.root().activeElement?.getAttribute('aria-label'), '更多队列操作');
  } finally { f.dom.window.close(); }
});
test('a completed reply without pending work passes Enter through to ChatGPT', async () => {
  const f = await fixture('complete');
  try { assert.equal(f.enter('normal message').defaultPrevented, false); }
  finally { f.dom.window.close(); }
});
test('content-script interception preserves Shift+Enter and IME Enter', async () => {
  const f = await fixture();
  try {
    assert.equal(f.enter('multiline', { shiftKey: true }).defaultPrevented, false);
    assert.equal(f.enter('选词', { isComposing: true }).defaultPrevented, false);
    await flush(); assert.equal(f.state().items.length, 0);
  } finally { f.dom.window.close(); }
});

test('a follow-up entered before the first user turn appears waits for the canonical conversation', async () => {
  const f = await fixture('complete', true, false, 'https://chatgpt.com/', true);
  try {
    assert.equal(f.enter('first request').defaultPrevented, false);
    assert.equal(f.enter('immediate follow-up').defaultPrevented, true);
    await flush();
    assert.match(f.root().textContent!, /正在等待会话创建/);
    const document = f.dom.window.document;
    document.querySelector('main')!.innerHTML = '<div data-talvt-turn-state="in_progress"><div data-message-author-role="user" data-message-id="created">first request</div></div>';
    f.dom.window.history.replaceState(null, '', '/c/local-chatgpt%3Afirst-local-id');
    const replacement = f.editor.cloneNode(true) as HTMLElement;
    f.editor.replaceWith(replacement);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(f.commands.includes('enqueue'), false);
    f.dom.window.history.replaceState(null, '', '/c/test');
    await new Promise(resolve => setTimeout(resolve, 120)); await flush();
    assert.equal(f.state().items[0]!.text, 'immediate follow-up');
    assert.equal(replacement.textContent, '');
    assert.equal(f.commands.includes('claim'), false);
  } finally { f.dom.window.close(); }
});

test('waiting for a new conversation preserves a newer draft in a remounted editor', async () => {
  const f = await fixture('complete', true, false, 'https://chatgpt.com/', true);
  try {
    f.enter('first request'); f.enter('captured follow-up');
    const document = f.dom.window.document;
    document.querySelector('main')!.innerHTML = '<div data-talvt-turn-state="in_progress"><div data-message-author-role="user" data-message-id="created">first request</div></div>';
    const replacement = f.editor.cloneNode(false) as HTMLElement;
    replacement.textContent = 'new unsent draft'; f.editor.replaceWith(replacement);
    replacement.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    f.dom.window.history.replaceState(null, '', '/c/test');
    await new Promise(resolve => setTimeout(resolve, 120)); await flush();
    assert.equal(f.state().items[0]!.text, 'captured follow-up');
    assert.equal(replacement.textContent, 'new unsent draft');
  } finally { f.dom.window.close(); }
});

test('a startup follow-up cannot be queued into a different chat opened before the new ID arrives', async () => {
  const f = await fixture('complete', true, false, 'https://chatgpt.com/', true);
  try {
    f.enter('first request'); f.enter('startup follow-up');
    f.dom.window.document.querySelector('main')!.innerHTML = '<div data-talvt-turn-state="complete"><div data-message-author-role="user" data-message-id="other-user">unrelated request</div><div data-message-author-role="assistant" data-message-id="other-reply">done</div></div>';
    f.dom.window.history.replaceState(null, '', '/c/test');
    await new Promise(resolve => setTimeout(resolve, 120)); await flush();
    assert.equal(f.commands.includes('enqueue'), false);
  } finally { f.dom.window.close(); }
});

test('an immediate follow-up on an existing conversation cannot dispatch before the native user turn appears', async () => {
  const f = await fixture('complete');
  try {
    assert.equal(f.enter('native submission').defaultPrevented, false);
    assert.equal(f.enter('follow-up before DOM commit').defaultPrevented, true);
    await flush();
    assert.equal(f.state().items[0]!.text, 'follow-up before DOM commit');
    await new Promise(resolve => setTimeout(resolve, 1450));
    assert.equal(f.commands.includes('claim'), false);
  } finally { f.dom.window.close(); }
});

test('the tray keeps its composer overlap under the real page universal margin reset', async () => {
  const f = await fixture('incomplete', true, true);
  try { assert.equal(f.dom.window.getComputedStyle(f.host()).marginBottom, '-20px'); }
  finally { f.dom.window.close(); }
});

test('completion mutations dispatch consecutive items without advancing any timer or fallback poll', async () => {
  const f = await fixture('incomplete', true, true);
  try {
    await f.enqueueExternal('second queued message');
    const sent = captureNativeSends(f);
    const document = f.dom.window.document;
    const stop = document.createElement('button'); stop.setAttribute('aria-label', 'Stop'); document.querySelector('form')!.append(stop);
    document.querySelector<HTMLElement>('[data-talvt-turn-state]')!.dataset.talvtTurnState = 'complete';
    await flush(); assert.deepEqual(sent, []);
    stop.remove(); await flush();
    assert.deepEqual(sent, ['saved message']);
    assert.ok(f.state().awaitingReply);
    document.querySelector<HTMLElement>('main > div:last-child')!.dataset.talvtTurnState = 'complete';
    await flush();
    assert.deepEqual(sent, ['saved message', 'second queued message']);
    assert.equal(f.commands.filter(c => c === 'claim').length, 2);
    assert.equal(f.state().items.length, 0);
    assert.equal(f.measures[0]!.name, 'cwq:completion-to-send');
    assert.ok(f.measures[0]!.duration >= 0);
  } finally { f.dom.window.close(); }
});

test('legacy live-region text-node completion dispatches without waiting for the interval', async () => {
  const f = await fixture('incomplete', true, true);
  try {
    const sent = captureNativeSends(f);
    const document = f.dom.window.document;
    document.querySelector('[role=status]')!.textContent = 'Working';
    document.querySelector('[data-talvt-turn-state]')!.removeAttribute('data-talvt-turn-state');
    await flush(); assert.deepEqual(sent, []);
    document.querySelector('[role=status]')!.firstChild!.nodeValue = 'Response complete';
    await flush(); assert.deepEqual(sent, ['saved message']);
  } finally { f.dom.window.close(); }
});

test('a streaming flag becoming false wakes dispatch immediately but true continues to block it', async () => {
  const f = await fixture('incomplete', true, true);
  try {
    const sent = captureNativeSends(f);
    const document = f.dom.window.document;
    const stream = document.createElement('span'); stream.dataset.isStreaming = 'true';
    const turn = document.querySelector<HTMLElement>('[data-talvt-turn-state]')!;
    turn.append(stream); turn.dataset.talvtTurnState = 'complete';
    await flush(); assert.deepEqual(sent, []);
    stream.dataset.isStreaming = 'false';
    await flush(); assert.deepEqual(sent, ['saved message']);
  } finally { f.dom.window.close(); }
});

test('a failed claim does not spin through immediate retries', async () => {
  const f = await fixture('incomplete', true, true);
  try {
    const sent = captureNativeSends(f); f.failNext('claim');
    f.dom.window.document.querySelector<HTMLElement>('[data-talvt-turn-state]')!.dataset.talvtTurnState = 'complete';
    await flush();
    assert.equal(f.commands.filter(c => c === 'claim').length, 1);
    assert.deepEqual(sent, []); assert.equal(f.state().items.length, 1);
  } finally { f.dom.window.close(); }
});

test('a failed reply acknowledgement does not spin through immediate retries', async () => {
  const f = await fixture('incomplete', true, true);
  try {
    await f.enqueueExternal('second queued message');
    const sent = captureNativeSends(f);
    const document = f.dom.window.document;
    document.querySelector<HTMLElement>('[data-talvt-turn-state]')!.dataset.talvtTurnState = 'complete';
    await flush(); assert.equal(sent.length, 1);
    f.failNext('replyComplete');
    document.querySelector<HTMLElement>('main > div:last-child')!.dataset.talvtTurnState = 'complete';
    await flush();
    assert.equal(f.commands.filter(c => c === 'replyComplete').length, 1);
    assert.equal(sent.length, 1); assert.equal(f.state().items.length, 1);
  } finally { f.dom.window.close(); }
});

test('takeover before the native click cancels the old send and transfers the queued item', { timeout: 5000 }, async () => {
  const f = await fixture('incomplete', true, true);
  try {
    const sent = captureNativeSends(f);
    let settled!: () => void;
    const done = new Promise<void>(resolve => { settled = resolve; });
    f.afterAction(async message => {
      if (message.action.type === 'abort') settled();
      if (message.action.type !== 'submitted') return;
      f.external({ type: 'takeover' });
      await flush(); // Deliver the newer storage revision before the delayed reply.
    });
    f.dom.window.document.querySelector<HTMLElement>('[data-talvt-turn-state]')!.dataset.talvtTurnState = 'complete';
    await done; await flush();
    assert.deepEqual(sent, []);
    assert.equal(f.state().owner?.documentId, 'tab-b');
    assert.equal(f.state().handoff, null);
    assert.equal(f.state().items[0]!.status, 'queued');
    assert.equal(f.state().paused, true);
    assert.equal(f.editor.textContent, '');
  } finally { f.dom.window.close(); }
});

test('takeover after the native click preserves the receipt before transferring sending rights', async () => {
  const f = await fixture('incomplete', true, true);
  try {
    const sent = captureNativeSends(f);
    f.dom.window.document.querySelector('form button')!.addEventListener('click', () => {
      f.external({ type: 'takeover' });
    });
    f.dom.window.document.querySelector<HTMLElement>('[data-talvt-turn-state]')!.dataset.talvtTurnState = 'complete';
    await flush();
    assert.deepEqual(sent, ['saved message']);
    assert.equal(f.state().items.length, 0);
    assert.equal(f.state().sent[0]!.userMessageId, 'sent-1');
    assert.equal(f.state().awaitingReply?.userMessageId, 'sent-1');
    assert.equal(f.state().owner?.documentId, 'tab-b');
    assert.equal(f.state().paused, true);
    assert.doesNotMatch(f.root().textContent!, /发送状态已变化/);
  } finally { f.dom.window.close(); }
});
