import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyQueue, transition } from '../src/core/queue.ts';
import type { Action, Actor, QueueState } from '../src/core/types.ts';
import { queueKey } from '../src/core/types.ts';

const a: Actor = { tabId: 1, documentId: 'a', now: 100 };
const b: Actor = { tabId: 2, documentId: 'b', now: 200 };
function fixture() {
  let state = emptyQueue('conversation:test'), seq = 0;
  return { get state() { return state; }, act(action: Action, actor = a) {
    const result = transition(state, action, actor, () => `id-${++seq}`);
    if (result.ok) state = result.state;
    return result;
  } };
}
test('conversation routing handles project/custom-GPT paths and excludes unrelated pages', () => {
  assert.equal(queueKey('https://chatgpt.com/g/project/c/abc-123?x=1'), 'conversation:abc-123');
  assert.equal(queueKey('https://chatgpt.com/c/abc'), 'conversation:abc');
  assert.equal(queueKey('https://chatgpt.com/'), null);
  assert.equal(queueKey('https://example.com/c/abc'), null);
});
test('duplicate prompts remain distinct, including paragraph and code block breaks', () => {
  const f = fixture(); const text = '继续\n\n```ts\nconst n = 1;\n```\n';
  f.act({ type: 'enqueue', text }); f.act({ type: 'enqueue', text });
  assert.equal(f.state.items.length, 2);
  assert.notEqual(f.state.items[0]!.id, f.state.items[1]!.id);
  assert.equal(f.state.items[0]!.text, text);
});
test('one tab owns dispatch and only one item can be in flight', () => {
  const f = fixture(); f.act({ type: 'enqueue', text: 'one' }); f.act({ type: 'enqueue', text: 'two' });
  assert.equal(f.act({ type: 'claim' }, b).ok, false);
  const claim = f.act({ type: 'claim' }); assert.ok(claim.attempt);
  assert.equal(f.act({ type: 'claim' }).ok, false);
  assert.equal(f.act({ type: 'submitted', attemptId: claim.attempt.id }, b).ok, false);
  assert.equal(f.state.items.length, 2);
});
test('next item waits for receipt AND full reply completion', () => {
  const f = fixture(); f.act({ type: 'enqueue', text: 'one' }); f.act({ type: 'enqueue', text: 'two' });
  const id = f.act({ type: 'claim' }).attempt!.id;
  assert.equal(f.act({ type: 'ack', attemptId: id, userMessageId: 'u1' }).ok, false);
  f.act({ type: 'submitted', attemptId: id }); f.act({ type: 'ack', attemptId: id, userMessageId: 'u1' });
  assert.equal(f.state.items.length, 1); assert.equal(f.act({ type: 'claim' }).ok, false);
  f.act({ type: 'replyComplete', attemptId: id });
  assert.equal(f.act({ type: 'claim' }).ok, true);
});
test('persisted pre-click attempts recover as queued; submitted attempts require confirmation', () => {
  for (const submitted of [false, true]) {
    const f = fixture(); f.act({ type: 'enqueue', text: 'one' });
    const id = f.act({ type: 'claim' }).attempt!.id;
    if (submitted) f.act({ type: 'submitted', attemptId: id });
    f.act({ type: 'connect' }, { ...a, documentId: 'reloaded' });
    assert.equal(f.state.items[0]!.status, submitted ? 'uncertain' : 'queued');
    assert.equal(f.state.paused, true);
    if (submitted) assert.equal(f.act({ type: 'pause', paused: false }, { ...a, documentId: 'reloaded' }).ok, false);
  }
});
test('editing blocks dispatch; save keeps queue position; removal is reversible', () => {
  const f = fixture(); f.act({ type: 'enqueue', text: 'one' }); f.act({ type: 'enqueue', text: 'two' });
  const first = f.state.items[0]!.id;
  f.act({ type: 'editStart', id: first });
  assert.equal(f.act({ type: 'claim' }).ok, false);
  f.act({ type: 'editSave', id: first, text: 'edited' });
  assert.equal(f.state.items[0]!.text, 'edited');
  f.act({ type: 'remove', id: first }); assert.equal(f.state.removed.length, 1);
  f.act({ type: 'restore', id: first }); assert.equal(f.state.items.at(-1)!.text, 'edited');
});
test('reordering preserves in-flight items and FIFO for the remaining queue', () => {
  const f = fixture(); for (const text of ['one', 'two', 'three']) f.act({ type: 'enqueue', text });
  const [one, two, three] = f.state.items;
  f.act({ type: 'claim' });
  assert.equal(f.act({ type: 'move', id: three!.id, beforeId: one!.id }).ok, false);
  f.act({ type: 'move', id: three!.id, beforeId: two!.id });
  assert.deepEqual(f.state.items.map(i => i.text), ['one', 'three', 'two']);
});
test('switching conversations retains messages and recovers submitted outcomes as uncertain', () => {
  const f = fixture(); f.act({ type: 'enqueue', text: 'one' });
  const id = f.act({ type: 'claim' }).attempt!.id;
  f.act({ type: 'submitted', attemptId: id }); f.act({ type: 'leave' });
  assert.equal(f.state.owner, null); assert.equal(f.state.items[0]!.status, 'uncertain');
  f.act({ type: 'connect' }, b);
  assert.equal(f.act({ type: 'pause', paused: false }, b).ok, false);
  f.act({ type: 'resolve', id: f.state.items[0]!.id, delivered: false }, b);
  assert.equal(f.state.paused, true);
  f.act({ type: 'pause', paused: false }, b); assert.equal(f.act({ type: 'claim' }, b).ok, true);
});
test('state is immutable and failed transitions cannot destroy a pending item', () => {
  const before: QueueState = emptyQueue('conversation:test');
  const result = transition(before, { type: 'enqueue', text: 'one' }, a, () => 'one');
  assert.equal(before.items.length, 0); assert.equal(result.state.items.length, 1);
  const bad = transition(result.state, { type: 'remove', id: 'missing' }, a);
  assert.equal(bad.ok, false); assert.deepEqual(bad.state, result.state);
});

test('submitted attempts retain their owner until a takeover receipt or cancellation settles them', () => {
  for (const outcome of ['ack', 'abort', 'uncertain'] as const) {
    const f = fixture(); f.act({ type: 'enqueue', text: 'one' });
    const id = f.act({ type: 'claim' }).attempt!.id;
    f.act({ type: 'submitted', attemptId: id });
    f.act({ type: 'takeover' }, b);
    assert.equal(f.state.owner?.documentId, a.documentId);
    assert.equal(f.state.handoff?.documentId, b.documentId);
    assert.equal(f.act({ type: 'pause', paused: false }).ok, false);
    assert.equal(f.act({ type: 'claim' }, b).ok, false);
    const result = outcome === 'ack'
      ? f.act({ type: 'ack', attemptId: id, userMessageId: 'u2' })
      : f.act({ type: outcome, attemptId: id, reason: 'settled' });
    assert.equal(result.ok, true);
    assert.equal(f.state.owner?.documentId, b.documentId);
    assert.equal(f.state.handoff, null);
    assert.equal(f.state.paused, true);
    if (outcome === 'ack') assert.equal(f.state.awaitingReply?.userMessageId, 'u2');
    else assert.equal(f.state.items[0]!.status, outcome === 'abort' ? 'queued' : 'uncertain');
  }
});

test('pre-click takeover rejects stale submissions and owner loss completes a pending handoff', () => {
  const f = fixture(); f.act({ type: 'enqueue', text: 'one' });
  const prepared = f.act({ type: 'claim' }).attempt!.id;
  f.act({ type: 'takeover' }, b);
  assert.equal(f.act({ type: 'submitted', attemptId: prepared }).ok, false);
  f.act({ type: 'pause', paused: false }, b);
  const id = f.act({ type: 'claim' }, b).attempt!.id;
  f.act({ type: 'submitted', attemptId: id }, b);
  f.act({ type: 'takeover' }, a);
  f.act({ type: 'leave' }, b);
  assert.equal(f.state.owner?.documentId, a.documentId);
  assert.equal(f.state.items[0]!.status, 'uncertain');
  assert.equal(f.state.handoff, null);
});

test('a departing takeover requester does not receive ownership after the receipt', () => {
  const f = fixture(); f.act({ type: 'enqueue', text: 'one' });
  const id = f.act({ type: 'claim' }).attempt!.id;
  f.act({ type: 'submitted', attemptId: id });
  f.act({ type: 'takeover' }, b); f.act({ type: 'leave' }, b);
  assert.equal(f.act({ type: 'ack', attemptId: id, userMessageId: 'u3' }).ok, true);
  assert.equal(f.state.owner?.documentId, a.documentId);
  assert.equal(f.state.handoff, null);
});

test('reconnecting a non-owner editing tab releases only the stale document lock', () => {
  const f = fixture(); f.act({ type: 'enqueue', text: 'one' });
  const id = f.state.items[0]!.id;
  f.act({ type: 'editStart', id }, b);
  f.act({ type: 'connect' }, { ...b, documentId: 'reloaded-editor' });
  assert.equal(f.state.editing, null);
  assert.equal(f.state.owner?.documentId, a.documentId);
  assert.equal(f.act({ type: 'editSave', id, text: 'stale edit' }, b).ok, false);
  assert.equal(f.state.items[0]!.text, 'one');
  assert.equal(f.act({ type: 'claim' }).ok, true);
});
