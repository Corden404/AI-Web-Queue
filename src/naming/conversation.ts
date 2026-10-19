import type { ConversationData, ConversationText } from './types.ts';

type Raw = Record<string, any>;
export function normalizeConversation(raw: Raw, id: string): ConversationData {
  if ((raw.conversation_id || raw.id) && (raw.conversation_id || raw.id) !== id) throw new Error('会话数据与当前页面不一致');
  let list: Raw[];
  if (raw.mapping && raw.current_node) {
    list = []; const seen = new Set<string>(); let node = raw.current_node;
    while (node) {
      if (seen.has(node) || !raw.mapping[node]) throw new Error('会话分支历史不完整');
      seen.add(node); const entry = raw.mapping[node];
      if (entry.message) list.unshift(entry.message);
      node = entry.parent;
    }
  } else if (Array.isArray(raw.messages)) list = raw.messages;
  else throw new Error('当前网页的会话数据格式尚不支持');
  const messages: ConversationText[] = [];
  for (const m of list) {
    const role = m.author?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    if (m.metadata?.is_visually_hidden_from_conversation || (role === 'assistant' && m.channel && m.channel !== 'final')) continue;
    if (m.recipient && m.recipient !== 'all') continue;
    const text = m.content?.content_type === 'text' || m.content?.content_type === 'multimodal_text'
      ? (m.content.parts ?? []).filter((part: unknown) => typeof part === 'string').join('\n').trim() : '';
    if (text || role === 'user') messages.push({ id: m.id, role, text });
  }
  const createdAt = Number(raw.create_time) * 1000;
  if (!Number.isFinite(createdAt) || createdAt <= 0) throw new Error('无法确认对话创建日期');
  return { id, title: typeof raw.title === 'string' ? raw.title : '', createdAt, project: null, messages,
    completeHistory: raw.mapping ? !raw.page_info?.has_previous_page && !raw.page_info?.has_next_page
      : raw.page_info?.has_previous_page === false && raw.page_info?.has_next_page === false,
    currentNode: raw.current_node || messages.at(-1)?.id || '', lastMessageId: messages.at(-1)?.id };
}
