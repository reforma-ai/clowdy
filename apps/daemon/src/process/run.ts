import { spawn } from 'node:child_process';

import { killTree, processGroupAlive } from './kill';

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
    /**
     * How long what the program left in its process group is spared after the program exited, before it is killed. Without it (the default) the group is killed at once, which
     * is what a program that backgrounds a helper and must not wait for it needs. A program that hands work to a child on its way out needs it: git starts
     * `maintenance run --auto --detach` and exits, and that child holds `objects/maintenance.lock` until it has left the group with `setsid` and finished; a kill that lands
     * first leaves the lock for good. The result does not wait for the grace: it comes when the pipes close, which is at the exit unless a leftover holds them, and then at the
     * end of the grace, when the leftover is killed. Not used on Windows, which has no groups: the tree of a pid that is gone is not worth a `taskkill` a second later, when
     * the pid may be another process's, nor after the program was stopped (`timeoutMs`, `signal`). The timer does not keep the daemon alive, so a leftover that is still there
     * when the daemon exits within the grace is left to finish.
     */
    leftoverGraceMs?: number;
    /** Called with each piece of what the program prints on its error stream as it arrives (git's progress), cut anywhere; the output kept in the result is not changed by it. */
    onStderr?: (text: string) => void;
    /**
     * Answer only when the program is gone, also after it was stopped (`timeoutMs`, `signal`), where the answer otherwise comes at the stop. A caller that cleans up after the program
     * (a half-made clone) must not do it while the program is still writing; the wait is bounded: a program that was asked to stop is killed `STOP_GRACE_MS` later, and the answer comes `STOP_GRACE_MS` after it exited even if a descendant that left its group still holds the pipes. A stopped
     * program's result has `error: 'stopped'` (and `timedOut`) as before, with the program's own `code`.
     */
    untilGone?: boolean;
}

/** How long a program that was asked to stop (`RunOptions.stopSignal`) has before it is killed. */
const STOP_GRACE_MS = 2000;

/**
 * The `leftoverGraceMs` of every `git` the daemon runs. Measured on a Linux container with git 2.56.1, six busy loops on one CPU and 960 fetches for each value: the pipes of a
 * git close after it exits with a median of 0 ms, p95 90 ms, p99 200 ms and a worst of 0.6 to 1.1 s; locks were left behind with no grace (2 and 15 of 16 repositories in two runs)
 * and with 5 ms (1), and by none from 20 ms up, though the pipes took longer than that now and then. A second is five times the p99 and fifty times the shortest grace that left
 * nothing, and it costs nothing when nothing is left: the call returns when the pipes close, not when the grace ends.
 */
export const LEFTOVER_GRACE_MS = 1000;

const DEFAULT_MAX_CHARS = 4 * 1024 * 1024;

/**
 * Runs a program to the end and answers with what it printed. Standard input is closed (a program that waits for a
 * terminal must not hang, and one that waits for piped input for a few seconds must not be slowed), the program leads
 * its own process group so the deadline takes its children down too, and nothing is thrown: a program that cannot be
 * started is a result with `error`.
 */
export function runProgram(
    command: string,
    args: string[],
    {
        env,
        cwd,
        timeoutMs,
        maxChars = DEFAULT_MAX_CHARS,
        input,
        signal,
        stopSignal = 'SIGKILL',
        leftoverGraceMs = 0,
        onStderr,
        untilGone = false,
    }: RunOptions
): Promise<RunResult> {
    return new Promise(resolve => {
        let child: ReturnType<typeof spawn>;

        if (signal?.aborted) {
            resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: 'stopped' });

            return;
        }

        try {
            child = spawn(command, args, {
                cwd,
                env,
                stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
                detached: process.platform !== 'win32',
                windowsHide: true,
            });

            if (input !== undefined) {
                // A program that exits before it reads its input must not take the daemon down with an EPIPE.
                child.stdin?.on('error', () => undefined);
                child.stdin?.end(input);
            }
        } catch (error) {
            resolve({
                code: null,
                stdout: '',
                stderr: '',
                timedOut: false,
                error: error instanceof Error ? error.message : String(error),
            });

            return;
        }

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let aborted = false;
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
                killTree(child.pid, name);
            } else {
                child.kill(name);
            }
        };
        // What the program left in its group once it has exited. Windows has no groups, and the tree of a pid that is gone is not worth a `taskkill`: the pid may be
        // another process's by now. A program that was stopped there had its tree ended by the stop.
        const killLeftovers = () => {
            if (process.platform !== 'win32') killGroup();
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
        // What the program left in its group is spared for the grace (`leftoverGraceMs`) when the caller asked for it; Windows has no groups, so it never is.
        const spare = leftoverGraceMs > 0 && process.platform !== 'win32';
        let leftover: ReturnType<typeof setTimeout> | undefined;
        // A program that left a child holding its pipes open never closes them: do not wait for that.
        const timer = setTimeout(() => {
            timedOut = true;
            stop();

            if (!untilGone) finish({ code: null });
        }, timeoutMs);
        const onAbort = () => {
            aborted = true;
            stop();

            if (!untilGone) finish({ code: null, error: 'stopped' });
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

            try {
                onStderr?.(text);
            } catch {
                // What reads the output must not take the daemon down with it.
            }
        });
        child.once('error', error => finish({ code: null, error: error.message }));
        // What the program left running goes with it, at once: a leftover that holds the pipes open would keep `close` from ever coming. With a grace it goes at the end of it, and
        // the call is answered then too, with the program's own code, so a leftover that holds the pipes still cannot keep it waiting past the grace. A program that was stopped
        // (the deadline, the daemon stopping) is not spared: it was told to go, and what it left goes with it as before.
        child.once('exit', code => {
            if (!spare || settled || aborted || timedOut) {
                killLeftovers();

                // A program that was stopped and is waited for (`untilGone`) may have a descendant that left the group and holds the pipes: it is not waited for past the grace.
                if (!settled && (aborted || timedOut)) {
                    const bound = setTimeout(
                        () => finish({ code, ...(aborted && { error: 'stopped' }) }),
                        STOP_GRACE_MS
                    );

                    bound.unref();
                }

                return;
            }

            leftover = setTimeout(() => {
                killGroup();
                finish({ code });
            }, leftoverGraceMs);
            leftover.unref();
        });
        child.once('close', code => {
            clearTimeout(grace);

            // With a grace, what is left in the group is killed at the end of it; when nothing is left (the common case), there is nothing to wait for and the timer goes.
            if (leftover === undefined) {
                killLeftovers();
            } else if (child.pid === undefined || !processGroupAlive(child.pid)) {
                clearTimeout(leftover);
            }

            finish({ code, ...(aborted && { error: 'stopped' }) });
        });
    });
}
