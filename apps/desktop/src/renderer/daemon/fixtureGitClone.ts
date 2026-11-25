import { TransportError } from './transport';

import type { GitCloneRequest, GitCloneTarget } from '@clowdy/protocol';
import type { GitCloneProgress } from './transport';

/**
 * How the fixture's clone ends, beyond going through:
 * - `slow`: it stops at 42% of "Receiving objects" and stays there, for a look at the running state (cancelling it works as the daemon's does);
 * - `failed`: git fails after a little progress, the way it does for an address that is not there, with a hint.
 */
export type FixtureCloneScript = 'slow' | 'failed';

/** The words the page's `&clone=` switch knows. */
export const FIXTURE_CLONE_SCRIPTS: readonly FixtureCloneScript[] = ['slow', 'failed'];

/** Where the fixture's daemon puts a repository when the person chose no folder. */
export const FIXTURE_PROJECTS_FOLDER = '/Users/dev/Clowdy/Projects';

/**
 * The few folders of the fixture's disk that the target rule looks at: `dir` is a folder, `file` a file, and a folder holds what the paths under it say. Anything not
 * listed is not on the disk, so a clone can make it. The folders `/Users/dev/empty` and `/Users/dev/clowdy` are empty; `/Users/dev/code` holds a folder `notes`, and
 * the projects folder holds `car-rental`, which holds files, so a repository of that name has nowhere to go there.
 */
const FIXTURE_DISK: Readonly<Record<string, 'dir' | 'file'>> = {
    [FIXTURE_PROJECTS_FOLDER]: 'dir',
    [`${FIXTURE_PROJECTS_FOLDER}/car-rental`]: 'dir',
    [`${FIXTURE_PROJECTS_FOLDER}/car-rental/package.json`]: 'file',
    '/Users/dev/code': 'dir',
    '/Users/dev/code/notes': 'dir',
    '/Users/dev/code/notes/todo.md': 'file',
    '/Users/dev/empty': 'dir',
    '/Users/dev/clowdy': 'dir',
    '/Users/dev/notes.txt': 'file',
};

/** The steps of a clone that goes through, one progress line each, as git prints them. */
const STEPS: readonly GitCloneProgress[] = [
    { label: 'Enumerating objects', percent: 100 },
    { label: 'Counting objects', percent: 100 },
    { label: 'Compressing objects', percent: 100 },
    { label: 'Receiving objects', percent: 18 },
    { label: 'Receiving objects', percent: 57 },
    { label: 'Receiving objects', percent: 100 },
    { label: 'Resolving deltas', percent: 64 },
    { label: 'Resolving deltas', percent: 100 },
];

/** How long each step of a clone takes, and how long a `slow` one waits where it stops. */
const STEP_MS = 320;
const SLOW_HOLD_MS = 120_000;

/** What git says for an address that is not there, and the hint the daemon adds to it. */
const FIXTURE_NOT_FOUND_HINT = 'Check the address, and that your git can sign in to it';

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        signal?.throwIfAborted();

        const abort = () => {
            clearTimeout(timer);
            reject(signal?.reason);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            resolve();
        }, ms);

        signal?.addEventListener('abort', abort, { once: true });
    });

/** The folder without the separators a copy leaves at its end; a root stays as it is. */
const trimmed = (path: string): string => (/^([a-z]:)?[\\/]+$/i.test(path) ? path : path.replace(/[\\/]+$/, ''));

/** `scheme://...`, and `[user@]host:path` (the short form of ssh; a single letter before the colon is a drive of Windows): the forms of address the daemon takes, besides an absolute path. */
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const SHORT_SSH = /^(?:[^@/\s]+@)?[^/:\s@]{2,}:(?!:)/;
const ABSOLUTE_PATH = /^(?:\/|[a-z]:[\\/])/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: a name with a control character is not a folder name
const NOT_A_NAME = /[\x00-\x1f\x7f<>"|?*]/;

/**
 * The name `git clone` gives a repository, judged as the daemon judges it: the last part of the address without `.git`, and nothing for an address it does not take (empty, not a full address
 * or an absolute path, so `owner/repo` is not one) and for one that names no repository (`https://host`).
 */
export function cloneName(url: string): string | undefined {
    const text = url.trim();

    if (!text || text.startsWith('-') || !(SCHEME_URL.test(text) || SHORT_SSH.test(text) || ABSOLUTE_PATH.test(text)))
        return undefined;

    const bare = text.replace(/[/\\]+$/, '');
    const path = SCHEME_URL.test(bare) ? bare.replace(SCHEME_URL, '').split('/').slice(1).join('/') : bare;
    const name = (path.split(/[/\\:]/).pop() ?? '').replace(/\.git$/i, '');

    return name === '' || name === '.' || name === '..' || NOT_A_NAME.test(name) ? undefined : name;
}

/**
 * What `GET git/clone-target` and `POST git/clone` do in the fixtures, judged as the daemon judges them: the target is the chosen folder itself when it is missing or empty, and a
 * folder named after the repository inside it when it holds anything; the projects folder, which is where repositories go, is never one itself. A target that exists and is not an empty
 * folder, or a chosen folder that is a file, is refused.
 * A clone that went through leaves its folder on the fake disk, so the same address cannot be cloned there again.
 */
export class FixtureGitClone {
    readonly #script: FixtureCloneScript | undefined;
    readonly #disk = new Map<string, 'dir' | 'file'>(Object.entries(FIXTURE_DISK));

    constructor(script?: FixtureCloneScript) {
        this.#script = script;
    }

    target(url: string, folder?: string): GitCloneTarget {
        const chosen = folder !== undefined && folder.trim() !== '';
        const where = trimmed(chosen ? folder.trim() : FIXTURE_PROJECTS_FOLDER);
        const name = cloneName(url);

        if (this.#disk.get(where) === 'file')
            return { folder: where, ...(name && { path: where }), blocked: `${where} is a file, not a folder` };

        if (!name) return { folder: where };

        // The projects folder is where repositories go, never one itself; a folder the person chose is the repository when there is nothing in it.
        const path = chosen && !this.#holdsAnything(where) ? where : `${where}/${name}`;
        const blocked = this.#blocked(path);

        return { folder: where, path, ...(blocked && { blocked }) };
    }

    async clone(
        request: GitCloneRequest,
        onProgress?: (progress: GitCloneProgress) => void,
        signal?: AbortSignal
    ): Promise<string> {
        const { path } = request;
        const blocked = this.#blocked(path);

        if (blocked) throw new TransportError(blocked, 409);

        if (!cloneName(request.url)) throw new TransportError(`${request.url} is not an address git can clone`, 400);

        for (const [index, step] of STEPS.entries()) {
            if (this.#script === 'failed' && index === 4)
                throw new TransportError(
                    `fatal: repository '${request.url.trim()}' not found`,
                    409,
                    FIXTURE_NOT_FOUND_HINT
                );

            if (this.#script === 'slow' && index === 4) {
                onProgress?.({ label: 'Receiving objects', percent: 42 });
                await sleep(SLOW_HOLD_MS, signal);
            }

            await sleep(STEP_MS, signal);
            onProgress?.(step);
        }

        this.#disk.set(path, 'dir');
        this.#disk.set(`${path}/README.md`, 'file');

        return path;
    }

    /** The folder holds something: a path of the disk is under it. */
    #holdsAnything(folder: string): boolean {
        return [...this.#disk.keys()].some(path => path.startsWith(`${folder}/`));
    }

    /** Why a clone cannot go to `path`: it is a file, or a folder with something in it. */
    #blocked(path: string): string | undefined {
        const kind = this.#disk.get(path);

        if (kind === 'file') return `${path} is a file, not a folder`;

        return kind === 'dir' && this.#holdsAnything(path)
            ? `${path} already exists and is not an empty folder`
            : undefined;
    }
}
