/** What a process that was run for its output came to. */
export interface LineRun {
    /** The exit code; `null` when the process was killed (a stop, the time) or did not start. */
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
    /** Kills the process when it aborts. */
    signal?: AbortSignal;
    /** Kills the process after this long. */
    timeoutMs?: number;
}

/** Reads a byte stream as lines and hands each to `onLine`; a last line with no break after it is handed over when the stream ends. */
async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
    const decoder = new TextDecoder();
    let rest = '';

    for await (const chunk of stream) {
        const lines = `${ rest }${ decoder.decode(chunk, { stream: true }) }`.split(/\r\n|\n|\r/);

        rest = lines.pop() ?? '';

        for (const line of lines) {
            onLine(line);
        }
    }

    rest += decoder.decode();

    if (rest !== '') {
        onLine(rest);
    }
}

/**
 * Runs a program and reports what it prints line by line while it runs, the way a person watches a log. It stops at the end of the process, which a stop or
 * the time cuts short. A program that cannot be started is thrown (`ENOENT` for one that is not installed): the caller says so in its own words.
 */
export async function runLines(argv: string[], options: LineRunOptions): Promise<LineRun> {
    const { cwd, env, onLine, signal, timeoutMs } = options;
    const child = Bun.spawn(argv, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    let timedOut = false;
    let aborted = false;
    const stop = () => {
        aborted = true;
        child.kill();
    };
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        timedOut = true;
        child.kill();
    }, timeoutMs);

    if (signal?.aborted) {
        stop();
    }
    else {
        signal?.addEventListener('abort', stop, { once: true });
    }

    try {
        await Promise.all([readLines(child.stdout, onLine), readLines(child.stderr, onLine)]);

        const code = await child.exited;

        return { code: timedOut || aborted ? null : code, timedOut, aborted };
    }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
    }
}
