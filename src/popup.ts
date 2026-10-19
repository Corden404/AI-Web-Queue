import { readSettings, writeEnabled } from './client.ts';
import { parseSettings, SETTINGS_KEY } from './core/settings.ts';
import type { Settings } from './core/settings.ts';
import { namingRequest } from './naming/client.ts';
import type { NamingSettings } from './naming/settings.ts';
import type { NamingState } from './naming/types.ts';

const toggle = document.querySelector<HTMLInputElement>('#enabled')!;
const status = document.querySelector<HTMLElement>('#status')!;
let settings: Settings;
function render(value: Settings) {
  settings = value; toggle.checked = value.enabled;
  status.setAttribute('role', 'status');
  status.textContent = value.enabled ? '已开启' : '已关闭，待发送消息已保留';
}
void readSettings().then(value => { render(value); toggle.disabled = false; }, error => {
  status.setAttribute('role', 'alert'); status.textContent = String(error);
});
toggle.addEventListener('change', () => {
  const enabled = toggle.checked;
  toggle.disabled = true;
  void writeEnabled(enabled).then(render, error => {
    toggle.checked = settings.enabled;
    status.setAttribute('role', 'alert'); status.textContent = String(error);
  }).finally(() => { toggle.disabled = false; });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SETTINGS_KEY]) render(parseSettings(changes[SETTINGS_KEY].newValue));
});

const namingStatus = document.querySelector<HTMLElement>('#naming-status')!;
const namingToggle = document.querySelector<HTMLInputElement>('#naming-enabled')!;
let namingSettings: NamingSettings | undefined;
let activeTab: number | undefined;
let namingState: NamingState | undefined;
function namingMessage(text: string, error = false) { namingStatus.textContent = text; namingStatus.setAttribute('role', error ? 'alert' : 'status'); }
async function control(type: string): Promise<any> {
  if (activeTab === undefined) throw new Error('请先打开一条 ChatGPT 对话');
  const reply = await chrome.tabs.sendMessage(activeTab, { channel: 'cwq-naming-page-control-v1', type });
  if (!reply?.ok) throw new Error(reply?.error || '请刷新 ChatGPT 页面后重试'); return reply;
}
async function loadNaming() {
  namingSettings = (await namingRequest({ type: 'getSettings' })).settings!;
  namingToggle.checked = namingSettings.enabled; namingToggle.disabled = false;
  namingMessage(namingSettings.provider.model ? (namingSettings.enabled ? '自动命名已开启' : '自动命名已关闭') : '先配置命名模型，默认使用首条消息。');
  const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.id || !tab.url?.startsWith('https://chatgpt.com/')) return;
  activeTab = tab.id;
  const reply = await control('status'); namingState = reply.state;
  document.querySelector('#chat-title')!.textContent = reply.title;
  document.querySelector<HTMLButtonElement>('#generate')!.disabled = !!reply.busy || !namingSettings.provider.model;
  document.querySelector<HTMLButtonElement>('#lock')!.disabled = false;
  document.querySelector('#lock')!.textContent = namingState!.locked ? '解除锁定' : '锁定标题';
  document.querySelector<HTMLButtonElement>('#undo')!.disabled = !!reply.busy || !namingState!.history.length;
  if (namingState!.lastError) namingMessage(namingState!.lastError, true);
  else if (namingState!.locked) namingMessage('当前标题已锁定');
}
void loadNaming().catch(error => namingMessage(error instanceof Error ? error.message : '请重新加载扩展', true));
namingToggle.addEventListener('change', () => {
  if (!namingSettings) return;
  const enabled = namingToggle.checked; namingToggle.disabled = true;
  void namingRequest({ type: 'saveSettings', settings: { ...namingSettings, enabled } }).then(reply => {
    namingSettings = reply.settings; namingMessage(enabled ? '自动命名已开启' : '自动命名已关闭');
  }, error => { namingToggle.checked = namingSettings!.enabled; namingMessage(String(error), true); }).finally(() => { namingToggle.disabled = false; });
});
document.querySelector('#naming-settings')!.addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('options.html') + (activeTab ? `?tab=${activeTab}` : '') });
});
for (const type of ['generate', 'lock', 'undo']) document.querySelector<HTMLButtonElement>(`#${type}`)!.addEventListener('click', event => {
  const button = event.currentTarget as HTMLButtonElement; button.disabled = true; namingMessage('正在处理…');
  void control(type === 'lock' && namingState?.locked ? 'unlock' : type).then(loadNaming)
    .catch(error => namingMessage(String(error), true)).finally(() => { button.disabled = type === 'undo' && !namingState?.history.length; });
});
