// Runs in the page world. Session credentials stay in this closure; only the
// selected conversation text and metadata cross into the extension world.
import { normalizeConversation } from '../naming/conversation.ts';
import type { NamingMode } from '../naming/settings.ts';

const REQUEST = 'cwq-page-read-v1';
const RESPONSE = 'cwq-page-read-result-v1';
let token = '';
let tokenAt = 0;
const pending = new Set<string>();
async function sessionToken(): Promise<string> {
  if (token && Date.now() - tokenAt < 60_000) return token;
  const response = await fetch('/api/auth/session', { credentials: 'same-origin', signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error('请先登录 ChatGPT 并刷新页面');
  const session = await response.json();
  token = typeof session.accessToken === 'string' ? session.accessToken : '';
  tokenAt = Date.now(); return token;
}
class ReadError extends Error { constructor(public status: number) { super(`读取 ChatGPT 会话失败（${status}），请刷新后重试`); } }
async function read(path: string, retry = true): Promise<any> {
  const accessToken = await sessionToken();
  const response = await fetch(path, { credentials: 'same-origin',
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}, signal: AbortSignal.timeout(15_000) });
  if (response.status === 401 && retry) { token = ''; return read(path, false); }
  if (!response.ok) throw new ReadError(response.status);
  return response.json();
}
async function readConversation(id: string, mode: NamingMode) {
  // One turn is enough for new conversations in first-message mode. Older
  // conversations may need a larger history window to locate the true first turn.
  let raw;
  try { raw = await read(`/backend-api/conversations/${encodeURIComponent(id)}?num_turns=${mode === 'first' ? 1 : 1000}&include_has_versions=true`); }
  catch (error) {
    if (!(error instanceof ReadError) || error.status !== 404) throw error;
    raw = await read(`/backend-api/conversation/${encodeURIComponent(id)}`);
  }
  if (mode === 'first' && raw.page_info?.has_previous_page)
    raw = await read(`/backend-api/conversations/${encodeURIComponent(id)}?num_turns=1000&include_has_versions=true`);
  const data = normalizeConversation(raw, id);
  if (raw.is_temporary_chat || raw.is_read_only) throw new Error('临时或只读对话无法保存名称');
  if (!data.completeHistory) throw new Error('网页接口返回的历史不完整，暂时无法确认首条消息或总结整段对话');
  if (raw.gizmo_id) {
    let project; let cursor = '';
    for (let page = 0; page < 10; page++) {
      const sidebar = await read('/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=5&limit=20&owned_only=false' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''));
      project = (sidebar.items ?? []).map((item: any) => item.gizmo?.gizmo ?? item.gizmo).find((g: any) => g?.id === raw.gizmo_id);
      if (project || !sidebar.cursor || typeof sidebar.cursor !== 'string' || sidebar.cursor === cursor) break;
      cursor = sidebar.cursor;
    }
    if (project) data.project = { id: project.id, name: project.display?.name || project.name || project.id };
    else if (raw.gizmo_type === 'snorlax' || raw.gizmo_type === 'project' || raw.gizmo_id.startsWith('g-p-'))
      data.project = { id: raw.gizmo_id, name: raw.gizmo_id };
  }
  if (mode === 'first') data.messages = data.messages.filter(m => m.role === 'user').slice(0, 1);
  return data;
}
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin || event.data?.channel !== REQUEST) return;
  const { requestId, id, mode } = event.data;
  if (typeof requestId !== 'string' || requestId.length > 100 || typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)
    || !['first', 'conversation'].includes(mode) || pending.has(requestId) || pending.size >= 3) return;
  const current = location.pathname.match(/\/c\/([a-zA-Z0-9_-]+)(?:\/|$)/)?.[1];
  if (current !== id) return;
  pending.add(requestId);
  void readConversation(id, mode).then(data => {
    window.postMessage({ channel: RESPONSE, requestId, ok: true, data }, location.origin);
  }, error => {
    window.postMessage({ channel: RESPONSE, requestId, ok: false, error: error instanceof Error ? error.message : '无法读取会话' }, location.origin);
  }).finally(() => pending.delete(requestId));
});
