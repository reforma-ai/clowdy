/** What a process that was run for its output came to. */
export interface LineRun {
    /** The exit code; `null` when the process was killed (a stop, the time) or never started. */
    code: number | null;
    /** It was killed because `timeoutMs` passed. */
    timedOut: boolean;
    /** It was killed because `signal` aborted. */
    aborted: boolean;
}

export interface LineRunOptions {
    cwd: string;
    env?: Record<string, string | undefined>;
    /** Called with each line the process prints, on stdout or stderr, as it arrives; a line ends at `\n`, `\r\n` or `\r` (a progress meter). */
    onLine(line: string): void;
    /** Kills the process, and everything it started, when it aborts. A signal that is aborted already starts nothing. */
    signal?: AbortSignal;
    /** Kills the process, and everything it started, after this long. */
    timeoutMs?: number;
    /** Windows only: the arguments go to the command line as they are, with no quoting (a `cmd /s /c "…"` line is written whole by its caller). */
    windowsVerbatimArguments?: boolean;
}

/** A process that was asked to end (SIGTERM) and does not is killed (SIGKILL) after this long. */
const KILL_GRACE_MS = 2000;

/** After the process has ended, what it started and left holding its output is waited for this long; the lines that are still to come are dropped. */
const PIPE_GRACE_MS = 1000;

interface Reader {
    done: Promise<void>;
    cancel(): void;
}

/** Reads a byte stream as lines and hands each to `onLine`; a last line with no break after it is handed over when the stream ends. */
function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Reader {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let rest = '';
    const done = (async () => {
        try {
            for (;;) {
                const { value, done: finished } = await reader.read();

                if (finished) {
                    break;
                }

                const lines = `${rest}${decoder.decode(value, { stream: true })}`.split(/\r\n|\n|\r/);

                rest = lines.pop() ?? '';

                for (const line of lines) {
                    onLine(line);
                }
            }

            rest += decoder.decode();

            if (rest !== '') {
                onLine(rest);
            }
        } finally {
            reader.releaseLock();
        }
    })();

    return { done, cancel: () => void reader.cancel().catch(() => undefined) };
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Runs a program and reports what it prints line by line while it runs, the way a person watches a log. A stop or the time ends the program and what it
 * started with it (a program of its own process group on POSIX, `taskkill /T` on Windows): SIGTERM first, SIGKILL after `KILL_GRACE_MS`, so a fetch waiting on
 * a dead network or a filter of a checkout does not outlive the call, and a program that is run without a terminal cannot ask one for a password. A child that
 * leaves the group and holds the pipes open after the program ended is not waited for longer than `PIPE_GRACE_MS`. A program that cannot be started is thrown
 * (`ENOENT` for one that is not installed): the caller says so in its own words.
 */
export async function runLines(argv: string[], options: LineRunOptions): Promise<LineRun> {
    const { cwd, env, onLine, signal, timeoutMs, windowsVerbatimArguments } = options;

    if (signal?.aborted) {
        return { code: null, timedOut: false, aborted: true };
    }

    const windows = process.platform === 'win32';
    const child = Bun.spawn(argv, {
        cwd,
        env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
        windowsVerbatimArguments,
        ...(!windows && { detached: true }),
    });
    let timedOut = false;
    let aborted = false;
    let exited = false;
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const killTree = (force: boolean) => {
        try {
            if (windows) {
                Bun.spawn(['taskkill', '/pid', String(child.pid), '/T', '/F'], {
                    stdin: 'ignore',
                    stdout: 'ignore',
                    stderr: 'ignore',
                    windowsHide: true,
                });
            } else {
                process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
            }
        } catch {
            // The group is gone already, or never was one.
            child.kill(force ? 'SIGKILL' : 'SIGTERM');
        }
    };
    const end = () => {
        if (exited || hardKill) {
            return;
        }

        killTree(false);
        hardKill = setTimeout(() => killTree(true), KILL_GRACE_MS);
    };
    const stop = () => {
        aborted = true;
        end();
    };
    const timer =
        timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                  timedOut = true;
                  end();
              }, timeoutMs);

    signal?.addEventListener('abort', stop, { once: true });

    const readers = [readLines(child.stdout, onLine), readLines(child.stderr, onLine)];

    try {
        // A line that cannot be handled (the caller's own failure) ends the program too: it must not run on with nobody reading.
        const reading = Promise.all(readers.map(reader => reader.done));

        reading.catch(() => end());

        const code = await child.exited;

        exited = true;
        await Promise.race([reading, pause(PIPE_GRACE_MS)]);

        return { code: timedOut || aborted ? null : code, timedOut, aborted };
    } finally {
        clearTimeout(timer);
        clearTimeout(hardKill);
        signal?.removeEventListener('abort', stop);

        // A program that was told to stop may have left what it started behind: nothing of it is wanted any more.
        if (!exited || aborted || timedOut) {
            killTree(true);
        }

        for (const reader of readers) {
            reader.cancel();
        }
    }
}
