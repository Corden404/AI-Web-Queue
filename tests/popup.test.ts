import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { build } from 'vite';
import { parseSettings, SETTINGS_KEY } from '../src/core/settings.ts';
import type { SettingsRequest } from '../src/core/settings.ts';

const built = await build({ configFile: false, logLevel: 'silent', build: { write: false,
  target: 'chrome120', lib: { entry: 'src/popup.ts', formats: ['iife'], name: 'QueuePopupTest' } } });
const output = Array.isArray(built) ? built[0] : built;
if (!('output' in output)) throw new Error('Expected a popup bundle');
const code = output.output.find(part => part.type === 'chunk')!.code;
const html = await readFile('public/popup.html', 'utf8');
const flush = async () => { for (let n = 0; n < 5; n++) await new Promise<void>(resolve => setImmediate(resolve)); };

test('shipping toolbar popup defaults on, persists off, and follows changes from another popup', async () => {
  const stored: Record<string, unknown> = {};
  const listeners: ((changes: object, area: string) => void)[] = [];
  const save = (enabled: boolean) => {
    stored[SETTINGS_KEY] = { enabled };
    listeners.forEach(listener => listener({ [SETTINGS_KEY]: { newValue: { enabled } } }, 'local'));
  };
  async function open() {
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    Object.defineProperty(dom.window, 'chrome', { value: {
      runtime: { async sendMessage(message: SettingsRequest) {
        if (message.action.type === 'setEnabled') save(message.action.enabled);
        return { ok: true, settings: parseSettings(stored[SETTINGS_KEY]) };
      } },
      storage: { onChanged: { addListener(listener: (changes: object, area: string) => void) { listeners.push(listener); } } },
    } });
    dom.window.eval(code); await flush(); return dom;
  }
  const first = await open();
  let second: JSDOM | undefined;
  try {
    const toggle = first.window.document.querySelector<HTMLInputElement>('[role=switch]')!;
    assert.equal(toggle.checked, true); assert.equal(toggle.disabled, false);
    toggle.click(); await flush(); assert.deepEqual(stored[SETTINGS_KEY], { enabled: false });
    second = await open();
    const reopened = second.window.document.querySelector<HTMLInputElement>('[role=switch]')!;
    assert.equal(reopened.checked, false);
    reopened.click(); await flush(); assert.equal(toggle.checked, true);
    assert.equal(first.window.document.querySelector('#status')!.textContent, '已开启');
  } finally { first.window.close(); second?.window.close(); }
});
