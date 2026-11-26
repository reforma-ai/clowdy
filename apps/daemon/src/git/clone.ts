import { existsSync, mkdirSync, opendirSync, readdirSync, realpathSync, rmdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { pathKey, placeOf } from '../domain/workspaces';
import { conflict, invalid, unavailable } from '../errors';
import { isInside } from '../fs/paths';
import { printedLines } from './commit';
import { checkGitWrite, runGitWrite } from './remote';
import { WriteEnvironment } from './writeEnv';

import type { GitCloneRequest, GitCloneTarget } from '@clowdy/protocol';

/** A clone of a large repository over a slow line takes a while; past this a clone that is still going is a hung one, and it is stopped and cleaned up. */
export const CLONE_TIMEOUT_MS = 30 * 60_000;

/** The least time between two progress steps of one phase that are not its last: git prints a line at every percent, which a window does not need. */
const STEP_INTERVAL_MS = 100;

/** The most lines of what git printed besides its progress that are kept: only one of them is ever shown. */
const MAX_KEPT_LINES = 200;

// biome-ignore lint/suspicious/noControlCharactersInRegex: an address or a path with a control character is refused
const CONTROL = /[\x00-\x1f\x7f]/;

/** A name that cannot be the folder of a repository on every system the app runs on. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: a name with a control character is not a folder name
const NOT_A_NAME = /[\x00-\x1f\x7f<>"|?*]/;

/** `scheme://...`: the forms git takes over the network and `file://`. */
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

/** `[user@]host:path`: the short form of ssh. A single letter before the colon is a drive of Windows, and `x::y` is a remote helper (`ext::` runs a command), which is never taken. */
const SHORT_SSH = /^(?:[^@/\s]+@)?[^/:\s@]{2,}:(?!:)/;

/** What `git clone` prints that is not progress: the line it opens with, which names the folder. */
const CLONING_INTO = /^Cloning into /;

/** `Receiving objects:  45% (45/100), 1.2 MiB | 2.0 MiB/s`, and the same after `remote: `: a phase with its percent. */
const PERCENT_STEP = /^(?:remote:\s*)?(\p{L}[\p{L} ]*?):\s+(\d{1,3})%/u;

/** `Enumerating objects: 1234, done.`: a phase that counts and has no percent. */
const COUNT_STEP = /^(?:remote:\s*)?(\p{L}[\p{L} ]*?):\s+\d+(?:,\s.*)?$/u;

/** The words git starts a line of its own with, which a number after them does not make a phase. */
const NOT_A_PHASE = /^(?:fatal|error|warning|hint|remote)$/i;

/** What is wrong with an address that cannot be cloned from, in words for the person; nothing when it can. The address itself is never part of the words. */
function addressProblem(address: string): string | undefined {
    if (address === '') return 'Enter the address of the repository';

    if (CONTROL.test(address)) return 'The address has a control character';

    if (address.startsWith('-')) return 'The address cannot start with a dash';

    if (/^ext::/i.test(address)) return 'The ext transport is not allowed';

    if (!SCHEME_URL.test(address) && !SHORT_SSH.test(address) && !isAbsolute(address))
        return 'Use the full address of the repository or an absolute path';

    return undefined;
}

/**
 * The name of the folder a repository is cloned into: the last part of its address (split on `/`, `\` and `:`) without `.git`, which is where git names it too. Nothing for an address
 * that names no repository (`https://host`, `host:`), and for a name that cannot be a folder's.
 */
export function repositoryName(address: string): string | undefined {
    const text = address.trim().replace(/[/\\]+$/, '');
    const path = SCHEME_URL.test(text) ? text.replace(SCHEME_URL, '').split('/').slice(1).join('/') : text;
    const name = (path.split(/[/\\:]/).pop() ?? '').replace(/\.git$/i, '');

    return name === '' || name === '.' || name === '..' || NOT_A_NAME.test(name) ? undefined : name;
}

/** Whether a folder has nothing in it: one entry is read, not the whole listing of a folder with thousands. */
function isEmpty(path: string): boolean {
    const folder = opendirSync(path);

    try {
        return folder.readSync() === null;
    } finally {
        folder.closeSync();
    }
}

type Look = 'missing' | 'empty' | 'holds' | 'file' | 'inside a file' | 'unreadable';

/** What is at `path`: nothing, an empty folder, a folder with something in it, a file, a place below a file, or something that cannot be looked at. A link is what it leads to. */
function look(path: string): Look {
    try {
        return statSync(path).isDirectory() ? (isEmpty(path) ? 'empty' : 'holds') : 'file';
    } catch (error) {
        const { code } = error as { code?: string };

        return code === 'ENOENT' ? 'missing' : code === 'ENOTDIR' ? 'inside a file' : 'unreadable';
    }
}

/** Why a clone cannot go to a path that looks like this; nothing when it can. */
function refusal(path: string, found: Look): string | undefined {
    switch (found) {
        case 'holds':
            return `${path} already exists and is not an empty folder`;
        case 'file':
            return `${path} is a file`;
        case 'inside a file':
            return `A parent of ${path} is a file`;
        case 'unreadable':
            return `Can't read ${path}`;
        default:
            return undefined;
    }
}

/** A step of git's progress: the phase in its own words, and how far it is when it says. */
export interface CloneStep {
    label: string;
    percent?: number;
}

/**
 * What `git clone --progress` prints on its error stream, read as it arrives. Progress is a line ended by a carriage return (git rewrites it in place), so the stream is cut at `\r`
 * and `\n`; a line that is a phase (`Receiving objects:  45% (...)`, with or without the `remote: ` before it) becomes a step, and every other line is kept for the failure's words.
 * Steps are few: one is dropped when it repeats the last, and a phase that is not finished is not sent again within `STEP_INTERVAL_MS`.
 */
export class CloneOutput {
    readonly #now: () => number;
    readonly #kept: string[] = [];
    #pending = '';
    #last: (CloneStep & { at: number }) | undefined;

    constructor(now: () => number = Date.now) {
        this.#now = now;
    }

    /** The steps in a piece of the stream, in order. */
    feed(text: string): CloneStep[] {
        const parts = (this.#pending + text).split(/[\r\n]/);

        this.#pending = parts.pop() ?? '';

        return parts.flatMap(line => this.#read(line));
    }

    /** What git printed besides its progress, one line to each, once the stream has ended. */
    finish(): string[] {
        const rest = this.#pending;

        this.#pending = '';
        this.#read(rest);

        return this.#kept;
    }

    #read(raw: string): CloneStep[] {
        const lines = printedLines(raw);
        const line = lines[0];

        if (line === undefined) return [];

        const found = PERCENT_STEP.exec(line);

        if (found) return this.#step({ label: found[1] as string, percent: Math.min(Number(found[2]), 100) });

        const counted = COUNT_STEP.exec(line);

        if (counted && !NOT_A_PHASE.test(counted[1] as string)) return this.#step({ label: counted[1] as string });

        if (!CLONING_INTO.test(line) && this.#kept.length < MAX_KEPT_LINES) this.#kept.push(line);

        return [];
    }

    #step(step: CloneStep): CloneStep[] {
        const at = this.#now();
        const last = this.#last;
        const sameLabel = last?.label === step.label;

        // A phase with no percent is told once; one with a percent is told when it moves, not faster than the window can use, and always at its end.
        if (sameLabel && (last.percent === step.percent || step.percent === undefined)) return [];

        if (sameLabel && step.percent !== 100 && at - last.at < STEP_INTERVAL_MS) return [];

        this.#last = { ...step, at };

        return [step];
    }
}

/** The ancestors of `path` that are not there yet, the shallowest first, then `path` itself. */
function missingFrom(path: string): string[] {
    const missing: string[] = [];

    for (let dir = path; look(dir) === 'missing'; dir = dirname(dir)) {
        missing.unshift(dir);

        if (dirname(dir) === dir) break;
    }

    return missing;
}

/** Takes away the folders a clone made, deepest first and only while each is empty: something else in one is not the clone's to remove. Nothing here throws. */
function removeMade(made: string[]): void {
    for (const dir of [...made].reverse()) {
        try {
            rmdirSync(dir);
        } catch {
            // Something else is in it, or it is gone.
        }
    }
}

/**
 * Makes the folders that are not there yet one at a time, so a folder somebody made meanwhile is seen (`EEXIST`) and never taken for the clone's own; answers the ones it made. A folder
 * that cannot be made leaves none of the ones made before it.
 */
function makeFolders(path: string): string[] {
    const made: string[] = [];

    try {
        for (const dir of missingFrom(path)) {
            mkdirSync(dir);
            made.push(dir);
        }
    } catch (error) {
        removeMade(made);

        const { code } = error as { code?: string };

        throw conflict(
            code === 'EEXIST'
                ? `${path} was made while the clone started`
                : code === 'EACCES' || code === 'EPERM'
                  ? `No permission to make ${path}`
                  : `Couldn't make ${path}`
        );
    }

    return made;
}

/**
 * Takes away what a clone made at `path`, once git is gone. Git removes its own half-made repository when it is stopped with `SIGTERM` or fails, so what is left to take is what a git
 * that was killed leaves: a `.git` and the files of the checkout in the folder, which is the clone's and no one else's (the folder was empty when the clone took it, or the clone made it).
 * A folder with no `.git` in it is left as it is, since whatever is in it now was put there by somebody else while the clone ran (an empty folder the person gave may be written to at once).
 * Then the folders the clone made, deepest first and only while each is empty. An empty folder the person gave stays. Nothing here throws: a clone that is being given up on has no use
 * for a second failure.
 */
async function undo(path: string, made: string[]): Promise<void> {
    if (existsSync(join(path, '.git'))) {
        try {
            for (const name of readdirSync(path))
                await rm(join(path, name), { recursive: true, force: true, maxRetries: 3 });
        } catch {
            // The folder is gone, or something in it could not be removed: the folders below are removed only if they came to be empty.
        }
    }

    removeMade(made);
}

/**
 * What an address carries that must not be shown: the credential of `scheme://user:token@host/...`, as written and as it is percent-decoded, which ssh and git print in their own forms (`user:token@host: Permission
 * denied`). Nothing for the short ssh form and a path, which carry none.
 */
function credentialsOf(address: string): string[] {
    const authority = SCHEME_URL.test(address) ? address.replace(SCHEME_URL, '').split('/')[0] : undefined;
    const at = authority?.lastIndexOf('@') ?? -1;

    if (authority === undefined || at < 0) return [];

    const userinfo = authority.slice(0, at);
    const decode = (text: string) => {
        try {
            return decodeURIComponent(text);
        } catch {
            return text;
        }
    };
    const password = userinfo.includes(':') ? userinfo.slice(userinfo.indexOf(':') + 1) : '';

    return [...new Set([userinfo, decode(userinfo), password, decode(password)])].filter(text => text !== '');
}

/** A line of git's without the credential of the address it was run with, wherever it is and in whatever form. */
function withoutCredentials(line: string, credentials: string[]): string {
    let shown = line;

    // The whole `user:token@` first, then what is left of a part of it that is on its own: short ones (a one-letter password) would take letters out of the words around them, so they are left.
    for (const secret of credentials) shown = shown.split(`${secret}@`).join('');

    for (const secret of credentials) if (secret.length >= 4) shown = shown.split(secret).join('…');

    return shown;
}

export interface GitCloneOptions {
    /** Where a clone goes when the person chose no folder: the folder of a project that has none. */
    projectsDir: string;
    environment?: WriteEnvironment;
    timeoutMs?: number;
}

/**
 * Clones a repository into a new folder (`POST /v1/git/clone`, with `GET /v1/git/clone-target` to say where first). It is the person's own `git` with their configuration and the write
 * environment (`WriteEnvironment`: no prompt for a password or for an ssh host key), as the fetch and the push are, no shell and the address after `--`: `git -c protocol.ext.allow=never
 * clone --progress --no-recurse-submodules -- <address> <path>`, so the default branch is checked out, with no submodules and no shallow clone. An address that starts with `-`, has a control
 * character, is not a full address or an absolute path, or is the `ext::` transport is `invalid`; so is a path that is not absolute.
 *
 * The folder is settled before git runs and git is given a folder that is there: a path that is not an empty folder is `conflict` (nothing is touched), a path that is not there is made, with
 * the parents it needs, by the clone itself. What the clone made is exactly what it takes away when it fails, when the request is closed (`signal`), when the daemon stops and at
 * `CLONE_TIMEOUT_MS`: the folders it made, or the contents of the empty folder it was given (the folder stays), and only once git is gone. A path that is being cloned into, or is
 * above or below one that is, is `conflict`. A credential in the address (`user:token@`) is never in a step, an error or a log: the failure is git's first useful line without it (`shownLine`).
 */
export class GitClone {
    readonly environment: WriteEnvironment;
    readonly #projectsDir: string;
    readonly #timeoutMs: number;
    readonly #stopper = new AbortController();
    /** The real places of the clones that are going on. */
    readonly #running = new Set<string>();
    readonly #active = new Set<Promise<string>>();

    constructor({ projectsDir, environment = new WriteEnvironment(), timeoutMs = CLONE_TIMEOUT_MS }: GitCloneOptions) {
        this.#projectsDir = projectsDir;
        this.environment = environment;
        this.#timeoutMs = timeoutMs;
    }

    /** Ends the clones that are going on and refuses new ones. It answers when each has taken away what it made, which the daemon waits for before it exits. */
    async stop(): Promise<void> {
        this.#stopper.abort();

        await Promise.allSettled([...this.#active]);
    }

    /**
     * `GET /v1/git/clone-target`: where a clone of `address` would go. A folder the person chose is the repository itself when it is not there or is empty (what "clone into this folder" means), and
     * holds it in `<folder>/<name>` when it has anything in it. The projects folder (no `folder`) is never the repository: it is where repositories go, so it is always `<projects>/<name>`.
     */
    target(address: string, folder?: string): GitCloneTarget {
        const chosen = folder !== undefined && folder.trim() !== '';
        const given = chosen ? folder : this.#projectsDir;

        if (!isAbsolute(given) || CONTROL.test(given)) throw invalid('The folder must be an absolute path');

        const root = resolve(given);
        const text = address.trim();
        const name = addressProblem(text) === undefined ? repositoryName(text) : undefined;
        const found = look(root);

        if (found === 'file' || found === 'inside a file' || found === 'unreadable')
            return { folder: root, ...(name !== undefined && { path: root }), blocked: refusal(root, found) as string };

        if (chosen && found !== 'holds') return { folder: root, ...(name !== undefined && { path: root }) };

        if (name === undefined) return { folder: root };

        const path = join(root, name);
        const blocked = refusal(path, look(path));

        return { folder: root, path, ...(blocked !== undefined && { blocked }) };
    }

    /**
     * `POST /v1/git/clone`: clones into `request.path` and answers its real path. `progress` gets the steps of git's own phases. `signal` is the request: when it fires git is stopped and what it made
     * is taken away (the answer is then `unavailable`, though nobody is left to read it).
     */
    async clone(request: GitCloneRequest, progress: (step: CloneStep) => void, signal: AbortSignal): Promise<string> {
        if (this.#stopper.signal.aborted) throw unavailable('The daemon is stopping');

        const address = request.url.trim();
        const problem = addressProblem(address);

        if (problem !== undefined) throw invalid(problem);

        if (!isAbsolute(request.path) || CONTROL.test(request.path))
            throw invalid('The folder must be an absolute path');

        const path = resolve(request.path);

        // Nothing awaits between the checks and the claim, so two clones to one path cannot both pass.
        const key = pathKey(placeOf(path));

        for (const other of this.#running) {
            if (isInside(other, key) || isInside(key, other)) throw conflict(`${path} is already being cloned into`);
        }

        const problemWithPath = refusal(path, look(path));

        if (problemWithPath !== undefined) throw conflict(problemWithPath);

        this.#running.add(key);

        const work = this.#cloneInto(address, path, progress, signal);

        this.#active.add(work);

        try {
            return await work;
        } finally {
            this.#active.delete(work);
            this.#running.delete(key);
        }
    }

    /** The clone itself, in `path` that is claimed and was checked: it makes the folders, runs git and takes away what it made unless git finished. */
    async #cloneInto(
        address: string,
        path: string,
        progress: (step: CloneStep) => void,
        signal: AbortSignal
    ): Promise<string> {
        const made = makeFolders(path);
        let kept = false;

        try {
            const output = new CloneOutput();
            const stopped = AbortSignal.any([signal, this.#stopper.signal]);
            const run = await runGitWrite(
                tmpdir(),
                [
                    '-c',
                    'protocol.ext.allow=never',
                    'clone',
                    '--progress',
                    '--no-recurse-submodules',
                    '--',
                    address,
                    path,
                ],
                await this.environment.of(tmpdir(), address),
                stopped,
                this.#timeoutMs,
                {
                    untilGone: true,
                    onStderr: text => {
                        for (const step of output.feed(text)) progress(step);
                    },
                }
            );
            const lines = output.finish();

            if (this.#stopper.signal.aborted) throw unavailable('The daemon is stopping');

            if (signal.aborted) throw unavailable('The clone was cancelled');

            if (run.code === 0 && run.error === undefined) {
                const real = realpathSync(path);

                kept = true;

                return real;
            }

            const credentials = credentialsOf(address);

            checkGitWrite(
                { ...run, stderr: lines.map(line => withoutCredentials(line, credentials)).join('\n'), stdout: '' },
                this.environment,
                'clone',
                'clone the repository'
            );

            throw conflict('git could not clone the repository');
        } finally {
            if (!kept) await undo(path, made);
        }
    }
}
