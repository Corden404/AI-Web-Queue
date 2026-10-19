import { NAMING_CHANNEL, NAMING_SETTINGS_KEY, STATE_PREFIX, cleanText, parseNamingSettings, providerOrigin, tagsFrom, validateNamingSettings } from './settings.ts';
import { emptyNamingState } from './types.ts';
import type { NamingAction, NamingReply, NamingState, ConversationData, NamingResult } from './types.ts';
import { fingerprint, renderTitle, resolveRule, sourceMessages } from './rules.ts';
import { generateName } from './provider.ts';

interface Lease {
  token: string; tabId: number; documentId: string; expires: number; revision: number; stateSignature: string;
  fingerprint: string; before: string; title?: string; result?: NamingResult; force: boolean; undo: boolean;
}
const leaseKey = (id: string) => `cwq:naming:lease:${id}`;
let writer: Promise<unknown> = Promise.resolve();
const serial = <T>(work: () => Promise<T>): Promise<T> => {
  const next = writer.then(work, work); writer = next.catch(() => {}); return next;
};
const stateSignature = (s: NamingState) => JSON.stringify([s.locked, s.mode, s.instructions, s.tags, s.lastTitle]);
async function getSettings() { return parseNamingSettings((await chrome.storage.local.get(NAMING_SETTINGS_KEY))[NAMING_SETTINGS_KEY]); }
async function getState(id: string): Promise<NamingState> {
  return { ...emptyNamingState(), ...((await chrome.storage.local.get(`${STATE_PREFIX}${id}`))[`${STATE_PREFIX}${id}`] as Partial<NamingState> | undefined) };
}
async function putState(id: string, state: NamingState) { await chrome.storage.local.set({ [`${STATE_PREFIX}${id}`]: state }); }
async function lease(id: string): Promise<Lease | undefined> {
  const value = (await chrome.storage.session.get(leaseKey(id)))[leaseKey(id)] as Lease | undefined;
  return value && value.expires > Date.now() ? value : undefined;
}
async function ownedLease(id: string, token: string, sender: chrome.runtime.MessageSender): Promise<Lease> {
  const current = await lease(id);
  if (!current || current.token !== token || current.tabId !== sender.tab?.id || current.documentId !== sender.documentId)
    throw new Error('命名任务已失效，请重新生成');
  return current;
}
async function checkedLease(id: string, token: string, sender: chrome.runtime.MessageSender): Promise<Lease> {
  const current = await ownedLease(id, token, sender);
  const [settings, state] = await Promise.all([getSettings(), getState(id)]);
  if (settings.revision !== current.revision || stateSignature(state) !== current.stateSignature || (!current.force && !settings.enabled))
    throw new Error('命名设置或标题状态已变化，请重新生成');
  return current;
}
function validateConversation(data: ConversationData) {
  if (!data || !/^[a-zA-Z0-9_-]+$/.test(data.id) || typeof data.title !== 'string' || data.title.length > 1000 ||
    !Number.isFinite(data.createdAt) || !Array.isArray(data.messages) || data.messages.length > 10_000 ||
    data.messages.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string') ||
    JSON.stringify(data).length > 2_000_000) throw new Error('会话内容格式无效或超过本次处理上限');
}
async function generate(action: Extract<NamingAction, { type: 'generate' }>, sender: chrome.runtime.MessageSender): Promise<NamingReply> {
  const data = action.conversation; validateConversation(data);
  const settings = await getSettings(); validateNamingSettings(settings);
  if (!settings.provider.model) throw new Error('请在命名设置中填写模型名称');
  if (!await chrome.permissions.contains({ origins: [providerOrigin(settings.provider.baseUrl)] })) throw new Error('请在命名设置中授权模型服务域名');
  const initial = await serial(async () => {
    if ((await getSettings()).revision !== settings.revision) return null;
    const state = await getState(data.id);
    if ((!settings.enabled || state.locked) && !action.force) return null;
    if (await lease(data.id)) return null;
    if (!action.force && state.lastTitle && data.title !== state.lastTitle) {
      state.locked = true; state.lastError = '标题已由其他操作修改，已保留当前名称并锁定自动命名';
      await putState(data.id, state); return null;
    }
    const rule = resolveRule(settings, data, state);
    const source = sourceMessages(data, rule.mode);
    const hash = await fingerprint({ revision: settings.revision, rule, source, createdAt: data.createdAt, project: data.project });
    if (!action.force && (hash === state.fingerprint || hash === state.failedFingerprint)) return null;
    const job: Lease = { token: crypto.randomUUID(), tabId: sender.tab!.id!, documentId: sender.documentId!,
      expires: Date.now() + 150_000, revision: settings.revision, stateSignature: stateSignature(state),
      fingerprint: hash, before: data.title, force: action.force, undo: false };
    await chrome.storage.session.set({ [leaseKey(data.id)]: job });
    return { state, rule, source, job };
  });
  if (!initial) return { ok: true, skipped: true, state: await getState(data.id) };
  try {
    // Network requests deliberately run outside both queue and naming storage locks.
    const result = await generateName(settings, initial.rule.instructions, initial.source, initial.rule.mode);
    const title = renderTitle(settings, data, initial.state, result);
    await serial(async () => {
      await checkedLease(data.id, initial.job.token, sender);
      await chrome.storage.session.set({ [leaseKey(data.id)]: { ...initial.job, title, result } });
    });
    return { ok: true, token: initial.job.token, title, before: data.title, result };
  } catch (error) {
    await serial(async () => {
      const current = await lease(data.id);
      if (current?.token !== initial.job.token) return;
      const state = await getState(data.id);
      state.lastError = error instanceof Error ? error.message : '命名失败';
      state.failedFingerprint = initial.job.fingerprint;
      await putState(data.id, state); await chrome.storage.session.remove(leaseKey(data.id));
    });
    throw error;
  }
}
export function registerNamingBackground() {
  chrome.runtime.onMessage.addListener((message: { channel?: string; action?: NamingAction }, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.channel !== NAMING_CHANNEL || !message.action) return;
    const action = message.action;
    const trusted = !!sender.url?.startsWith(chrome.runtime.getURL(''));
    const content = sender.tab?.id !== undefined && sender.documentId && sender.url?.startsWith('https://chatgpt.com/');
    if (!trusted && !content) return;
    const run = async (): Promise<NamingReply> => {
      if (action.type === 'getSettings') {
        const settings = await getSettings();
        if (!trusted) settings.provider.apiKey = '';
        return { ok: true, settings };
      }
      if (action.type === 'saveSettings') {
        if (!trusted) throw new Error('请通过扩展设置页修改模型配置');
        return serial(async () => {
          const settings = parseNamingSettings(action.settings); validateNamingSettings(settings);
          const previous = await getSettings();
          if (settings.revision !== previous.revision) throw new Error('其他设置页面已修改规则，请刷新后再保存');
          settings.revision = previous.revision + 1;
          await chrome.storage.local.set({ [NAMING_SETTINGS_KEY]: settings }); return { ok: true, settings };
        });
      }
      if (action.type === 'preview') {
        if (!trusted) throw new Error('请在扩展设置页预览规则');
        validateConversation(action.conversation);
        const settings = parseNamingSettings(action.settings); validateNamingSettings(settings);
        if (!settings.provider.model) throw new Error('请填写模型名称后预览');
        if (!await chrome.permissions.contains({ origins: [providerOrigin(settings.provider.baseUrl)] })) throw new Error('请先授权模型服务域名');
        const state = emptyNamingState();
        const rule = resolveRule(settings, action.conversation, state);
        const source = sourceMessages(action.conversation, rule.mode);
        const result = await generateName(settings, rule.instructions, source, rule.mode);
        return { ok: true, result, title: renderTitle(settings, action.conversation, state, result) };
      }
      const id = action.type === 'generate' ? action.conversation?.id : action.id;
      if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('会话 ID 无效');
      if (action.type === 'generate') {
        if (!content) throw new Error('请在 ChatGPT 会话内生成标题');
        return generate(action, sender);
      }
      return serial(async () => {
        const state = await getState(id);
        if (action.type === 'getState') return { ok: true, state, busy: !!await lease(id) };
        if (action.type === 'reportError') {
          state.lastError = cleanText(action.error, 500); await putState(id, state); return { ok: true, state };
        }
        if (action.type === 'setState') {
          if (action.patch.locked === false && state.locked) { state.lastTitle = ''; state.fingerprint = ''; }
          if (action.patch.locked !== undefined) state.locked = action.patch.locked === true;
          if (action.patch.mode !== undefined && ['first', 'conversation', 'inherit'].includes(action.patch.mode)) state.mode = action.patch.mode;
          if (action.patch.instructions !== undefined) state.instructions = cleanText(action.patch.instructions);
          if (action.patch.tags !== undefined) state.tags = tagsFrom(action.patch.tags);
          state.failedFingerprint = ''; state.lastError = '';
          await putState(id, state); return { ok: true, state };
        }
        if (!content) throw new Error('请在 ChatGPT 会话内修改标题');
        if (action.type === 'claimUndo') {
          const last = state.history.at(-1);
          if (!last) throw new Error('没有可以撤销的改名记录');
          if (await lease(id)) throw new Error('当前会话正在命名，请稍后撤销');
          const settings = await getSettings();
          const job: Lease = { token: crypto.randomUUID(), tabId: sender.tab!.id!, documentId: sender.documentId!,
            expires: Date.now() + 30_000, revision: settings.revision, stateSignature: stateSignature(state),
            fingerprint: '', before: last.after, title: last.before, force: true, undo: true };
          await chrome.storage.session.set({ [leaseKey(id)]: job });
          return { ok: true, token: job.token, title: job.title, before: job.before };
        }
        if (action.type === 'release') {
          const current = await lease(id);
          if (current?.token === action.token && current.tabId === sender.tab?.id && current.documentId === sender.documentId) {
            state.lastError = cleanText(action.error, 500); state.failedFingerprint = action.retryable ? '' : current.fingerprint;
            if (action.locked) state.locked = true;
            await putState(id, state); await chrome.storage.session.remove(leaseKey(id));
          }
          return { ok: true, state };
        }
        if (action.type === 'authorize') { await checkedLease(id, action.token, sender); return { ok: true }; }
        // Record a completed native save even if settings changed just after
        // authorization, so its original title remains available to undo.
        const job = await ownedLease(id, action.token, sender);
        if (action.before !== job.before || action.after !== job.title || (action.type === 'commitUndo') !== job.undo)
          throw new Error('保存的标题与命名结果不一致');
        if (action.type === 'commitUndo') {
          state.history.pop(); state.locked = true; state.fingerprint = ''; state.result = null;
        } else {
          if (action.before !== action.after) state.history = [...state.history, { before: action.before, after: action.after, at: Date.now() }].slice(-10);
          state.fingerprint = job.fingerprint; state.result = job.result ?? null;
        }
        state.lastTitle = action.after; state.lastError = ''; state.failedFingerprint = '';
        await putState(id, state); await chrome.storage.session.remove(leaseKey(id));
        return { ok: true, state };
      });
    };
    void run().then(respond, error => respond({ ok: false, error: error instanceof Error ? error.message : '命名失败' }));
    return true;
  });
}
