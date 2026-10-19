import test from 'node:test';
import assert from 'node:assert/strict';
import type { QueueReply, Request } from '../src/core/types.ts';
import { SETTINGS_CHANNEL, SETTINGS_KEY } from '../src/core/settings.ts';
import type { Settings, SettingsRequest } from '../src/core/settings.ts';

const data: Record<string, unknown> = {};
let listener: (message: Request | SettingsRequest, sender: chrome.runtime.MessageSender, respond: (reply: unknown) => void) => unknown;
Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
  runtime: { id: 'test-extension', onMessage: { addListener(fn: typeof listener) { listener = fn; } } },
  storage: { local: {
    async get(keys: string | string[] | null) {
      const selected = keys === null ? Object.keys(data) : typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(selected.filter(key => key in data).map(key => [key, structuredClone(data[key])]));
    },
    async set(values: Record<string, unknown>) { Object.assign(data, structuredClone(values)); },
  } },
  tabs: { onRemoved: { addListener() {} } },
} });
await import('../src/background.ts');
const sender = { id: 'test-extension', tab: { id: 1 }, url: 'https://chatgpt.com/c/test' } as chrome.runtime.MessageSender;
function call<T = QueueReply>(message: Request | SettingsRequest, from = sender): Promise<T> {
  return new Promise(resolve => { listener(message, from, value => resolve(value as T)); });
}
const command = (action: Request['action']) => call({ channel: 'chatgpt-web-queue-v1', key: 'conversation:test', documentId: 'doc', action });
const enable = (enabled: boolean) => call<{ ok: boolean; settings: Settings }>({ channel: SETTINGS_CHANNEL, action: { type: 'setEnabled', enabled } });

test('background settings default on and support the toolbar popup without a tab ID', async () => {
  const popup = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' } as chrome.runtime.MessageSender;
  const reply = await call<{ ok: boolean; settings: Settings }>({ channel: SETTINGS_CHANNEL, action: { type: 'get' } }, popup);
  assert.equal(reply.settings.enabled, true);
  await enable(false);
  assert.deepEqual(data[SETTINGS_KEY], { enabled: false });
  const saved = await call<{ settings: Settings }>({ channel: SETTINGS_CHANNEL, action: { type: 'get' } }, popup);
  assert.equal(saved.settings.enabled, false);
});
test('turning off centrally blocks enqueuing and dispatch while preserving existing messages', async () => {
  await enable(true);
  await command({ type: 'enqueue', text: 'preserve this message' });
  await enable(false);
  const enqueue = await command({ type: 'enqueue', text: 'should not be added' });
  const claim = await command({ type: 'claim' });
  assert.equal(enqueue.ok, false); assert.equal(claim.ok, false);
  assert.equal(claim.state.items.length, 1); assert.equal(claim.state.items[0]!.status, 'queued');
  await enable(true);
  assert.equal((await command({ type: 'claim' })).ok, true);
});
test('turning off before the click boundary blocks submission; abort retains the item', async () => {
  const state = await command({ type: 'connect' });
  const id = state.state.attempt!.id;
  await enable(false);
  const blocked = await command({ type: 'submitted', attemptId: id });
  assert.equal(blocked.ok, false);
  const abort = await command({ type: 'abort', attemptId: id, reason: 'Queue 已关闭' });
  assert.equal(abort.state.items.length, 1); assert.equal(abort.state.items[0]!.status, 'queued');
});
test('disabling after an actual submission still allows its receipt to be reconciled', async () => {
  await enable(true); await command({ type: 'pause', paused: false });
  const claim = await command({ type: 'claim' }); const id = claim.attempt!.id;
  await command({ type: 'submitted', attemptId: id }); await enable(false);
  const ack = await command({ type: 'ack', attemptId: id, userMessageId: 'u1' });
  assert.equal(ack.ok, true); assert.equal(ack.state.items.length, 0); assert.equal(ack.state.sent.length, 1);
});
