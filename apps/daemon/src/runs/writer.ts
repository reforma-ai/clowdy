import { appendItem, updateItem } from '../domain/items';

import type { StreamItemBody } from '@clowdy/protocol';
import type { EngineEvent } from '../engine/types';
import type { Store } from '../store';

/** Streaming text reaches the log at most this often; the last piece is always flushed. */
const TEXT_THROTTLE_MS = 50;

/** What a call that was still running says once its turn is over (`STOPPED_TOOL` once the person stopped the run, or the daemon stopped). */
export const UNFINISHED_TOOL = 'The turn ended before this finished';

type ToolBody = Extract<StreamItemBody, { kind: 'tool' }>;

/**
 * Turns one turn's engine events into stream items. Streaming text updates a single `assistant` item in place,
 * throttled; a tool call is one item that changes state. Anything that is not text ends the open message.
 */
export class TurnWriter {
    private message?: { seq?: number; text: string; messageId?: string };
    /** The last message that was written out whole, if it said something and came with the agent's own id of it: what `takePoint` hands over. */
    private answer?: { seq: number; ref: string };
    private flushedAt = 0;
    private timer?: ReturnType<typeof setTimeout>;
    /** Each call's item and what it holds now. */
    private tools = new Map<string, { seq: number; body: ToolBody }>();

    constructor(private store: Store, private runId: string, private throttleMs = TEXT_THROTTLE_MS) {}

    /** `messageId`: the agent's id of the message, which comes with the event that ends it. */
    text(delta: string, done: boolean, messageId?: string): void {
        this.message ??= { text: '' };
        this.message.text += delta;

        if (messageId !== undefined) {
            this.message.messageId = messageId;
        }

        if (done) {
            this.end();
        }
        else {
            this.schedule();
        }
    }

    tool(event: Extract<EngineEvent, { type: 'tool' }>): void {
        this.end();

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
            this.tools.set(event.toolCallId, { seq: appendItem(this.store, this.runId, body).seq, body });
        }
        else {
            known.body = body;
            updateItem(this.store, this.runId, known.seq, body);
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
                    updateItem(this.store, this.runId, tool.seq, tool.body);
                }
            }
        });
    }

    /** Closes the open assistant message, if any: its item gets its final text and `done: true`. */
    end(): void {
        clearTimeout(this.timer);
        this.timer = undefined;

        if (this.message) {
            this.flush(true);
            this.message = undefined;
        }
    }

    private schedule(): void {
        if (this.timer) {
            return;
        }

        const wait = this.flushedAt + this.throttleMs - Date.now();

        if (wait <= 0) {
            this.flush(false);
        }
        else {
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
        const message = this.message;

        if (!message || (message.text === '' && message.seq === undefined)) {
            return;
        }

        const body = { kind: 'assistant' as const, text: message.text, done };

        if (message.seq === undefined) {
            message.seq = appendItem(this.store, this.runId, body).seq;
        }
        else {
            updateItem(this.store, this.runId, message.seq, body);
        }

        if (done) {
            this.answer = message.messageId !== undefined && message.text.trim() !== '' ? { seq: message.seq, ref: message.messageId } : undefined;
        }

        this.flushedAt = Date.now();
    }
}
