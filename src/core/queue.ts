import type { Action, Actor, Owner, QueueReply, QueueState } from './types.ts';

export function emptyQueue(key: string): QueueState {
  return { version: 1, revision: 0, key, items: [], removed: [], sent: [], paused: false,
    reason: '', owner: null, handoff: null, attempt: null, awaitingReply: null, editing: null };
}
export function sameOwner(a: Owner | null, b: Owner): boolean {
  return !!a && a.tabId === b.tabId && a.documentId === b.documentId;
}

/** One writer in the service worker serializes this reducer and its durable writes. */
export function transition(input: QueueState, action: Action, actor: Actor,
  uid: () => string = () => crypto.randomUUID()): QueueReply {
  const state = structuredClone(input);
  state.handoff ??= null;
  const owner = { tabId: actor.tabId, documentId: actor.documentId };
  const fail = (error: string): QueueReply => ({ ok: false, state: input, error });
  const editable = (id: string) => state.items.find(i => i.id === id && i.status === 'queued');
  const ownAttempt = (id: string) => sameOwner(state.owner, owner) && state.attempt?.id === id;
  const pause = (reason: string) => { state.paused = true; state.reason = reason; };
  const finishHandoff = () => {
    if (!state.handoff) return;
    state.owner = state.handoff;
    state.handoff = null;
    state.editing = null;
    pause('已接管队列，核对当前回答后继续');
  };
  const recover = () => {
    if (state.attempt) {
      const item = state.items.find(i => i.id === state.attempt!.itemId);
      if (item) item.status = state.attempt.phase === 'submitted' ? 'uncertain' : 'queued';
      state.attempt = null;
    }
    state.editing = null;
  };

  switch (action.type) {
    case 'connect':
      if (state.editing?.owner.tabId === owner.tabId && !sameOwner(state.editing.owner, owner))
        state.editing = null;
      if (state.handoff?.tabId === owner.tabId && !sameOwner(state.handoff, owner))
        state.handoff = owner;
      if (state.owner?.tabId === owner.tabId && !sameOwner(state.owner, owner)) {
        recover();
        state.owner = owner;
        if (state.items.length || state.awaitingReply) pause('页面已重新加载，请核对后继续');
        finishHandoff();
      } else if (!state.owner) state.owner = owner;
      break;
    case 'enqueue':
      if (!action.text.trim()) return fail('请输入要排队的文字');
      if (action.text.length > 100_000) return fail('单条队列消息最多 100,000 个字符');
      if (!state.items.length && !state.awaitingReply && !state.attempt) state.owner = owner;
      state.items.push({ id: uid(), text: action.text, createdAt: actor.now, status: 'queued' });
      break;
    case 'pause':
      if (!sameOwner(state.owner, owner)) return fail('请先在此标签页接管队列');
      if (!action.paused && state.handoff) return fail('正在交接发送权，请等待当前消息核对完成');
      if (!action.paused && state.items.some(i => i.status === 'uncertain'))
        return fail('请先确认结果不明的消息是否已经发送');
      state.paused = action.paused;
      state.reason = action.paused ? '已暂停自动发送' : '';
      break;
    case 'remove': {
      const item = editable(action.id);
      if (!item) return fail('这条消息已开始发送，无法移除');
      state.items = state.items.filter(i => i.id !== action.id);
      state.removed.push(item);
      if (state.editing?.itemId === action.id) state.editing = null;
      break;
    }
    case 'restore': {
      const item = state.removed.find(i => i.id === action.id);
      if (!item) return fail('找不到可恢复的消息');
      state.removed = state.removed.filter(i => i.id !== action.id);
      state.items.push({ ...item, status: 'queued' });
      break;
    }
    case 'move': {
      const item = editable(action.id);
      if (!item) return fail('只能调整待发送消息的顺序');
      if (action.id === action.beforeId) return { ok: true, state: input };
      if (action.beforeId && !editable(action.beforeId)) return fail('目标消息已开始发送');
      state.items = state.items.filter(i => i.id !== item.id);
      const index = action.beforeId ? state.items.findIndex(i => i.id === action.beforeId) : state.items.length;
      state.items.splice(index, 0, item);
      break;
    }
    case 'editStart':
      if (!editable(action.id)) return fail('这条消息已经开始发送');
      if (state.editing && !sameOwner(state.editing.owner, owner)) return fail('这条队列正在另一个标签页编辑');
      state.editing = { itemId: action.id, owner };
      break;
    case 'editSave': {
      if (!state.editing || !sameOwner(state.editing.owner, owner) || state.editing.itemId !== action.id)
        return fail('编辑状态已变化，请重新打开编辑');
      const item = editable(action.id);
      if (!item || !action.text.trim()) return fail('消息不能为空');
      if (action.text.length > 100_000) return fail('单条队列消息最多 100,000 个字符');
      item.text = action.text;
      state.editing = null;
      break;
    }
    case 'editCancel':
      if (state.editing && sameOwner(state.editing.owner, owner)) state.editing = null;
      break;
    case 'claim': {
      if (!sameOwner(state.owner, owner)) return fail('队列由另一个标签页发送');
      if (state.paused || state.editing || state.attempt || state.awaitingReply)
        return fail('队列尚未准备好');
      const first = state.items[0];
      if (!first || first.status !== 'queued') return fail('没有可以发送的消息');
      first.status = 'sending';
      state.attempt = { id: uid(), itemId: first.id, phase: 'prepared', startedAt: actor.now };
      break;
    }
    case 'submitted':
      if (!ownAttempt(action.attemptId)) return fail('发送权已变化');
      if (state.paused || state.editing) return fail('队列已暂停');
      state.attempt!.phase = 'submitted';
      break;
    case 'ack': {
      if (!ownAttempt(action.attemptId) || state.attempt!.phase !== 'submitted') return fail('发送状态已变化');
      const itemId = state.attempt!.itemId;
      state.sent.push({ id: itemId, userMessageId: action.userMessageId, sentAt: actor.now });
      state.items = state.items.filter(i => i.id !== itemId);
      state.awaitingReply = { attemptId: action.attemptId, userMessageId: action.userMessageId };
      state.attempt = null;
      finishHandoff();
      break;
    }
    case 'abort':
      if (!ownAttempt(action.attemptId)) return fail('发送状态已变化');
      state.items.find(i => i.id === state.attempt!.itemId)!.status = 'queued';
      state.attempt = null;
      pause(action.reason);
      finishHandoff();
      break;
    case 'uncertain':
      if (!ownAttempt(action.attemptId)) return fail('发送状态已变化');
      state.items.find(i => i.id === state.attempt!.itemId)!.status = 'uncertain';
      state.attempt = null;
      pause(action.reason);
      finishHandoff();
      break;
    case 'resolve': {
      if (!sameOwner(state.owner, owner)) return fail('请先在此标签页接管队列');
      const item = state.items.find(i => i.id === action.id && i.status === 'uncertain');
      if (!item) return fail('消息状态已变化');
      if (action.delivered) {
        state.items = state.items.filter(i => i.id !== item.id);
        state.sent.push({ id: item.id, userMessageId: '', sentAt: actor.now });
      } else item.status = 'queued';
      pause('已确认消息状态，点击继续恢复队列');
      break;
    }
    case 'replyComplete':
      if (!sameOwner(state.owner, owner) || state.awaitingReply?.attemptId !== action.attemptId)
        return fail('回合状态已变化');
      state.awaitingReply = null;
      break;
    case 'stop':
      pause(action.reason);
      break;
    case 'leave':
      if (sameOwner(state.owner, owner)) {
        recover();
        state.owner = null;
        if (state.items.length || state.awaitingReply) pause('会话已切换，请返回后继续');
        finishHandoff();
      }
      if (state.editing && sameOwner(state.editing.owner, owner)) state.editing = null;
      if (sameOwner(state.handoff, owner)) state.handoff = null;
      break;
    case 'takeover':
      // A submitted attempt may already be clicking or waiting for its receipt.
      // Its original owner must settle it before another tab can dispatch.
      if (state.attempt?.phase === 'submitted') {
        state.handoff = sameOwner(state.owner, owner) ? null : owner;
        pause(state.handoff ? '正在交接发送权，等待当前消息核对完成' : '已取消交接，核对当前回答后继续');
        break;
      }
      recover();
      state.owner = owner;
      state.handoff = null;
      if (state.items.length || state.awaitingReply) pause('已接管队列，核对当前回答后继续');
      break;
  }
  if (JSON.stringify(state) === JSON.stringify(input)) return { ok: true, state: input };
  state.revision++;
  return { ok: true, state, ...(action.type === 'claim' && state.attempt ? { attempt: state.attempt } : {}) };
}
