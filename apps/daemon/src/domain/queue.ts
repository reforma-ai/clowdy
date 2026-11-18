import type { Chat, QueuedMessage, QueuePause, StreamItemBody } from '@clowdy/protocol';

/** The messages waiting for the chat's orchestrator; none when the chat has no queue. */
export const queueOf = (chat: Chat): QueuedMessage[] => chat.queue ?? [];

/** The chat with this queue and pause (`undefined` lets the queue flow). An empty queue is no queue, and has nothing to hold: its pause goes with it. */
export function withQueue(chat: Chat, queue: QueuedMessage[], paused: QueuePause | undefined): Chat {
    const { queue: _queue, queuePaused: _paused, ...rest } = chat;

    return queue.length === 0 ? rest : { ...rest, queue, ...(paused && { queuePaused: paused }) };
}

/**
 * Puts `item` among the messages of its own kind: the steers come before the next turns. `index` is its place in that part, the end when it is left out
 * or beyond it. An item that is in the queue already moves.
 */
export function placeQueued(queue: readonly QueuedMessage[], item: QueuedMessage, index?: number): QueuedMessage[] {
    const others = queue.filter(entry => entry.id !== item.id);
    const steers = others.filter(entry => entry.mode === 'steer');
    const turns = others.filter(entry => entry.mode !== 'steer');
    const part = item.mode === 'steer' ? steers : turns;

    part.splice(Math.min(index ?? part.length, part.length), 0, item);

    return [...steers, ...turns];
}

/**
 * The queue of an orchestrator that came to rest: the steers its turn did not take become the next turns, ahead of the others and in their own order,
 * so the next turn starts with them and the row offers Send now again.
 */
export function settleSteers(queue: readonly QueuedMessage[]): QueuedMessage[] {
    return queue.map(item => (item.mode === 'steer' ? { ...item, mode: 'queue' } : item));
}

/** The stream's `user` item of a queued message, written when the agent gets it. */
export function userItemOf(item: QueuedMessage): StreamItemBody {
    return { kind: 'user', text: item.text, ...(item.attachments?.length && { attachments: item.attachments }) };
}
