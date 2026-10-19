import type { Settings } from './settings.ts';

export type ItemStatus = 'queued' | 'sending' | 'uncertain';
export interface QueueItem {
  id: string;
  text: string;
  createdAt: number;
  status: ItemStatus;
}
export interface Owner { tabId: number; documentId: string }
export interface Attempt {
  id: string;
  itemId: string;
  phase: 'prepared' | 'submitted';
  startedAt: number;
}
export interface QueueState {
  version: 1;
  revision: number;
  key: string;
  items: QueueItem[];
  removed: QueueItem[];
  sent: { id: string; userMessageId: string; sentAt: number }[];
  paused: boolean;
  reason: string;
  owner: Owner | null;
  handoff: Owner | null;
  attempt: Attempt | null;
  awaitingReply: { attemptId: string; userMessageId: string } | null;
  editing: { itemId: string; owner: Owner } | null;
}
export interface Actor extends Owner { now: number }
export type Action =
  | { type: 'connect' }
  | { type: 'enqueue'; text: string }
  | { type: 'pause'; paused: boolean }
  | { type: 'remove'; id: string }
  | { type: 'restore'; id: string }
  | { type: 'move'; id: string; beforeId: string | null }
  | { type: 'editStart'; id: string }
  | { type: 'editSave'; id: string; text: string }
  | { type: 'editCancel' }
  | { type: 'claim' }
  | { type: 'submitted'; attemptId: string }
  | { type: 'ack'; attemptId: string; userMessageId: string }
  | { type: 'abort'; attemptId: string; reason: string }
  | { type: 'uncertain'; attemptId: string; reason: string }
  | { type: 'resolve'; id: string; delivered: boolean }
  | { type: 'replyComplete'; attemptId: string }
  | { type: 'stop'; reason: string }
  | { type: 'leave' }
  | { type: 'takeover' };
export interface QueueReply { ok: boolean; state: QueueState; error?: string; attempt?: Attempt }
export interface Request {
  channel: 'chatgpt-web-queue-v1';
  key: string;
  documentId: string;
  action: Action;
}
export interface QueueClient {
  documentId: string;
  send(key: string, action: Action): Promise<QueueReply>;
  subscribe(listener: (key: string) => void): () => void;
  getSettings(): Promise<Settings>;
  setEnabled(enabled: boolean): Promise<Settings>;
  subscribeSettings(listener: (settings: Settings) => void): () => void;
}
export function queueKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://chatgpt.com' && parsed.hostname !== '127.0.0.1') return null;
    const id = parsed.pathname.match(/\/c\/([a-zA-Z0-9_-]+)(?:\/|$)/)?.[1];
    return id ? `conversation:${id}` : null;
  } catch { return null; }
}

/** ChatGPT briefly uses the home URL or a local ID while creating a conversation. */
export function pendingConversation(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://chatgpt.com' && parsed.hostname !== '127.0.0.1') return false;
    const path = decodeURIComponent(parsed.pathname);
    return path === '/' || /^\/c\/local-chatgpt:[a-zA-Z0-9-]+\/?$/.test(path);
  } catch { return false; }
}
