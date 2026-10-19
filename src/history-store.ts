import { emptyQueue } from './core/queue.ts';
import { byteLength, partitionHistory } from './core/history.ts';
import type { ArchivePage, ArchiveRecord, HistoryExport, HistoryStatus } from './core/history.ts';
import type { QueueState } from './core/types.ts';

export const queueStorageKey = (key: string) => `cwq:v1:${key}`;
let database: Promise<IDBDatabase> | undefined;
function openArchive(): Promise<IDBDatabase> {
  if (database) return database;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('cwq-history-v1', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('records', { keyPath: 'archiveId' });
      store.createIndex('item', ['key', 'value.id']);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
  database = opening;
  void opening.catch(() => { if (database === opening) database = undefined; });
  return opening;
}
async function archiveWork<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openArchive();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction('records', mode);
    const request = work(transaction.objectStore('records'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error ?? request.error ?? new Error('本地归档失败'));
    transaction.onerror = () => {}; // The abort event reports the durable outcome.
  });
}
async function storeArchive(records: ArchiveRecord[]) {
  if (!records.length) return;
  await archiveWork('readwrite', store => {
    // Stable IDs make retrying an interrupted local-storage write idempotent.
    for (const record of records) store.put(record);
    return store.count();
  });
}
export const readArchive = () => archiveWork<ArchiveRecord[]>('readonly', store => store.getAll());
export async function listArchive(before?: string): Promise<ArchivePage> {
  const db = await openArchive();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('records', 'readonly');
    const request = transaction.objectStore('records').openCursor(before ? IDBKeyRange.upperBound(before, true) : null, 'prev');
    const items: ArchivePage['items'] = [];
    let next: string | undefined;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const record = cursor.value as ArchiveRecord;
      if (record.kind === 'removed' && !record.restored)
        items.push({ archiveId: record.archiveId, key: record.key, text: record.value.text.slice(0, 200) });
      if (items.length === 50) { next = record.archiveId; return; }
      cursor.continue();
    };
    transaction.oncomplete = () => resolve({ items, next });
    transaction.onabort = () => reject(transaction.error);
  });
}

async function compactAndWrite(state: QueueState, all = false): Promise<QueueState> {
  const partition = partitionHistory(state, all);
  await storeArchive(partition.archive);
  await chrome.storage.local.set({ [queueStorageKey(state.key)]: partition.state });
  return partition.state;
}
export async function archiveHistory(except?: string): Promise<void> {
  const stored = await chrome.storage.local.get(null);
  for (const [name, state] of Object.entries(stored)) {
    const queue = state as QueueState;
    if (name !== except && name.startsWith('cwq:v1:') && (queue.removed.length || queue.sent.length)) await compactAndWrite(queue, true);
  }
}
export async function persistQueue(state: QueueState, previous?: QueueState): Promise<QueueState> {
  const name = queueStorageKey(state.key);
  const quota = chrome.storage.local.QUOTA_BYTES;
  let hot = partitionHistory(state).state;
  let projected = await chrome.storage.local.getBytesInUse(null) - await chrome.storage.local.getBytesInUse(name)
    + byteLength(hot) + byteLength(name);
  if (projected > quota * .8) {
    // Move old text to recoverable storage across conversations before hitting the quota.
    await archiveHistory(name);
    hot = partitionHistory(state, true).state;
    projected = await chrome.storage.local.getBytesInUse(null) - await chrome.storage.local.getBytesInUse(name)
      + byteLength(hot) + byteLength(name);
    if (projected > quota * .9 && byteLength(state.items) > byteLength(previous?.items ?? []))
      throw new Error('本地队列空间不足，请在扩展的“管理本地记录”中导出数据并归档后重试');
    return compactAndWrite(state, true);
  }
  return compactAndWrite(state);
}
export async function historyStatus(): Promise<HistoryStatus> {
  return { bytes: await chrome.storage.local.getBytesInUse(null), quota: chrome.storage.local.QUOTA_BYTES,
    archived: await archiveWork('readonly', store => store.count()) };
}
export async function exportHistory(): Promise<HistoryExport> {
  const stored = await chrome.storage.local.get(null);
  const queues = Object.fromEntries(Object.entries(stored).filter(([key]) => key.startsWith('cwq:v1:'))) as Record<string, QueueState>;
  return { version: 1, queues, archive: await readArchive() };
}
export async function restoreArchive(archiveId: string): Promise<void> {
  const record = await archiveWork<ArchiveRecord | undefined>('readonly', store => store.get(archiveId));
  if (!record || record.kind !== 'removed') throw new Error('找不到可恢复的归档消息');
  if (record.restored) return;
  const name = queueStorageKey(record.key);
  const stored = await chrome.storage.local.get(name);
  const previous = (stored[name] as QueueState | undefined) ?? emptyQueue(record.key);
  const state = structuredClone(previous);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(record.archiveId));
  const restoredId = `restored-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  const known = [...state.items, ...state.removed, ...state.sent].some(item => item.id === restoredId)
    || await archiveWork('readonly', store => store.index('item').count([record.key, restoredId])) > 0;
  if (!known) {
    // A historical version must not replace a newer edit with the same original ID.
    state.items.push({ ...record.value, id: restoredId, status: 'queued' });
    state.paused = true; state.reason = '已恢复归档消息，请返回会话核对后继续'; state.revision++;
    await persistQueue(state, previous);
  }
  // Retain the archive even after restoring, including its original text.
  await storeArchive([{ ...record, restored: true }]);
}
