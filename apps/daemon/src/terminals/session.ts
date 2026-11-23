import { isTerminalSize, TERMINAL_SCROLLBACK } from '@clowdy/protocol';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal } from '@xterm/headless';

import type {
    FolderId,
    ProjectId,
    TerminalInfo,
    TerminalServerMessage,
    TerminalState,
    WorkspaceId,
} from '@clowdy/protocol';
import type { Pty, SpawnPty } from './pty';
import type { Shell } from './shell';

/** Output is passed on once per turn of the event loop, or at once when this much has piled up: a burst becomes few frames, a keystroke's echo waits no longer than a turn. */
const MAX_BATCH_BYTES = 64 * 1024;

/** DECSET mouse report encodings (UTF-8, SGR, urxvt, SGR pixels); setting one replaces the other. */
const MOUSE_ENCODINGS = new Set([1005, 1006, 1015, 1016]);

export interface TerminalSpec {
    projectId: ProjectId;
    folderId: FolderId;
    /** The worktree of the folder the shell runs in, in place of the folder's own checkout. */
    workspaceId?: WorkspaceId;
    cwd: string;
    shell: Shell;
    env: Record<string, string>;
    cols: number;
    rows: number;
}

export type ScreenMessage = Extract<TerminalServerMessage, { type: 'screen' }>;

/** What a client of a terminal receives. All calls come from the daemon's one thread, in the order things happened. */
export interface TerminalListener {
    /** The whole screen, first and again whenever the client has to start over. Output after it continues from exactly there. */
    screen: (message: ScreenMessage) => void;
    output: (data: Uint8Array) => void;
    exit: (exitCode: number) => void;
    /** The terminal was closed: nothing more will come, and attaching again finds it gone. */
    gone: () => void;
}

interface Attachment {
    /** Output that came while the screen was being taken, by batch number; `undefined` once the client is up to date. */
    queue: Array<{ seq: number; data: Uint8Array }> | undefined;
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
    if (chunks.length === 1) {
        return chunks[0];
    }

    const result = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }

    return result;
}

/**
 * One shell on a PTY, mirrored into a headless xterm so that a client that comes later (a reloaded window, a second one, one on the far side of a bad
 * connection) is given the exact screen, full-screen programs and scrollback included, and then the live output from that very point.
 */
export class TerminalSession {
    readonly createdAt = Date.now();
    readonly #mirror: Terminal;
    readonly #serializer = new SerializeAddon();
    readonly #clients = new Map<TerminalListener, Attachment>();
    #pty: Pty | undefined;
    #state: TerminalState = 'running';
    #exitCode: number | undefined;
    #endedAt: number | undefined;
    #cols: number;
    #rows: number;
    /** Resolves once every write to the mirror so far has been parsed. */
    #parsed: Promise<void> = Promise.resolve();
    #batch: Uint8Array[] = [];
    #batchBytes = 0;
    #flushScheduled = false;
    #disposed = false;
    /** How many batches of output there have been: a client that is shown a screen knows which batches it already holds. */
    #seq = 0;
    // `addon-serialize` restores mouse tracking but not these, so a screen appends them.
    #mouseEncoding: number | undefined;
    #cursorHidden = false;

    constructor(
        readonly id: string,
        readonly spec: TerminalSpec
    ) {
        this.#cols = spec.cols;
        this.#rows = spec.rows;
        this.#mirror = new Terminal({
            cols: spec.cols,
            rows: spec.rows,
            scrollback: TERMINAL_SCROLLBACK,
            allowProposedApi: true,
        });
        this.#mirror.loadAddon(this.#serializer);
        this.#trackModes();
    }

    get state(): TerminalState {
        return this.#state;
    }

    get exitCode(): number | undefined {
        return this.#exitCode;
    }

    /** When the shell ended, if it did. */
    get endedAt(): number | undefined {
        return this.#endedAt;
    }

    get isRunning(): boolean {
        return this.#state === 'running';
    }

    get pid(): number | undefined {
        return this.#pty?.pid;
    }

    info(): TerminalInfo {
        const { projectId, folderId, workspaceId, cwd, shell } = this.spec;

        return {
            id: this.id,
            projectId,
            folderId,
            ...(workspaceId !== undefined && { workspaceId }),
            cwd,
            shell: shell.name,
            cols: this.#cols,
            rows: this.#rows,
            state: this.#state,
            exitCode: this.#exitCode,
            createdAt: this.createdAt,
        };
    }

    /** Starts the shell. Throws when the program cannot be started; nothing of the session is left running then. */
    start(spawn: SpawnPty): void {
        const { shell, cwd, env } = this.spec;

        this.#pty = spawn({
            cmd: [shell.file, ...shell.args],
            cwd,
            env,
            cols: this.#cols,
            rows: this.#rows,
            onData: data => this.#receive(data),
            onExit: exitCode => this.#ended(exitCode),
        });
    }

    write(data: string | Uint8Array): void {
        this.#pty?.write(data);
    }

    /** Resizes the shell and the mirror. A size the PTY cannot take is ignored. */
    resize(cols: number, rows: number): boolean {
        if (!this.isRunning || !isTerminalSize(cols, rows)) {
            return false;
        }

        if (cols !== this.#cols || rows !== this.#rows) {
            this.#pty?.resize(cols, rows);
            this.#mirror.resize(cols, rows);
            this.#cols = cols;
            this.#rows = rows;
        }

        return true;
    }

    kill(): void {
        this.#pty?.kill();
    }

    /**
     * Gives the client the screen as it is now, then everything the shell prints after it. Attaching a client again starts it over with a new screen, which is
     * how a client that fell behind catches up.
     */
    async attach(listener: TerminalListener): Promise<void> {
        if (this.#disposed) {
            listener.gone();

            return;
        }

        const attachment: Attachment = { queue: [] };

        this.#clients.set(listener, attachment);

        const screen = await this.#screen();

        // Detached, attached again, or the terminal closed, while the screen was being taken.
        if (!screen || this.#clients.get(listener) !== attachment) {
            return;
        }

        const { message, seq } = screen;
        const queued = attachment.queue ?? [];

        attachment.queue = undefined;
        listener.screen(message);

        for (const { seq: batch, data } of queued) {
            // The screen holds every batch up to `seq`.
            if (batch > seq) {
                listener.output(data);
            }
        }
    }

    detach(listener: TerminalListener): void {
        this.#clients.delete(listener);
    }

    /** Kills the shell, frees the mirror and tells the clients the terminal is gone. */
    dispose(): void {
        this.#disposed = true;
        this.kill();
        this.#mirror.dispose();

        const listeners = [...this.#clients.keys()];

        this.#clients.clear();

        for (const listener of listeners) {
            listener.gone();
        }
    }

    #receive(data: Uint8Array): void {
        // Bun reuses the buffer behind a chunk.
        this.#batch.push(data.slice());
        this.#batchBytes += data.length;

        if (this.#batchBytes >= MAX_BATCH_BYTES) {
            this.#flush();
        } else if (!this.#flushScheduled) {
            this.#flushScheduled = true;
            setImmediate(() => this.#flush());
        }
    }

    #flush(): void {
        this.#flushScheduled = false;

        // What a shell prints while it is being killed has nowhere to go.
        if (this.#disposed || this.#batch.length === 0) {
            return;
        }

        const data = concat(this.#batch, this.#batchBytes);
        const seq = ++this.#seq;

        this.#batch = [];
        this.#batchBytes = 0;
        this.#parsed = new Promise(resolve => this.#mirror.write(data, resolve));

        for (const [listener, attachment] of this.#clients) {
            if (attachment.queue) {
                attachment.queue.push({ seq, data });
            } else {
                listener.output(data);
            }
        }
    }

    #ended(exitCode: number): void {
        this.#flush();
        this.#state = 'exited';
        this.#exitCode = exitCode;
        this.#endedAt = Date.now();
        this.#pty = undefined;

        for (const [listener, attachment] of this.#clients) {
            // A client still being given its screen gets the state with it.
            if (!attachment.queue) {
                listener.exit(exitCode);
            }
        }
    }

    /** The mirror's screen once it has parsed everything received, and the number of the last batch it holds; `undefined` when the terminal was closed meanwhile. */
    async #screen(): Promise<{ message: ScreenMessage; seq: number } | undefined> {
        this.#flush();

        // Output can arrive while waiting; take the screen only when nothing is left to parse.
        let parsed: Promise<void>;

        do {
            parsed = this.#parsed;
            await parsed;
        } while (parsed !== this.#parsed);

        if (this.#disposed) {
            return undefined;
        }

        const modes =
            (this.#mouseEncoding ? `\x1b[?${this.#mouseEncoding}h` : '') + (this.#cursorHidden ? '\x1b[?25l' : '');
        const message: ScreenMessage = {
            type: 'screen',
            screen: this.#serializer.serialize({ scrollback: TERMINAL_SCROLLBACK }) + modes,
            cols: this.#cols,
            rows: this.#rows,
            state: this.#state,
            ...(this.#exitCode !== undefined && { exitCode: this.#exitCode }),
        };

        return { message, seq: this.#seq };
    }

    /** Watches DECSET/DECRST and RIS without consuming them; the mirror still applies each. */
    #trackModes(): void {
        const onMode =
            (isSet: boolean) =>
            (params: Array<number | number[]>): boolean => {
                for (const param of params) {
                    if (param === 25) {
                        this.#cursorHidden = !isSet;
                    } else if (typeof param === 'number' && MOUSE_ENCODINGS.has(param)) {
                        this.#mouseEncoding = isSet ? param : undefined;
                    }
                }

                return false;
            };

        this.#mirror.parser.registerCsiHandler({ prefix: '?', final: 'h' }, onMode(true));
        this.#mirror.parser.registerCsiHandler({ prefix: '?', final: 'l' }, onMode(false));
        this.#mirror.parser.registerEscHandler({ final: 'c' }, () => {
            this.#mouseEncoding = undefined;
            this.#cursorHidden = false;

            return false;
        });
    }
}
