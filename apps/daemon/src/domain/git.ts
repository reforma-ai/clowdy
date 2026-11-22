import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { unavailable } from '../errors';

const run = promisify(execFile);

/** A read on a person's folder that takes longer than this is given up: the folder may be on a disk that does not answer. */
const READ_TIMEOUT_MS = 5000;

export interface GitResult {
    ok: boolean;
    stdout: string;
    stderr: string;
}

/** Runs git synchronously. Only for short commands (rev-parse, init, a commit). */
export function git(cwd: string, args: string[]): GitResult {
    try {
        const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

        return { ok: result.exitCode === 0, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString().trim() };
    }
    catch {
        throw unavailable('git is not installed or not on PATH');
    }
}

/** The most a read of a list (branches, worktrees, changed files) may print: git run through `execFile` fails for more, which a caller reads as "could not tell". */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** What a read of git came to: its stdout, or why there is none (`failed`: git ran and said no, as it does outside a repository; `unavailable`: it could not be run, did not answer in time or printed too much). */
export type GitRead = { ok: true; stdout: string } | { ok: false; reason: 'failed' | 'unavailable' };

/**
 * Runs git in `cwd` and reads its stdout without holding up the daemon (the sync `git` stops everything while it runs, and on a stale network disk for as long as that
 * takes). It gives up after `READ_TIMEOUT_MS` and for more than `MAX_OUTPUT_BYTES`.
 */
export async function gitRead(cwd: string, args: string[]): Promise<GitRead> {
    try {
        // These reads run in the person's repositories while they work in them: git is asked not to take the index lock a `status` would refresh the index under.
        const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
        const { stdout } = await run('git', args, { cwd, timeout: READ_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES, env });

        return { ok: true, stdout };
    }
    catch (error) {
        // A process that ran and exited with a code is git's own answer; one that did not start, was killed for the time or for the size is not.
        const { code, killed } = error as { code?: unknown; killed?: boolean };

        return { ok: false, reason: typeof code === 'number' && !killed ? 'failed' : 'unavailable' };
    }
}

/** What git prints on stdout in `cwd` (`gitRead`): nothing when it fails for any reason, an empty string when it prints nothing. */
export async function gitOutput(cwd: string, args: string[]): Promise<string | undefined> {
    const read = await gitRead(cwd, args);

    return read.ok ? read.stdout : undefined;
}

/** The first line git prints in `cwd` (`gitOutput`): nothing when git fails, prints nothing or does not answer. */
export async function gitLine(cwd: string, args: string[]): Promise<string | undefined> {
    return (await gitOutput(cwd, args))?.trim().split('\n')[0] || undefined;
}
