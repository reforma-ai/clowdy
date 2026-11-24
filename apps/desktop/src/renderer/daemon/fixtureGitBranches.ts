import { FIXTURE_BASE_COMMIT, FIXTURE_WORKTREE_PATH } from './fixtureData';
import { TransportError } from './transport';

import type {
    GitBranches,
    GitLocalBranch,
    GitRemoteBranch,
    GitStatus,
    GitStatusEntry,
    GitSwitchRequest,
    GitSwitchResult,
} from '@clowdy/protocol';

/**
 * What the page's `&branches=` says of the folder's branches and of a switch, as a list of words joined by commas (`&branches=remote,held,slow`):
 * - `remote`: `origin` has branches that no local branch is called after (`feature/search`, `release/2.1`, `chore/deps`);
 * - `held`: a worktree of the chat has `clowdy/ab12cd34` checked out, and one the person made has `feature/payments`, so git would refuse a second checkout of either;
 * - `dirty`: the folder's checkout has uncommitted files, so a switch is refused for them (and the Changes tab lists them);
 * - `refused`: two chats are working in the checkout, so a switch is refused for them;
 * - `slow`: a switch takes a while, for a look at the running state;
 * - `warned`: a switch is made and the person's `post-checkout` hook failed after it, which the answer's `warning` says;
 * - `idle`: every chat of the fixtures is at rest, so the chats working in the checkout (which the new chat's pill counts from the runs it has) are not in the way of a switch: without it five
 *   of them are, and that is what the pill says.
 */
export type FixtureBranchScript = 'remote' | 'held' | 'dirty' | 'refused' | 'slow' | 'warned' | 'idle';

/** The words the page's `&branches=` switch knows. */
export const FIXTURE_BRANCH_SCRIPTS: readonly FixtureBranchScript[] = [
    'remote',
    'held',
    'dirty',
    'refused',
    'slow',
    'warned',
    'idle',
];

/** What a `warned` switch says its hook printed. */
const HOOK_WARNING = 'post-checkout: the install failed';

/** How long a `slow` switch takes: long enough for a screenshot of its running state. */
const SLOW_MS = 2500;

/** The branches of the fixture's repository that have a local branch and a branch on `origin`. */
const TRACKED = ['main', 'dev'];

/** The branches only `origin` has, when `remote` is on. */
const REMOTE_ONLY = ['feature/search', 'release/2.1', 'chore/deps'];

/** What the fixture's person made a worktree of, when `held` is on. */
const PERSON_TREE = { branch: 'feature/payments', path: '/Users/dev/car-rental-payments' };

/** The files the checkout has changed when `dirty` is on: the worktree's own, so the Changes tab and the refusal say the same. */
const DIRTY_ENTRIES: GitStatusEntry[] = [
    { path: 'notes.md', untracked: true },
    { path: 'src/booking/price.ts', unstaged: 'modified' },
    { path: 'src/limits.ts', unstaged: 'modified' },
];

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** The branch of the place that a switch is asked about, as far as the fixture's branches need to know it. */
export interface FixtureBranchPlace {
    /** What the fixture keeps the state of the place under. */
    key: string;
    /** The branch checked out; absent on a detached HEAD. */
    branch: string | undefined;
    /** The place is a chat's worktree, whose branch stays. */
    worktree: boolean;
    /** The worktree's branch, when the place is one. */
    worktreeBranch?: string;
}

/**
 * What `GET git/branches` and `POST git/switch` do in the fixtures, judged as the daemon judges them (`git/branches.ts`, `git/switch.ts`): a worktree is refused, a name that is no name is
 * `400`, a branch a worktree holds, a tree with changes and a run in the place are `409` with the daemon's words, and a switch to a branch that only `origin` has makes the local one. The
 * fixtures keep no repository, so this keeps what changed (the branches made, the ones that became local) and `FixtureTransport` writes the branch it answers back into the folder's head.
 */
export class FixtureGitBranches {
    readonly #scripts: ReadonlySet<FixtureBranchScript>;
    /** The branches a switch made, and the remote-only ones it took, by the place's key: they are local from then on. */
    readonly #made = new Map<string, string[]>();
    readonly #took = new Map<string, Set<string>>();

    constructor(scripts: readonly FixtureBranchScript[] = []) {
        this.#scripts = new Set(scripts);
    }

    /** The chats are all at rest (`&branches=idle`). */
    get idle(): boolean {
        return this.#scripts.has('idle');
    }

    /** The checkout has uncommitted files. */
    get dirty(): boolean {
        return this.#scripts.has('dirty');
    }

    /** The checkout's status as the fixture says it, with the changed files a `dirty` checkout has. */
    dirtied(status: GitStatus): GitStatus {
        if (!this.dirty || !status.isRepository) return status;

        return { ...status, entries: structuredClone(DIRTY_ENTRIES) };
    }

    /** `GET git/branches` of a place. */
    list(place: FixtureBranchPlace): Extract<GitBranches, { isRepository: true }> {
        const now = Date.now();
        const current = place.worktree ? place.worktreeBranch : place.branch;
        const took = this.#took.get(place.key) ?? new Set<string>();
        const names = [
            ...new Set([
                ...(current === undefined ? [] : [current]),
                'main',
                'dev',
                ...(this.#made.get(place.key) ?? []),
                ...took,
                ...(this.#scripts.has('held') ? [PERSON_TREE.branch, 'clowdy/ab12cd34'] : []),
            ]),
        ];
        const holds = (name: string): GitLocalBranch['heldBy'] => {
            if (name === current) return undefined;

            if (this.#scripts.has('held') && name === 'clowdy/ab12cd34')
                return { path: FIXTURE_WORKTREE_PATH, workspaceId: 'wks_ab12cd34' };

            if (this.#scripts.has('held') && name === PERSON_TREE.branch) return { path: PERSON_TREE.path };

            return place.worktree && name === 'main' ? { path: '/Users/dev/car-rental', main: true } : undefined;
        };
        const local: GitLocalBranch[] = names.map((name, index) => ({
            name,
            ...(name === current && { current: true as const }),
            ...(name === 'main' && { default: true as const }),
            ...((TRACKED.includes(name) || took.has(name)) && { upstream: `origin/${name}` }),
            ...(holds(name) && { heldBy: holds(name) }),
            committedAt: now - (index + 1) * 3_600_000 * 7,
        }));
        const remote: GitRemoteBranch[] = this.#scripts.has('remote')
            ? REMOTE_ONLY.filter(name => !took.has(name)).map((name, index) => ({
                  name,
                  committedAt: now - (index + 1) * 86_400_000,
              }))
            : [];

        return {
            isRepository: true,
            defaultBranch: 'main',
            local,
            remote,
            recent: ['dev', 'main', ...(this.#scripts.has('held') ? [PERSON_TREE.branch] : [])].filter(
                name => name !== current && names.includes(name)
            ),
        };
    }

    /** `POST git/switch` of a place, answered as the daemon answers it; the place's branch is `answer.head.name` afterwards (the caller keeps it). */
    async switch(
        place: FixtureBranchPlace,
        request: Pick<GitSwitchRequest, 'branch' | 'create'>
    ): Promise<GitSwitchResult> {
        const { branch: name, create } = request;

        if (place.worktree) throw new TransportError("A chat's worktree keeps its branch", 400);

        if (name.trim() === '') throw new TransportError('Name the branch', 400);

        if (name.startsWith('-')) throw new TransportError('A branch name cannot start with a dash', 400);

        if (/[\s~^:?*[\\]|\.\.|@\{/.test(name)) throw new TransportError(`${name} is not a branch name`, 400);

        const listing = this.list(place);
        const found = listing.local.find(branch => branch.name === name);
        const remoteOnly = listing.remote.some(branch => branch.name === name);

        if (create) {
            if (found) throw new TransportError(`A branch called ${name} exists already`, 400);

            if (remoteOnly) throw new TransportError(`origin has a branch called ${name} already`, 400);
        } else if (found?.current) {
            return { head: { kind: 'branch', name, commit: FIXTURE_BASE_COMMIT } };
        } else if (found?.heldBy) {
            throw new TransportError(`Checked out in ${found.heldBy.path}`, 409);
        } else if (!found && !remoteOnly) {
            throw new TransportError(`There is no branch called ${name}`, 400);
        }

        if (this.#scripts.has('refused'))
            throw new TransportError('2 chats are working here', 409, 'Stop them or wait until they finish');

        if (this.dirty)
            throw new TransportError(
                'Commit or discard the changes first',
                409,
                `${DIRTY_ENTRIES.length} files changed`
            );

        if (this.#scripts.has('slow')) await sleep(SLOW_MS);

        const warning = this.#scripts.has('warned') ? { warning: HOOK_WARNING } : {};

        if (create) {
            this.#made.set(place.key, [...(this.#made.get(place.key) ?? []), name]);

            return { head: { kind: 'branch', name, commit: FIXTURE_BASE_COMMIT }, created: true, ...warning };
        }

        if (remoteOnly) {
            this.#took.set(place.key, new Set([...(this.#took.get(place.key) ?? []), name]));

            return {
                head: { kind: 'branch', name, commit: FIXTURE_BASE_COMMIT },
                upstream: { name: `origin/${name}`, ahead: 0, behind: 0 },
                created: true,
                ...warning,
            };
        }

        return {
            head: { kind: 'branch', name, commit: FIXTURE_BASE_COMMIT },
            ...(TRACKED.includes(name) && { upstream: { name: `origin/${name}`, ahead: 0, behind: 0 } }),
            ...warning,
        };
    }
}
