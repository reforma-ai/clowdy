import { describe, expect, it } from 'vitest';

import {
    branchOf,
    canCreatePullRequest,
    commitAndPushBlock,
    commitBlock,
    commitLabel,
    commitTarget,
    githubBaseName,
    isDiverged,
    isFetchFirst,
    lastFetchedWords,
    pushOrPublish,
    RUNNING_WORDS,
    remoteActions,
    remoteCall,
    remoteNotice,
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
    it('lists nothing for a place that is not a repository, and for one that has not been read', () => {
        expect(remoteActions({ isRepository: false }, false)).toEqual([]);
        expect(remoteActions(undefined, false)).toEqual([]);
    });

    it('lists Fetch, Pull and Push for a branch that is on origin and level, disabling the two with nothing to do', () => {
        expect(menuStates(status())).toEqual([
            ['fetch', false, null],
            ['pull', true, null],
            ['push', true, null],
        ]);
    });

    it('counts what Pull takes and Push sends, when they are available', () => {
        expect(menuStates(status({}, { behind: 3 }))).toEqual([
            ['fetch', false, null],
            ['pull', false, 3],
            ['push', true, null],
        ]);
        expect(menuStates(status({}, { ahead: 1 }))).toEqual([
            ['fetch', false, null],
            ['pull', true, null],
            ['push', false, 1],
        ]);
    });

    it('pulls a branch that diverged, which merges, and holds the push until that pull', () => {
        expect(menuStates(status({}, { ahead: 1, behind: 2 }))).toEqual([
            ['fetch', false, null],
            ['pull', false, 2],
            ['push', true, 1],
        ]);
        expect(isDiverged({ name: 'origin/feature', ahead: 1, behind: 2 })).toBe(true);
        expect(isDiverged({ name: 'origin/feature', ahead: 1, behind: 0 })).toBe(false);
        expect(isDiverged({ name: 'origin/feature', ahead: 1, behind: 2, gone: true })).toBe(false);
        expect(isDiverged(undefined)).toBe(false);
    });

    it('offers Publish in place of Push for a branch that is not on origin, with nothing to pull from', () => {
        expect(menuStates(status({}, null))).toEqual([
            ['fetch', false, null],
            ['pull', true, null],
            ['publish', false, null],
        ]);
        // An upstream that is gone from origin is published again, not pushed.
        expect(menuStates(status({}, { gone: true }))).toEqual([
            ['fetch', false, null],
            ['pull', true, null],
            ['publish', false, null],
        ]);
    });

    it('turns every action off when there is no origin, and all but Fetch for a HEAD that is on no branch', () => {
        expect(menuStates(status({ origin: false }, null))).toEqual([
            ['fetch', true, null],
            ['pull', true, null],
            ['publish', true, null],
        ]);
        expect(menuStates(status({ head: { kind: 'detached', commit: 'a'.repeat(40) } }, null))).toEqual([
            ['fetch', false, null],
            ['pull', true, null],
            ['publish', true, null],
        ]);
        expect(menuStates(status({ head: { kind: 'unborn', name: 'main' } }, null))).toEqual([
            ['fetch', false, null],
            ['pull', true, null],
            ['publish', true, null],
        ]);
    });

    it('turns every action off while one runs', () => {
        expect(menuStates(status({}, { ahead: 1 }), true)).toEqual([
            ['fetch', true, null],
            ['pull', true, null],
            ['push', true, 1],
        ]);
    });

    it('turns Pull and Push off for a branch that tracks something that is not on origin', () => {
        expect(menuStates(status({}, { name: 'upstream/main', ahead: 1 }))).toEqual([
            ['fetch', false, null],
            ['pull', true, null],
            ['push', true, 1],
        ]);
    });

    it('does not offer to publish a branch whose upstream is gone from another remote', () => {
        expect(menuStates(status({}, { name: 'upstream/main', gone: true }))).toEqual([
            ['fetch', false, null],
            ['pull', true, null],
            ['publish', true, null],
        ]);
        // The same upstream gone from origin is published again.
        expect(menuStates(status({}, { gone: true }))).toEqual([
            ['fetch', false, null],
            ['pull', true, null],
            ['publish', false, null],
        ]);
    });

    it('makes a call of each action, publishing being a push', () => {
        expect([remoteCall('fetch'), remoteCall('pull'), remoteCall('push'), remoteCall('publish')]).toEqual([
            'fetch',
            'pull',
            'push',
            'push',
        ]);
    });
});

describe('the labels of the menu', () => {
    it("are GitHub Desktop's words: Fetch origin, Pull origin, Push origin and Publish branch", () => {
        expect(remoteActions(status({}, { ahead: 1 }), false).map(action => action.label)).toEqual([
            'Fetch origin',
            'Pull origin',
            'Push origin',
        ]);
        expect(remoteActions(status({}, null), false).map(action => action.label)).toEqual([
            'Fetch origin',
            'Pull origin',
            'Publish branch',
        ]);
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
    const sync = (value: GitStatus | undefined, running: Parameters<typeof syncButton>[1] = undefined) =>
        syncButton(value, running, NOW);

    it('is nothing for a place that is not a repository and for one that has not been read', () => {
        expect(sync({ isRepository: false })).toBeUndefined();
        expect(sync(undefined)).toBeUndefined();
    });

    it('says what is running, with the progress as its label, and cannot be pressed', () => {
        expect(sync(status(), 'fetch')).toMatchObject({
            kind: 'running',
            label: 'Fetching origin',
            reason: 'An action is running',
        });
        expect(sync(status(), 'pull')).toMatchObject({ kind: 'running', label: 'Pulling origin' });
        expect(sync(status(), 'push')).toMatchObject({ kind: 'running', label: 'Pushing origin' });
        expect(sync(status({}, null), 'publish')).toMatchObject({ kind: 'running', label: 'Publishing branch' });
        expect(sync(status(), 'fetch')?.action).toBeUndefined();
    });

    it('says there is nothing to sync with when the repository has no origin, whatever the branch is', () => {
        expect(sync(status({ origin: false }))).toMatchObject({
            kind: 'no_origin',
            label: 'No origin',
            line: 'Nothing to sync with',
            reason: 'No origin',
        });
        expect(sync(status({ origin: false }, null))?.action).toBeUndefined();
        expect(sync(status({ origin: false }), 'fetch')).toMatchObject({ kind: 'running' });
    });

    it('is Publish branch, off with the reason, for a HEAD on no branch and for a branch with no commit yet', () => {
        expect(sync(status({ head: { kind: 'detached', commit: 'a'.repeat(40) } }, null))).toMatchObject({
            kind: 'blocked',
            label: 'Publish branch',
            line: 'HEAD is detached',
            reason: 'HEAD is detached',
        });
        expect(sync(status({ head: { kind: 'unborn', name: 'main' } }, null))).toMatchObject({
            kind: 'blocked',
            label: 'Publish branch',
            line: 'No commits yet',
            reason: 'No commits yet',
        });
        expect(sync(status({ head: { kind: 'unborn', name: 'main' } }, null))?.action).toBeUndefined();
    });

    it('is Publish branch for a branch that is not on origin, and again for one whose upstream is gone, which it says as a warning', () => {
        expect(sync(status({}, null))).toMatchObject({
            kind: 'publish',
            label: 'Publish branch',
            action: 'publish',
            line: 'Publish this branch to origin',
        });
        expect(sync(status({}, null))?.reason).toBeUndefined();
        expect(sync(status({}, { gone: true }))).toMatchObject({
            kind: 'publish',
            label: 'Publish branch',
            action: 'publish',
            line: 'Upstream gone from origin',
            tone: 'warning',
        });
    });

    it('is Pull origin with the count for a branch that is behind, and says when the counts are from', () => {
        expect(sync(status({ lastFetchedAt: FETCHED }, { behind: 2 }))).toMatchObject({
            kind: 'pull',
            label: 'Pull origin',
            behind: 2,
            action: 'pull',
            line: 'Last fetched 3 minutes ago',
        });
        expect(sync(status({}, { behind: 1 }))).toMatchObject({ kind: 'pull', behind: 1, line: 'Never fetched' });
        expect(sync(status({}, { behind: 1 }))?.ahead).toBeUndefined();
    });

    it('is Push origin with the count for a branch that is ahead', () => {
        expect(sync(status({ lastFetchedAt: FETCHED }, { ahead: 1 }))).toMatchObject({
            kind: 'push',
            label: 'Push origin',
            ahead: 1,
            action: 'push',
            line: 'Last fetched 3 minutes ago',
        });
        expect(sync(status({}, { ahead: 4 }))?.behind).toBeUndefined();
    });

    it('is Pull origin for a branch with commits on both sides, which merges, and shows how far', () => {
        const view = sync(status({ lastFetchedAt: FETCHED }, { ahead: 1, behind: 2 }));

        expect(view).toMatchObject({
            kind: 'pull',
            label: 'Pull origin',
            ahead: 1,
            behind: 2,
            action: 'pull',
            line: 'Last fetched 3 minutes ago',
        });
        expect(view?.title).toContain('Pull origin merges what origin/feature has.');
        expect(JSON.stringify(view)).not.toMatch(/Force push/);
    });

    it('is Fetch origin with when the last fetch was for a branch that is level, or Never fetched', () => {
        expect(sync(status({ lastFetchedAt: FETCHED }))).toMatchObject({
            kind: 'fetch',
            label: 'Fetch origin',
            action: 'fetch',
            line: 'Last fetched 3 minutes ago',
        });
        expect(sync(status())).toMatchObject({
            kind: 'fetch',
            label: 'Fetch origin',
            action: 'fetch',
            line: 'Never fetched',
        });
        expect(sync(status())?.reason).toBeUndefined();
        expect(sync(status({ lastFetchedAt: FETCHED }))?.title).toBe(
            'Fetch origin to look for new commits: origin/feature is up to date, last fetched 3 minutes ago'
        );
    });

    it('is Fetch origin, with what is in the way as its line, for a branch that tracks something that is not on origin', () => {
        expect(sync(status({}, { name: 'upstream/main', ahead: 1 }))).toMatchObject({
            kind: 'fetch',
            label: 'Fetch origin',
            action: 'fetch',
            line: 'Tracks upstream/main, not origin',
        });
    });

    it('is Fetch origin, not a Publish branch that the daemon would refuse, for an upstream that is gone from another remote', () => {
        expect(sync(status({}, { name: 'upstream/main', gone: true }))).toMatchObject({
            kind: 'fetch',
            label: 'Fetch origin',
            action: 'fetch',
            line: 'Tracks upstream/main, not origin',
        });
    });

    it('prioritizes progress, unavailable states, and upstream sync before updating from the base or fetching', () => {
        const order = (value: GitStatus, running?: Parameters<typeof syncButton>[1]) => sync(value, running)?.kind;

        expect(order(status({ origin: false }, null), 'fetch')).toBe('running');
        expect(order(status({ origin: false, head: { kind: 'detached', commit: 'a'.repeat(40) } }, null))).toBe(
            'no_origin'
        );
        expect(order(status({ head: { kind: 'detached', commit: 'a'.repeat(40) } }, { ahead: 1 }))).toBe('blocked');
        expect(order(status({}, { name: 'upstream/x', ahead: 1, behind: 1 }))).toBe('fetch');
        expect(order(status({}, { ahead: 1, behind: 1 }))).toBe('pull');
        expect(order(status({}, { ahead: 1, behind: 1, gone: true }))).toBe('publish');
        expect(order(status({}, { ahead: 3 }))).toBe('push');
        expect(order(status({}, { behind: 3 }))).toBe('pull');
        expect(order(status())).toBe('fetch');

        const base = { ...READY, behind: 2 };

        expect(sync(status({ base }))).toMatchObject({ kind: 'update', label: 'Update from main', action: 'update' });
        expect(order(status({ base }, { name: 'upstream/feature' }))).toBe('update');
        expect(order(status({ base }, { behind: 1 }))).toBe('pull');
        expect(order(status({ base }, { ahead: 1 }))).toBe('push');
        expect(order(status({ base }, null))).toBe('publish');
        expect(order(status({ base, origin: false }))).toBe('no_origin');
        expect(order(status({ base, merging: { conflicts: 1 } }))).toBe('fetch');
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

            const block = commitAndPushBlock(value);

            if (block) texts.add(block);
        }

        // At least the tooltip of a pull that merges has two sentences, so the check is not about nothing.
        expect([...texts].some(text => /\. [A-Z]/.test(text))).toBe(true);

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

    it('is not published: Publish branch with what it tracks as its line, and Pull, Push and Diverged left out, whatever the counts against that other branch are', () => {
        expect(syncButton(renamed(), undefined, 0)).toMatchObject({
            kind: 'publish',
            label: 'Publish branch',
            action: 'publish',
            line: 'Tracks origin/main',
        });
        expect(syncButton(renamed(), undefined, 0)?.title).toContain('publish it as origin/feature');
        expect(syncButton(renamed({}, { ahead: 0, behind: 3 }), undefined, 0)).toMatchObject({
            kind: 'publish',
            action: 'publish',
        });
        expect(syncButton(renamed({}, { gone: true }), undefined, 0)).toMatchObject({
            kind: 'publish',
            line: 'Tracks origin/main',
        });
        expect(menuStates(renamed())).toEqual([
            ['fetch', false, null],
            ['pull', true, null],
            ['publish', false, null],
        ]);
    });

    it('publishes a branch tracking another branch through Commit & Push and hides Create PR until then', () => {
        expect(commitAndPushBlock(renamed())).toBeUndefined();
        expect(pushOrPublish(renamed())).toBe('publish');
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
        ).toMatchObject({ kind: 'push' });
        // A name that only begins like the branch's is another branch.
        expect(syncButton(status({}, { name: 'origin/feature-2', ahead: 1 }), undefined, 0)).toMatchObject({
            kind: 'publish',
            line: 'Tracks origin/feature-2',
        });
        expect(syncButton(status({}, { name: 'origin/feature/x', ahead: 1 }), undefined, 0)).toMatchObject({
            kind: 'publish',
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

describe('commitAndPushBlock', () => {
    it('is nothing where the push after a commit would be taken: a branch on origin that is level or ahead, one that is not published, one with no commit yet', () => {
        expect(commitAndPushBlock(status())).toBeUndefined();
        expect(commitAndPushBlock(status({}, { ahead: 3 }))).toBeUndefined();
        expect(commitAndPushBlock(status({}, null))).toBeUndefined();
        expect(commitAndPushBlock(status({ head: { kind: 'unborn', name: 'main' } }, null))).toBeUndefined();
    });

    it('says why not for no origin, a detached HEAD, another remote, a branch that is behind or has diverged, and a place that is no repository', () => {
        expect(commitAndPushBlock(status({ origin: false }))).toBe('No origin');
        expect(commitAndPushBlock(status({ head: { kind: 'detached', commit: 'a'.repeat(40) } }, null))).toBe(
            'HEAD is detached'
        );
        expect(commitAndPushBlock(status({}, { name: 'fork/feature' }))).toBe('Tracks fork/feature, not origin');
        expect(commitAndPushBlock(status({}, { name: 'fork/feature', gone: true }))).toBe(
            'Tracks fork/feature, not origin'
        );
        expect(commitAndPushBlock(status({}, { behind: 1 }))).toBe('1 commit to pull first');
        expect(commitAndPushBlock(status({}, { behind: 2 }))).toBe('2 commits to pull first');
        expect(commitAndPushBlock(status({}, { ahead: 1, behind: 2 }))).toBe('Pull first');
        expect(commitAndPushBlock(status({ merging: { conflicts: 1 } }))).toBe('A merge is in progress');
        expect(commitAndPushBlock({ isRepository: false })).toBe('Not a repository');
        expect(commitAndPushBlock(undefined)).toBe('Not a repository');
    });

    it('sends a branch that is on origin with a push, and publishes one that is not', () => {
        expect(pushOrPublish(status())).toBe('push');
        expect(pushOrPublish(status({}, null))).toBe('publish');
        expect(pushOrPublish(status({}, { gone: true }))).toBe('publish');
        expect(pushOrPublish(undefined)).toBe('publish');
    });
});
