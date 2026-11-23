import { spawn } from 'node:child_process';

import { killProcessGroup } from '../engine/process';

/** What a program printed, and how it ended. */
export interface RunResult {
    /** The exit code; `null` when it was killed by a signal (the deadline, for one) or never started. */
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    /** Why the program could not be started (`ENOENT`, `EACCES`). */
    error?: string;
}

export interface RunOptions {
    env: Record<string, string>;
    cwd: string;
    timeoutMs: number;
    /** Output beyond this many characters per stream is dropped. */
    maxChars?: number;
    /** Written to the program's standard input, which is then closed. Without it standard input is closed at once. */
    input?: string;
    /** Ends the program with its group when it fires (the daemon stops); the result then has `error: 'stopped'`. */
    signal?: AbortSignal;
    /**
     * The signal that ends the program at the deadline and when `signal` fires: `SIGKILL` unless it is told otherwise. A program that must clean up after itself (git removes its
     * lock files on `SIGTERM`, and a `SIGKILL` leaves them for the person to find) is asked with `SIGTERM`, and killed after `STOP_GRACE_MS` if it is still there.
     */
    stopSignal?: NodeJS.Signals;
}

/** How long a program that was asked to stop (`RunOptions.stopSignal`) has before it is killed. */
const STOP_GRACE_MS = 2000;

const DEFAULT_MAX_CHARS = 4 * 1024 * 1024;

/**
 * Runs a program to the end and answers with what it printed. Standard input is closed (a program that waits for a
 * terminal must not hang, and one that waits for piped input for a few seconds must not be slowed), the program leads
 * its own process group so the deadline takes its children down too, and nothing is thrown: a program that cannot be
 * started is a result with `error`.
 */
export function runProgram(command: string, args: string[], { env, cwd, timeoutMs, maxChars = DEFAULT_MAX_CHARS, input, signal, stopSignal = 'SIGKILL' }: RunOptions): Promise<RunResult> {
    return new Promise((resolve) => {
        let child: ReturnType<typeof spawn>;

        if (signal?.aborted) {
            resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: 'stopped' });

            return;
        }

        try {
            child = spawn(command, args, { cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });

            if (input !== undefined) {
                // A program that exits before it reads its input must not take the daemon down with an EPIPE.
                child.stdin?.on('error', () => undefined);
                child.stdin?.end(input);
            }
        }
        catch (error) {
            resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: error instanceof Error ? error.message : String(error) });

            return;
        }

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        const finish = (result: Omit<RunResult, 'stdout' | 'stderr' | 'timedOut'>) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve({ stdout, stderr, timedOut, ...result });
        };
        const killGroup = (name: NodeJS.Signals = 'SIGKILL') => {
            if (child.pid !== undefined) {
                killProcessGroup(child.pid, name);
            }
            else {
                child.kill(name);
            }
        };
        let grace: ReturnType<typeof setTimeout> | undefined;
        /** Ends the program with the signal the caller chose; one that was only asked to stop is killed if it is still there after the grace. */
        const stop = () => {
            killGroup(stopSignal);

            if (stopSignal !== 'SIGKILL') {
                grace = setTimeout(() => killGroup(), STOP_GRACE_MS);
                grace.unref();
            }
        };
        // A program that left a child holding its pipes open never closes them: do not wait for that.
        const timer = setTimeout(() => {
            timedOut = true;
            stop();
            finish({ code: null });
        }, timeoutMs);
        const onAbort = () => {
            stop();
            finish({ code: null, error: 'stopped' });
        };

        signal?.addEventListener('abort', onAbort, { once: true });

        child.stdout?.setEncoding('utf8').on('data', (text: string) => {
            if (stdout.length < maxChars) {
                stdout += text;
            }
        });
        child.stderr?.setEncoding('utf8').on('data', (text: string) => {
            if (stderr.length < maxChars) {
                stderr += text;
            }
        });
        child.once('error', error => finish({ code: null, error: error.message }));
        // What the program left running goes with it, at once: a leftover that holds the pipes open would keep `close` from ever coming.
        child.once('exit', () => killGroup());
        child.once('close', (code) => {
            clearTimeout(grace);
            killGroup();
            finish({ code });
        });
    });
}
