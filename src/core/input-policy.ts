export type ReplyStatus = 'idle' | 'incomplete' | 'complete';
export function shouldQueueInput(input: {
  enabled: boolean;
  conversationReady: boolean;
  replyStatus: ReplyStatus;
  pending: boolean;
  awaitingReply: boolean;
  dispatching: boolean;
}): boolean {
  return input.enabled && input.conversationReady &&
    (input.replyStatus === 'incomplete' || input.pending || input.awaitingReply || input.dispatching);
}
export function queueEnter(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey' | 'isComposing' | 'keyCode' | 'repeat'>,
  composing: boolean): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey &&
    !event.isComposing && event.keyCode !== 229 && !composing && !event.repeat;
}
