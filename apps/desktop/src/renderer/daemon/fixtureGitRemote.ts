import { FIXTURE_SIGNING_HINT, FIXTURE_SIGNING_LINE } from './fixtureGitWrites';
import { TransportError } from './transport';

import type { GitRemoteAction, GitRemoteResult, GitUpstream } from '@clowdy/protocol';

/**
 * How the fixture's fetch, pull and push end, beyond going through: each starts the place in the state its name says, or fails the way git does.
 * - `slow`: every action takes a while, for a look at the running state;
 * - `behind`: the branch is published and origin has 2 commits that it lacks, so Pull has something to take;
 * - `ahead`: published, with 2 commits of its own that origin lacks, so Push has something to send;
 * - `level`: published and level with its upstream, last fetched 3 minutes ago (what a checkout is without a script);
 * - `never`: published and level, and the repository has never fetched;
 * - `diverged`: published, 1 commit of its own and 2 of origin's: Pull answers `diverged`, Push is rejected;
 * - `rejected`: published with 1 commit of its own, and origin has moved on: Push is rejected with git's line;
 * - `signing`: published with 1 commit to push, and the signing agent cannot be reached, with its hint;
 * - `offline`: published with 1 commit to push, and every action fails as git does with no network;
 * - `no_origin`: the repository has no remote called `origin`, so there is nothing to sync with;
 * - `detached`: HEAD is on no branch;
 * - `unborn`: the branch has no commit yet.
 */
export type FixtureRemoteScript = 'slow' | 'behind' | 'ahead' | 'level' | 'never' | 'diverged' | 'rejected' | 'signing' | 'offline' | 'no_origin' | 'detached' | 'unborn';

/** The words the page's `&remote=` switch knows. */
export const FIXTURE_REMOTE_SCRIPTS: readonly FixtureRemoteScript[] = ['slow', 'behind', 'ahead', 'level', 'never', 'diverged', 'rejected', 'signing', 'offline', 'no_origin', 'detached', 'unborn'];

/** How long before the page was opened the fixture's repository last fetched, when its script does not say it never did. */
const FETCHED_AGO_MS = 3 * 60_000;

/** How long a `slow` action takes: long enough for a screenshot of its running state. */
const SLOW_MS = 2500;

/** What git says with no network, as the daemon would send it (the credential of an address is already gone). */
const FIXTURE_OFFLINE_LINE = 'fatal: unable to access \'https://github.com/acme/car-rental.git/\': Could not resolve host: github.com';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** The place an action is run in, as far as the fixture's remote needs to know it. */
export interface FixtureRemotePlace {
    /** What the fixture keeps the state of the place under. */
    key: string;
    /** The branch checked out; absent on a detached HEAD. */
    branch: string | undefined;
    /** The place is a chat's worktree, whose branch has not been published yet. */
    worktree: boolean;
}

interface RemoteState {
    published: boolean;
    ahead: number;
    behind: number;
}

/**
 * What `POST git/fetch`, `git/pull` and `git/push` do in the fixtures, judged as the daemon judges them: a detached HEAD is refused for a pull and a push, a pull needs an upstream, a branch
 * that diverged is answered `diverged`, a push of a branch with no upstream publishes it. The fixtures keep no repository, so this keeps what the upstream says of each place (published or
 * not, ahead and behind) and `FixtureTransport` reads it back for the status: a commit made in the fixture adds one ahead of a published branch, a push takes them to 0 and a pull takes the
 * behind to 0.
 */
export class FixtureGitRemote {
    readonly #states = new Map<string, RemoteState>();
    readonly #script: FixtureRemoteScript | undefined;
    readonly #now: () => number;
    /** When the repository last fetched: the fixture has one repository, so its places share the time, as the daemon's places of one repository do. */
    #fetchedAt: number | undefined;

    constructor(script?: FixtureRemoteScript, now: () => number = Date.now) {
        this.#script = script;
        this.#now = now;
        this.#fetchedAt = script === 'never' ? undefined : now() - FETCHED_AGO_MS;
    }

    /** When the repository last fetched; nothing when it never has. A fetch and a pull set it to now. */
    get lastFetchedAt(): number | undefined {
        return this.#fetchedAt;
    }

    /** The script has no `origin` in the repository. */
    get hasOrigin(): boolean {
        return this.#script !== 'no_origin';
    }

    /** The script takes HEAD off its branch (`detached`), or leaves the branch with no commit (`unborn`). */
    get head(): 'detached' | 'unborn' | undefined {
        return this.#script === 'detached' || this.#script === 'unborn' ? this.#script : undefined;
    }

    /** The upstream the place has now, nothing for a branch that is not published yet and for a HEAD on no branch. */
    upstreamOf(place: FixtureRemotePlace): GitUpstream | undefined {
        if (place.branch === undefined) return undefined;

        const state = this.#stateOf(place);

        return state.published ? { name: `origin/${ place.branch }`, ahead: state.ahead, behind: state.behind } : undefined;
    }

    /** A commit was made in the place: a published branch is one ahead further. */
    committed(place: FixtureRemotePlace): void {
        const state = this.#stateOf(place);

        if (state.published) state.ahead++;
    }

    async run(action: GitRemoteAction, place: FixtureRemotePlace): Promise<GitRemoteResult> {
        const script = this.#script;

        if (!this.hasOrigin) throw new TransportError('The repository has no origin', 400);

        if (action !== 'fetch' && place.branch === undefined) throw new TransportError('HEAD is detached, switch to a branch to ' + action, 400);

        if (action !== 'fetch' && script === 'unborn') throw new TransportError('The branch has no commits yet', 400);

        if (script === 'slow') await sleep(SLOW_MS);

        if (script === 'offline') throw new TransportError(FIXTURE_OFFLINE_LINE, 409);

        const state = this.#stateOf(place);
        const branch = place.branch ?? '';

        if (action === 'fetch') {
            this.#fetchedAt = this.#now();

            return { state: 'done', action, ...this.#upstream(place) };
        }

        if (action === 'pull') {
            if (!state.published) throw new TransportError(`${ branch } has no upstream to pull from, publish it first`, 400);

            // A pull fetches first, whatever it finds.
            this.#fetchedAt = this.#now();

            if (state.ahead > 0 && state.behind > 0) return { state: 'diverged', upstream: this.upstreamOf(place)! };

            const pulled = state.behind;

            state.behind = 0;

            return { state: 'done', action, pulled, ...this.#upstream(place) };
        }

        if (!state.published) {
            state.published = true;
            state.ahead = 0;

            return { state: 'done', action, published: true, ...this.#upstream(place) };
        }

        if (script === 'signing') throw new TransportError(FIXTURE_SIGNING_LINE, 409, FIXTURE_SIGNING_HINT);

        // A branch that origin has commits for that it lacks is not taken, whichever script made it so.
        if (state.behind > 0 && state.ahead > 0 || script === 'rejected') throw new TransportError(`! [rejected] ${ branch } -> ${ branch } (fetch first)`, 409);

        state.ahead = 0;

        return { state: 'done', action, ...this.#upstream(place) };
    }

    /** The upstream as a part of an answer: absent when the branch has none. */
    #upstream(place: FixtureRemotePlace): { upstream?: GitUpstream } {
        const upstream = this.upstreamOf(place);

        return upstream ? { upstream } : {};
    }

    /** What the place's upstream said when it was first looked at: scripted, else a checkout is level with its upstream and a worktree's branch is not published. */
    #stateOf(place: FixtureRemotePlace): RemoteState {
        let state = this.#states.get(place.key);

        if (!state) {
            const script = this.#script;
            const scripted = script !== undefined && script !== 'slow';

            state = {
                published: !place.worktree || scripted,
                ahead: script === 'ahead' ? 2 : script === 'diverged' || script === 'rejected' || script === 'signing' || script === 'offline' ? 1 : 0,
                behind: script === 'behind' || script === 'diverged' ? 2 : 0,
            };
            this.#states.set(place.key, state);
        }

        return state;
    }
}
