import { FIXTURE_BASE_COMMIT, FIXTURE_WORKTREE_PATH } from './fixtureData';
import { TransportError } from './transport';

import type {
    ChatWorkspace,
    GitBranchDeletePreview,
    GitBranchDeleteRequest,
    GitBranchDeleteResult,
    GitBranches,
    GitBranchHolder,
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
 * - `merged`: the worktree's current branch is merged into `origin/main`; use `&clean` to clear uncommitted files;
 * - `merge-conflict`: preview an outgoing merge that would conflict;
 * - `idle`: every chat of the fixtures is at rest, so the chats working in the checkout (which the new chat's pill counts from the runs it has) are not in the way of a switch: without it five
 *   of them are, and that is what the pill says.
 */
export type FixtureBranchScript =
    | 'remote'
    | 'held'
    | 'dirty'
    | 'refused'
    | 'slow'
    | 'warned'
    | 'merged'
    | 'idle'
    | 'merge-conflict';

/** The words the page's `&branches=` switch knows. */
export const FIXTURE_BRANCH_SCRIPTS: readonly FixtureBranchScript[] = [
    'remote',
    'held',
    'dirty',
    'refused',
    'slow',
    'warned',
    'merged',
    'idle',
    'merge-conflict',
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
    /** Where the fixture keeps the branches shared by the folder and its worktrees. */
    key: string;
    /** The main checkout's branch and path. */
    branch: string | undefined;
    mainPath: string;
    /** The place is a chat's worktree. */
    worktree: boolean;
    /** The worktree's branch, when the place is one. */
    worktreeBranch?: string;
    /** Ready worktrees in this repository, with their live fixture branch. */
    worktrees: readonly Pick<ChatWorkspace, 'id' | 'path' | 'branch'>[];
    changes?: number;
}

/**
 * What `GET git/branches` and `POST git/switch` do in the fixtures, judged as the daemon judges them (`git/branches.ts`, `git/switch.ts`): an unmerged worktree is refused, a name that is no name is
 * `400`, a branch a worktree holds, a tree with changes and a run in the place are `409` with the daemon's words, and a switch to a branch that only `origin` has makes the local one. The
 * fixtures keep no repository, so this keeps what changed (the branches made, the ones that became local) and `FixtureTransport` writes the branch it answers back into the folder's head.
 */
export class FixtureGitBranches {
    readonly #scripts: ReadonlySet<FixtureBranchScript>;
    /** The local branches remembered after a switch, and the remote-only ones it took, by repository. */
    readonly #local = new Map<string, Set<string>>();
    readonly #took = new Map<string, Set<string>>();
    readonly #deletedLocal = new Map<string, Set<string>>();
    readonly #deletedOrigin = new Map<string, Set<string>>();

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

    get merged(): boolean {
        return this.#scripts.has('merged');
    }

    get mergeConflict(): boolean {
        return this.#scripts.has('merge-conflict');
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
        const holders = new Map<string, GitBranchHolder>();

        for (const { id, path, branch } of place.worktrees) {
            if (branch !== undefined) holders.set(branch, { path, workspaceId: id });
        }

        if (this.#scripts.has('held')) {
            holders.set(PERSON_TREE.branch, { path: PERSON_TREE.path });

            // The held fixture also works when the chat whose worktree it represents is absent.
            if (!place.worktrees.some(worktree => worktree.id === 'wks_ab12cd34'))
                holders.set('clowdy/ab12cd34', { path: FIXTURE_WORKTREE_PATH, workspaceId: 'wks_ab12cd34' });
        }

        if (place.worktree && place.branch !== undefined) {
            holders.set(place.branch, { path: place.mainPath, main: true });
        }

        const names = [
            ...new Set([
                ...(current === undefined ? [] : [current]),
                'main',
                'dev',
                ...(this.#local.get(place.key) ?? []),
                ...took,
                ...holders.keys(),
            ]),
        ].filter(name => !this.#deletedLocal.get(place.key)?.has(name));
        const local: GitLocalBranch[] = names.map((name, index) => {
            const holder = name === current ? undefined : holders.get(name);

            return {
                name,
                ...(name === current && { current: true as const }),
                ...(name === 'main' && { default: true as const }),
                ...((TRACKED.includes(name) || took.has(name)) && { upstream: `origin/${name}` }),
                ...(holder && { heldBy: holder }),
                committedAt: now - (index + 1) * 3_600_000 * 7,
            };
        });
        const origin: GitRemoteBranch[] = [
            ...TRACKED.map(name => ({ name, ...(name === 'main' && { default: true as const }) })),
            ...(this.#scripts.has('remote')
                ? REMOTE_ONLY.map((name, index) => ({
                      name,
                      committedAt: now - (index + 1) * 86_400_000,
                  }))
                : []),
        ].filter(branch => !this.#deletedOrigin.get(place.key)?.has(branch.name));
        const remote = origin.filter(branch => !names.includes(branch.name));

        return {
            isRepository: true,
            defaultBranch: 'main',
            local,
            remote,
            origin,
            recent: ['dev', 'main', ...(this.#scripts.has('held') ? [PERSON_TREE.branch] : [])].filter(
                name => name !== current && names.includes(name)
            ),
        };
    }

    async deleteBranch(
        place: FixtureBranchPlace,
        request: GitBranchDeleteRequest,
        switchCheckout: (branch: string) => Promise<GitSwitchResult>
    ): Promise<GitBranchDeleteResult> {
        const { branch } = request;
        const remoteOnly = request.action === 'preview' ? request.remote === true : request.localCommit === undefined;
        const listing = this.list(place);
        const local = remoteOnly ? undefined : listing.local.find(candidate => candidate.name === branch);
        const origin = listing.origin?.find(candidate => candidate.name === branch);
        if (remoteOnly ? !origin : !local) throw new TransportError(`There is no branch called ${branch}`, 409);

        const switchTo = local?.current ? listing.defaultBranch : undefined;
        const fallback = listing.local.find(candidate => candidate.name === switchTo);
        const blocked =
            branch === listing.defaultBranch
                ? 'The default branch cannot be deleted'
                : local?.heldBy
                  ? `Checked out in ${local.heldBy.path}`
                  : switchTo &&
                      (fallback?.heldBy ||
                          this.dirty ||
                          this.#scripts.has('refused') ||
                          (place.worktree && (!this.merged || (place.changes ?? 0) > 0)))
                    ? 'Switch to another branch before deleting this branch'
                    : undefined;
        const preview: GitBranchDeletePreview = {
            state: 'preview',
            branch,
            ...(local && { localCommit: FIXTURE_BASE_COMMIT, localUnmerged: !this.merged }),
            ...(origin && { originCommit: FIXTURE_BASE_COMMIT, originUnmerged: !this.merged }),
            ...(switchTo && { switchTo }),
            ...(blocked && { blocked }),
        };
        if (request.action === 'preview') return preview;
        if (blocked) throw new TransportError(blocked, 409);
        if (
            (!request.localCommit && !request.originCommit) ||
            (request.localCommit !== undefined && request.localCommit !== preview.localCommit) ||
            (request.originCommit !== undefined && request.originCommit !== preview.originCommit) ||
            (request.localCommit !== undefined && preview.localUnmerged && !request.localUnmerged) ||
            (request.originCommit !== undefined && preview.originUnmerged && !request.originUnmerged) ||
            request.switchTo !== preview.switchTo
        )
            throw new TransportError('The branch changed since the preview', 409);

        const switched = switchTo === undefined ? undefined : await switchCheckout(switchTo);
        if (request.localCommit) {
            this.#deletedLocal.set(place.key, new Set([...(this.#deletedLocal.get(place.key) ?? []), branch]));
            this.#local.get(place.key)?.delete(branch);
            this.#took.get(place.key)?.delete(branch);
        }
        if (request.originCommit)
            this.#deletedOrigin.set(place.key, new Set([...(this.#deletedOrigin.get(place.key) ?? []), branch]));

        return {
            state: 'done',
            localDeleted: request.localCommit !== undefined,
            originDeleted: request.originCommit !== undefined,
            ...(switched && { switchedTo: switchTo }),
            ...(switched?.warning && { warning: switched.warning }),
        };
    }

    /** `POST git/switch` of a place, answered as the daemon answers it; the place's branch is `answer.head.name` afterwards (the caller keeps it). */
    async switch(
        place: FixtureBranchPlace,
        request: Pick<GitSwitchRequest, 'branch' | 'create'>
    ): Promise<GitSwitchResult> {
        const { branch: name, create } = request;

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

        const changes = place.worktree ? (place.changes ?? 0) : this.dirty ? DIRTY_ENTRIES.length : 0;

        if (changes > 0)
            throw new TransportError(
                'Commit or discard the changes first',
                409,
                `${changes} ${changes === 1 ? 'file' : 'files'} changed`
            );

        if (place.worktree && !this.merged)
            throw new TransportError('Merge this branch into origin/main before switching', 409);

        if (this.#scripts.has('slow')) await sleep(SLOW_MS);

        const warning = this.#scripts.has('warned') ? { warning: HOOK_WARNING } : {};

        this.#deletedLocal.get(place.key)?.delete(name);

        if (create || place.worktreeBranch !== undefined) {
            const local = this.#local.get(place.key) ?? new Set<string>();

            // The old branch still exists after a worktree checks out a different one.
            if (place.worktreeBranch !== undefined) local.add(place.worktreeBranch);
            if (create) local.add(name);

            this.#local.set(place.key, local);
        }

        if (create) {
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
