import { useSyncExternalStore } from 'react';

import type { ReplyMessage } from '../../stream/MessageActions';

/**
 * The message each message box replies to: one per key (a chat's id, as the words and files of `composerDrafts` and `composerFiles`), shown as a card above
 * the field and sent as a quote in front of the words. Kept apart from the component, as they are, so going to another chat and back leaves each box's card
 * where it was. The box of an edit frame has none.
 */
const quotes = new Map<string, ReplyMessage>();
const listeners = new Set<() => void>();

const changed = () => listeners.forEach(listener => listener());

function subscribe(listener: () => void): () => void {
    listeners.add(listener);

    return () => void listeners.delete(listener);
}

export function replyQuoteOf(key: string): ReplyMessage | undefined {
    return quotes.get(key);
}

/** Replies to `message`: it takes the place of the one the box had, since the box quotes one message at a time. */
export function setReplyQuote(key: string, message: ReplyMessage): void {
    quotes.set(key, message);
    changed();
}

/** Takes the quote away without sending it. */
export function dropReplyQuote(key: string): void {
    if (quotes.delete(key)) changed();
}

/** Hands the quote over for sending, and leaves the box without it. */
export function takeReplyQuote(key: string): ReplyMessage | undefined {
    const message = quotes.get(key);

    dropReplyQuote(key);

    return message;
}

/** Puts the quote back when its message did not go, unless the person has picked another message to reply to meanwhile. */
export function restoreReplyQuote(key: string, message: ReplyMessage): void {
    if (!quotes.has(key)) setReplyQuote(key, message);
}

export function useReplyQuote(key: string): ReplyMessage | undefined {
    return useSyncExternalStore(subscribe, () => replyQuoteOf(key));
}
