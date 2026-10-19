import type { QueueItem, QueueState } from './types.ts';

export const HISTORY_CHANNEL = 'chatgpt-web-queue-history-v1';
export const RECENT_REMOVED_LIMIT = 20;
export const RECENT_REMOVED_BYTES = 512 * 1024;
export const RECENT_SENT_LIMIT = 100;
export const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

export type ArchiveRecord = { archiveId: string; key: string; archivedAt: number; restored?: boolean } & (
  { kind: 'removed'; value: QueueItem } | { kind: 'sent'; value: QueueState['sent'][number] }
);
export interface HistoryRequest {
  channel: typeof HISTORY_CHANNEL;
  action: { type: 'status' } | { type: 'export' } | { type: 'archive' }
    | { type: 'list'; before?: string } | { type: 'restore'; archiveId: string };
}
export interface HistoryStatus { bytes: number; quota: number; archived: number }
export interface HistoryExport { version: 1; queues: Record<string, QueueState>; archive: ArchiveRecord[] }
export interface ArchivePage { items: { archiveId: string; key: string; text: string }[]; next?: string }

/** Keep the hot state small; callers durably archive overflow before replacing it. */
export function partitionHistory(state: QueueState, all = false, now = Date.now()) {
  let start = state.removed.length, bytes = 0;
  if (!all) {
    while (start > 0 && state.removed.length - start < RECENT_REMOVED_LIMIT) {
      const size = byteLength(state.removed[start - 1]);
      if (bytes + size > RECENT_REMOVED_BYTES) break;
      bytes += size; start--;
    }
  }
  const sentStart = all ? state.sent.length : Math.max(0, state.sent.length - RECENT_SENT_LIMIT);
  const archive: ArchiveRecord[] = [
    ...state.removed.slice(0, start).map(value => ({ kind: 'removed' as const, value })),
    ...state.sent.slice(0, sentStart).map(value => ({ kind: 'sent' as const, value })),
  ].map(record => ({ ...record, key: state.key, archivedAt: now,
    archiveId: `${state.key}:${state.revision}:${record.kind}:${record.value.id}` }));
  return { archive, state: archive.length ? { ...state, revision: state.revision + 1,
    removed: state.removed.slice(start), sent: state.sent.slice(sentStart) } : state };
}
