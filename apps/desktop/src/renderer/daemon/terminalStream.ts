import { MAX_TERMINAL_INPUT_BYTES, TERMINAL_SUBPROTOCOL, terminalTokenProtocol } from '@clowdy/protocol';

import type { TerminalClientMessage, TerminalScreen, TerminalServerMessage } from '@clowdy/protocol';

/**
 * - `connecting`: the first connection is being made.
 * - `open`: the screen was received and input goes through.
 * - `reconnecting`: the connection dropped; the stream keeps trying, and the daemon sends a new screen when it connects, which replaces whatever was shown.
 */
export type TerminalStreamStatus = 'connecting' | 'open' | 'reconnecting';

export interface TerminalStreamHandlers {
    /** The screen as it is, at the shell's size: first, after every reconnect, and when the daemon had to skip output for a slow connection. It replaces what was shown. */
    onScreen: (screen: TerminalScreen) => void;
    /** What the shell prints after the last screen, in order. */
    onOutput: (data: Uint8Array) => void;
    onExit: (exitCode: number) => void;
    onStatus: (status: TerminalStreamStatus) => void;
    /** The daemon no longer has the terminal (it was closed from elsewhere, or the daemon started again): the stream has ended. */
    onGone: () => void;
}

/** One terminal of the daemon, followed by this window. */
export interface TerminalStream {
    /** Types into the shell. `false` when the stream is not open, and the input is dropped: the view should not take keystrokes it cannot deliver. */
    write: (data: string) => boolean;
    resize: (cols: number, rows: number) => void;
    /** Leaves the terminal. The shell keeps running. */
    close: () => void;
}

export interface TerminalSocketOptions {
    /** The terminal's `ws://` address and the daemon's token, read at each connection so a daemon that was replaced is found where it is now. */
    address: () => { url: string; token: string };
    /** Whether the daemon still has the terminal: `undefined` when it cannot be told (the daemon is out of reach). Asked after a connection failed. */
    exists: () => Promise<boolean | undefined>;
    handlers: TerminalStreamHandlers;
    /** For tests. */
    WebSocket?: typeof WebSocket;
    sleep?: (ms: number) => Promise<void>;
}

export const RECONNECT_MIN_MS = 250;
export const RECONNECT_MAX_MS = 5000;

/** A frame of input is at most 64 KiB of bytes; a string of this many UTF-16 units is at most three times that in UTF-8, which stays under it. */
const INPUT_CHUNK_UNITS = Math.floor(MAX_TERMINAL_INPUT_BYTES / 3);

const sleepFor = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Cuts text into pieces a frame can carry, never between the two halves of a character outside the BMP. */
export function chunkInput(text: string): string[] {
    const chunks: string[] = [];

    for (let start = 0; start < text.length; ) {
        let end = Math.min(start + INPUT_CHUNK_UNITS, text.length);
        const last = text.charCodeAt(end - 1);

        if (end < text.length && last >= 0xd800 && last <= 0xdbff) {
            end -= 1;
        }

        chunks.push(text.slice(start, end));
        start = end;
    }

    return chunks;
}

/**
 * A terminal's WebSocket stream, kept alive: it reconnects with a growing pause when the connection drops and stops when the terminal is gone or
 * `close` is called. The daemon starts every connection with the screen, so nothing has to be replayed or reconciled here.
 */
export class TerminalSocket implements TerminalStream {
    readonly #options: TerminalSocketOptions;
    readonly #encoder = new TextEncoder();
    #socket: WebSocket | undefined;
    #open = false;
    #closed = false;

    constructor(options: TerminalSocketOptions) {
        this.#options = options;
        options.handlers.onStatus('connecting');
        void this.#run();
    }

    write(data: string): boolean {
        if (!this.#open || !this.#socket) {
            return false;
        }

        for (const chunk of chunkInput(data)) {
            this.#socket.send(this.#encoder.encode(chunk));
        }

        return true;
    }

    resize(cols: number, rows: number): void {
        if (this.#open && this.#socket) {
            this.#socket.send(JSON.stringify({ type: 'resize', cols, rows } satisfies TerminalClientMessage));
        }
    }

    close(): void {
        this.#closed = true;
        this.#socket?.close();
    }

    async #run(): Promise<void> {
        const sleep = this.#options.sleep ?? sleepFor;
        let delay = RECONNECT_MIN_MS;

        while (!this.#closed) {
            const opened = await this.#connect();

            if (this.#closed) {
                return;
            }

            // A connection that was up resets the pause: the next drop is a new one.
            delay = opened ? RECONNECT_MIN_MS : delay;
            this.#options.handlers.onStatus('reconnecting');

            if (!opened) {
                const exists = await this.#options.exists();

                // Closed while the daemon was being asked: the owner is already done with the stream, and needs no word of it.
                if (this.#closed) {
                    return;
                }

                if (exists === false) {
                    this.#closed = true;
                    this.#options.handlers.onGone();

                    return;
                }
            }

            await sleep(delay);
            delay = Math.min(delay * 2, RECONNECT_MAX_MS);
        }
    }

    /** One connection, from the attempt to its end. Resolves whether the daemon accepted it. */
    #connect(): Promise<boolean> {
        const { address, handlers, WebSocket: Socket = WebSocket } = this.#options;
        const { url, token } = address();

        return new Promise(resolve => {
            let opened = false;
            let socket: WebSocket;

            try {
                socket = new Socket(url, [TERMINAL_SUBPROTOCOL, terminalTokenProtocol(token)]);
            } catch {
                resolve(false);

                return;
            }

            socket.binaryType = 'arraybuffer';
            this.#socket = socket;
            socket.onopen = () => {
                opened = true;
            };
            socket.onmessage = event => {
                if (typeof event.data === 'string') {
                    const message = this.#parse(event.data);

                    if (message?.type === 'screen') {
                        this.#open = true;
                        handlers.onStatus('open');
                        handlers.onScreen(message);
                    } else if (message?.type === 'exit') {
                        handlers.onExit(message.exitCode);
                    }
                } else {
                    handlers.onOutput(new Uint8Array(event.data as ArrayBuffer));
                }
            };
            socket.onclose = () => {
                this.#open = false;
                resolve(opened);
            };
            socket.onerror = () => {
                // `close` follows; nothing to add.
            };
        });
    }

    #parse(text: string): TerminalServerMessage | undefined {
        try {
            const message = JSON.parse(text) as TerminalServerMessage;

            return typeof message === 'object' && message !== null ? message : undefined;
        } catch {
            return undefined;
        }
    }
}
