import { nextSeq } from '../db/items';
import { appendItem, rewriteItem } from '../domain/items';

import type { MessageSource, Run, StreamItem, StreamItemBody } from '@clowdy/protocol';
import type { EngineEvent } from '../engine/types';
import type { Store } from '../store';

/** Streaming text reaches the log at most this often; the last piece is always flushed. */
const TEXT_THROTTLE_MS = 50;

/** A thought is cut here: reasoning can run to many pages, and nobody reads past what a row of the stream shows. */
export const MAX_THOUGHT_CHARS = 60_000;

/** What a call that was still running says once its turn is over (`STOPPED_TOOL` once the person stopped the run, or the daemon stopped). */
export const UNFINISHED_TOOL = 'The turn ended before this finished';

type ToolBody = Extract<StreamItemBody, { kind: 'tool' }>;

/**
 * Turns one turn's engine events into stream items. Streaming text updates a single `assistant` item in place,
 * throttled, and a thought is a `reasoning` item that streams the same way; a tool call is one item that changes state. Anything that is not text ends
 * the open message, and anything that is not a thought ends the open thought, so a thought, a message and a call are items of their own. Each item is kept as
 * it was published, so writing it again reads nothing back (`rewriteItem`).
 */
export class TurnWriter {
    private message?: { item?: StreamItem; text: string; messageId?: string };
    /** The open thought, which is never open together with a message: each ends the other. */
    private thought?: { item?: StreamItem; text: string; startedAt: number };
    /**
     * When the writer last heard from the agent. A thought is dated from here, not from its first piece: an agent sends the thought whole once it has finished
     * thinking, so the time between its last word or step and the thought is the time it thought.
     */
    private heardAt = Date.now();
    /** The last message that was written out whole, if it said something and came with the agent's own id of it: what `takePoint` hands over. */
    private answer?: { seq: number; ref: string };
    /** The last message item that was written out whole, with what it says: the one a mark that comes after a thought cut its message short belongs to. */
    private closed?: { seq: number; text: string };
    private flushedAt = 0;
    private timer?: ReturnType<typeof setTimeout>;
    /** Each call's item as it was last published, and what it holds now. */
    private tools = new Map<string, { item: StreamItem; body: ToolBody }>();

    constructor(
        private store: Store,
        private run: Pick<Run, 'id' | 'projectId'>,
        private throttleMs = TEXT_THROTTLE_MS
    ) {}

    /**
     * What the agent was asked, as the first item of its stream (a native sub-agent's prompt, from the chat that holds its parent): the same `user` item a
     * thread's first message is. Written only to a stream that is still empty, so it stays the first: with an item in the stream already, or a
     * text that says nothing, nothing is written. The text is kept whole, as the thread's message is, except the blank space around it.
     */
    brief(text: string, from: MessageSource): void {
        const trimmed = text.trim();

        if (trimmed !== '' && nextSeq(this.store.db, this.run.id) === 1) {
            appendItem(this.store, this.run.id, { kind: 'user', text: trimmed, from });
        }
    }

    /** The agent's session is ready and its prompt goes out: what it thinks about is dated from now, not from the turn's start, which includes starting the agent. */
    heard(): void {
        this.heardAt = Date.now();
    }

    /** `messageId`: the agent's id of the message, which comes with the event that ends it. */
    text(delta: string, done: boolean, messageId?: string): void {
        // What the agent said after thinking is a message of its own.
        if (this.thought) {
            this.end();
        }

        // A thought cut the message short before its mark came (the mappers close a message when the prompt ends, after a thought that came last): the
        // mark names the item that holds the message's last piece, so the turn keeps its rewind point.
        if (done && delta === '' && messageId !== undefined && !this.message && this.closed) {
            this.answer = this.closed.text.trim() !== '' ? { seq: this.closed.seq, ref: messageId } : undefined;

            return;
        }

        this.message ??= { text: '' };
        this.message.text += delta;
        this.heardAt = Date.now();

        if (messageId !== undefined) {
            this.message.messageId = messageId;
        }

        if (done) {
            this.end();
        } else {
            this.schedule();
        }
    }

    /** A piece of what the agent thought; `done` ends the thought, and so does a message, a tool call and the end of the turn. */
    reasoning(delta: string, done: boolean): void {
        let grew = false;

        if (delta !== '') {
            // What it said before thinking is over.
            if (this.message) {
                this.end();
            }

            this.thought ??= { text: '', startedAt: this.heardAt };

            const text = `${this.thought.text}${delta}`.slice(0, MAX_THOUGHT_CHARS);

            // Past the cut a piece changes nothing, and the log is not written again for it (each write holds the whole thought).
            grew = text !== this.thought.text;
            this.thought.text = text;
        }

        if (!this.thought) {
            return;
        }

        this.heardAt = Date.now();

        if (done) {
            this.end();
        } else if (grew) {
            this.schedule();
        }
    }

    tool(event: Extract<EngineEvent, { type: 'tool' }>): void {
        this.end();
        this.heardAt = Date.now();

        const body: ToolBody = {
            kind: 'tool',
            toolCallId: event.toolCallId,
            name: event.name,
            input: event.input,
            state: event.state,
            ...(event.output !== undefined && { output: event.output }),
            ...(event.error !== undefined && { error: event.error }),
        };
        const known = this.tools.get(event.toolCallId);

        if (known === undefined) {
            this.tools.set(event.toolCallId, { item: appendItem(this.store, this.run.id, body), body });
        } else {
            known.body = body;
            known.item = this.write(known.item, body);
        }
    }

    /**
     * The turn is over (an answer, a failure, a Stop): closes the open message, and a call the agent never reported finished is failed with `reason`, so the
     * stream does not show it running for ever. The calls in `keep` go on: they are background work the session still waits for. One transaction for all of it.
     */
    finish(reason = UNFINISHED_TOOL, keep?: ReadonlySet<string>): void {
        this.store.tx(() => {
            this.end();

            for (const [toolCallId, tool] of this.tools) {
                if (tool.body.state === 'running' && !keep?.has(toolCallId)) {
                    tool.body = { ...tool.body, state: 'error', error: reason };
                    tool.item = this.write(tool.item, tool.body);
                }
            }
        });
    }

    /** Closes the open assistant message or thought, if any: its item gets its final text and `done: true`. */
    end(): void {
        clearTimeout(this.timer);
        this.timer = undefined;

        if (this.message) {
            this.flush(true);
            this.message = undefined;
        }

        if (this.thought) {
            this.flush(true);
            this.thought = undefined;
        }
    }

    private schedule(): void {
        if (this.timer) {
            return;
        }

        const wait = this.flushedAt + this.throttleMs - Date.now();

        if (wait <= 0) {
            this.flush(false);
        } else {
            this.timer = setTimeout(() => {
                this.timer = undefined;
                this.flush(false);
            }, wait);
        }
    }

    /**
     * The point the turn that is ending can be cut at: the item of its last message and the agent's id of it, when that message was written out whole,
     * said something, and came with an id. Handed over once. It is a candidate: anything written after it (a tool call, a steer) makes the item no end of
     * the turn, which `markRewindPoint` checks against the stream.
     */
    takePoint(): { seq: number; ref: string } | undefined {
        const { answer } = this;

        this.answer = undefined;

        return answer;
    }

    private flush(done: boolean): void {
        if (this.thought) {
            this.flushThought(this.thought, done);

            return;
        }

        const message = this.message;

        if (!message || (message.text === '' && message.item === undefined)) {
            return;
        }

        message.item = this.write(message.item, { kind: 'assistant', text: message.text, done });

        const { seq } = message.item;

        if (done) {
            this.answer =
                message.messageId !== undefined && message.text.trim() !== ''
                    ? { seq, ref: message.messageId }
                    : undefined;
            this.closed = { seq, text: message.text };
        }

        this.flushedAt = Date.now();
    }

    /** Writes the open thought out: a thought of nothing but blank space is no item, its words are trimmed, and the one that ends takes the time it lasted. */
    private flushThought(thought: NonNullable<TurnWriter['thought']>, done: boolean): void {
        const text = thought.text.trim();

        if (text === '' && thought.item === undefined) {
            return;
        }

        // The agents pad a thought with line breaks (a section break before Codex's, after Claude's): they are no part of it.
        thought.item = this.write(thought.item, {
            kind: 'reasoning',
            text,
            done,
            ...(done && { durationMs: Date.now() - thought.startedAt }),
        });
        this.flushedAt = Date.now();
    }

    /** Publishes `body` as a new item, or as what the item the writer holds says now. */
    private write(item: StreamItem | undefined, body: StreamItemBody): StreamItem {
        return item === undefined
            ? appendItem(this.store, this.run.id, body)
            : rewriteItem(this.store, this.run.projectId, item, body);
    }
}
