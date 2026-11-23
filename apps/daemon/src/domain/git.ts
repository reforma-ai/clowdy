import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { CommandError, unavailable } from '../errors';

const run = promisify(execFile);

/** A read on a person's folder that takes longer than this is given up: the folder may be on a disk that does not answer. */
const READ_TIMEOUT_MS = 5000;

export interface GitResult {
    ok: boolean;
    stdout: string;
    stderr: string;
}

/**
 * Runs git synchronously. Only for short commands (rev-parse, init, a commit). With `timeoutMs` a git that does not answer in time is `unavailable`, not a
 * "no": a caller that holds up the whole daemon while it waits (a command inside a transaction) says how long it may.
 */
export function git(cwd: string, args: string[], timeoutMs?: number): GitResult {
    try {
        const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...(timeoutMs !== undefined && { timeout: timeoutMs, killSignal: 'SIGKILL' }) });

        if (result.exitedDueToTimeout) {
            throw unavailable('git did not answer');
        }

        return { ok: result.exitCode === 0, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString().trim() };
    }
    catch (error) {
        throw error instanceof CommandError ? error : unavailable('git is not installed or not on PATH');
    }
}

/** The most a read of a list (branches, worktrees, changed files) may print: git run through `execFile` fails for more, which a caller reads as "could not tell". */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * The environment of every read: no prompt for a password, no index lock (these reads run in the person's repositories while they work in them, and a `status` would
 * refresh the index under that lock), and English with no translation or collation of the person's locale, so what is read from git's words is the same everywhere.
 */
function readEnvironment(): NodeJS.ProcessEnv {
    return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LANGUAGE: 'C', LC_ALL: 'C' };
}

/**
 * What the person's git configuration may not change in the output of a read that is parsed: no quoted paths, no colour, no prefixes on the paths of a diff, no paths
 * relative to a folder, no signatures in a log, no submodule summaries. A command that a person's `diff.external` or textconv could change takes `--no-ext-diff` and
 * `--no-textconv` itself.
 */
const PARSED_OUTPUT_CONFIG = [
    'core.quotepath=false',
    'color.ui=never',
    'diff.noprefix=false',
    'diff.mnemonicprefix=false',
    'diff.srcprefix=a/',
    'diff.dstprefix=b/',
    'diff.relative=false',
    'diff.submodule=short',
    'log.showsignature=false',
    'status.submodulesummary=false',
].flatMap(setting => ['-c', setting]);

/** What a read of git may be told besides its arguments. */
export interface GitOptions {
    /** How long git may run before it is killed and the read is `unavailable`; `READ_TIMEOUT_MS` (5 s) when absent. */
    timeoutMs?: number;
    /** The output is parsed: git is run with `PARSED_OUTPUT_CONFIG`, so the person's configuration cannot change what it prints. */
    parsed?: boolean;
}

export interface GitReadOptions extends GitOptions {
    /** The most bytes git may print before it is killed and the read is `unavailable`; `MAX_OUTPUT_BYTES` (8 MiB) when absent. */
    maxBytes?: number;
    /** Text written to git's standard input, which is then closed (`hash-object --stdin`, `cat-file --batch-check`). */
    input?: string;
}

/** What a read of git came to: its stdout, or why there is none (`failed`: git ran and said no, as it does outside a repository; `unavailable`: it could not be run, did not answer in time or printed too much). */
export type GitRead = { ok: true; stdout: string } | { ok: false; reason: 'failed' | 'unavailable' };

const withConfig = (args: string[], parsed: boolean | undefined) => (parsed ? [...PARSED_OUTPUT_CONFIG, ...args] : args);

/**
 * Runs git in `cwd` and reads its stdout without holding up the daemon (the sync `git` stops everything while it runs, and on a stale network disk for as long as that
 * takes). It gives up after `READ_TIMEOUT_MS` and for more than `MAX_OUTPUT_BYTES`; a read that needs more says so in its `options`.
 */
export async function gitRead(cwd: string, args: string[], options: GitReadOptions = {}): Promise<GitRead> {
    try {
        const pending = run('git', withConfig(args, options.parsed), {
            cwd,
            timeout: options.timeoutMs ?? READ_TIMEOUT_MS,
            killSignal: 'SIGKILL',
            windowsHide: true,
            maxBuffer: options.maxBytes ?? MAX_OUTPUT_BYTES,
            env: readEnvironment(),
        });

        // A git that exits before it reads its input closes the pipe: that is its answer, which the read below reports, not a failure of ours.
        pending.child.stdin?.on('error', () => undefined);

        if (options.input !== undefined) {
            pending.child.stdin?.end(options.input);
        }

        const { stdout } = await pending;

        return { ok: true, stdout };
    }
    catch (error) {
        // A process that ran and exited with a code is git's own answer; one that did not start, was killed for the time or for the size is not.
        const { code, killed } = error as { code?: unknown; killed?: boolean };

        return { ok: false, reason: typeof code === 'number' && !killed ? 'failed' : 'unavailable' };
    }
}

/** What a read of the NUL-separated records git prints came to: the records it read (the last may be cut short by `maxRecords`, which `truncated` says), or why there are none. */
export type GitRecords = { ok: true; records: string[]; truncated: boolean } | { ok: false; reason: 'failed' | 'unavailable' };

export interface GitRecordsOptions extends GitOptions {
    /** git is killed once it has printed one more record than this: a listing too long to be wanted whole (every file of a tree that is all new) costs no more than this. */
    maxRecords: number;
}

/**
 * Runs git in `cwd` with `-z` output and reads its records as they come, stopping git once more than `maxRecords` are in: a `status` or a listing of new files in a tree
 * that is all new would otherwise print for as long as it takes and fill the daemon's memory. The records are decoded text without their NUL.
 */
export function gitRecords(cwd: string, args: string[], { maxRecords, timeoutMs = READ_TIMEOUT_MS, parsed }: GitRecordsOptions): Promise<GitRecords> {
    return new Promise((resolve) => {
        const records: string[] = [];
        let rest: Buffer = Buffer.alloc(0);
        let cut = false;
        let done = false;
        const finish = (result: GitRecords) => {
            if (!done) {
                done = true;
                clearTimeout(timer);
                resolve(result);
            }
        };
        let child: ReturnType<typeof spawn>;

        try {
            child = spawn('git', withConfig(args, parsed), { cwd, env: readEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        }
        catch {
            resolve({ ok: false, reason: 'unavailable' });

            return;
        }

        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish({ ok: false, reason: 'unavailable' });
        }, timeoutMs);

        child.on('error', () => finish({ ok: false, reason: 'unavailable' }));
        child.stdout?.on('data', (chunk: Buffer) => {
            if (cut) return;

            rest = rest.length > 0 ? Buffer.concat([rest, chunk]) : chunk;

            let start = 0;

            for (let end = rest.indexOf(0, start); end !== -1; end = rest.indexOf(0, start)) {
                if (records.length >= maxRecords) {
                    cut = true;
                    child.kill('SIGKILL');

                    return;
                }

                records.push(rest.toString('utf8', start, end));
                start = end + 1;
            }

            rest = rest.subarray(start);
        });
        child.on('close', (code) => {
            if (cut) {
                finish({ ok: true, records, truncated: true });
            }
            else if (code === 0) {
                // Output that does not end in a NUL (a git that wrote no `-z` record at all) is one more record.
                if (rest.length > 0) records.push(rest.toString('utf8'));

                finish({ ok: true, records, truncated: false });
            }
            else {
                finish({ ok: false, reason: code === null ? 'unavailable' : 'failed' });
            }
        });
    });
}

/** What git prints on stdout in `cwd` (`gitRead`): nothing when it fails for any reason, an empty string when it prints nothing. */
export async function gitOutput(cwd: string, args: string[], options?: GitReadOptions): Promise<string | undefined> {
    const read = await gitRead(cwd, args, options);

    return read.ok ? read.stdout : undefined;
}

/** The first line git prints in `cwd` (`gitOutput`): nothing when git fails, prints nothing or does not answer. */
export async function gitLine(cwd: string, args: string[], options?: GitReadOptions): Promise<string | undefined> {
    return (await gitOutput(cwd, args, options))?.trim().split('\n')[0] || undefined;
}
