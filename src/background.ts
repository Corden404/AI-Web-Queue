import { emptyQueue, transition } from './core/queue.ts';
import type { Request, QueueState } from './core/types.ts';
import { parseSettings, SETTINGS_CHANNEL, SETTINGS_KEY } from './core/settings.ts';
import type { SettingsRequest } from './core/settings.ts';
import { HISTORY_CHANNEL } from './core/history.ts';
import type { HistoryRequest } from './core/history.ts';
import { archiveHistory, exportHistory, historyStatus, listArchive, persistQueue, queueStorageKey, restoreArchive } from './history-store.ts';

let writer: Promise<unknown> = Promise.resolve();
const serialize = <T>(work: () => Promise<T>): Promise<T> => {
  const next = writer.then(work, work);
  writer = next.catch(() => {});
  return next;
};
chrome.runtime.onMessage.addListener((message: Request | SettingsRequest | HistoryRequest, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.channel === HISTORY_CHANNEL) {
    if (!sender.url?.startsWith(chrome.runtime.getURL(''))) return;
    void serialize(async () => {
      const action = message.action;
      switch (action.type) {
        case 'status': return historyStatus();
        case 'list': return listArchive(action.before);
        case 'export': return exportHistory();
        case 'archive': await archiveHistory(); return historyStatus();
        case 'restore': await restoreArchive(action.archiveId); return historyStatus();
        default: throw new Error('无效的记录操作');
      }
    }).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: String(error) }));
    return true;
  }
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
    const name = queueStorageKey(message.key);
    const stored = await chrome.storage.local.get([name, SETTINGS_KEY]);
    const state: QueueState = (stored[name] as QueueState | undefined) ?? emptyQueue(message.key);
    if (!parseSettings(stored[SETTINGS_KEY]).enabled &&
      ['enqueue', 'claim', 'submitted'].includes(message.action.type))
      return { ok: false, state, error: 'Queue 已关闭' };
    const reply = transition(state, message.action, { tabId, documentId: message.documentId, now: Date.now() });
    if (reply.ok && reply.state.revision !== state.revision) reply.state = await persistQueue(reply.state, state);
    return reply;
  }).then(respond, error => respond({ ok: false, error: `队列保存失败：${String(error)}` }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  void serialize(async () => {
    const all = await chrome.storage.local.get(null);
    for (const [name, state] of Object.entries(all)) {
      if (!name.startsWith('cwq:v1:')) continue;
      let current = state as QueueState;
      const actors = [current.owner, current.editing?.owner, current.handoff]
        .filter(actor => actor?.tabId === tabId);
      for (const actor of actors) {
        current = transition(current, { type: 'leave' }, { ...actor!, now: Date.now() }).state;
      }
      if (actors.length) await persistQueue(current, state as QueueState);
    }
  });
});
