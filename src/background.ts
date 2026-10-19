import { emptyQueue, transition } from './core/queue.ts';
import type { Request, QueueState } from './core/types.ts';
import { parseSettings, SETTINGS_CHANNEL, SETTINGS_KEY } from './core/settings.ts';
import type { SettingsRequest } from './core/settings.ts';
import { registerNamingBackground } from './naming/background.ts';

registerNamingBackground();

let writer: Promise<unknown> = Promise.resolve();
const storageKey = (key: string) => `cwq:v1:${key}`;
const serialize = <T>(work: () => Promise<T>): Promise<T> => {
  const next = writer.then(work, work);
  writer = next.catch(() => {});
  return next;
};
chrome.runtime.onMessage.addListener((message: Request | SettingsRequest, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.channel === SETTINGS_CHANNEL) {
    if (message.action?.type !== 'get' && message.action?.type !== 'setEnabled') return;
    void serialize(async () => {
      if (message.action.type === 'setEnabled') {
        if (typeof message.action.enabled !== 'boolean') throw new Error('开关值无效');
        const settings = { enabled: message.action.enabled };
        await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
        return { ok: true, settings };
      }
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      return { ok: true, settings: parseSettings(stored[SETTINGS_KEY]) };
    }).then(respond, error => respond({ ok: false, error: `设置保存失败：${String(error)}` }));
    return true;
  }
  if (message?.channel !== 'chatgpt-web-queue-v1') return;
  if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined ||
      !sender.url?.startsWith('https://chatgpt.com/') ||
      !/^conversation:[a-zA-Z0-9_-]+$/.test(message.key) || !message.documentId || !message.action) return;
  const tabId = sender.tab.id;
  void serialize(async () => {
    const name = storageKey(message.key);
    const stored = await chrome.storage.local.get([name, SETTINGS_KEY]);
    const state: QueueState = (stored[name] as QueueState | undefined) ?? emptyQueue(message.key);
    if (!parseSettings(stored[SETTINGS_KEY]).enabled &&
      ['enqueue', 'claim', 'submitted'].includes(message.action.type))
      return { ok: false, state, error: 'Queue 已关闭' };
    const reply = transition(state, message.action, { tabId, documentId: message.documentId, now: Date.now() });
    if (reply.ok && reply.state.revision !== state.revision) await chrome.storage.local.set({ [name]: reply.state });
    return reply;
  }).then(respond, error => respond({ ok: false, error: `队列保存失败：${String(error)}` }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  void serialize(async () => {
    const all = await chrome.storage.local.get(null);
    for (const [name, state] of Object.entries(all)) {
      if (!name.startsWith('cwq:v1:') || (state as QueueState).owner?.tabId !== tabId) continue;
      const current = state as QueueState;
      const reply = transition(current, { type: 'leave' }, { ...current.owner!, now: Date.now() });
      await chrome.storage.local.set({ [name]: reply.state });
    }
  });
});
