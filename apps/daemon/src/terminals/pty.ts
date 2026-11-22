import { constants } from 'node:os';

export interface PtySpec {
    /** The program and its arguments. */
    cmd: string[];
    cwd: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
    /** The program's output, in order. A chunk is only valid during the call: copy what is kept. */
    onData: (data: Uint8Array) => void;
    /** Once, after all the output: the program's exit code, or 128 plus the signal that ended it. */
    onExit: (exitCode: number) => void;
}

export interface Pty {
    readonly pid: number;
    write: (data: string | Uint8Array) => void;
    resize: (cols: number, rows: number) => void;
    /** Hangs the shell up, and kills it when it is still there after `graceMs`. */
    kill: (graceMs?: number) => void;
}

/** Starts a program on a pseudo-terminal. A seam for tests; `spawnPty` is the real one. */
export type SpawnPty = (spec: PtySpec) => Pty;

const KILL_GRACE_MS = 2000;

/**
 * A pseudo-terminal from Bun itself: `openpty` on macOS and Linux, ConPTY on Windows, with no native module and no second runtime to ship. The terminal is
 * given to `Bun.spawn` inline: one made first and passed in never becomes the child's controlling terminal (oven-sh/bun#33237), and then Ctrl+C, job control
 * and resizing do nothing.
 */
export const spawnPty: SpawnPty = ({ cmd, cwd, env, cols, rows, onData, onExit }) => {
    const proc = Bun.spawn(cmd, {
        cwd,
        env,
        terminal: { cols, rows, name: 'xterm-256color', data: (_terminal, data) => onData(data) },
    });
    const terminal = proc.terminal!;
    let ended = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const close = () => {
        try {
            terminal.close();
        }
        catch {
            // Already closed.
        }
    };

    void proc.exited.then(() => {
        ended = true;
        clearTimeout(killTimer);
        // Closing frees the descriptor of the PTY's master, which Bun keeps open until it is asked.
        close();

        const signal = proc.signalCode ? constants.signals[proc.signalCode] : undefined;

        onExit(proc.exitCode ?? (signal === undefined ? 1 : 128 + signal));
    });

    return {
        pid: proc.pid,
        write(data) {
            if (!ended && !terminal.closed) {
                terminal.write(data);
            }
        },
        resize(newCols, newRows) {
            if (!ended && !terminal.closed) {
                terminal.resize(newCols, newRows);
            }
        },
        kill(graceMs = KILL_GRACE_MS) {
            if (ended || killTimer !== undefined) {
                return;
            }

            // Hang-up first: an interactive shell ignores SIGTERM, and closing the master hangs up its foreground jobs too. On Windows closing
            // before the process is gone can block, so the process goes first.
            proc.kill('SIGHUP');
            close();
            killTimer = setTimeout(() => proc.kill('SIGKILL'), graceMs);
            killTimer.unref?.();
        },
    };
};
