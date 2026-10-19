import type { ReplyStatus } from '../core/input-policy.ts';

export interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string; element: HTMLElement }
export interface PageSnapshot {
  editor: HTMLElement | null;
  form: HTMLElement | null;
  send: HTMLButtonElement | null;
  stop: HTMLButtonElement | null;
  busy: boolean;
  complete: boolean;
  replyStatus: ReplyStatus;
  error: string;
  attachments: boolean;
  unsupportedMode: boolean;
  messages: ChatMessage[];
  signature: string;
}
const EDITOR = '[data-chatgpt-composer] [contenteditable="true"][role="textbox"], #prompt-textarea[contenteditable="true"], .ProseMirror[contenteditable="true"], textarea#prompt-textarea';
const STOP = /^(stop(?: streaming| generating| response)?|停止(?:生成|回答|响应)?|停止輸出|停止回應)$/i;
const SEND = /^(send(?: message| prompt)?|发送(?:消息)?|傳送(?:訊息)?)$/i;
const ERROR = /something went wrong|network error|error in (?:message|the message) stream|unable to (?:load|send)|failed to (?:send|fetch)|too many requests|usage limit|rate limit|you.ve reached|you have reached|log in|sign in|出现错误|出了点问题|发生错误|网络错误|网络连接|达到.{0,12}(?:限制|上限)|達到.{0,12}(?:限制|上限)|登入|登录/i;

export function visible(element: Element | null): element is HTMLElement {
  if (!element || element.closest('[hidden], [aria-hidden="true"]')) return false;
  const style = element.ownerDocument.defaultView!.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}
export function editorText(editor: HTMLElement): string {
  if (editor.tagName === 'TEXTAREA') return (editor as HTMLTextAreaElement).value;
  // Chromium innerText adds an extra newline for <div><br></div>. Serialize the
  // editing blocks instead, retaining empty paragraphs and literal text breaks.
  const block = /^(DIV|P|PRE|LI|BLOCKQUOTE)$/;
  const serialize = (element: Element): string => {
    const parts: string[] = [];
    let inline = '';
    for (const child of element.childNodes) {
      if (child.nodeType === 3) { inline += child.textContent ?? ''; continue; }
      if (child.nodeType !== 1) continue;
      const node = child as Element;
      if (node.tagName === 'BR') {
        if (!node.classList.contains('ProseMirror-trailingBreak') && element.childNodes.length !== 1) inline += '\n';
      } else if (block.test(node.tagName)) {
        if (inline) { parts.push(inline); inline = ''; }
        parts.push(serialize(node));
      } else inline += serialize(node);
    }
    if (inline || !parts.length) parts.push(inline);
    return parts.join('\n');
  };
  return serialize(editor).replace(/\r\n?/g, '\n');
}
export const comparableText = (text: string) => text.replace(/\r\n?/g, '\n').trim();

export function messagesFrom(document: Document): ChatMessage[] {
  const selector = '[data-message-author-role], [data-chatgpt-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":assistant"]';
  const found = new Map<string, ChatMessage>();
  for (const node of document.querySelectorAll<HTMLElement>(selector)) {
    const unitKey = node.getAttribute('data-chatgpt-search-unit-key') ?? '';
    const role = node.getAttribute('data-message-author-role') ?? (unitKey.endsWith(':user') ? 'user' : 'assistant');
    if (role !== 'user' && role !== 'assistant') continue;
    const id = node.getAttribute('data-message-id') ?? node.getAttribute('data-chatgpt-search-message-ids')?.split(' ')[0]
      ?? node.querySelector('[data-chatgpt-selection-message-id]')?.getAttribute('data-chatgpt-selection-message-id')
      ?? node.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid') ?? unitKey;
    if (!id) continue;
    const body = role === 'user' ? node.querySelector<HTMLElement>('[data-user-message-bubble]') ?? node : node;
    found.set(`${role}:${id}`, { id, role, text: editorText(body), element: node });
  }
  return [...found.values()];
}
function enabled(button: HTMLButtonElement): boolean {
  return !button.disabled && button.getAttribute('aria-disabled') !== 'true' && visible(button);
}
function label(button: Element): string { return button.getAttribute('aria-label')?.trim() ?? button.textContent?.trim() ?? ''; }

export function inspectPage(document: Document): PageSnapshot {
  const editor = Array.from(document.querySelectorAll<HTMLElement>(EDITOR)).find(visible) ?? null;
  const form = editor?.closest<HTMLElement>('form, [data-chatgpt-composer]') ?? null;
  const buttons = form ? Array.from(form.querySelectorAll<HTMLButtonElement>('button')).filter(visible) : [];
  const stop = buttons.find(b => b.dataset.testid === 'stop-button' || STOP.test(label(b)))
    ?? Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-testid="stop-button"]')).find(visible) ?? null;
  const send = buttons.find(b => enabled(b) && b !== stop &&
    (b.dataset.testid === 'send-button' || SEND.test(label(b)) ||
      (b.id === 'composer-submit-button' && !STOP.test(label(b))))) ?? null;
  const messages = messagesFrom(document);
  const latest = messages.at(-1);
  const latestTurn = latest?.element.closest<HTMLElement>('[data-talvt-turn-state], article, [data-testid^="conversation-turn-"]');
  const turnState = latestTurn?.getAttribute('data-talvt-turn-state')?.toLowerCase() ?? '';
  const streaming = !!latestTurn?.querySelector('[data-is-streaming="true"], [data-streaming="true"], [aria-busy="true"]');
  const busyState = !!turnState && !['complete', 'completed', 'error', 'failed', 'stopped', 'cancelled', 'canceled', 'incomplete'].includes(turnState);
  const busy = !!stop || streaming || busyState;
  const alerts = Array.from(document.querySelectorAll<HTMLElement>('[role="alert"], [data-testid="conversation-error"], [data-error-message]')).filter(visible);
  const currentError = alerts.map(a => a.textContent?.trim() ?? '').find(text => ERROR.test(text));
  const error = currentError ?? (['error', 'failed'].includes(turnState) ? '当前回答遇到错误' : '');
  const liveComplete = Array.from(document.querySelectorAll<HTMLElement>('[role="status"][aria-live="polite"]'))
    .some(e => /^(response complete|回答完成|回复完成|回覆完成|已完成回覆)[。.!]?$/i.test(e.textContent?.trim() ?? ''));
  const explicitComplete = ['complete', 'completed'].includes(turnState);
  // A legacy live-region hint is accepted only when no active turn state contradicts it.
  const complete = !busy && !error && latest?.role === 'assistant' &&
    (explicitComplete || (!turnState && liveComplete));
  const replyStatus: ReplyStatus = complete ? 'complete' : busy || latest ? 'incomplete' : 'idle';
  const attachments = !!form && Array.from(form.querySelectorAll<HTMLElement>(
    '[data-composer-attachments], [data-testid="attachment-preview"], [data-testid="file-thumbnail"]'))
    .some(e => visible(e) && e.children.length > 0);
  const unsupportedMode = !!form && /deep research|深度研究|agent mode|代理模式/i.test(form.innerText ?? form.textContent ?? '');
  const signature = `${latest?.id ?? 'empty'}:${latest?.text.length ?? 0}:${turnState}:${busy}:${complete}`;
  return { editor, form, send, stop, busy, complete, replyStatus, error, attachments, unsupportedMode, messages, signature };
}

export function replaceEditorText(editor: HTMLElement, text: string): void {
  if (!editor.isConnected || !visible(editor)) throw new Error('输入框已变化，请刷新后重试');
  editor.focus({ preventScroll: true });
  if (editor.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(editor.ownerDocument.defaultView!.HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(editor, text);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    const selection = editor.ownerDocument.getSelection();
    const range = editor.ownerDocument.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const success = editor.ownerDocument.execCommand(text ? 'insertText' : 'delete', false, text || undefined);
    if (!success && comparableText(editorText(editor)) !== comparableText(text))
      throw new Error('无法更新输入框，原消息仍保留在队列中');
  }
  if (comparableText(editorText(editor)) !== comparableText(text)) throw new Error('输入框内容未同步，已暂停队列');
}
