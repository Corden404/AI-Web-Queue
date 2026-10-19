import type { Action, QueueClient, QueueReply, QueueState } from './core/types.ts';
import { pendingConversation, queueKey } from './core/types.ts';
import { queueEnter, shouldQueueInput } from './core/input-policy.ts';
import type { Settings } from './core/settings.ts';
import { comparableText, editorText, inspectPage, replaceEditorText } from './page/adapter.ts';
import type { PageSnapshot } from './page/adapter.ts';
import { QueuePanel } from './ui/panel.ts';

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export class QueueController {
  private key: string | null = null;
  private state: QueueState | null = null;
  private snapshot: PageSnapshot;
  private panel: QueuePanel;
  private completionObserved: { messageId: string; at: number } | null = null;
  private error = '';
  private blocked = '';
  private generation = 0;
  private loading = false;
  private dispatching = false;
  private enqueueing = false;
  private composing = false;
  private writing = false;
  private ownClick = false;
  private inputVersion = 0;
  private scheduled = false;
  private lastError = '';
  private enabled = false;
  private settingsReady = false;
  private nativeSubmission: { key: string | null; signature: string; text: string } | null = null;
  constructor(private document: Document, private client: QueueClient) {
    this.snapshot = inspectPage(document);
    this.panel = new QueuePanel(document, action => this.act(action), () => void this.enqueue());
  }
  start() {
    this.document.addEventListener('keydown', this.onKeyDown, true);
    this.document.addEventListener('click', this.onClick, true);
    this.document.addEventListener('compositionstart', () => { this.composing = true; }, true);
    this.document.addEventListener('compositionend', () => { this.composing = false; }, true);
    this.document.addEventListener('input', event => {
      if (!this.writing && inspectPage(this.document).editor?.contains(event.target as Node)) this.inputVersion++;
      this.schedule();
    }, true);
    this.document.defaultView!.addEventListener('pagehide', () => {
      if (this.key) void this.client.send(this.key, { type: 'leave' }).catch(() => {});
    });
    const observer = new MutationObserver(() => this.schedule());
    observer.observe(this.document.documentElement, { childList: true, characterData: true, subtree: true, attributes: true,
      attributeFilter: ['data-talvt-turn-state', 'data-is-streaming', 'data-streaming', 'disabled', 'aria-label', 'aria-busy', 'class', 'data-theme'] });
    this.client.subscribe(key => { if (key === this.key) void this.refresh(); });
    this.client.subscribeSettings(settings => this.applySettings(settings));
    void this.client.getSettings().then(settings => this.applySettings(settings), error => {
      this.error = this.readError(error); this.render();
    });
    setInterval(() => void this.tick(), 500);
    void this.tick();
  }
  private applySettings(settings: Settings) {
    if (this.enabled !== settings.enabled) this.completionObserved = null;
    this.enabled = settings.enabled;
    this.settingsReady = true;
    this.render(); this.schedule();
  }
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; void this.tick(); });
  }
  private owns(): boolean { return this.state?.owner?.documentId === this.client.documentId; }
  private setReply(reply: QueueReply, key: string) {
    if (this.key !== key) return;
    const changed = !this.state || reply.state.revision > this.state.revision;
    if (!this.state || reply.state.revision >= this.state.revision) this.state = reply.state;
    if (!reply.ok && reply.error) this.error = reply.error;
    this.render();
    if (reply.ok && changed) this.schedule();
  }
  private async refresh() {
    if (!this.key || this.loading) return;
    this.loading = true;
    const key = this.key;
    try { this.setReply(await this.client.send(key, { type: 'connect' }), key); }
    catch (error) { if (key === this.key) { this.error = this.readError(error); this.render(); } }
    finally { this.loading = false; }
  }
  private async act(action: Action) {
    if (!this.key) return;
    const key = this.key;
    this.error = '';
    try {
      const reply = await this.client.send(key, action);
      this.setReply(reply, key);
      if (!reply.ok) return;
    } catch (error) { this.error = this.readError(error); this.render(); return; }
    this.schedule();
  }
  private readError(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return /extension context invalidated|receiving end does not exist/i.test(text)
      ? '扩展已更新，请刷新 ChatGPT 页面' : text;
  }
  private render() {
    const editor = this.snapshot.editor;
    const dark = this.document.documentElement.classList.contains('dark') ||
      this.document.documentElement.dataset.theme === 'dark' || !!this.snapshot.form?.querySelector('[data-composer-dark]');
    this.panel.render({ state: this.state, owned: this.owns(), busy: this.snapshot.busy,
      enabled: this.enabled, settingsReady: this.settingsReady,
      waitingForConversation: this.enqueueing && !queueKey(this.document.location.href),
      hasText: !!this.key && !!editor && !!editorText(editor).trim(), blocked: this.blocked, error: this.error, dark });
  }
  private async tick() {
    const key = queueKey(this.document.location.href);
    if (key !== this.key) {
      const old = this.key;
      this.key = key; this.generation++; this.state = null; this.error = ''; this.blocked = '';
      this.completionObserved = null; this.panel.reset();
      if (old) void this.client.send(old, { type: 'leave' }).catch(() => {});
      if (key) void this.refresh();
    }
    this.snapshot = inspectPage(this.document);
    if (!this.snapshot.form) { this.panel.unmount(); return; }
    this.panel.mount(this.snapshot.form);
    const state = this.state;
    const page = this.snapshot;
    this.blocked = page.attachments ? '请先移除输入框中的附件' :
      page.unsupportedMode ? '请切换为普通聊天或 Thinking' :
      page.editor && editorText(page.editor).trim() && !this.dispatching ? '等待输入框空闲，草稿已保留' :
      !page.complete && !page.busy ? '等待本轮回答完成' : '';
    if (!this.settingsReady || !this.enabled) { this.completionObserved = null; this.render(); return; }
    if (!state) { if (this.key && !this.loading) void this.refresh(); this.render(); return; }
    if (page.error && (state.items.length || state.awaitingReply) && !state.paused && this.lastError !== page.error) {
      this.lastError = page.error; void this.act({ type: 'stop', reason: page.error.slice(0, 240) });
    }
    if (!page.error) this.lastError = '';
    this.render();
    // The native submit can precede both its new user turn and its Stop button.
    if (this.nativeReplyPending(page) || !page.complete) { this.completionObserved = null; return; }
    const responseId = page.messages.at(-1)!.id;
    if (this.completionObserved?.messageId !== responseId)
      this.completionObserved = { messageId: responseId, at: this.document.defaultView!.performance.now() };
    if (this.dispatching || this.enqueueing || !this.owns() || state.paused || state.editing || !page.editor) return;
    if (state.awaitingReply) {
      const index = page.messages.findIndex(message => message.role === 'user' && message.id === state.awaitingReply!.userMessageId);
      if (index < 0) { void this.act({ type: 'stop', reason: '无法核对上一条消息，请检查会话后继续' }); return; }
      if (!page.messages.slice(index + 1).some(message => message.role === 'assistant')) return;
      this.dispatching = true;
      try { await this.act({ type: 'replyComplete', attemptId: state.awaitingReply.attemptId }); }
      finally {
        this.dispatching = false;
        if (!this.state?.awaitingReply) this.schedule();
      }
      return;
    }
    if (!state.items.length || state.attempt || this.composing || this.blocked || editorText(page.editor).trim()) return;
    void this.dispatch();
  }
  private shouldQueue(page: PageSnapshot): boolean {
    const starting = this.nativeReplyPending(page);
    const routed = queueKey(this.document.location.href);
    const sameConversation = !!routed && routed === this.key;
    const ready = !!routed || (pendingConversation(this.document.location.href) && (starting || page.replyStatus === 'incomplete'));
    return shouldQueueInput({ enabled: this.settingsReady && this.enabled, conversationReady: ready,
      replyStatus: starting ? 'incomplete' : page.replyStatus, pending: sameConversation && !!this.state?.items.length,
      awaitingReply: sameConversation && !!this.state?.awaitingReply, dispatching: sameConversation && this.dispatching });
  }
  private nativeReplyPending(page: PageSnapshot): boolean {
    const submission = this.nativeSubmission;
    if (!submission) return false;
    const routed = queueKey(this.document.location.href);
    if (submission.key && submission.key !== routed) return false;
    if (!submission.key && routed && !page.messages.some(m => m.role === 'user' && comparableText(m.text) === comparableText(submission.text))) return false;
    return submission.signature === page.signature;
  }
  private noteNativeSubmission(page: PageSnapshot) {
    if (!this.settingsReady || !this.enabled || !page.editor || !page.send || page.attachments || page.unsupportedMode) return;
    const text = editorText(page.editor);
    if (text.trim()) this.nativeSubmission = { key: queueKey(this.document.location.href), signature: page.signature, text };
  }
  private onKeyDown = (event: KeyboardEvent) => {
    if (!queueEnter(event, this.composing)) return;
    const page = inspectPage(this.document);
    if (!page.editor?.contains(event.target as Node)) return;
    if (!this.shouldQueue(page)) { this.noteNativeSubmission(page); return; }
    event.preventDefault(); event.stopImmediatePropagation(); void this.enqueue();
  };
  private onClick = (event: MouseEvent) => {
    if (this.ownClick || !this.settingsReady || !this.enabled) return;
    const page = inspectPage(this.document);
    const target = (event.target as Element)?.closest?.('button');
    if (target && target === page.stop && this.key) {
      this.completionObserved = null; void this.act({ type: 'stop', reason: '你停止了当前回答，队列已暂停' }); return;
    }
    if (target && target === page.send && this.shouldQueue(page)) {
      event.preventDefault(); event.stopImmediatePropagation(); void this.enqueue();
    } else if (target && target === page.send) this.noteNativeSubmission(page);
  };
  private async enqueue() {
    if (this.enqueueing || !this.settingsReady || !this.enabled) return;
    const page = inspectPage(this.document);
    const editor = page.editor;
    if (!editor || this.composing) return;
    if (page.attachments || page.unsupportedMode) {
      this.error = page.attachments ? '纯文本队列暂不接收附件，请先移除附件' : '纯文本队列目前支持普通聊天和 Thinking';
      this.render(); return;
    }
    const text = editorText(editor);
    if (!text.trim()) return;
    const inputVersion = this.inputVersion;
    const submission = this.nativeSubmission;
    this.enqueueing = true; this.error = '';
    this.render();
    let key = queueKey(this.document.location.href);
    try {
      if (!key && pendingConversation(this.document.location.href)) {
        const deadline = Date.now() + 15_000;
        while (!key && this.enabled && Date.now() < deadline && pendingConversation(this.document.location.href)) {
          await wait(50); key = queueKey(this.document.location.href);
        }
        if (!key) throw new Error('会话尚未创建，消息未入队，请保留输入框内容后重试');
        const now = inspectPage(this.document);
        if (submission && !submission.key && !now.messages.some(m => m.role === 'user' && comparableText(m.text) === comparableText(submission.text)))
          throw new Error('会话已切换，消息未入队，输入框内容已保留');
      }
      if (!this.enabled || !key) return;
      if (key !== this.key) await this.tick();
      if (this.key !== key || queueKey(this.document.location.href) !== key) return;
      const generation = this.generation;
      const reply = await this.client.send(key, { type: 'enqueue', text });
      this.setReply(reply, key);
      const currentEditor = inspectPage(this.document).editor;
      if (reply.ok && generation === this.generation && this.key === key && currentEditor &&
          (currentEditor === editor || this.inputVersion === inputVersion) && editorText(currentEditor) === text) {
        this.writing = true;
        try { replaceEditorText(currentEditor, ''); }
        finally { this.writing = false; }
      } else if (reply.ok && this.key === key) this.error = '消息已入队；输入框中的新草稿已保留';
    } catch (error) { if (!key || this.key === key) this.error = this.readError(error); }
    finally { this.enqueueing = false; this.snapshot = inspectPage(this.document); this.render(); this.schedule(); }
  }
  private async dispatch() {
    if (!this.key || this.dispatching || !this.settingsReady || !this.enabled) return;
    this.dispatching = true;
    const key = this.key;
    const generation = this.generation;
    let attemptId: string | null = null;
    let clicked = false;
    let editor: HTMLElement | null = null;
    let injectedText = '';
    let injectedVersion = this.inputVersion;
    const stillHere = () => this.key === key && this.generation === generation && queueKey(this.document.location.href) === key;
    try {
      const claim = await this.client.send(key, { type: 'claim' });
      this.setReply(claim, key);
      if (!claim.ok || !claim.attempt) return;
      attemptId = claim.attempt.id;
      const item = claim.state.items.find(item => item.id === claim.attempt!.itemId)!;
      const page = inspectPage(this.document);
      editor = page.editor;
      if (!this.enabled || !stillHere() || !editor || !page.complete || page.busy || page.error || page.attachments || page.unsupportedMode ||
          editorText(editor).trim() || this.composing) throw new Error('发送条件已变化，草稿和队列均已保留');
      const baseline = new Set(page.messages.filter(message => message.role === 'user').map(message => message.id));
      this.writing = true;
      try { replaceEditorText(editor, item.text); }
      finally { this.writing = false; }
      injectedText = item.text; injectedVersion = this.inputVersion;
      const deadline = Date.now() + 4000;
      while (!inspectPage(this.document).send && Date.now() < deadline && stillHere() && this.enabled) await wait(80);
      if (!this.enabled) throw new Error('Queue 已关闭，待发送消息已保留');
      if (!stillHere()) throw new Error('会话已切换，队列已暂停');
      const ready = inspectPage(this.document);
      if (!ready.send || ready.busy || ready.attachments || ready.error || ready.editor !== editor ||
          comparableText(editorText(editor)) !== comparableText(item.text) || this.inputVersion !== injectedVersion)
        throw new Error('输入框或发送按钮发生变化，已暂停队列');
      // Persist the boundary BEFORE clicking: a crash after this point must never auto-retry.
      const submitted = await this.client.send(key, { type: 'submitted', attemptId });
      this.setReply(submitted, key);
      if (!submitted.ok) throw new Error(submitted.error ?? '队列已暂停');
      const final = inspectPage(this.document);
      if (!this.enabled || !stillHere() || final.editor !== editor || !final.send || final.busy || final.error || final.attachments ||
          this.inputVersion !== injectedVersion || comparableText(editorText(editor)) !== comparableText(item.text))
        throw new Error('发送前输入框发生变化，草稿已保留');
      this.ownClick = true;
      try {
        const completion = this.completionObserved;
        if (completion && completion.messageId === final.messages.at(-1)?.id) {
          const timing = this.document.defaultView!.performance;
          // Retain only the latest local timing; no message text or network reporting.
          timing.clearMeasures('cwq:completion-to-send');
          timing.measure('cwq:completion-to-send', { start: completion.at, end: timing.now() });
        }
        clicked = true; final.send.click();
      }
      finally { this.ownClick = false; }
      const receiptDeadline = Date.now() + 12_000;
      while (Date.now() < receiptDeadline) {
        if (!stillHere()) throw new Error('会话已切换，请核对这条消息是否已经发送');
        const now = inspectPage(this.document);
        const receipt = now.messages.find(message => message.role === 'user' && !baseline.has(message.id) &&
          comparableText(message.text) === comparableText(item.text));
        if (receipt) {
          this.setReply(await this.client.send(key, { type: 'ack', attemptId, userMessageId: receipt.id }), key);
          return;
        }
        if (now.error) throw new Error(now.error);
        await wait(100);
      }
      throw new Error('未能确认发送结果，请检查会话中的消息');
    } catch (error) {
      const reason = this.readError(error);
      if (!clicked && editor && editor.isConnected && stillHere() && injectedText &&
          this.inputVersion === injectedVersion && comparableText(editorText(editor)) === comparableText(injectedText)) {
        this.writing = true;
        try { replaceEditorText(editor, ''); } catch {} finally { this.writing = false; }
      }
      if (attemptId) {
        try { this.setReply(await this.client.send(key, { type: clicked ? 'uncertain' : 'abort', attemptId, reason }), key); }
        catch { if (stillHere()) this.error = reason; }
      } else if (stillHere()) this.error = reason;
    } finally {
      this.dispatching = false;
      this.snapshot = inspectPage(this.document); this.render();
      if (!this.error) this.schedule();
    }
  }
}
