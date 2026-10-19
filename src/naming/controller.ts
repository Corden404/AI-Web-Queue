import { editorText, inspectPage } from '../page/adapter.ts';
import { currentTitle, saveTitle, TitleChangedError } from '../page/title.ts';
import { SETTINGS_KEY, parseSettings } from '../core/settings.ts';
import type { QueueState } from '../core/types.ts';
import { NAMING_SETTINGS_KEY, STATE_PREFIX, defaultNamingSettings } from './settings.ts';
import type { NamingSettings } from './settings.ts';
import { namingRequest, readConversation } from './client.ts';
import { conversationId, emptyNamingState } from './types.ts';
import type { NamingState } from './types.ts';
import { resolveRule } from './rules.ts';

class ContextChangedError extends Error {}

export class NamingController {
  private settings: NamingSettings = defaultNamingSettings();
  private state: NamingState = emptyNamingState();
  private id: string | null = null;
  private running = false;
  private observed = '';
  private observedAt = 0;
  private attempted = '';
  private titleChangedAt = 0;
  private titleCandidate = '';
  private seenTitle = '';
  private lastAppliedAt = 0;
  private ready = false;
  constructor(private document: Document) {}
  start() {
    void this.loadSettings();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[NAMING_SETTINGS_KEY]) void this.loadSettings();
      if (this.id && changes[`${STATE_PREFIX}${this.id}`]) this.state = { ...emptyNamingState(), ...(changes[`${STATE_PREFIX}${this.id}`].newValue as Partial<NamingState>) };
    });
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (sender.id !== chrome.runtime.id || message?.channel !== 'cwq-naming-page-control-v1') return;
      void this.control(message.type).then(respond, error => respond({ ok: false, error: error instanceof Error ? error.message : '命名失败' }));
      return true;
    });
    setInterval(() => { void this.tick().catch(() => {}); }, 1000);
  }
  private async loadSettings() {
    try { this.settings = (await namingRequest({ type: 'getSettings' })).settings!; this.ready = true; }
    catch { this.ready = false; }
  }
  private async syncId() {
    const id = conversationId(this.document.location.href);
    if (id !== this.id) {
      this.id = id; this.observed = ''; this.attempted = ''; this.titleCandidate = ''; this.seenTitle = id ? currentTitle(this.document, id) : ''; this.state = emptyNamingState();
      if (id) {
        const reply = await namingRequest({ type: 'getState', id });
        if (this.id === id) this.state = reply.state!;
      }
    }
    return id;
  }
  private async queueActive(id: string) {
    const values = await chrome.storage.local.get([`cwq:v1:conversation:${id}`, SETTINGS_KEY]);
    const queue = values[`cwq:v1:conversation:${id}`] as QueueState | undefined;
    return parseSettings(values[SETTINGS_KEY]).enabled && queue && !queue.paused && (queue.items?.length || queue.attempt || queue.awaitingReply);
  }
  private async tick() {
    if (!this.ready || this.running) return;
    const id = await this.syncId(); if (!id) return;
    const page = inspectPage(this.document);
    if (!page.complete || page.error || page.busy) { this.observed = ''; return; }
    const title = currentTitle(this.document, id);
    if (title !== this.seenTitle) {
      this.seenTitle = title;
      if (this.state.lastTitle && title && title !== 'ChatGPT' && title !== this.state.lastTitle && !this.state.locked && Date.now() - this.lastAppliedAt > 6000) {
        this.titleCandidate = title; this.titleChangedAt = Date.now();
      } else this.titleCandidate = '';
    }
    if (this.titleCandidate === title && !this.state.locked) {
      if (Date.now() - this.titleChangedAt > 4000) {
        const shared = await namingRequest({ type: 'getState', id });
        if (!shared.busy && shared.state?.lastTitle === this.state.lastTitle) {
          this.state = (await namingRequest({ type: 'setState', id, patch: { locked: true } })).state!;
        }
      }
      return;
    }
    if (!this.settings.enabled || !this.settings.provider.model || this.state.locked) return;
    if (page.editor && editorText(page.editor).trim()) return;
    const signature = `${id}:${page.signature}:${this.settings.revision}:${this.state.mode}:${this.state.instructions}:${this.state.tags.join(',')}`;
    if (signature !== this.observed) { this.observed = signature; this.observedAt = Date.now(); return; }
    if (signature === this.attempted || Date.now() - this.observedAt < 1500 || await this.queueActive(id)) return;
    if (this.document.querySelector('[role="dialog"], [aria-modal="true"], [role="menu"]')) return;
    this.attempted = signature;
    await this.generate(false);
  }
  private async generate(force: boolean) {
    if (this.running) throw new Error('当前标签页正在处理命名，请稍后重试');
    const id = await this.syncId(); if (!id) throw new Error('请先打开一条 ChatGPT 对话');
    const original = inspectPage(this.document);
    if (!original.complete) throw new Error('请等待当前回复完成后再生成标题');
    this.running = true;
    let token: string | undefined;
    try {
      await this.loadSettings();
      const initialMode = this.state.mode === 'inherit' ? this.settings.mode : this.state.mode;
      let data = await readConversation(this.document, id, initialMode);
      const mode = resolveRule(this.settings, data, this.state).mode;
      if (mode === 'conversation' && initialMode !== 'conversation') data = await readConversation(this.document, id, mode);
      const fresh = inspectPage(this.document);
      if (!fresh.complete || original.signature !== fresh.signature || conversationId(this.document.location.href) !== id)
        throw new ContextChangedError('读取期间对话发生变化，请等待回复完成后重新生成');
      if (data.lastMessageId && !fresh.messages.some(m => m.id === data.lastMessageId ||
        (m.element.getAttribute('data-chatgpt-search-message-ids') ?? '').split(' ').includes(data.lastMessageId!)))
        throw new Error('网页选中的分支与读取的历史不一致，请重新加载该对话后重试');
      const signature = fresh.signature;
      const generation = await namingRequest({ type: 'generate', conversation: data, force });
      token = generation.token;
      if (!token || generation.skipped) return { ok: true, skipped: true };
      const authorize = async () => {
        if (conversationId(this.document.location.href) !== id) throw new ContextChangedError('已切换会话，未应用标题');
        const fresh = inspectPage(this.document);
        if (!fresh.complete || fresh.signature !== signature || await this.queueActive(id)) throw new ContextChangedError('对话内容已继续变化，请等待回复完成后重新生成');
        if (!force && fresh.editor && editorText(fresh.editor).trim()) throw new ContextChangedError('正在编辑下一条消息，稍后再命名');
        await namingRequest({ type: 'authorize', id, token: token! });
      };
      await saveTitle(this.document, id, generation.before!, generation.title!, authorize);
      const reply = await namingRequest({ type: 'commit', id, token, before: generation.before!, after: generation.title! });
      if (this.id === id) { this.state = reply.state!; this.seenTitle = generation.title!; }
      this.lastAppliedAt = Date.now(); token = undefined;
      return { ok: true, title: generation.title, result: generation.result };
    } catch (error) {
      if (token) await namingRequest({ type: 'release', id, token, error: error instanceof Error ? error.message : '命名失败', locked: error instanceof TitleChangedError, retryable: error instanceof ContextChangedError }).catch(() => {});
      else await namingRequest({ type: 'reportError', id, error: error instanceof Error ? error.message : '命名失败' }).catch(() => {});
      if (error instanceof ContextChangedError) this.attempted = '';
      throw error;
    } finally { this.running = false; }
  }
  private async control(type: string): Promise<unknown> {
    const id = await this.syncId(); if (!id) throw new Error('请先打开一条 ChatGPT 对话');
    if (type === 'status') return { ok: true, id, title: currentTitle(this.document, id), state: this.state, busy: this.running };
    if (type === 'generate') return this.generate(true);
    if (type === 'lock' || type === 'unlock') {
      this.state = (await namingRequest({ type: 'setState', id, patch: { locked: type === 'lock' } })).state!;
      this.attempted = ''; return { ok: true, state: this.state };
    }
    if (type !== 'undo') throw new Error('未知命名操作');
    if (this.running || !inspectPage(this.document).complete) throw new Error('请等待当前回复与命名任务完成后撤销');
    this.running = true;
    let token: string | undefined;
    try {
      const job = await namingRequest({ type: 'claimUndo', id }); token = job.token!;
      await saveTitle(this.document, id, job.before!, job.title!, async () => {
        await namingRequest({ type: 'authorize', id, token: token! });
      });
      this.state = (await namingRequest({ type: 'commitUndo', id, token, before: job.before!, after: job.title! })).state!;
      token = undefined; this.lastAppliedAt = Date.now(); this.seenTitle = job.title!;
      return { ok: true, title: job.title, state: this.state };
    } finally {
      if (token) await namingRequest({ type: 'release', id, token }).catch(() => {});
      this.running = false;
    }
  }
}
