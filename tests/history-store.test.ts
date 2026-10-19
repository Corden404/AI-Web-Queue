import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { emptyQueue, transition } from '../src/core/queue.ts';
import { byteLength, RECENT_REMOVED_BYTES, RECENT_REMOVED_LIMIT, RECENT_SENT_LIMIT } from '../src/core/history.ts';
import { archiveHistory, exportHistory, historyStatus, listArchive, persistQueue, queueStorageKey, readArchive, restoreArchive } from '../src/history-store.ts';
import type { QueueState } from '../src/core/types.ts';

let data: Record<string, unknown> = {};
let failWrite = false;
let quota = 10 * 1024 * 1024;
const actor = { tabId: 1, documentId: 'owner', now: 1 };
const selected = (keys: string | string[] | null) => (keys === null ? Object.keys(data) : typeof keys === 'string' ? [keys] : keys).filter(key => key in data);
const bytes = (values: Record<string, unknown>) => Object.entries(values).reduce((size, [key, value]) => size + byteLength(key) + byteLength(value), 0);
Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { storage: { local: {
  get QUOTA_BYTES() { return quota; },
  async get(keys: string | string[] | null) { return structuredClone(Object.fromEntries(selected(keys).map(key => [key, data[key]]))); },
  async getBytesInUse(keys: string | string[] | null) { return bytes(Object.fromEntries(selected(keys).map(key => [key, data[key]]))); },
  async set(values: Record<string, unknown>) {
    if (failWrite) throw new Error('simulated local write failure');
    const next = { ...data, ...structuredClone(values) };
    if (bytes(next) > quota) throw new Error('QUOTA_BYTES quota exceeded');
    data = next;
  },
} } } });
beforeEach(() => { data = {}; failWrite = false; quota = 10 * 1024 * 1024; });
const removed = (count: number, length = 10) => Array.from({ length: count }, (_, i) => ({
  id: `item-${i}`, text: String(i).padEnd(length, 'x'), createdAt: i, status: 'queued' as const,
}));

test('110 maximum-length removals remain bounded and every original message is recoverable', async () => {
  let state = emptyQueue('conversation:long-history');
  for (let i = 0; i < 110; i++) {
    state = transition(state, { type: 'enqueue', text: `${i}:`.padEnd(100_000, 'x') }, actor, () => `item-${i}`).state;
    state = transition(state, { type: 'remove', id: `item-${i}` }, actor).state;
    state = await persistQueue(state);
  }
  assert.equal(state.items.length, 0);
  assert.ok(state.removed.length <= RECENT_REMOVED_LIMIT);
  assert.ok(byteLength(state.removed) < RECENT_REMOVED_BYTES + 100);
  assert.ok(bytes(data) < 600_000);
  const archived = (await readArchive()).filter(row => row.key === state.key && row.kind === 'removed');
  assert.equal(new Set([...state.removed.map(item => item.id), ...archived.map(row => row.value.id)]).size, 110);
  assert.equal(state.removed.length + archived.length, 110);
  const oldest = archived.find(row => row.value.id === 'item-0')!;
  await restoreArchive(oldest.archiveId);
  await restoreArchive(oldest.archiveId);
  const restored = data[queueStorageKey(state.key)] as QueueState;
  assert.equal(restored.items.length, 1);
  assert.equal(restored.items[0]!.text, '0:'.padEnd(100_000, 'x'));
  assert.equal(restored.paused, true);
});

test('legacy overflow is archived without altering pending attempts, editing, or receipts', async () => {
  const state = emptyQueue('conversation:legacy');
  state.items = removed(1);
  state.items[0]!.status = 'sending';
  state.attempt = { id: 'active', itemId: state.items[0]!.id, phase: 'submitted', startedAt: 1 };
  state.owner = { tabId: 1, documentId: 'owner' };
  state.removed = removed(40);
  state.sent = Array.from({ length: 250 }, (_, i) => ({ id: `sent-${i}`, userMessageId: `u-${i}`, sentAt: i }));
  const hot = await persistQueue(state);
  assert.equal(hot.removed.length, RECENT_REMOVED_LIMIT);
  assert.equal(hot.sent.length, RECENT_SENT_LIMIT);
  assert.deepEqual(hot.attempt, state.attempt);
  assert.deepEqual(hot.items, state.items);
  assert.deepEqual(hot.owner, state.owner);
  const archive = (await readArchive()).filter(row => row.key === state.key);
  assert.equal(archive.length, 20 + 150);
});

test('failed archive writes leave the original local history untouched', async () => {
  const state = emptyQueue('conversation:archive-failure'); state.removed = removed(21);
  data[queueStorageKey(state.key)] = structuredClone(state);
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function () { throw new Error('simulated archive failure'); };
  try { await assert.rejects(persistQueue(state), /simulated archive failure/); }
  finally { IDBObjectStore.prototype.put = original; }
  assert.deepEqual(data[queueStorageKey(state.key)], state);
  const saved = await persistQueue(state);
  assert.equal(saved.removed.length, 20);
});

test('failed local writes keep all text and retries do not duplicate archived records', async () => {
  const state = emptyQueue('conversation:local-failure'); state.removed = removed(21);
  data[queueStorageKey(state.key)] = structuredClone(state);
  failWrite = true;
  await assert.rejects(persistQueue(state), /simulated local write failure/);
  assert.deepEqual(data[queueStorageKey(state.key)], state);
  failWrite = false; await persistQueue(state);
  const archive = (await readArchive()).filter(row => row.key === state.key);
  assert.equal(archive.length, 1);
});

test('manual cleanup and export preserve histories, and archive pagination skips restored messages', async () => {
  const state = emptyQueue('conversation:manual'); state.removed = removed(65);
  data[queueStorageKey(state.key)] = structuredClone(state); data['other-extension-data'] = 'exclude this';
  await archiveHistory();
  assert.equal((data[queueStorageKey(state.key)] as QueueState).removed.length, 0);
  const exported = await exportHistory();
  assert.equal(exported.queues['other-extension-data'], undefined);
  assert.equal(exported.archive.filter(row => row.key === state.key).length, 65);
  const all: string[] = [];
  let before: string | undefined;
  do {
    const page = await listArchive(before);
    all.push(...page.items.filter(item => item.key === state.key).map(item => item.archiveId));
    before = page.next;
  } while (before);
  assert.equal(all.length, 65); assert.equal(new Set(all).size, 65);
  await restoreArchive(all[0]!);
  const active = await listArchive();
  assert.ok(!active.items.some(item => item.archiveId === all[0]));
  assert.ok((await historyStatus()).archived >= 65);
});

test('near-quota writes archive other conversations before accepting new text', async () => {
  quota = 100_000;
  const old = emptyQueue('conversation:old'); old.removed = removed(1, 80_000);
  data[queueStorageKey(old.key)] = old;
  const next = emptyQueue('conversation:next'); next.items = removed(1, 5000);
  await persistQueue(next, emptyQueue(next.key));
  assert.equal((data[queueStorageKey(old.key)] as QueueState).removed.length, 0);
  assert.equal((data[queueStorageKey(next.key)] as QueueState).items[0]!.text.length, 5000);
  assert.ok((await readArchive()).some(row => row.key === old.key && row.value.id === 'item-0'));
});

test('capacity rejection preserves active messages and reserves space for reconciliation', async () => {
  quota = 10_000;
  const previous = emptyQueue('conversation:full'); previous.items = removed(1, 6000);
  data[queueStorageKey(previous.key)] = structuredClone(previous);
  const next = transition(previous, { type: 'enqueue', text: 'new draft'.repeat(500) }, actor).state;
  await assert.rejects(persistQueue(next, previous), /本地队列空间不足/);
  assert.deepEqual(data[queueStorageKey(previous.key)], previous);
  assert.equal((await readArchive()).filter(row => row.key === previous.key).length, 0);
});

test('opening the archive can be retried after an initial IndexedDB failure', async () => {
  const fresh = await import('../src/history-store.ts?open-failure');
  const state = emptyQueue('conversation:open-failure'); state.removed = removed(21);
  data[queueStorageKey(state.key)] = structuredClone(state);
  const original = indexedDB.open;
  indexedDB.open = function () { throw new Error('simulated open failure'); };
  try { await assert.rejects(fresh.persistQueue(state), /simulated open failure/); }
  finally { indexedDB.open = original; }
  assert.deepEqual(data[queueStorageKey(state.key)], state);
  assert.equal((await fresh.persistQueue(state)).removed.length, 20);
});

test('restoring an older version preserves a newer removed edit with the same original ID', async () => {
  const state = emptyQueue('conversation:versions'); state.removed = removed(1);
  state.removed[0]!.text = 'original version';
  data[queueStorageKey(state.key)] = structuredClone(state); await archiveHistory();
  const record = (await readArchive()).find(row => row.key === state.key)!;
  const newer = emptyQueue(state.key); newer.revision = 100; newer.removed = removed(1);
  newer.removed[0]!.text = 'newer edited version';
  data[queueStorageKey(state.key)] = newer;
  await restoreArchive(record.archiveId);
  const restored = data[queueStorageKey(state.key)] as QueueState;
  assert.equal(restored.items[0]!.text, 'original version');
  assert.notEqual(restored.items[0]!.id, 'item-0');
  assert.equal(restored.removed[0]!.text, 'newer edited version');
});

test('retrying after the archive restore marker fails does not enqueue a second copy', async () => {
  const state = emptyQueue('conversation:restore-retry'); state.removed = removed(1);
  data[queueStorageKey(state.key)] = state; await archiveHistory();
  const record = (await readArchive()).find(row => row.key === state.key)!;
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, key) {
    if (value.restored) throw new Error('simulated restore marker failure');
    return original.call(this, value, key);
  };
  try { await assert.rejects(restoreArchive(record.archiveId), /restore marker failure/); }
  finally { IDBObjectStore.prototype.put = original; }
  await restoreArchive(record.archiveId);
  assert.equal((data[queueStorageKey(state.key)] as QueueState).items.length, 1);
  assert.equal((data[queueStorageKey(state.key)] as QueueState).paused, true);
});

test('a restore marker retry remains idempotent after the restored message was sent and archived', async () => {
  const state = emptyQueue('conversation:restore-sent'); state.removed = removed(1);
  data[queueStorageKey(state.key)] = state; await archiveHistory();
  const record = (await readArchive()).find(row => row.key === state.key)!;
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, key) {
    if (value.restored) throw new Error('restore marker failure');
    return original.call(this, value, key);
  };
  try { await assert.rejects(restoreArchive(record.archiveId), /restore marker failure/); }
  finally { IDBObjectStore.prototype.put = original; }
  let current = data[queueStorageKey(state.key)] as QueueState;
  current = transition(current, { type: 'connect' }, actor).state;
  current = transition(current, { type: 'pause', paused: false }, actor).state;
  const claim = transition(current, { type: 'claim' }, actor); const id = claim.attempt!.id;
  current = transition(claim.state, { type: 'submitted', attemptId: id }, actor).state;
  current = transition(current, { type: 'ack', attemptId: id, userMessageId: 'sent-restored' }, actor).state;
  await persistQueue(current); await archiveHistory();
  await restoreArchive(record.archiveId);
  const final = data[queueStorageKey(state.key)] as QueueState;
  assert.equal(final.items.length, 0);
  assert.equal(final.awaitingReply?.userMessageId, 'sent-restored');
});
