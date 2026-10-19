import test from 'node:test';
import assert from 'node:assert/strict';
import { queueEnter, shouldQueueInput } from '../src/core/input-policy.ts';

const idle = { enabled: true, conversationReady: true, replyStatus: 'idle' as const,
  pending: false, awaitingReply: false, dispatching: false };
test('unfinished reply captures Enter even while not generating and without a queue', () => {
  assert.equal(shouldQueueInput({ ...idle, replyStatus: 'incomplete' }), true);
  assert.equal(shouldQueueInput(idle), false);
  assert.equal(shouldQueueInput({ ...idle, replyStatus: 'complete' }), false);
  assert.equal(shouldQueueInput({ ...idle, replyStatus: 'complete', pending: true }), true);
});
test('disabled Queue leaves input alone even during an unfinished reply or an existing queue', () => {
  assert.equal(shouldQueueInput({ ...idle, enabled: false, replyStatus: 'incomplete', pending: true, awaitingReply: true }), false);
  assert.equal(shouldQueueInput({ ...idle, conversationReady: false, replyStatus: 'incomplete' }), false);
});
test('Shift+Enter and IME confirmation remain outside the Queue shortcut', () => {
  const enter = { key: 'Enter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, keyCode: 13, repeat: false };
  assert.equal(queueEnter(enter, false), true);
  for (const patch of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { repeat: true }])
    assert.equal(queueEnter({ ...enter, ...patch }, false), false);
  assert.equal(queueEnter(enter, true), false);
});
