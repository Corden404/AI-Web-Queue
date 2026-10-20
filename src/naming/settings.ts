export type NamingMode = 'first' | 'conversation';
export interface TagRule { condition: string; tag: string }
export interface ProjectRule {
  id: string;
  name: string;
  alias: string;
  mode: NamingMode | 'inherit';
  instructions: string;
  tags: string[];
  template: string;
}
export interface NamingSettings {
  version: 1;
  revision: number;
  enabled: boolean;
  mode: NamingMode;
  provider: { baseUrl: string; model: string; apiKey: string; protocol: 'chat' | 'responses'; format: 'json' | 'schema' | 'prompt' };
  projectTemplate: string;
  standaloneTemplate: string;
  instructions: string;
  tags: string[];
  tagRules: TagRule[];
  tagSelection: 'single' | 'multiple';
  fallbackTag: string;
  projects: ProjectRule[];
  maxActivityLength: number;
  timeZone: string;
  dateFormat: 'MM-DD' | 'YYYY-MM-DD';
}
export const NAMING_SETTINGS_KEY = 'cwq:naming:settings:v1';
export const NAMING_CHANNEL = 'chatgpt-web-naming-v1';
export const STATE_PREFIX = 'cwq:naming:state:';
export const defaultNamingSettings = (): NamingSettings => ({
  version: 1, revision: 0, enabled: true, mode: 'first',
  provider: { baseUrl: 'https://api.openai.com/v1', model: '', apiKey: '', protocol: 'chat', format: 'json' },
  projectTemplate: '{标签} | {日期} | {项目简称} | {活动}', standaloneTemplate: '{标签} | {日期} | {活动}',
  instructions: '使用简洁中文概括任务，保留有辨识度的主题。首条消息模式描述任务意图；对话总结模式描述实际讨论内容，不把计划写成已完成。',
  tags: [], tagRules: [
    { tag: '研究', condition: '搜集资料、查文献、了解产品或现状、比较工具、模型、方案' },
    { tag: '计划', condition: '制定计划、安排步骤、确定优先级' },
    { tag: '执行', condition: '编写代码、实现功能、重构程序、执行任务或要求' },
    { tag: '审阅', condition: '审阅已有的代码、PR、Issue、找出 bug 或改进' },
    { tag: '学习', condition: '和代码、开发无关，用于指导用户学业的对话' },
    { tag: '杂项', condition: '仅在研究、计划、执行、审阅、学习的规则都没有命中时使用' },
  ], tagSelection: 'single', fallbackTag: '杂项', projects: [], maxActivityLength: 16,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, dateFormat: 'MM-DD',
});
export function cleanText(value: unknown, max = 4000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
export function tagsFrom(value: unknown): string[] {
  const values = typeof value === 'string' ? value.split(/[,，\s]+/) : Array.isArray(value) ? value : [];
  return [...new Set(values.map(v => cleanText(v, 40).replace(/^#+/, '').replace(/[|{}\s#]/g, '')).filter(Boolean))].slice(0, 12);
}
export function parseNamingSettings(value: unknown): NamingSettings {
  const d = defaultNamingSettings();
  if (!value || typeof value !== 'object') return d;
  const v = value as Partial<NamingSettings>;
  const provider = v.provider;
  return {
    ...d, revision: Number.isSafeInteger(v.revision) ? v.revision! : 0, enabled: v.enabled !== false,
    mode: v.mode === 'conversation' ? 'conversation' : 'first',
    provider: { baseUrl: cleanText(provider?.baseUrl, 1000) || d.provider.baseUrl,
      model: cleanText(provider?.model, 200), apiKey: cleanText(provider?.apiKey, 2000),
      protocol: provider?.protocol === 'responses' ? 'responses' : 'chat',
      format: provider?.format === 'schema' || provider?.format === 'prompt' ? provider.format : 'json' },
    projectTemplate: cleanText(v.projectTemplate, 300) || d.projectTemplate,
    standaloneTemplate: cleanText(v.standaloneTemplate, 300) || d.standaloneTemplate,
    instructions: typeof v.instructions === 'string' ? cleanText(v.instructions) : d.instructions,
    tags: tagsFrom(v.tags), tagRules: Array.isArray(v.tagRules) ? v.tagRules.slice(0, 40).map(r => ({
      condition: cleanText(r?.condition, 1000), tag: tagsFrom([r?.tag])[0] ?? '',
    })).filter(r => r.condition && r.tag) : d.tagRules,
    tagSelection: v.tagSelection === 'single' || v.tagSelection === 'multiple' ? v.tagSelection
      : Array.isArray(v.tagRules) ? 'multiple' : d.tagSelection,
    fallbackTag: typeof v.fallbackTag === 'string' ? tagsFrom([v.fallbackTag])[0] ?? ''
      : Array.isArray(v.tagRules) ? '' : d.fallbackTag,
    projects: Array.isArray(v.projects) ? v.projects.slice(0, 100).map(p => ({
      id: cleanText(p?.id, 200), name: cleanText(p?.name, 200), alias: cleanText(p?.alias, 80),
      mode: p?.mode === 'first' || p?.mode === 'conversation' ? p.mode : 'inherit' as const,
      instructions: cleanText(p?.instructions), tags: tagsFrom(p?.tags), template: cleanText(p?.template, 300),
    })).filter(p => p.id || p.name) : [],
    maxActivityLength: Math.max(4, Math.min(60, Math.round(Number(v.maxActivityLength) || d.maxActivityLength))),
    timeZone: cleanText(v.timeZone, 100) || d.timeZone,
    dateFormat: v.dateFormat === 'YYYY-MM-DD' ? 'YYYY-MM-DD' : 'MM-DD',
  };
}
export function providerOrigin(baseUrl: string): string {
  const url = new URL(baseUrl);
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('模型地址需要 HTTPS；本地模型可使用 http://localhost 或 http://127.0.0.1');
  if (url.username || url.password || url.search || url.hash) throw new Error('模型地址不能包含账号、密码、查询参数或片段');
  if (url.hostname === 'chatgpt.com' || url.hostname.endsWith('.chatgpt.com')) throw new Error('请填写模型 API 地址');
  return `${url.origin}/*`;
}
export function validateTemplate(template: string): void {
  const supported = new Set(['项目简称', '项目名称', '日期', '活动', '主题', '标签']);
  const tokens: string[] = template.match(/\{[^{}]*\}/g) ?? [];
  if (!tokens.includes('{活动}') && !tokens.includes('{主题}')) throw new Error('标题模板需要包含 {活动} 或 {主题}');
  if (tokens.some(token => !supported.has(token.slice(1, -1))) || /[{}]/.test(template.replace(/\{[^{}]*\}/g, '')))
    throw new Error('模板支持：{项目简称}、{项目名称}、{日期}、{活动}、{主题}、{标签}');
}
export function validateNamingSettings(settings: NamingSettings): void {
  providerOrigin(settings.provider.baseUrl);
  new Intl.DateTimeFormat('en', { timeZone: settings.timeZone });
  validateTemplate(settings.projectTemplate); validateTemplate(settings.standaloneTemplate);
  for (const project of settings.projects) if (project.template) validateTemplate(project.template);
  if (settings.fallbackTag && !settings.tagRules.some(rule => rule.tag === settings.fallbackTag))
    throw new Error('兜底标签需要存在于条件标签库中，或留空取消兜底');
  const keys = settings.projects.map(p => p.id ? `id:${p.id}` : `name:${p.name}`);
  if (new Set(keys).size !== keys.length) throw new Error('项目规则有重复的项目 ID 或名称');
}
