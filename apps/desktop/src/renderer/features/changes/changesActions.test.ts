import { describe, expect, it } from 'vitest';

import { commitAndPushBlock, createPullRequest, githubBaseName, isDiverged, isOffered, pushOrPublish, remoteActions, remoteBranchOf, remoteCall, remoteNotice, upstreamView } from './changesActions';

import type { GitBase, GitStatus, GitUpstream } from '@clowdy/protocol';

type RepositoryStatus = Extract<GitStatus, { isRepository: true }>;

const READY: GitBase = { state: 'ready', name: 'origin/main', commit: 'b'.repeat(40), mergeBase: 'b'.repeat(40), ahead: 2, behind: 0, commits: [] };

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

const reasons = (value: GitStatus | undefined, busy = false) => remoteActions(value, busy).map(action => [action.id, action.reason ?? null, action.count ?? null]);

describe('remoteActions', () => {
    it('lists nothing for a place that is not a repository, and for one that has not been read', () => {
        expect(remoteActions({ isRepository: false }, false)).toEqual([]);
        expect(remoteActions(undefined, false)).toEqual([]);
    });

    it('lists Fetch, Pull and Push for a branch that is on origin and level, with a reason for the two that have nothing to do', () => {
        expect(reasons(status())).toEqual([['fetch', null, null], ['pull', 'Nothing to pull', null], ['push', 'Nothing to push', null]]);
    });

    it('counts what Pull takes and Push sends, and has no reason for them', () => {
        expect(reasons(status({}, { behind: 3 }))).toEqual([['fetch', null, null], ['pull', null, 3], ['push', 'Nothing to push', null]]);
        expect(reasons(status({}, { ahead: 1 }))).toEqual([['fetch', null, null], ['pull', 'Nothing to pull', null], ['push', null, 1]]);
    });

    it('turns Pull and Push off for a branch that diverged, and says it, with how far', () => {
        expect(reasons(status({}, { ahead: 1, behind: 2 }))).toEqual([['fetch', null, null], ['pull', 'Diverged: 1 ahead, 2 behind', 2], ['push', 'Diverged: 1 ahead, 2 behind', 1]]);
        expect(isDiverged({ name: 'origin/feature', ahead: 1, behind: 2 })).toBe(true);
        expect(isDiverged({ name: 'origin/feature', ahead: 1, behind: 0 })).toBe(false);
        expect(isDiverged({ name: 'origin/feature', ahead: 1, behind: 2, gone: true })).toBe(false);
        expect(isDiverged(undefined)).toBe(false);
    });

    it('offers Publish in place of Push for a branch that is not on origin, with nothing to pull from', () => {
        expect(reasons(status({}, null))).toEqual([['fetch', null, null], ['pull', 'Not published yet', null], ['publish', null, null]]);
        // An upstream that is gone from origin is published again, not pushed.
        expect(reasons(status({}, { gone: true }))).toEqual([['fetch', null, null], ['pull', 'Upstream gone from origin', null], ['publish', null, null]]);
    });

    it('turns every action off with the reason when there is no origin, and all but Fetch for a HEAD that is on no branch', () => {
        expect(reasons(status({ origin: false }, null))).toEqual([['fetch', 'No origin', null], ['pull', 'No origin', null], ['publish', 'No origin', null]]);
        expect(reasons(status({ head: { kind: 'detached', commit: 'a'.repeat(40) } }, null))).toEqual([['fetch', null, null], ['pull', 'HEAD is detached', null], ['publish', 'HEAD is detached', null]]);
        expect(reasons(status({ head: { kind: 'unborn', name: 'main' } }, null))).toEqual([['fetch', null, null], ['pull', 'No commits yet', null], ['publish', 'No commits yet', null]]);
    });

    it('turns every action off while one runs', () => {
        expect(reasons(status({}, { ahead: 1 }), true)).toEqual([['fetch', 'An action is running', null], ['pull', 'An action is running', null], ['push', 'An action is running', 1]]);
    });

    it('turns Pull and Push off for a branch that tracks something that is not on origin, and says what', () => {
        expect(reasons(status({}, { name: 'upstream/main', ahead: 1 }))).toEqual([['fetch', null, null], ['pull', 'Tracks upstream/main, not origin', null], ['push', 'Tracks upstream/main, not origin', 1]]);
    });

    it('makes a call of each action, publishing being a push', () => {
        expect([remoteCall('fetch'), remoteCall('pull'), remoteCall('push'), remoteCall('publish')]).toEqual(['fetch', 'pull', 'push', 'push']);
    });
});

describe('upstreamView', () => {
    it('says the upstream and how far apart, and that a branch is not published', () => {
        expect(upstreamView(status({}, { ahead: 1 }))).toMatchObject({ label: 'origin/feature', detail: '1 ahead' });
        expect(upstreamView(status({}, { behind: 4 }))).toMatchObject({ label: 'origin/feature', detail: '4 behind' });
        expect(upstreamView(status())).toMatchObject({ label: 'origin/feature', detail: 'up to date' });
        expect(upstreamView(status({}, null))).toMatchObject({ label: 'Not published' });
        expect(upstreamView(status({}, null))?.detail).toBeUndefined();
    });

    it('warns for a branch that diverged and for an upstream that is gone, and names the rest of the cases', () => {
        expect(upstreamView(status({}, { ahead: 1, behind: 2 }))).toMatchObject({ label: 'origin/feature', detail: 'diverged', tone: 'warning', title: 'origin/feature, diverged: 1 ahead, 2 behind' });
        expect(upstreamView(status({}, { gone: true }))).toMatchObject({ detail: 'gone', tone: 'warning' });
        expect(upstreamView(status({ head: { kind: 'detached', commit: 'a'.repeat(40) } }, null))).toMatchObject({ label: 'Not on a branch' });
        expect(upstreamView(status({ head: { kind: 'unborn', name: 'main' } }, null))).toMatchObject({ label: 'No commits yet' });
        expect(upstreamView({ isRepository: false })).toBeUndefined();
        expect(upstreamView(undefined)).toBeUndefined();
    });
});

describe('remoteNotice', () => {
    it('says what each action did', () => {
        expect(remoteNotice({ state: 'done', action: 'fetch' })).toEqual({ words: 'Fetched origin' });
        expect(remoteNotice({ state: 'done', action: 'pull', pulled: 1 })).toEqual({ words: 'Pulled 1 commit' });
        expect(remoteNotice({ state: 'done', action: 'pull', pulled: 3 })).toEqual({ words: 'Pulled 3 commits' });
        expect(remoteNotice({ state: 'done', action: 'pull', pulled: 0 })).toEqual({ words: 'Already up to date' });
        expect(remoteNotice({ state: 'done', action: 'push' })).toEqual({ words: 'Pushed to origin' });
        expect(remoteNotice({ state: 'done', action: 'push', published: true })).toEqual({ words: 'Published to origin' });
    });

    it('says a diverged branch was left as it was, as a warning, and with no period', () => {
        expect(remoteNotice({ state: 'diverged', upstream: { name: 'origin/main', ahead: 1, behind: 2 } })).toEqual({ words: 'Diverged: 1 ahead, 2 behind, left as it was', tone: 'warning' });
    });
});

describe('githubBaseName', () => {
    const named = (name: string, state: 'ready' | 'no_merge_base' = 'ready'): GitBase => (state === 'ready' ? { ...READY, name } : { state, name, commit: 'c'.repeat(40) });

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

describe('remoteBranchOf', () => {
    const of = (value: GitStatus) => remoteBranchOf(value as RepositoryStatus);

    it('is the name the branch tracks on origin, which a branch made from another one has otherwise than its own, and its own name when it tracks nothing', () => {
        expect(of(status())).toBe('feature');
        expect(of(status({}, { name: 'origin/shared/feature' }))).toBe('shared/feature');
        expect(of(status({}, null))).toBe('feature');
        // An upstream that is gone is where a push sends the branch again.
        expect(of(status({}, { name: 'origin/other', gone: true }))).toBe('other');
    });

    it('is the branch\'s own name for an upstream that is not on origin, and nothing for a HEAD on no branch', () => {
        expect(of(status({}, { name: 'upstream/feature' }))).toBe('feature');
        expect(of(status({ head: { kind: 'detached', commit: 'a'.repeat(40) } }, null))).toBeUndefined();
    });
});

describe('createPullRequest', () => {
    const state = (value: GitStatus | undefined, extra: { hasPullRequest?: boolean; onGitHub?: boolean } = {}) => createPullRequest({ status: value, hasPullRequest: false, onGitHub: true, ...extra });

    it('opens the compare page once the branch is on origin and level with its upstream', () => {
        expect(state(status())).toEqual({ kind: 'ready', label: 'Create PR' });
    });

    it('is off, with "Switch to a feature branch", on the branch the work is compared with, whether the base is origin\'s or the local one', () => {
        const blocked = { kind: 'blocked', label: 'Create PR', reason: 'Switch to a feature branch' };

        expect(state(status({ head: { kind: 'branch', name: 'main', commit: 'a'.repeat(40) } }, { name: 'origin/main' }))).toEqual(blocked);
        expect(state(status({ head: { kind: 'branch', name: 'main', commit: 'a'.repeat(40) }, base: { ...READY, name: 'main' } }, null))).toEqual(blocked);
        expect(state(status({ head: { kind: 'branch', name: 'release/2.0', commit: 'a'.repeat(40) }, base: { ...READY, name: 'origin/release/2.0' } }))).toEqual(blocked);
    });

    it('says Publish first for a branch that is not on origin, and for one whose upstream is gone', () => {
        expect(state(status({}, null))).toEqual({ kind: 'publish', label: 'Publish first' });
        expect(state(status({}, { gone: true }))).toEqual({ kind: 'publish', label: 'Publish first' });
    });

    it('says Push first for a branch with commits that are not on origin', () => {
        expect(state(status({}, { ahead: 2 }))).toEqual({ kind: 'push', label: 'Push first' });
        // Behind only is not in the way: the branch GitHub has is all of its work.
        expect(state(status({}, { behind: 2 }))).toEqual({ kind: 'ready', label: 'Create PR' });
    });

    it('is off for a branch that diverged, one that tracks something that is not on origin, and one with no commit ahead of its base', () => {
        expect(state(status({}, { ahead: 1, behind: 1 }))).toEqual({ kind: 'blocked', label: 'Create PR', reason: 'Diverged: 1 ahead, 1 behind' });
        expect(state(status({}, { name: 'upstream/feature' }))).toEqual({ kind: 'blocked', label: 'Create PR', reason: 'Tracks upstream/feature, not origin' });
        expect(state(status({ base: { ...READY, ahead: 0 } }, null))).toEqual({ kind: 'blocked', label: 'Create PR', reason: 'No commits ahead of origin/main' });
    });

    it('works without a base to count from: a branch is still published, and the page is left to choose the base', () => {
        expect(state(status({ base: { state: 'no_base' } }, null))).toEqual({ kind: 'publish', label: 'Publish first' });
        expect(state(status({ base: { state: 'no_base' } }))).toEqual({ kind: 'ready', label: 'Create PR' });
    });

    it('is nothing: for a place that is no repository, one with no origin, a remote that is not on GitHub, a HEAD on no branch, a branch with no commit, and a branch that has a pull request', () => {
        expect(state({ isRepository: false })).toBeUndefined();
        expect(state(undefined)).toBeUndefined();
        expect(state(status({ origin: false }))).toBeUndefined();
        expect(state(status(), { onGitHub: false })).toBeUndefined();
        expect(state(status({ head: { kind: 'detached', commit: 'a'.repeat(40) } }, null))).toBeUndefined();
        expect(state(status({ head: { kind: 'unborn', name: 'feature' } }, null))).toBeUndefined();
        expect(state(status(), { hasPullRequest: true })).toBeUndefined();
    });

    it('is offered in the strip for every state but a blocked one', () => {
        expect(isOffered(state(status()))).toBe(true);
        expect(isOffered(state(status({}, null)))).toBe(true);
        expect(isOffered(state(status({}, { ahead: 1 })))).toBe(true);
        expect(isOffered(state(status({ head: { kind: 'branch', name: 'main', commit: 'a'.repeat(40) } })))).toBe(false);
        expect(isOffered(state(status({}, { ahead: 1, behind: 1 })))).toBe(false);
        expect(isOffered(undefined)).toBe(false);
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
        expect(commitAndPushBlock(status({ head: { kind: 'detached', commit: 'a'.repeat(40) } }, null))).toBe('HEAD is detached');
        expect(commitAndPushBlock(status({}, { name: 'fork/feature' }))).toBe('Tracks fork/feature, not origin');
        expect(commitAndPushBlock(status({}, { behind: 1 }))).toBe('1 commit to pull first');
        expect(commitAndPushBlock(status({}, { behind: 2 }))).toBe('2 commits to pull first');
        expect(commitAndPushBlock(status({}, { ahead: 1, behind: 2 }))).toBe('Diverged: 1 ahead, 2 behind');
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
