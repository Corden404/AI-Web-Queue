import type { NamingMode, NamingSettings } from './settings.ts';

export interface ConversationText { id: string; role: 'user' | 'assistant'; text: string }
export interface ConversationData {
  id: string;
  title: string;
  createdAt: number;
  project: { id: string; name: string } | null;
  messages: ConversationText[];
  completeHistory: boolean;
  currentNode: string;
  lastMessageId?: string;
}
export interface NamingResult { activity: string; topic: string; tags: string[] }
export interface NamingState {
  locked: boolean;
  mode: NamingMode | 'inherit';
  instructions: string;
  tags: string[];
  lastTitle: string;
  fingerprint: string;
  failedFingerprint: string;
  history: { before: string; after: string; at: number }[];
  lastError: string;
  result: NamingResult | null;
}
export const emptyNamingState = (): NamingState => ({ locked: false, mode: 'inherit', instructions: '', tags: [],
  lastTitle: '', fingerprint: '', failedFingerprint: '', history: [], lastError: '', result: null });
export type NamingAction =
  | { type: 'getSettings' }
  | { type: 'saveSettings'; settings: NamingSettings }
  | { type: 'preview'; settings: NamingSettings; conversation: ConversationData }
  | { type: 'getState'; id: string }
  | { type: 'reportError'; id: string; error: string }
  | { type: 'setState'; id: string; patch: Partial<Pick<NamingState, 'locked' | 'mode' | 'instructions' | 'tags'>> }
  | { type: 'generate'; conversation: ConversationData; force: boolean }
  | { type: 'authorize'; id: string; token: string }
  | { type: 'commit'; id: string; token: string; before: string; after: string }
  | { type: 'release'; id: string; token: string; error?: string; locked?: boolean; retryable?: boolean }
  | { type: 'claimUndo'; id: string }
  | { type: 'commitUndo'; id: string; token: string; before: string; after: string };
export interface NamingReply {
  ok: boolean;
  error?: string;
  skipped?: boolean;
  settings?: NamingSettings;
  state?: NamingState;
  token?: string;
  title?: string;
  before?: string;
  result?: NamingResult;
  busy?: boolean;
}
export const conversationId = (url: string): string | null => {
  try { return new URL(url).pathname.match(/\/c\/([a-zA-Z0-9_-]+)(?:\/|$)/)?.[1] ?? null; }
  catch { return null; }
};
