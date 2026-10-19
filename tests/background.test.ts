import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { emptyQueue } from '../src/core/queue.ts';
import type { QueueReply, Request } from '../src/core/types.ts';
import { SETTINGS_CHANNEL, SETTINGS_KEY } from '../src/core/settings.ts';
import type { Settings, SettingsRequest } from '../src/core/settings.ts';
import { byteLength, HISTORY_CHANNEL } from '../src/core/history.ts';
import type { HistoryExport, HistoryRequest } from '../src/core/history.ts';

const data: Record<string, unknown> = {};
let listener: (message: Request | SettingsRequest | HistoryRequest, sender: chrome.runtime.MessageSender, respond: (reply: unknown) => void) => unknown;
let closed: (tabId: number) => void;
Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
  runtime: { id: 'test-extension', getURL: (path: string) => `chrome-extension://test-extension/${path}`, onMessage: { addListener(fn: typeof listener) { listener = fn; } } },
  storage: { local: {
    QUOTA_BYTES: 10 * 1024 * 1024,
    async getBytesInUse(keys: string | string[] | null) {
      const selected = keys === null ? Object.keys(data) : typeof keys === 'string' ? [keys] : keys;
      return selected.filter(key => key in data).reduce((bytes, key) => bytes + byteLength(data[key]) + byteLength(key), 0);
    },
    async get(keys: string | string[] | null) {
      const selected = keys === null ? Object.keys(data) : typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(selected.filter(key => key in data).map(key => [key, structuredClone(data[key])]));
    },
    async set(values: Record<string, unknown>) { Object.assign(data, structuredClone(values)); },
  } },
  tabs: { onRemoved: { addListener(fn: typeof closed) { closed = fn; } } },
} });
await import('../src/background.ts');
const sender = { id: 'test-extension', tab: { id: 1 }, url: 'https://chatgpt.com/c/test' } as chrome.runtime.MessageSender;
function call<T = QueueReply>(message: Request | SettingsRequest | HistoryRequest, from = sender): Promise<T> {
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

test('closing a non-owner editing tab releases its lock without a pagehide notification', async () => {
  await enable(true);
  const send = (action: Request['action'], tabId = 10, documentId = 'owner') => call({
    channel: 'chatgpt-web-queue-v1', key: 'conversation:closed-editor', documentId, action,
  }, { ...sender, tab: { id: tabId } } as chrome.runtime.MessageSender);
  const added = await send({ type: 'enqueue', text: 'retained text' });
  await send({ type: 'editStart', id: added.state.items[0]!.id }, 20, 'editor');
  closed(20);
  const recovered = await send({ type: 'connect' }); // Serialized after onRemoved.
  assert.equal(recovered.state.editing, null);
  assert.equal(recovered.state.owner?.tabId, 10);
  assert.equal(recovered.state.items[0]!.text, 'retained text');
  assert.equal((await send({ type: 'claim' })).ok, true);
});

test('closing a takeover requester cancels the handoff without discarding the active attempt', async () => {
  await enable(true);
  const send = (action: Request['action'], tabId = 30, documentId = 'owner') => call({
    channel: 'chatgpt-web-queue-v1', key: 'conversation:closed-requester', documentId, action,
  }, { ...sender, tab: { id: tabId } } as chrome.runtime.MessageSender);
  await send({ type: 'enqueue', text: 'message' });
  const id = (await send({ type: 'claim' })).attempt!.id;
  await send({ type: 'submitted', attemptId: id });
  await send({ type: 'takeover' }, 40, 'requester');
  closed(40);
  const reply = await send({ type: 'ack', attemptId: id, userMessageId: 'receipt' });
  assert.equal(reply.ok, true);
  assert.equal(reply.state.handoff, null);
  assert.equal(reply.state.owner?.tabId, 30);
});

test('connecting migrates oversized legacy history and the management page can export it', async () => {
  const state = emptyQueue('conversation:legacy-background');
  state.removed = Array.from({ length: 25 }, (_, i) => ({ id: `old-${i}`, text: `original ${i}`, status: 'queued', createdAt: i }));
  const { handoff, ...legacy } = state;
  data['cwq:v1:conversation:legacy-background'] = legacy;
  const reply = await call({ channel: 'chatgpt-web-queue-v1', key: state.key, documentId: 'reloaded', action: { type: 'connect' } });
  assert.equal(reply.state.removed.length, 20);
  const exported = await call<{ ok: boolean; data: HistoryExport }>({ channel: HISTORY_CHANNEL, action: { type: 'export' } },
    { id: 'test-extension', url: 'chrome-extension://test-extension/history.html' });
  assert.equal(exported.ok, true);
  assert.equal(exported.data.archive.filter(row => row.key === state.key).length, 5);
});

test('ChatGPT content scripts cannot invoke privileged history export', () => {
  let responded = false;
  const result = listener({ channel: HISTORY_CHANNEL, action: { type: 'export' } }, sender, () => { responded = true; });
  assert.equal(result, undefined); assert.equal(responded, false);
});
