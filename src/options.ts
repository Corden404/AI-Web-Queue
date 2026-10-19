import { namingRequest } from './naming/client.ts';
import { defaultNamingSettings, parseNamingSettings, providerOrigin, tagsFrom, validateNamingSettings } from './naming/settings.ts';
import type { NamingSettings, ProjectRule, TagRule } from './naming/settings.ts';
import type { NamingState, ConversationData } from './naming/types.ts';

const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const value = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
const set = (id: string, value: string) => { input(id).value = value; };
const status = document.querySelector<HTMLElement>('#status')!;
const save = document.querySelector<HTMLButtonElement>('#save')!;
let settings = defaultNamingSettings();
let loaded = false;
let chatId = '';
let chatState: NamingState | undefined;
const tabId = Number(new URL(location.href).searchParams.get('tab')) || undefined;
function message(text: string, error = false, target = status) {
  target.setAttribute('role', error ? 'alert' : 'status'); target.textContent = text;
}
function labeled(label: string, key: string, initial = '', textarea = false) {
  const wrapper = document.createElement('label'); wrapper.append(document.createTextNode(label));
  const field = document.createElement(textarea ? 'textarea' : 'input'); field.dataset.field = key; field.value = initial;
  if (textarea) (field as HTMLTextAreaElement).rows = 2;
  wrapper.append(field); return wrapper;
}
function removeButton(row: HTMLElement) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'remove'; button.textContent = '移除此规则';
  button.addEventListener('click', () => {
    const removed = row.dataset.removed === 'true'; row.dataset.removed = String(!removed);
    button.textContent = removed ? '移除此规则' : '撤销移除';
    row.style.opacity = removed ? '' : '.55';
  }); return button;
}
function addTag(rule: TagRule = { condition: '', tag: '' }) {
  const row = document.createElement('div'); row.className = 'tag-row';
  row.append(labeled('满足什么条件', 'condition', rule.condition), labeled('添加标签', 'tag', rule.tag), removeButton(row));
  document.querySelector('#tag-rules')!.append(row);
}
function addProject(project: ProjectRule = { id: '', name: '', alias: '', mode: 'inherit', instructions: '', tags: [], template: '' }) {
  const row = document.createElement('details'); row.className = 'project-row'; row.open = !project.name && !project.id;
  const summary = document.createElement('summary'); summary.textContent = project.name || project.id || '新项目规则'; row.append(summary);
  const first = document.createElement('div'); first.className = 'grid';
  first.append(labeled('项目名称', 'name', project.name), labeled('项目简称', 'alias', project.alias)); row.append(first);
  const second = document.createElement('div'); second.className = 'grid'; second.append(labeled('项目 ID（可选）', 'id', project.id));
  const mode = document.createElement('label'); mode.append(document.createTextNode('命名依据'));
  const select = document.createElement('select'); select.dataset.field = 'mode';
  for (const [v, label] of [['inherit', '跟随全局模式'], ['first', '首条消息'], ['conversation', '整段对话总结']]) {
    const option = document.createElement('option'); option.value = v; option.textContent = label; select.append(option);
  }
  select.value = project.mode; mode.append(select); second.append(mode); row.append(second);
  row.append(labeled('此项目的命名要求（留空跟随全局）', 'instructions', project.instructions, true),
    labeled('此项目的固定标签', 'tags', project.tags.join(' ')), labeled('此项目的标题模板（留空跟随全局）', 'template', project.template), removeButton(row));
  row.addEventListener('input', () => { summary.textContent = row.querySelector<HTMLInputElement>('[data-field=name]')!.value || row.querySelector<HTMLInputElement>('[data-field=id]')!.value || '新项目规则'; });
  document.querySelector('#projects')!.append(row);
}
function render(s: NamingSettings) {
  settings = s; input('naming-enabled').checked = s.enabled;
  for (const [key, v] of Object.entries({ mode: s.mode, instructions: s.instructions, 'max-length': String(s.maxActivityLength),
    'project-template': s.projectTemplate, 'standalone-template': s.standaloneTemplate, 'date-format': s.dateFormat,
    'time-zone': s.timeZone, tags: s.tags.join(' '), 'base-url': s.provider.baseUrl, model: s.provider.model,
    'api-key': s.provider.apiKey, protocol: s.provider.protocol, 'output-format': s.provider.format })) set(key, v);
  document.querySelector('#tag-rules')!.replaceChildren(); s.tagRules.forEach(addTag);
  document.querySelector('#projects')!.replaceChildren(); s.projects.forEach(addProject);
}
function collect(): NamingSettings {
  const field = (row: Element, key: string) => row.querySelector<HTMLInputElement>(`[data-field="${key}"]`)!.value;
  const data = parseNamingSettings({ ...settings, enabled: input('naming-enabled').checked, mode: value('mode'),
    instructions: value('instructions'), maxActivityLength: Number(value('max-length')),
    projectTemplate: value('project-template'), standaloneTemplate: value('standalone-template'), dateFormat: value('date-format'),
    timeZone: value('time-zone'), tags: tagsFrom(value('tags')),
    provider: { baseUrl: value('base-url'), model: value('model'), apiKey: value('api-key'), protocol: value('protocol'), format: value('output-format') },
    tagRules: Array.from(document.querySelectorAll('#tag-rules .tag-row:not([data-removed="true"])')).map(row => ({ condition: field(row, 'condition'), tag: field(row, 'tag') })),
    projects: Array.from(document.querySelectorAll('#projects .project-row:not([data-removed="true"])')).map(row => ({
      id: field(row, 'id'), name: field(row, 'name'), alias: field(row, 'alias'), mode: field(row, 'mode'),
      instructions: field(row, 'instructions'), tags: tagsFrom(field(row, 'tags')), template: field(row, 'template'),
    })),
  });
  validateNamingSettings(data); return data;
}
save.disabled = true;
void namingRequest({ type: 'getSettings' }).then(reply => {
  render(reply.settings!); loaded = true; save.disabled = false;
  message(settings.provider.model ? '设置已载入' : '填写模型服务后保存，即可开始自动命名。');
}, error => message(String(error), true));
document.querySelector('#add-tag')!.addEventListener('click', () => addTag());
document.querySelector('#add-project')!.addEventListener('click', () => addProject());
document.querySelector('#settings')!.addEventListener('submit', event => {
  event.preventDefault();
  if (!loaded) return;
  let draft: NamingSettings;
  try { draft = collect(); } catch (error) { message(String(error), true); return; }
  // Request directly from the click/submit gesture, before any storage awaits.
  const permission = draft.provider.model ? chrome.permissions.request({ origins: [providerOrigin(draft.provider.baseUrl)] }) : Promise.resolve(true);
  save.disabled = true;
  void permission.then(async granted => {
    if (!granted) throw new Error('未授予模型服务域名权限，设置尚未保存');
    const reply = await namingRequest({ type: 'saveSettings', settings: draft });
    settings = reply.settings!; message('已保存，所有 ChatGPT 标签页会使用新规则。');
  }).catch(error => message(String(error), true)).finally(() => { save.disabled = false; });
});
document.querySelector<HTMLButtonElement>('#preview')!.addEventListener('click', event => {
  if (!loaded) return;
  const button = event.currentTarget as HTMLButtonElement;
  const output = document.querySelector<HTMLElement>('#preview-result')!;
  let draft: NamingSettings;
  try { draft = collect(); if (!draft.provider.model) throw new Error('请先填写模型名称'); if (!value('sample').trim()) throw new Error('请填写示例消息'); }
  catch (error) { message(String(error), true, output); return; }
  const permission = chrome.permissions.request({ origins: [providerOrigin(draft.provider.baseUrl)] });
  button.disabled = true; message('正在生成预览…', false, output);
  const projectName = value('sample-project').trim();
  const data: ConversationData = { id: 'preview', title: '示例', createdAt: Date.now(),
    project: projectName ? { id: value('sample-project-id').trim(), name: projectName } : null,
    messages: [{ id: 'sample', role: 'user', text: value('sample').trim() }], completeHistory: true, currentNode: 'sample' };
  void permission.then(async granted => {
    if (!granted) throw new Error('未授予模型服务域名权限');
    const reply = await namingRequest({ type: 'preview', settings: draft, conversation: data });
    message(`活动：${reply.result!.activity}\n主题：${reply.result!.topic}\n条件标签：${reply.result!.tags.map(t => `#${t}`).join(' ') || '无'}\n\n${reply.title}`, false, output);
  }).catch(error => message(String(error), true, output)).finally(() => { button.disabled = false; });
});
async function pageControl(type: string): Promise<any> {
  if (!tabId) throw new Error('请从 ChatGPT 页面的扩展弹窗进入设置');
  const reply = await chrome.tabs.sendMessage(tabId, { channel: 'cwq-naming-page-control-v1', type });
  if (!reply?.ok) throw new Error(reply?.error || '请刷新 ChatGPT 页面后重试'); return reply;
}
async function refreshChat() {
  if (!tabId) return;
  const reply = await pageControl('status'); chatId = reply.id; chatState = reply.state;
  document.querySelector<HTMLElement>('#current-chat')!.hidden = false;
  document.querySelector('#current-title')!.textContent = reply.title;
  set('chat-mode', chatState!.mode); set('chat-tags', chatState!.tags.join(' ')); set('chat-instructions', chatState!.instructions);
  document.querySelector('#lock-chat')!.textContent = chatState!.locked ? '解除锁定' : '锁定标题';
  (document.querySelector('#undo-chat') as HTMLButtonElement).disabled = !chatState!.history.length;
  message(chatState!.lastError || (chatState!.locked ? '当前标题已锁定' : '自动命名可用'), !!chatState!.lastError, document.querySelector('#chat-status')!);
}
void refreshChat().catch(error => { if (tabId) message(String(error), true); });
document.querySelector('#save-chat')!.addEventListener('click', () => {
  if (!chatId) return;
  void namingRequest({ type: 'setState', id: chatId, patch: { mode: value('chat-mode') as NamingState['mode'],
    instructions: value('chat-instructions'), tags: tagsFrom(value('chat-tags')) } }).then(async () => {
      await refreshChat(); message('已保存此对话的规则', false, document.querySelector('#chat-status')!);
    }).catch(error => message(String(error), true, document.querySelector('#chat-status')!));
});
for (const [id, type] of [['generate-chat', 'generate'], ['lock-chat', 'lock'], ['undo-chat', 'undo']]) {
  document.querySelector<HTMLButtonElement>(`#${id}`)!.addEventListener('click', event => {
    const button = event.currentTarget as HTMLButtonElement; button.disabled = true;
    message('正在处理…', false, document.querySelector('#chat-status')!);
    void pageControl(type === 'lock' && chatState?.locked ? 'unlock' : type).then(refreshChat)
      .catch(error => message(String(error), true, document.querySelector('#chat-status')!)).finally(() => { button.disabled = id === 'undo-chat' && !chatState?.history.length; });
  });
}
