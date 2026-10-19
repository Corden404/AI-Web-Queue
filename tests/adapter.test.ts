import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { editorText, inspectPage, messagesFrom, replaceEditorText, visible } from '../src/page/adapter.ts';

const fixture = (turn = 'complete', extra = '', latest = 'assistant') => new JSDOM(`<!doctype html><html><body>
 <main><div data-talvt-turn-state="${turn}">
 <div data-chatgpt-search-unit-key="turn:0:user" data-chatgpt-search-message-ids="user-1"><div data-user-message-bubble>hello</div></div>
 ${latest === 'assistant' ? '<div data-chatgpt-search-unit-key="turn:2:assistant" data-chatgpt-search-message-ids="assistant-1"><h4 data-conversation-role="assistant">ChatGPT said:</h4><div>response</div></div>' : ''}
 </div></main>
 <form data-chatgpt-composer><div contenteditable="true" role="textbox" class="ProseMirror"></div>${extra}</form>
 <div role="status" aria-live="polite">Response complete</div></body></html>`).window.document;

test('current ChatGPT DOM works without #prompt-textarea or data-message-author-role', () => {
  const page = inspectPage(fixture());
  assert.ok(page.editor); assert.equal(page.editor.id, '');
  assert.equal(page.complete, true); assert.equal(page.send, null);
  assert.deepEqual(page.messages.map(m => [m.id, m.role]), [['user-1', 'user'], ['assistant-1', 'assistant']]);
  assert.equal(page.messages[0]!.text, 'hello');
});
test('text serialization retains paragraphs and code lines without Chromium extra breaks', () => {
  const document = fixture(); const editor = document.querySelector<HTMLElement>('[contenteditable]')!;
  for (const html of ['段落一<div><br></div><div>段落二</div><div>```js</div><div>x</div><div>```</div>',
    '<p>段落一</p><p><br></p><p>段落二</p><p>```js</p><p>x</p><p>```</p>']) {
    editor.innerHTML = html;
    assert.equal(editorText(editor), '段落一\n\n段落二\n```js\nx\n```');
  }
  editor.innerHTML = '<p>one<br><br class="ProseMirror-trailingBreak"></p>';
  assert.equal(editorText(editor), 'one\n');
});
test('a stale Response complete region cannot override an active turn or tool pause', () => {
  for (const state of ['inProgress', 'running', 'tool_call', 'pending']) {
    const page = inspectPage(fixture(state)); assert.equal(page.complete, false); assert.equal(page.busy, true);
  }
});
test('no next dispatch during the gap between user submission and assistant creation', () => {
  const page = inspectPage(fixture('complete', '', 'user'));
  assert.equal(page.complete, false);
  assert.equal(page.replyStatus, 'incomplete');
  const empty = fixture(); empty.querySelector('main')!.replaceChildren();
  assert.equal(inspectPage(empty).complete, false);
  assert.equal(inspectPage(empty).replyStatus, 'idle');
});
test('incomplete and stopped replies remain incomplete without a Stop button', () => {
  for (const state of ['incomplete', 'stopped', 'cancelled', 'canceled']) {
    const page = inspectPage(fixture(state));
    assert.equal(page.busy, false); assert.equal(page.complete, false);
    assert.equal(page.replyStatus, 'incomplete');
  }
});
test('an assistant reply without completion evidence is incomplete, not idle', () => {
  const document = fixture('');
  document.querySelector('[role="status"]')!.textContent = '';
  assert.equal(inspectPage(document).replyStatus, 'incomplete');
});
test('stop button wins over terminal markers; voice button is never treated as Send', () => {
  const page = inspectPage(fixture('complete', '<button aria-label="Stop streaming"></button><button aria-label="Start Voice"></button>'));
  assert.equal(page.busy, true); assert.equal(page.complete, false); assert.equal(page.send, null);
});
test('localized send button, disabled controls, hidden attachments, and error states', () => {
  const document = fixture('complete', '<button aria-label="发送消息" disabled></button><div data-composer-attachments hidden><img></div>');
  assert.equal(inspectPage(document).send, null); assert.equal(inspectPage(document).attachments, false);
  document.querySelector('button')!.removeAttribute('disabled');
  assert.ok(inspectPage(document).send);
  const alert = document.createElement('div'); alert.setAttribute('role', 'alert'); alert.textContent = 'You have reached the usage limit'; document.body.append(alert);
  assert.match(inspectPage(document).error, /usage limit/); assert.equal(inspectPage(document).complete, false);
});
test('legacy message attributes use the live completion region', () => {
  const document = new JSDOM('<div data-message-author-role="assistant" data-message-id="a">done</div><form><div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">send</button></form><div role="status" aria-live="polite">Response complete</div>').window.document;
  assert.equal(inspectPage(document).complete, true); assert.equal(messagesFrom(document)[0]!.id, 'a');
});

test('hidden ancestor composers, stop buttons and alerts cannot override the visible chat', () => {
  const document = fixture('complete', '<button aria-label="Send message"></button>');
  const hidden = document.createElement('div'); hidden.style.display = 'none';
  hidden.innerHTML = '<form><textarea id="prompt-textarea">hidden draft</textarea><button data-testid="stop-button">Stop</button></form><div role="alert">Network error</div>';
  document.body.prepend(hidden);
  const page = inspectPage(document);
  assert.equal(page.editor?.className, 'ProseMirror');
  assert.equal(page.stop, null); assert.equal(page.error, ''); assert.equal(page.complete, true);
  assert.equal(visible(hidden.querySelector('textarea')), false);
  assert.throws(() => replaceEditorText(hidden.querySelector('textarea')!, 'overwrite'), /输入框已变化/);
  assert.equal(hidden.querySelector('textarea')!.value, 'hidden draft');
  document.defaultView!.close();
});

test('CSS classes and content-visibility on ancestors are honored', () => {
  const document = new JSDOM('<style>.gone{display:none}</style><div class="gone"><button>Send</button></div>').window.document;
  const parent = document.querySelector('div')!;
  const button = document.querySelector('button')!;
  assert.equal(visible(button), false);
  parent.className = ''; parent.style.contentVisibility = 'hidden';
  assert.equal(visible(button), false);
  parent.style.contentVisibility = ''; parent.style.visibility = 'hidden';
  assert.equal(visible(button), false);
  parent.style.visibility = ''; assert.equal(visible(button), true);
  document.defaultView!.close();
});
