import { FIXTURE_UNCOMMITTED_PATHS } from './fixtureData';
import { TransportError } from './transport';

import type { GitCommitResult, GitMessage } from '@clowdy/protocol';
import type { FixtureRemoteScript } from './fixtureGitRemote';

/** How the next commit of the fixture ends: it goes through (`ok`), git says the signing agent could not be reached (`signing`), a hook says no (`hook`), or it takes a while before it goes through (`slow`). */
export type FixtureCommitScript = 'ok' | 'signing' | 'hook' | 'slow';

/** How a request for a message ends: it is written (`ok`), the agent fails (`failed`), or it takes a while (`slow`). */
export type FixtureMessageScript = 'ok' | 'failed' | 'slow';

export interface FixtureGitWritesOptions {
    commit?: FixtureCommitScript;
    message?: FixtureMessageScript;
    /** How a fetch, a pull and a push end and where the branch stands against its upstream (`fixtureGitRemote.ts`). */
    remote?: FixtureRemoteScript;
    /** The worktree has nothing uncommitted: its files are already committed, as if a commit had taken them (the page's `&clean`), so the commit box is at its empty state. */
    clean?: true;
}

/** How long a `slow` request takes: long enough for a screenshot of its running state. */
const SLOW_MS = 2500;

/** What the fixture's agent writes for any files. */
export const FIXTURE_MESSAGE = 'feat(booking): add the weekend surcharge';

/** The lines git says when it fails in the fixture: the daemon's answers carry the line as the message and the signing one carries the hint as well. */
export const FIXTURE_SIGNING_LINE =
    'error: No private key found for public key "/Users/dev/Library/Containers/SecretAgent/PublicKeys/6e1d.pub"?';
export const FIXTURE_SIGNING_HINT = "The signing agent couldn't be reached";
export const FIXTURE_HOOK_LINE = 'pre-commit: 2 problems in src/limits.ts';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * What `POST git/commit` and `POST git/message` do in the fixtures, judged as the daemon judges them: no paths, no message and a path that is not an uncommitted file of the place are 400, and the scripts say
 * how else a commit can end. A commit takes its files out of the place's uncommitted list for good (`committedOf`: what the fixture's status and changes leave out); nothing else moves, since the fixtures keep
 * no repository.
 */
export class FixtureGitWrites {
    readonly #committed = new Map<string, Set<string>>();
    readonly #script: FixtureGitWritesOptions;
    #count = 0;

    constructor(script: FixtureGitWritesOptions = {}) {
        this.#script = script;
    }

    /** The paths already committed in a place, which its uncommitted changes no longer list. A worktree that the page asked to be clean has every one of its files committed. */
    committedOf(place: string): ReadonlySet<string> {
        const committed = this.#committed.get(place) ?? new Set<string>();

        return this.#script.clean && place !== '' ? new Set([...committed, ...FIXTURE_UNCOMMITTED_PATHS]) : committed;
    }

    /** Commits `paths` of the place, which has `uncommitted` as its uncommitted files. */
    async commit(
        place: string,
        uncommitted: readonly string[],
        paths: readonly string[],
        message: string
    ): Promise<GitCommitResult> {
        if (message.trim() === '') throw new TransportError('Write a message for the commit', 400);

        if (paths.length === 0) throw new TransportError('Pick at least one file', 400);

        const open = uncommitted.filter(path => !this.committedOf(place).has(path));
        const unknown = paths.find(path => !open.includes(path));

        if (unknown !== undefined) throw new TransportError(`${unknown} is not a changed file`, 400);

        if (this.#script.commit === 'slow') await sleep(SLOW_MS);

        if (this.#script.commit === 'signing')
            throw new TransportError(FIXTURE_SIGNING_LINE, 409, FIXTURE_SIGNING_HINT);

        if (this.#script.commit === 'hook') throw new TransportError(FIXTURE_HOOK_LINE, 409);

        this.#committed.set(place, new Set([...this.committedOf(place), ...paths]));

        const sha = (0xc0ffee00 + ++this.#count).toString(16).padEnd(40, '0');

        return { sha, shortSha: sha.slice(0, 7), subject: message.trim().split('\n')[0]!.trim() };
    }

    /** The message of the files, or why it could not be written. */
    async message(place: string, uncommitted: readonly string[], paths: readonly string[]): Promise<GitMessage> {
        const open = uncommitted.filter(path => !this.committedOf(place).has(path));

        if (paths.length === 0 || paths.some(path => !open.includes(path)))
            throw new TransportError('Pick at least one changed file', 400);

        if (this.#script.message === 'slow') await sleep(SLOW_MS);

        if (this.#script.message === 'failed') throw new TransportError("Couldn't write the message", 503);

        return { message: FIXTURE_MESSAGE };
    }
}
