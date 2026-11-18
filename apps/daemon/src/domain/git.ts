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

/**
 * The first line git prints in `cwd`, read without holding up the daemon (the sync `git` stops everything while it runs, and on a stale
 * network disk for as long as that takes). Nothing when git fails, prints nothing, is not installed or does not answer in time.
 */
export async function gitLine(cwd: string, args: string[]): Promise<string | undefined> {
    try {
        const { stdout } = await run('git', args, { cwd, timeout: READ_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

        return stdout.trim().split('\n')[0] || undefined;
    }
    catch {
        return undefined;
    }
}
