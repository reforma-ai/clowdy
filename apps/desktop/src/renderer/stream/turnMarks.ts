import { noticeLine } from './threadMessages';

import type { StreamItem, StreamItemBody } from '@clowdy/protocol';

/** The rail stays hidden until the stream has this many messages that start a turn (the person's, or a thread's). */
export const TURN_RAIL_MIN = 7;

/** How far above a message a jump lands, so the bubble is not flush with the top of the stream. */
const JUMP_INSET = 16;

/** One tick: a message that starts a turn (the person's, or a thread's), and the latest reply that followed it. */
export interface TurnMark {
    /** The stream item the tick scrolls to. */
    id: string;
    /** What they wrote, as plain text. Empty when the message has no words yet. */
    title: string;
    /** The latest reply in the turn, as plain text. Empty until some arrives. */
    reply: string;
}

type UserBody = Extract<StreamItemBody, { kind: 'user' }>;

/**
 * One item object is one version of its text. A later token replaces the object,
 * so a tick rebuild does not strip every older message again.
 */
const plainCache = new WeakMap<StreamItem, string>();

/** Markdown is noise in a two-line preview: keep the words, drop the marks. */
function plain(text: string): string {
    const flat = text
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/(\*\*|__)(.*?)\1/g, '$2')
        .replace(/[`*]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    return flat.length > 600 ? flat.slice(0, 600) : flat;
}

function plainOf(item: StreamItem, text: string): string {
    const cached = plainCache.get(item);

    if (cached !== undefined) return cached;

    const value = plain(text);

    plainCache.set(item, value);

    return value;
}

function titleOf(item: StreamItem, body: UserBody): string {
    // A notice has no words of its own: its line is which threads stopped.
    if (body.from?.kind === 'threadNotice') return body.from.threads.map(noticeLine).join(', ');

    const text = plainOf(item, body.text);

    if (text !== '') return text;

    return (body.attachments ?? [])
        .map(file => file.name)
        .filter(name => name !== '')
        .join(', ');
}

/**
 * One mark per message of the person's, or of a thread's (a thread's message, threads that stopped): each starts a turn. Everything until the next message is that turn:
 * the reply is the latest assistant text in it, and tools, notes, questions and errors are not marks.
 */
export function turnMarks(items: readonly StreamItem[]): TurnMark[] {
    const marks: TurnMark[] = [];
    let current: TurnMark | null = null;

    for (const item of items) {
        if (item.body.kind === 'user') {
            current = { id: item.id, title: titleOf(item, item.body), reply: '' };
            marks.push(current);
            continue;
        }

        if (current == null || item.body.kind !== 'assistant') continue;

        const reply = plainOf(item, item.body.text);

        if (reply !== '') current.reply = reply;
    }

    return marks;
}

/** Scroll the stream so the person's message sits just under the top. No-op when the message is not in it. */
export function scrollStreamToTurn(scroll: HTMLElement, id: string) {
    const message = scroll.querySelector<HTMLElement>(`[data-turn="${CSS.escape(id)}"]`);

    if (!message) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const top =
        message.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - JUMP_INSET;

    scroll.scrollTo({ top: Math.max(0, top), behavior: reduce ? 'auto' : 'smooth' });
}
