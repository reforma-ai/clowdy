import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { MAX_FS_SEARCH_LINES_PER_FILE } from '@clowdy/protocol';

import { invalid, unavailable } from '../errors';
import { inheritedEnv } from '../process/env';
import { isBelow } from './paths';
import { MAX_SEARCHED_BYTES } from './search-rules';

import type { Collector, LineRange } from './search-collect';

/** How long a missing ripgrep is believed to be missing: one that is installed meanwhile is found again. */
const MISSING_TTL_MS = 30_000;
/** How long ripgrep gets to end after it was told to, before it is killed. */
const KILL_AFTER_MS = 2000;
/** What of ripgrep's own messages (a line for each unreadable file) is kept. */
const MAX_STDERR = 64 * 1024;

/** Ripgrep could not be started: it is not there, not executable, or not a program. The search falls back to the daemon's own scan. */
export class RipgrepMissing extends Error {}

/**
 * Finds the ripgrep to run: the file `CLOWDY_RG` names (when it is an executable file), else `rg` on the PATH. The answer is kept; a run that
 * cannot start ripgrep makes the next search look again, and a ripgrep that was not found is looked for again after a while.
 */
export class RipgrepLocator {
    private found: { path: string | null; at: number } | undefined;

    /** `false` means none: the daemon scans the files itself. */
    constructor(private configured?: string | false) {}

    find(): string | null {
        if (this.configured === false) {
            return null;
        }

        if (this.found && (this.found.path !== null || Date.now() - this.found.at < MISSING_TTL_MS)) {
            return this.found.path;
        }

        const path =
            (this.configured !== undefined && isExecutable(this.configured) ? this.configured : Bun.which('rg')) ??
            null;

        this.found = { path, at: Date.now() };

        return path;
    }

    /** The program found could not be started: look again next time. */
    forget(): void {
        this.found = undefined;
    }
}

function isExecutable(path: string): boolean {
    try {
        accessSync(path, constants.X_OK);

        return statSync(path).isFile();
    } catch {
        return false;
    }
}

export interface RipgrepRun {
    program: string;
    /** The real path of the folder: ripgrep runs in it, so the globs are read from it. */
    root: string;
    query: string;
    matchCase: boolean;
    wholeWord: boolean;
    /** Gitignore-style globs to leave out. */
    globs: readonly string[];
}

/**
 * The arguments of a run. The program is never given to a shell and the query always follows `-e`, so text that looks like a flag is a
 * query. Dotfiles are searched, `.gitignore` is read (ripgrep's default), links are not followed, a file over 1 MB is skipped, and a
 * file stops one line past the per-file cap so a file cut by it can be told from one that has exactly that many lines. `--no-config`
 * keeps the person's own ripgrep settings out of it, and the files come in path order (which costs the other threads).
 */
function argumentsOf(run: RipgrepRun): string[] {
    return [
        '--no-config',
        '--json',
        '--hidden',
        // One thread, files in path order: a result cut by the cap keeps the first files, the same ones every time, as the scan does.
        '--sort=path',
        '--max-filesize',
        `${MAX_SEARCHED_BYTES / 1024 / 1024}M`,
        '--max-count',
        String(MAX_FS_SEARCH_LINES_PER_FILE + 1),
        '-F',
        run.matchCase ? '-s' : '-i',
        ...(run.wholeWord ? ['-w'] : []),
        ...run.globs.flatMap(glob => ['-g', `!${glob}`]),
        '-e',
        run.query,
        '--',
        run.root,
    ];
}

interface Ended {
    code: number | null;
    stderr: string;
    /** Whether the run was ended by the caller (it asked to stop, or the signal fired), not by ripgrep. */
    stopped: boolean;
}

/**
 * Runs the program and hands each line of its output to `onLine`; a `false` from it, or the signal, kills the program. Answers when the
 * program has ended. Rejects with `RipgrepMissing` when it could not be started.
 */
function runProgram(
    program: string,
    args: string[],
    cwd: string,
    onLine: (line: string) => boolean | void,
    signal: AbortSignal
): Promise<Ended> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            resolve({ code: null, stderr: '', stopped: true });

            return;
        }

        const { RIPGREP_CONFIG_PATH: _config, ...env } = inheritedEnv();
        let child: ReturnType<typeof spawn>;

        try {
            child = spawn(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        } catch (error) {
            reject(new RipgrepMissing((error as Error).message));

            return;
        }

        const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
        let stderr = '';
        let stopped = false;
        let started = false;
        let settled = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;

        const finish = (settle: () => void) => {
            if (!settled) {
                settled = true;
                clearTimeout(killTimer);
                signal.removeEventListener('abort', stop);
                lines.close();
                settle();
            }
        };

        function stop() {
            if (stopped) {
                return;
            }

            stopped = true;
            lines.close();
            child.kill();
            killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS);
            killTimer.unref();
        }

        signal.addEventListener('abort', stop, { once: true });
        child.stderr!.on('data', (chunk: Buffer) => {
            if (stderr.length < MAX_STDERR) {
                stderr += chunk.toString();
            }
        });
        lines.on('line', line => {
            if (!stopped && onLine(line) === false) {
                stop();
            }
        });
        child.once('spawn', () => {
            started = true;
        });
        child.on('error', error => {
            // An error after the program started is a failed kill: the close that follows ends the run.
            if (!started) {
                finish(() => reject(new RipgrepMissing(error.message)));
            }
        });
        child.on('close', code => {
            finish(() => resolve({ code, stderr, stopped }));
        });
    });
}

/** The path as a result names it: relative to the folder, `/` separators. */
function relativePath(root: string, path: string): string | undefined {
    return isBelow(root, path) ? relative(root, path).split(sep).join('/') : undefined;
}

/** Ripgrep's byte offsets into a line as offsets into its string. Matches come in order, so each decodes only the bytes since the previous one: a minified line can hold thousands. */
function charRanges(text: string, submatches: ReadonlyArray<{ start: number; end: number }>): LineRange[] {
    const bytes = Buffer.from(text);
    let byte = 0;
    let char = 0;
    const offset = (target: number) => {
        char += bytes.subarray(byte, target).toString().length;
        byte = Math.max(byte, target);

        return char;
    };

    return submatches.map(({ start, end }) => ({ start: offset(start), end: offset(end) }));
}

interface MatchEvent {
    type: string;
    data: {
        path: { text?: string };
        lines: { text?: string };
        line_number: number;
        submatches: Array<{ start: number; end: number }>;
    };
}

const firstLine = (text: string) =>
    text
        .split('\n')
        .find(line => line.trim() !== '')
        ?.replace(/^rg: /, '')
        .trim() ?? '';

/**
 * Searches the folder with ripgrep, feeding the lines it finds to `collector`. A line or a path that is not UTF-8 (ripgrep gives it as
 * `bytes`) is skipped. Stops, keeping what it has, when the collector is full or the signal fires. Ripgrep refusing the request (an
 * exclude glob it cannot parse) is `invalid`; ripgrep that cannot be started rejects with `RipgrepMissing`.
 */
export async function ripgrepSearch(run: RipgrepRun, collector: Collector, signal: AbortSignal): Promise<void> {
    let output = false;
    let summary = false;

    const ended = await runProgram(
        run.program,
        argumentsOf(run),
        run.root,
        line => {
            output = true;

            let event: MatchEvent;

            try {
                event = JSON.parse(line) as MatchEvent;
            } catch {
                return;
            }

            // Ripgrep says it is done with a summary, also when it could not read some of the files (and then exits with 2).
            if (event.type === 'summary') {
                summary = true;

                return;
            }

            if (event.type !== 'match' || event.data.path.text === undefined || event.data.lines.text === undefined) {
                return;
            }

            const path = relativePath(run.root, event.data.path.text);

            if (path === undefined) {
                return;
            }

            const text = event.data.lines.text.replace(/\r?\n$/, '');

            return collector.add(path, event.data.line_number, text, charRanges(text, event.data.submatches));
        },
        signal
    );

    if (ended.stopped || summary || ended.code === 0 || ended.code === 1) {
        return;
    }

    // Before any output: ripgrep did not like the request (an exclude glob, say).
    if (ended.code === 2 && !output) {
        throw invalid(
            `The search was refused: ${firstLine(ended.stderr) || 'ripgrep could not read the request'}`.replace(
                /\.$/,
                ''
            )
        );
    }

    // It died on the way (killed by the system, say): what it found is kept.
    if (output) {
        collector.truncated = true;

        return;
    }

    throw unavailable('The search stopped before it answered');
}
