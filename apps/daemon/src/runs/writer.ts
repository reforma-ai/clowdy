import { appendItem, updateItem } from '../domain/items';

import type { EngineEvent } from '../engine/types';
import type { Store } from '../store';

/** Streaming text reaches the log at most this often; the last piece is always flushed. */
const TEXT_THROTTLE_MS = 50;

/**
 * Turns one turn's engine events into stream items. Streaming text updates a single `assistant` item in place,
 * throttled; a tool call is one item that changes state. Anything that is not text ends the open message.
 */
export class TurnWriter {
    private message?: { seq?: number; text: string };
    private flushedAt = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private tools = new Map<string, number>();

    constructor(private store: Store, private runId: string, private throttleMs = TEXT_THROTTLE_MS) {}

    text(delta: string, done: boolean): void {
        this.message ??= { text: '' };
        this.message.text += delta;

        if (done) {
            this.end();
        }
        else {
            this.schedule();
        }
    }

    tool(event: Extract<EngineEvent, { type: 'tool' }>): void {
        this.end();

        const body = {
            kind: 'tool' as const,
            toolCallId: event.toolCallId,
            name: event.name,
            input: event.input,
            state: event.state,
            ...(event.output !== undefined && { output: event.output }),
            ...(event.error !== undefined && { error: event.error }),
        };
        const seq = this.tools.get(event.toolCallId);

        if (seq === undefined) {
            this.tools.set(event.toolCallId, appendItem(this.store, this.runId, body).seq);
        }
        else {
            updateItem(this.store, this.runId, seq, body);
        }
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

        this.flushedAt = Date.now();
    }
}
