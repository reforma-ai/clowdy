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
        const frame = this.#data.length > 0 ? { event: this.#event || 'message', data: this.#data.join('\n'), id: this.#id } : undefined;

        this.#event = '';
        this.#data = [];
        this.#id = undefined;

        return frame;
    }
}
