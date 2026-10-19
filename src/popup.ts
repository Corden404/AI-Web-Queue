import { readSettings, writeEnabled } from './client.ts';
import { parseSettings, SETTINGS_KEY } from './core/settings.ts';
import type { Settings } from './core/settings.ts';

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
