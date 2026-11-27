export interface SseFrame {
    event: string;
    data: string;
    id?: string;
}

/**
 * Incremental parser for `text/event-stream`, fed with decoded text in chunks of any size.
 * A frame ends at a blank line; lines starting with `:` (heartbeats) and a frame without data are dropped.
 */
export class SseParser {
    #buffer = '';
    #event = '';
    #data: string[] = [];
    #id: string | undefined;

    push(chunk: string): SseFrame[] {
        this.#buffer += chunk;

        const frames: SseFrame[] = [];
        // A `\r` at the very end may be the first half of `\r\n`; wait for the next chunk to know.
        const complete = this.#buffer.endsWith('\r') ? this.#buffer.slice(0, -1) : this.#buffer;
        const lines = complete.split(/\r\n|\n|\r/);
        const rest = lines.pop() ?? '';

        this.#buffer = this.#buffer.slice(complete.length - rest.length);

        for (const line of lines) {
            if (line === '') {
                const frame = this.#flush();

                if (frame) frames.push(frame);

                continue;
            }

            if (line.startsWith(':')) continue;

            const colon = line.indexOf(':');
            const field = colon === -1 ? line : line.slice(0, colon);
            // One space after the colon belongs to the syntax.
            const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');

            if (field === 'event') this.#event = value;
            else if (field === 'data') this.#data.push(value);
            else if (field === 'id') this.#id = value;
        }

        return frames;
    }

    #flush(): SseFrame | undefined {
        const frame =
            this.#data.length > 0
                ? { event: this.#event || 'message', data: this.#data.join('\n'), id: this.#id }
                : undefined;

        this.#event = '';
        this.#data = [];
        this.#id = undefined;

        return frame;
    }
}

/** A stream that sent nothing, not even a heartbeat, for longer than its reader allows. */
class SseStalledError extends Error {}

/**
 * The frames of an event stream as they arrive. However the loop over it ends (the stream closed, the consumer threw or broke out, an abort),
 * the reader is cancelled, so no response is left open to the daemon. With `idleMs`, a stream that sends nothing for that long is cancelled
 * and the loop throws `SseStalledError`: the daemon's heartbeats count as traffic, so silence means the connection or the daemon hangs.
 */
export async function* readSse(body: ReadableStream<Uint8Array>, idleMs?: number): AsyncGenerator<SseFrame> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    let stalled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
        if (idleMs === undefined) return;

        clearTimeout(timer);
        timer = setTimeout(() => {
            stalled = true;
            void reader.cancel().catch(() => undefined);
        }, idleMs);
    };

    try {
        arm();

        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
            arm();
            yield* parser.push(decoder.decode(chunk.value, { stream: true }));
        }

        if (stalled) throw new SseStalledError(`The stream sent nothing for ${idleMs} ms`);
    } finally {
        clearTimeout(timer);
        await reader.cancel().catch(() => undefined);
    }
}
