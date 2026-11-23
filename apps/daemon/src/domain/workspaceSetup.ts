import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { STOPPED_TOOL } from '@clowdy/protocol';

import { DEFAULT_TIMINGS } from '../config';
import { NEVER_INHERITED } from '../engine/acp/env';
import { runLines } from './lines';

import type { WorkspaceSetup } from '@clowdy/protocol';

/** A refusal or a failure of the setup, in words the person reads; `prepareWorkspace` turns it into the reason the turn fails with. */
export class SetupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SetupError';
    }
}

/** What `runSetup` is asked to do, and where. */
export interface SetupRun {
    /** The folder's own checkout: the files are copied from it, and it is `CLOWDY_ROOT_PATH`. */
    root: string;
    /** The worktree: the files go into it, the command runs in it, and it is `CLOWDY_WORKSPACE_PATH`. */
    workspace: string;
    /** The worktree's branch, `CLOWDY_BRANCH`; empty when it has none. */
    branch?: string;
    setup: WorkspaceSetup;
    /** Where the step writes what it does and what the command prints, line by line. */
    log(line: string): void;
    /** A Stop: the command is killed with everything it started, and the step ends as stopped. */
    signal?: AbortSignal;
    /** How long the command may run: a `bun install` of a large repository takes minutes, and this only ends one that has hung; `DEFAULT_TIMINGS.setupMs` when absent. */
    timeoutMs?: number;
}

/* ------------------------------- Copying files ------------------------------- */

/** A name git keeps its data in, or that Windows reads as one (a trailing dot or space is dropped, `GIT~1` is its short name): never a file to copy. */
const isGitName = (part: string): boolean => {
    const name = part.replace(/[. ]+$/, '').toLowerCase();

    return name === '.git' || /^git~\d+$/.test(name);
};

/** Whether `path` is not `base` or something below it. Both are real paths (links followed): the answer says where a file really is, whatever it was called. */
function leavesFolder(base: string, path: string): boolean {
    const inside = relative(base, path);

    return inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside);
}

/** Whether the way from `base` down to `path` goes through a git name. */
const reachesGit = (base: string, path: string): boolean => relative(base, path).split(sep).some(isGitName);

const realOf = (path: string): Promise<string> => realpath(path);
const namesIn = (path: string): Promise<string[]> => readdir(path);

/** What a path is on the disk, or `undefined` when nothing is there (no such file, or a part of the path is no folder); anything else is thrown. */
async function look<T>(path: string, read: (path: string) => Promise<T>): Promise<T | undefined> {
    try {
        return await read(path);
    } catch (error) {
        const { code } = error as { code?: string };

        if (code === 'ENOENT' || code === 'ENOTDIR') {
            return undefined;
        }

        throw error;
    }
}

/** The real path of the nearest part of `path` that is there: where a file that is about to be made would land once the links on the way are followed. */
async function nearestReal(path: string): Promise<string> {
    const real = await look(path, realOf);

    if (real !== undefined) {
        return real;
    }

    const parent = dirname(path);

    return parent === path ? path : nearestReal(parent);
}

/**
 * A `*` in an entry's last part as the names it matches: any run of characters, a leading dot too (`.env*` is `.env`, `.env.local`), case ignored where Windows ignores
 * it. Not a regular expression: a pattern of many stars would make one backtrack for seconds on a long name, and this takes at most the product of their lengths.
 */
function matcherOf(pattern: string): (name: string) => boolean {
    const fold = process.platform === 'win32' ? (text: string) => text.toLowerCase() : (text: string) => text;
    const glob = fold(pattern);

    return name => {
        const text = fold(name);
        let at = 0;
        let from = 0;
        let star = -1;
        let resume = 0;

        while (from < text.length) {
            if (glob[at] === '*') {
                star = at++;
                resume = from;
            } else if (at < glob.length && glob[at] === text[from]) {
                at++;
                from++;
            } else if (star >= 0) {
                at = star + 1;
                from = ++resume;
            } else {
                return false;
            }
        }

        while (glob[at] === '*') {
            at++;
        }

        return at === glob.length;
    };
}

class Copier {
    private constructor(
        private root: string,
        private workspace: string,
        private log: (line: string) => void,
        private signal: AbortSignal | undefined
    ) {}

    /** The real places of the two checkouts, which every path is judged against. */
    static async open(
        root: string,
        workspace: string,
        log: (line: string) => void,
        signal?: AbortSignal
    ): Promise<Copier> {
        return new Copier(await realpath(root), await realpath(workspace), log, signal);
    }

    /**
     * Copies what an entry names: the one file, or the files of the folder that a `*` in the last part matches. An entry that is not a plain relative path in
     * the portable notation (the settings refuse them already) names nothing.
     */
    async copyEntry(entry: string): Promise<void> {
        const parts = entry.split('/');

        if (
            isAbsolute(entry) ||
            parts.some(part => part === '' || part === '.' || part === '..' || /[\\:\0]/.test(part))
        ) {
            this.log(`Skipped ${entry}: it is not a path inside the folder`);

            return;
        }

        if (parts.some(isGitName)) {
            this.log(`Skipped ${entry}: it is in .git`);

            return;
        }

        const last = parts.at(-1) as string;

        if (!last.includes('*')) {
            await this.copyOne(parts, false);

            return;
        }

        const folder = parts.slice(0, -1);
        const place = await look(join(this.root, ...folder), realOf);

        if (place === undefined) {
            return;
        }

        if (leavesFolder(this.root, place) || reachesGit(this.root, place)) {
            this.log(`Skipped ${entry}: it leads out of the folder`);

            return;
        }

        const matches = matcherOf(last);
        const names = await look(place, namesIn);

        for (const name of (names ?? []).filter(matches).sort()) {
            await this.copyOne([...folder, name], true);
        }
    }

    /**
     * Copies one file (`transfer`). A file that cannot be read or written fails the step with its errno when the entry named it (`Couldn't copy .env: EACCES`: the
     * command that follows may need it), and is skipped with a line when only a `*` matched it (a link that loops, a file nobody may read).
     */
    private async copyOne(parts: string[], matched: boolean): Promise<void> {
        try {
            await this.transfer(parts, matched);
        } catch (error) {
            if (error instanceof SetupError) {
                throw error;
            }

            const { code } = error as { code?: string };
            const reason = code ?? (error instanceof Error ? error.message : String(error));

            if (!matched) {
                throw new SetupError(`Couldn't copy ${parts.join('/')}: ${reason}`);
            }

            this.log(`Skipped ${parts.join('/')}: couldn't copy it (${reason})`);
        }
    }

    /**
     * Copies one file of the main checkout to the same place in the worktree. Only a file that is there is copied, never a folder or anything else that is not a
     * file, never one that is in `.git`, and never one whose real place (a link followed) is outside the folder. A file the worktree has already, a link or a
     * link with nothing behind it included, is left as it is. `matched` says the file came from a `*`, whose misses are not worth a line.
     */
    private async transfer(parts: string[], matched: boolean): Promise<void> {
        if (this.signal?.aborted) {
            throw new SetupError(STOPPED_TOOL);
        }

        // What a `*` expands to may be named `.git`; the file is not copied, and it is no news.
        if (parts.some(isGitName)) {
            return;
        }

        const name = parts.join('/');
        const from = join(this.root, ...parts);
        const to = join(this.workspace, ...parts);
        // The real place of the file, a link followed: nothing, for a file that is not in the main checkout (or a link with nothing behind it).
        const source = await look(from, realOf);

        if (source === undefined) {
            return;
        }

        if (leavesFolder(this.root, source) || reachesGit(this.root, source)) {
            this.log(`Skipped ${name}: it leads out of the folder`);

            return;
        }

        if (!(await stat(source)).isFile()) {
            if (!matched) {
                this.log(`Skipped ${name}: it is not a file`);
            }

            return;
        }

        if (await look(to, lstat)) {
            this.log(`Kept ${name}: the worktree has it already`);

            return;
        }

        // The worktree may have a link on the way (a tracked one): the file lands where the links lead, which has to be inside it.
        const outOfTree = `Skipped ${name}: the worktree has a link on its way that leads out of it`;

        if (leavesFolder(this.workspace, await nearestReal(dirname(to)))) {
            this.log(outOfTree);

            return;
        }

        const blocked = `Skipped ${name}: the worktree has something else on its way`;

        try {
            await mkdir(dirname(to), { recursive: true });
        } catch (error) {
            // A file where the folder should be, or a link with nothing behind it: the worktree's own, left as it is.
            if (['EEXIST', 'ENOTDIR', 'ENOENT'].includes((error as { code?: string }).code ?? '')) {
                this.log(blocked);

                return;
            }

            throw error;
        }

        if (leavesFolder(this.workspace, await realpath(dirname(to)))) {
            this.log(outOfTree);

            return;
        }

        try {
            // Never over a file: the flag fails where something appeared at the path meanwhile.
            await copyFile(source, to, constants.COPYFILE_EXCL);
        } catch (error) {
            if ((error as { code?: string }).code === 'EEXIST') {
                this.log(`Kept ${name}: the worktree has it already`);

                return;
            }

            throw error;
        }

        this.log(`Copied ${name}`);
    }
}

/**
 * Copies the files a folder's setup lists from its main checkout into the same place of a new worktree. An entry is a relative path written with `/` (turned into
 * the machine's own with `node:path`, and judged by where it really leads) or has a `*` in its last part. Nothing that exists in the worktree is changed.
 */
export async function copySetupFiles(
    run: Pick<SetupRun, 'root' | 'workspace' | 'log' | 'signal'> & { files: readonly string[] }
): Promise<void> {
    const copier = await Copier.open(run.root, run.workspace, run.log, run.signal);

    for (const entry of run.files) {
        await copier.copyEntry(entry);
    }
}

/* ------------------------------ Running the command ----------------------------- */

/**
 * What the setup command is started as: a script for the system's shell. `sh -c` takes it as it is, lines and all. On Windows `cmd /c` reads one line only, so the
 * lines are joined with `&` (each runs whatever the one before came to, as in `sh`, and the last one's exit code is the command's); the line is handed over
 * whole between quotes (`/s` takes the outer pair off, so quotes inside stay as written), and Bun is told not to quote it again.
 */
export function setupShell(
    command: string,
    platform: NodeJS.Platform = process.platform,
    env: Record<string, string | undefined> = process.env
): { argv: string[]; verbatim: boolean } {
    if (platform === 'win32') {
        const line = command
            .split(/\r?\n/)
            .map(each => each.trim())
            .filter(Boolean)
            .join(' & ');

        return { argv: [env.ComSpec || env.COMSPEC || 'cmd.exe', '/d', '/s', '/c', `"${line}"`], verbatim: true };
    }

    return { argv: ['sh', '-c', command], verbatim: false };
}

/**
 * The environment of the command: the daemon's own without its settings and secrets (`CLOWDY_TOKEN` and the rest of `CLOWDY_*`, as an agent's shell does not get
 * them), so no variable of the daemon can stand in for the three set here, then the three.
 */
function setupEnvironment(run: Pick<SetupRun, 'root' | 'workspace' | 'branch'>): Record<string, string> {
    const env: Record<string, string> = {};

    for (const [name, value] of Object.entries(process.env)) {
        if (value !== undefined && !NEVER_INHERITED.some(pattern => pattern.test(name))) {
            env[name] = value;
        }
    }

    return {
        ...env,
        CLOWDY_ROOT_PATH: run.root,
        CLOWDY_WORKSPACE_PATH: run.workspace,
        CLOWDY_BRANCH: run.branch ?? '',
    };
}

/** A length of time for a person: whole minutes, else seconds. */
function lasting(ms: number): string {
    const minutes = ms / 60_000;

    if (Number.isInteger(minutes)) {
        return minutes === 1 ? '1 minute' : `${minutes} minutes`;
    }

    const seconds = Math.max(1, Math.round(ms / 1000));

    return seconds === 1 ? '1 second' : `${seconds} seconds`;
}

async function runCommand(run: SetupRun, command: string): Promise<void> {
    const shell = setupShell(command);
    const timeoutMs = run.timeoutMs ?? DEFAULT_TIMINGS.setupMs;

    run.log('Running the setup command');

    let result;

    try {
        result = await runLines(shell.argv, {
            cwd: run.workspace,
            env: setupEnvironment(run),
            signal: run.signal,
            timeoutMs,
            windowsVerbatimArguments: shell.verbatim,
            onLine(line) {
                if (line.trim() !== '') {
                    run.log(line);
                }
            },
        });
    } catch (error) {
        // A shell that is not there; anything else (the stream's own write failing, say) is thrown as it is.
        if ((error as { code?: unknown } | undefined)?.code === 'ENOENT') {
            throw new SetupError(
                `Couldn't run the setup command: ${shell.argv[0]} is not installed or not on the PATH`
            );
        }

        throw error;
    }

    if (result.aborted) {
        throw new SetupError(STOPPED_TOOL);
    }

    if (result.timedOut) {
        throw new SetupError(`The setup command was stopped after ${lasting(timeoutMs)}`);
    }

    if (result.code !== 0) {
        throw new SetupError(
            result.code === null
                ? 'The setup command was killed'
                : `The setup command failed with exit code ${result.code}`
        );
    }
}

/**
 * The setup of a new worktree, after its checkout: first the listed files are copied from the folder's main checkout (`copySetupFiles`, each copy a line of the
 * log), then the command runs in the worktree through the system's shell with its output in the log, `CLOWDY_ROOT_PATH` (the main checkout),
 * `CLOWDY_WORKSPACE_PATH` (the worktree) and `CLOWDY_BRANCH` in its environment, and is stopped, with everything it started, after `timeoutMs` (ten minutes) or on a
 * Stop. A command that fails, that is stopped by the time or that cannot be started is a `SetupError` with the reason, and a Stop is one that says `STOPPED_TOOL`.
 * Nothing in the worktree is changed beyond the files that were not there and what the command itself does.
 */
export async function runSetup(run: SetupRun): Promise<void> {
    const command = run.setup.command?.trim();

    await copySetupFiles({ ...run, files: run.setup.files });

    if (command) {
        await runCommand(run, command);
    }
}
