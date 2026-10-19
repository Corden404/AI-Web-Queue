import { NAMING_CHANNEL } from './settings.ts';
import type { NamingAction, NamingReply, ConversationData } from './types.ts';
import type { NamingMode } from './settings.ts';

export async function namingRequest(action: NamingAction): Promise<NamingReply> {
  const reply = await chrome.runtime.sendMessage({ channel: NAMING_CHANNEL, action }) as NamingReply | undefined;
  if (!reply?.ok) throw new Error(reply?.error || '无法连接命名功能，请重新加载扩展并刷新页面');
  return reply;
}
export async function readConversation(document: Document, id: string, mode: NamingMode): Promise<ConversationData> {
  const window = document.defaultView!;
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const done = () => { window.removeEventListener('message', listener); window.clearTimeout(timer); };
    const listener = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== document.location.origin || event.data?.channel !== 'cwq-page-read-result-v1' || event.data.requestId !== requestId) return;
      done();
      if (event.data.ok && event.data.data?.id === id) resolve(event.data.data);
      else reject(new Error(event.data.error || '会话读取失败'));
    };
    const timer = window.setTimeout(() => { done(); reject(new Error('读取会话超时，请刷新 ChatGPT 页面后重试')); }, 60_000);
    window.addEventListener('message', listener);
    window.postMessage({ channel: 'cwq-page-read-v1', requestId, id, mode }, document.location.origin);
  });
}
