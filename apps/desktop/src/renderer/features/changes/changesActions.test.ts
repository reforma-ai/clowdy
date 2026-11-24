import { describe, expect, it } from 'vitest';

import {
    branchOf,
    canCreatePullRequest,
    commitBlock,
    commitLabel,
    commitTarget,
    githubBaseName,
    isFetchFirst,
    lastFetchedWords,
    RUNNING_WORDS,
    remoteActions,
    remoteNotice,
    syncBlock,
    syncButton,
    updateFromBase,
} from './changesActions';

import type { GitBase, GitStatus, GitUpstream } from '@clowdy/protocol';

type RepositoryStatus = Extract<GitStatus, { isRepository: true }>;

const READY: GitBase = {
    state: 'ready',
    name: 'origin/main',
    commit: 'b'.repeat(40),
    mergeBase: 'b'.repeat(40),
    ahead: 2,
    behind: 0,
    commits: [],
};

/** A status of a branch `feature` with an upstream, `origin` and work ahead of its base, with `fields` having their say. */
function status(fields: Partial<RepositoryStatus> = {}, upstream: Partial<GitUpstream> | null = {}): GitStatus {
    return {
        isRepository: true,
        head: { kind: 'branch', name: 'feature', commit: 'a'.repeat(40) },
        ...(upstream !== null && { upstream: { name: 'origin/feature', ahead: 0, behind: 0, ...upstream } }),
        origin: true,
        entries: [],
        base: READY,
        ...fields,
    };
}

const menuStates = (value: GitStatus | undefined, busy = false) =>
    remoteActions(value, busy).map(action => [action.id, action.disabled, action.count ?? null]);

describe('remoteActions', () => {
    it('lists nothing for a place that is not a repository or has not been read', () => {
        expect(remoteActions({ isRepository: false }, false)).toEqual([]);
        expect(remoteActions(undefined, false)).toEqual([]);
    });

    it('keeps explicit Pull available before a fresh fetch knows about incoming commits', () => {
        expect(menuStates(status())).toEqual([
            ['fetch', false, null],
            ['pull', false, null],
        ]);
        expect(menuStates(status({}, { ahead: 1, behind: 2 }))).toEqual([
            ['fetch', false, null],
            ['pull', false, 2],
        ]);
        expect(remoteActions(status(), false).map(action => action.label)).toEqual(['Fetch origin', 'Pull origin']);
    });

    it('holds writes while switching, and requires a published branch for Pull', () => {
        expect(menuStates(status({}, { behind: 2 }), true)).toEqual([
            ['fetch', true, null],
            ['pull', true, 2],
        ]);
        expect(menuStates(status({ origin: false }, null))).toEqual([
            ['fetch', true, null],
            ['pull', true, null],
        ]);

        for (const value of [
            status({}, null),
            status({}, { gone: true }),
            status({}, { name: 'origin/main', behind: 1 }),
            status({}, { name: 'upstream/feature', behind: 1 }),
            status({ head: { kind: 'detached', commit: 'a'.repeat(40) } }, null),
            status({ head: { kind: 'unborn', name: 'main' } }, null),
        ]) {
            expect(menuStates(value)).toEqual([
                ['fetch', false, null],
                ['pull', true, null],
            ]);
        }

        expect(menuStates(status({ merging: { conflicts: 1 } }, { behind: 2 }))[1]).toEqual(['pull', true, 2]);
    });
});

describe('lastFetchedWords', () => {
    const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
    const MINUTE = 60_000;
    const words = (ago: number) => lastFetchedWords(NOW - ago, NOW);

    it('says that a repository that has not fetched never has', () => {
        expect(lastFetchedWords(undefined, NOW)).toBe('Never fetched');
    });

    it('says just now under a minute, and a time in the future (a clock that moved) is just now too', () => {
        expect(words(0)).toBe('Last fetched just now');
        expect(words(59_000)).toBe('Last fetched just now');
        expect(words(-5 * MINUTE)).toBe('Last fetched just now');
    });

    it('counts in the largest unit that fits, rounded down, with the singular for one', () => {
        expect(words(MINUTE)).toBe('Last fetched 1 minute ago');
        expect(words(3 * MINUTE)).toBe('Last fetched 3 minutes ago');
        expect(words(59 * MINUTE)).toBe('Last fetched 59 minutes ago');
        expect(words(60 * MINUTE)).toBe('Last fetched 1 hour ago');
        expect(words(23 * 60 * MINUTE + 59 * MINUTE)).toBe('Last fetched 23 hours ago');
        expect(words(24 * 60 * MINUTE)).toBe('Last fetched 1 day ago');
        expect(words(6 * 24 * 60 * MINUTE)).toBe('Last fetched 6 days ago');
        expect(words(7 * 24 * 60 * MINUTE)).toBe('Last fetched 1 week ago');
        expect(words(29 * 24 * 60 * MINUTE)).toBe('Last fetched 4 weeks ago');
        expect(words(30 * 24 * 60 * MINUTE)).toBe('Last fetched 1 month ago');
        expect(words(364 * 24 * 60 * MINUTE)).toBe('Last fetched 12 months ago');
        expect(words(365 * 24 * 60 * MINUTE)).toBe('Last fetched 1 year ago');
        expect(words(800 * 24 * 60 * MINUTE)).toBe('Last fetched 2 years ago');
    });
});

describe('syncButton', () => {
    const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
    const FETCHED = NOW - 3 * 60_000;
    const sync = (value: GitStatus | undefined) => syncButton(value, undefined, NOW);

    it('hides the button before a repository is known', () => {
        expect(sync({ isRepository: false })).toBeUndefined();
        expect(sync(undefined)).toBeUndefined();
    });

    it('shows the sync phase and holds the primary action while it runs', () => {
        expect(syncButton(status(), 'sync', NOW)).toMatchObject({ kind: 'running', label: 'Syncing…' });
        expect(syncButton(status(), 'sync', NOW, 'fetch')?.label).toBe('Fetching origin');
        expect(syncButton(status(), 'sync', NOW, 'merge')?.label).toBe('Merging from origin');
        expect(syncButton(status(), 'sync', NOW, 'push')?.label).toBe('Pushing origin');
        expect(syncButton(status(), 'sync', NOW, 'push')?.action).toBeUndefined();
        expect(syncButton(status(), 'pull', NOW)?.label).toBe('Pulling origin');
    });

    it('explains when Sync cannot run', () => {
        expect(sync(status({ origin: false }))).toMatchObject({
            kind: 'no_origin',
            label: 'No origin',
            line: 'Nothing to sync with',
        });
        expect(sync(status({ head: { kind: 'detached', commit: 'a'.repeat(40) } }, null))).toMatchObject({
            kind: 'blocked',
            line: 'HEAD is detached',
        });
        expect(sync(status({ head: { kind: 'unborn', name: 'main' } }, null))).toMatchObject({
            kind: 'blocked',
            line: 'No commits yet',
        });
        expect(sync(status({ merging: { conflicts: 0 } }))).toMatchObject({
            kind: 'blocked',
            line: 'Complete or abort the merge first',
        });
        expect(sync(status({ rebasing: true }))).toMatchObject({
            kind: 'blocked',
            line: 'Continue or abort the rebase first',
        });
    });

    it('prefers upstream work to a base update, then fetches when both are level', () => {
        const base = { ...READY, behind: 5 };
        expect(sync(status())).toMatchObject({
            kind: 'fetch',
            label: 'Fetch origin',
            action: 'fetch',
            line: 'Never fetched',
        });
        expect(sync(status({ base }))).toMatchObject({ kind: 'update', action: 'update', behind: 5 });
        expect(sync(status({ base }, { ahead: 3 }))).toMatchObject({ kind: 'push', action: 'sync', ahead: 3 });
        expect(sync(status({ base }, { behind: 2 }))).toMatchObject({ kind: 'pull', action: 'sync', behind: 2 });
        expect(sync(status({ lastFetchedAt: FETCHED }, { ahead: 1, behind: 2 }))).toMatchObject({
            kind: 'sync',
            label: 'Sync',
            action: 'sync',
            line: 'Last fetched 3 minutes ago',
            ahead: 1,
            behind: 2,
        });
    });

    it('offers to publish under the local branch name and only fetches for a foreign upstream', () => {
        expect(sync(status({}, null))).toMatchObject({
            kind: 'publish',
            action: 'sync',
            line: 'Publish this branch to origin',
            title: 'Publish as origin/feature',
        });
        expect(sync(status({}, { gone: true }))).toMatchObject({
            kind: 'publish',
            action: 'sync',
            line: 'Upstream gone from origin',
            tone: 'warning',
        });
        expect(sync(status({}, { name: 'upstream/feature', gone: true }))).toMatchObject({
            kind: 'fetch',
            label: 'Fetch origin',
            action: 'fetch',
            line: 'Tracks upstream/feature, not origin',
        });
        expect(sync(status({ base: { ...READY, behind: 2 } }, { name: 'upstream/feature' }))).toMatchObject({
            kind: 'update',
            action: 'update',
        });
    });
});

describe('the words of the sidebar', () => {
    const NOW = 1_700_000_000_000;
    const head = { kind: 'branch', name: 'feature', commit: 'a'.repeat(40) } as const;

    it('close a one-sentence text without a period, and a text of two sentences with one', () => {
        const statuses: GitStatus[] = [
            status({}, null),
            status({}, { gone: true }),
            status({}, { name: 'upstream/main', gone: true }),
            status({}, { ahead: 2 }),
            status({}, { behind: 1 }),
            status({}, { ahead: 1, behind: 1 }),
            status({}, {}),
            status({ origin: false }, null),
            status({ head: { kind: 'detached', commit: 'a'.repeat(40) } }, null),
            status({ head: { kind: 'unborn', name: 'main' } }, null),
            status({ head }, { name: 'upstream/main' }),
        ];
        const texts = new Set<string>([
            'A commit summary is required to commit',
            'Select one or more files to commit',
            commitLabel(3),
            ...Object.values(RUNNING_WORDS),
        ]);

        for (const value of statuses) {
            for (const view of [syncButton(value, undefined, NOW)])
                for (const text of [view?.label, view?.line, view?.reason, view?.title]) if (text) texts.add(text);

            for (const action of remoteActions(value, false)) texts.add(action.label);

            const block = syncBlock(value);

            if (block) texts.add(block);
        }

        for (const text of texts) expect(/\. [A-Z]/.test(text) ? text.endsWith('.') : !text.endsWith('.')).toBe(true);
    });
});

describe('the commit button', () => {
    it('counts the selected files in the commit label', () => {
        expect(commitLabel(3)).toBe('Commit 3 files');
        expect(commitLabel(1)).toBe('Commit 1 file');
        expect(commitLabel(0)).toBe('Commit 0 files');
    });

    it("says why it cannot be pressed in GitHub Desktop's tooltips: the summary first, then the files", () => {
        expect(commitBlock('', 3)).toBe('A commit summary is required to commit');
        expect(commitBlock('  \n ', 0)).toBe('A commit summary is required to commit');
        expect(commitBlock('Fix it', 0)).toBe('Select one or more files to commit');
        expect(commitBlock('Fix it', 2)).toBeUndefined();
    });

    it("goes to the branch the work is compared with when the branch is its base, origin's or the local one", () => {
        expect(commitTarget(status({ head: { kind: 'branch', name: 'main', commit: 'a'.repeat(40) } }))).toEqual({
            name: 'main',
            onBase: true,
        });
        expect(
            commitTarget(
                status({
                    head: { kind: 'branch', name: 'main', commit: 'a'.repeat(40) },
                    base: { ...READY, name: 'main' },
                })
            )
        ).toEqual({ name: 'main', onBase: true });
        expect(commitTarget(status())).toEqual({ name: 'feature', onBase: false });
        expect(
            commitTarget(
                status({ base: { state: 'no_base' }, head: { kind: 'branch', name: 'main', commit: 'a'.repeat(40) } })
            )
        ).toEqual({ name: 'main', onBase: false });
        expect(commitTarget(status({ head: { kind: 'detached', commit: 'a'.repeat(40) } }, null))).toEqual({
            name: 'detached HEAD',
            onBase: false,
        });
        expect(commitTarget({ isRepository: false })).toBeUndefined();
        expect(commitTarget(undefined)).toBeUndefined();
    });
});

describe('isFetchFirst', () => {
    it('is true for the line git prints when origin has commits the branch lacks, and for nothing else', () => {
        expect(isFetchFirst('! [rejected] clowdy/ab12cd34 -> clowdy/ab12cd34 (fetch first)')).toBe(true);
        expect(isFetchFirst('Committed 1a2b3c4, push failed: ! [rejected] main -> main (fetch first)')).toBe(true);
        expect(isFetchFirst('! [rejected] main -> main (non-fast-forward)')).toBe(false);
        expect(isFetchFirst('! [remote rejected] main -> main (protected branch hook declined)')).toBe(false);
        expect(isFetchFirst('fatal: unable to access the remote')).toBe(false);
    });
});

describe('remoteNotice', () => {
    it('does not show a notice for any successful action', () => {
        expect(remoteNotice({ state: 'done', action: 'fetch' })).toBeUndefined();
        expect(remoteNotice({ state: 'done', action: 'pull', pulled: 2, merged: true })).toBeUndefined();
        expect(remoteNotice({ state: 'done', action: 'pull', pulled: 0 })).toBeUndefined();
        expect(remoteNotice({ state: 'done', action: 'push' })).toBeUndefined();
        expect(remoteNotice({ state: 'done', action: 'push', published: true })).toBeUndefined();
        expect(remoteNotice({ state: 'done', action: 'update', pulled: 1 })).toBeUndefined();
        expect(remoteNotice({ state: 'done', action: 'abort' })).toBeUndefined();
    });

    it('reports a merge that stopped on conflicts', () => {
        expect(remoteNotice({ state: 'conflicts', action: 'pull', conflicts: 2 })).toEqual({
            words: '2 conflicts',
            tone: 'warning',
        });
        expect(remoteNotice({ state: 'conflicts', action: 'update', conflicts: 1 })).toEqual({
            words: '1 conflict',
            tone: 'warning',
        });
    });

    it('leaves a merge with no remaining conflicts to the commit section', () => {
        expect(remoteNotice({ state: 'conflicts', action: 'pull', conflicts: 0 })).toBeUndefined();
        expect(remoteNotice({ state: 'conflicts', action: 'update', conflicts: 0 })).toBeUndefined();
    });
});

describe('update from the base', () => {
    it('offers Update from main when the branch is behind the base and is not the base', () => {
        expect(updateFromBase(status({ base: { ...READY, behind: 2 } }))).toEqual({
            label: 'Update from main',
            behind: 2,
        });
        expect(updateFromBase(status())).toBeUndefined();
        for (const name of ['main', 'origin/main']) {
            expect(
                updateFromBase(
                    status({
                        head: { kind: 'branch', name, commit: 'a'.repeat(40) },
                        base: { ...READY, name: 'origin/main', behind: 2 },
                    })
                )
            ).toBeUndefined();
        }
        expect(updateFromBase(status({ merging: { conflicts: 1 }, base: { ...READY, behind: 2 } }))).toBeUndefined();
    });
});

describe('githubBaseName', () => {
    const named = (name: string, state: 'ready' | 'no_merge_base' = 'ready'): GitBase =>
        state === 'ready' ? { ...READY, name } : { state, name, commit: 'c'.repeat(40) };

    it('is the local part of a base on origin, and a local base as it is, with its slashes', () => {
        expect(githubBaseName(named('origin/main'))).toBe('main');
        expect(githubBaseName(named('origin/release/2.0'))).toBe('release/2.0');
        expect(githubBaseName(named('main'))).toBe('main');
        expect(githubBaseName(named('develop', 'no_merge_base'))).toBe('develop');
    });

    it('is nothing for a base that is a commit, and when there is no base', () => {
        expect(githubBaseName(named('a1b2c3d'))).toBeUndefined();
        expect(githubBaseName({ state: 'unborn' })).toBeUndefined();
        expect(githubBaseName({ state: 'no_base', name: 'main' })).toBeUndefined();
        expect(githubBaseName(undefined)).toBeUndefined();
    });
});

describe('a branch that tracks a branch of another name', () => {
    // `git switch -c feat origin/main` tracks `origin/main`: a push to the upstream would update `main` itself, which git's own `push.default=simple` refuses.
    const renamed = (fields: Partial<RepositoryStatus> = {}, upstream: Partial<GitUpstream> = {}) =>
        status(fields, { name: 'origin/main', ahead: 2, behind: 1, ...upstream });

    it('offers to sync under the local name and keeps Create PR hidden until the branch is published', () => {
        expect(syncButton(renamed(), undefined, 0)).toMatchObject({
            kind: 'publish',
            label: 'Publish branch',
            action: 'sync',
            line: 'Tracks origin/main',
            title: 'Publish as origin/feature',
        });
        expect(syncButton(renamed(), undefined, 0)?.behind).toBeUndefined();
        expect(syncButton(renamed(), undefined, 0)?.ahead).toBeUndefined();
        expect(syncBlock(renamed())).toBeUndefined();
        expect(canCreatePullRequest(renamed())).toBe(false);
        expect(canCreatePullRequest(renamed({}, { ahead: 0, behind: 0 }))).toBe(false);
    });

    it('is published once its upstream is the branch of its own name, whatever the branch is called', () => {
        expect(
            syncButton(
                status(
                    { head: { kind: 'branch', name: 'feature/new-menu', commit: 'a'.repeat(40) } },
                    { name: 'origin/feature/new-menu', ahead: 1 }
                ),
                undefined,
                0
            )
        ).toMatchObject({ kind: 'push', ahead: 1 });
        // A name that only begins like the branch's is another branch.
        expect(syncButton(status({}, { name: 'origin/feature-2', ahead: 1 }), undefined, 0)).toMatchObject({
            kind: 'publish',
            line: 'Tracks origin/feature-2',
        });
        expect(syncButton(status({}, { name: 'origin/feature/x', ahead: 1 }), undefined, 0)).toMatchObject({
            kind: 'publish',
            line: 'Tracks origin/feature/x',
        });
    });
});

describe('branchOf', () => {
    it('is the name of the branch, which an unborn one has too, and nothing for a HEAD on no branch', () => {
        expect(branchOf(status() as RepositoryStatus)).toBe('feature');
        expect(branchOf(status({ head: { kind: 'unborn', name: 'main' } }, null) as RepositoryStatus)).toBe('main');
        expect(
            branchOf(status({ head: { kind: 'detached', commit: 'a'.repeat(40) } }, null) as RepositoryStatus)
        ).toBeUndefined();
    });
});

describe('canCreatePullRequest', () => {
    it('allows a published branch with work against the base and all its commits on origin', () => {
        expect(canCreatePullRequest(status())).toBe(true);
        expect(canCreatePullRequest(status({}, { behind: 2 }))).toBe(true);
        expect(canCreatePullRequest(status({ base: { state: 'no_base' } }))).toBe(true);
    });

    it('rejects a branch that still needs to be published or pushed', () => {
        expect(canCreatePullRequest(status({}, null))).toBe(false);
        expect(canCreatePullRequest(status({}, { gone: true }))).toBe(false);
        expect(canCreatePullRequest(status({}, { ahead: 2 }))).toBe(false);
        expect(canCreatePullRequest(status({}, { ahead: 1, behind: 1 }))).toBe(false);
        expect(canCreatePullRequest(status({}, { name: 'upstream/feature' }))).toBe(false);
    });

    it('rejects the base branch and a branch with no commits ahead of its base', () => {
        const head = { kind: 'branch', name: 'main', commit: 'a'.repeat(40) } as const;

        expect(canCreatePullRequest(status({ head }, { name: 'origin/main' }))).toBe(false);
        expect(canCreatePullRequest(status({ head, base: { ...READY, name: 'main' } }, { name: 'origin/main' }))).toBe(
            false
        );
        expect(canCreatePullRequest(status({ base: { ...READY, ahead: 0 } }))).toBe(false);
    });

    it('rejects missing repository or origin, detached HEAD and unborn branches', () => {
        expect(canCreatePullRequest(undefined)).toBe(false);
        expect(canCreatePullRequest({ isRepository: false })).toBe(false);
        expect(canCreatePullRequest(status({ origin: false }))).toBe(false);
        expect(canCreatePullRequest(status({ head: { kind: 'detached', commit: 'a'.repeat(40) } }, null))).toBe(false);
        expect(canCreatePullRequest(status({ head: { kind: 'unborn', name: 'feature' } }, null))).toBe(false);
    });
});

describe('syncBlock', () => {
    it('allows Sync after a first commit, a resolved merge, or a commit on a branch adding to either side', () => {
        expect(syncBlock(status())).toBeUndefined();
        expect(syncBlock(status({}, { ahead: 3, behind: 2 }))).toBeUndefined();
        expect(syncBlock(status({}, { behind: 2 }))).toBeUndefined();
        expect(syncBlock(status({ merging: { conflicts: 0 } }))).toBeUndefined();
        expect(syncBlock(status({}, null))).toBeUndefined();
        expect(syncBlock(status({ head: { kind: 'unborn', name: 'main' } }, null))).toBeUndefined();
    });

    it('gives the reason for no origin, detached HEAD, foreign upstream and unresolved conflicts', () => {
        expect(syncBlock(status({ origin: false }))).toBe('No origin');
        expect(syncBlock(status({ head: { kind: 'detached', commit: 'a'.repeat(40) } }, null))).toBe(
            'HEAD is detached'
        );
        expect(syncBlock(status({}, { name: 'fork/feature', gone: true }))).toBe('Tracks fork/feature, not origin');
        expect(syncBlock(status({ merging: { conflicts: 1 } }))).toBe('A merge is in progress');
        expect(syncBlock(status({ rebasing: true }))).toBe('Continue or abort the rebase first');
        expect(syncBlock({ isRepository: false })).toBe('Not a repository');
        expect(syncBlock(undefined)).toBe('Not a repository');
    });
});
