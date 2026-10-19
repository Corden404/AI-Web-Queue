import { tagsFrom } from './settings.ts';
import type { NamingSettings } from './settings.ts';
import type { ConversationData, NamingResult, NamingState } from './types.ts';

export function resolveRule(settings: NamingSettings, conversation: ConversationData, state: NamingState) {
  const project = conversation.project;
  const specific = project ? settings.projects.find(p => p.id && p.id === project.id)
    ?? settings.projects.find(p => !p.id && p.name === project.name) : undefined;
  return {
    mode: state.mode !== 'inherit' ? state.mode : specific?.mode && specific.mode !== 'inherit' ? specific.mode : settings.mode,
    alias: specific?.alias || project?.name || '',
    template: specific?.template || (project ? settings.projectTemplate : settings.standaloneTemplate),
    instructions: state.instructions || specific?.instructions || settings.instructions,
    tags: tagsFrom([...settings.tags, ...(specific?.tags ?? []), ...state.tags]),
  };
}
export function sourceMessages(conversation: ConversationData, mode: 'first' | 'conversation') {
  if (!conversation.completeHistory) throw new Error('尚未取得首条消息及完整历史，请重新加载对话后重试');
  if (mode === 'first') {
    const first = conversation.messages.find(m => m.role === 'user');
    if (!first?.text.trim()) throw new Error('首条消息没有可用于命名的文字');
    return [first];
  }
  if (!conversation.messages.some(m => m.role === 'user' && m.text.trim())) throw new Error('对话没有可用于命名的文字');
  return conversation.messages;
}
export function renderTitle(settings: NamingSettings, conversation: ConversationData, state: NamingState, result: NamingResult): string {
  const rule = resolveRule(settings, conversation, state);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: settings.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(conversation.createdAt));
  const part = (type: string) => date.find(p => p.type === type)?.value ?? '';
  const day = `${part('month')}-${part('day')}`;
  const allowedTags = new Set(settings.tagRules.map(r => r.tag));
  const values: Record<string, string> = {
    项目简称: rule.alias, 项目名称: conversation.project?.name ?? '',
    日期: settings.dateFormat === 'YYYY-MM-DD' ? `${part('year')}-${day}` : day,
    活动: result.activity, 主题: result.topic,
    标签: tagsFrom([...rule.tags, ...result.tags.filter(t => allowedTags.has(t))]).map(t => `#${t}`).join(' '),
  };
  const title = rule.template.replace(/\{([^{}]+)\}/g, (_, key: string) => values[key] ?? '')
    .split('|').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ').trim();
  if (!title || [...title].length > 160) throw new Error('生成的标题为空或超过 160 字，请调整模板与标签');
  return title;
}
export async function fingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
