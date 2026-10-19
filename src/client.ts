import type { Action, QueueClient, QueueReply } from './core/types.ts';
import { parseSettings, SETTINGS_CHANNEL, SETTINGS_KEY } from './core/settings.ts';
import type { Settings } from './core/settings.ts';
import { HISTORY_CHANNEL } from './core/history.ts';
import type { HistoryRequest } from './core/history.ts';

export async function historyRequest<T>(action: HistoryRequest['action']): Promise<T> {
  const response = await chrome.runtime.sendMessage({ channel: HISTORY_CHANNEL, action });
  if (!response?.ok) throw new Error(response?.error ?? '无法读取本地记录');
  return response.data;
}

export async function readSettings(): Promise<Settings> {
  const response = await chrome.runtime.sendMessage({ channel: SETTINGS_CHANNEL, action: { type: 'get' } });
  if (!response?.ok) throw new Error(response?.error ?? '无法读取 Queue 设置，请重新加载扩展');
  return parseSettings(response.settings);
}
export async function writeEnabled(enabled: boolean): Promise<Settings> {
  const response = await chrome.runtime.sendMessage({ channel: SETTINGS_CHANNEL, action: { type: 'setEnabled', enabled } });
  if (!response?.ok) throw new Error(response?.error ?? '无法保存 Queue 设置');
  return parseSettings(response.settings);
}

export function extensionClient(): QueueClient {
  const documentId = crypto.randomUUID();
  return {
    documentId,
    async send(key: string, action: Action): Promise<QueueReply> {
      const response = await chrome.runtime.sendMessage({ channel: 'chatgpt-web-queue-v1', key, documentId, action });
      if (!response || !response.state) throw new Error(response?.error ?? '扩展已更新，请刷新 ChatGPT 页面');
      return response;
    },
    subscribe(listener) {
      const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        if (area !== 'local') return;
        for (const name of Object.keys(changes)) if (name.startsWith('cwq:v1:')) listener(name.slice(7));
      };
      chrome.storage.onChanged.addListener(changed);
      return () => chrome.storage.onChanged.removeListener(changed);
    },
    getSettings: readSettings,
    setEnabled: writeEnabled,
    subscribeSettings(listener) {
      const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        if (area === 'local' && changes[SETTINGS_KEY]) listener(parseSettings(changes[SETTINGS_KEY].newValue));
      };
      chrome.storage.onChanged.addListener(changed);
      return () => chrome.storage.onChanged.removeListener(changed);
    },
  };
}
