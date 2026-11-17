import { unavailable } from '../errors';

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
