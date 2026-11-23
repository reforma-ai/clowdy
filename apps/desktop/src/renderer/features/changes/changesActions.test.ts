import { describe, expect, it } from 'vitest';

import { commitAndPushBlock, commitBlock, commitLabel, commitTarget, createPullRequest, githubBaseName, isDiverged, isFetchFirst, lastFetchedWords, middleCut, nextStep, pushOrPublish, remoteActions, remoteBranchOf, remoteCall, remoteNotice, RUNNING_WORDS, syncButton } from './changesActions';

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

    it('does not offer to publish a branch whose upstream is gone from another remote: the daemon refuses it, so the reason is the remote and not a gone origin', () => {
        expect(reasons(status({}, { name: 'upstream/main', gone: true }))).toEqual([['fetch', null, null], ['pull', 'Tracks upstream/main, not origin', null], ['publish', 'Tracks upstream/main, not origin', null]]);
        // The same upstream gone from origin is published again.
        expect(reasons(status({}, { gone: true }))).toEqual([['fetch', null, null], ['pull', 'Upstream gone from origin', null], ['publish', null, null]]);
    });

    it('makes a call of each action, publishing being a push', () => {
        expect([remoteCall('fetch'), remoteCall('pull'), remoteCall('push'), remoteCall('publish')]).toEqual(['fetch', 'pull', 'push', 'push']);
    });
});

describe('the labels of the menu', () => {
    it('are GitHub Desktop\'s words: Fetch origin, Pull origin, Push origin and Publish branch', () => {
        expect(remoteActions(status({}, { ahead: 1 }), false).map(action => action.label)).toEqual(['Fetch origin', 'Pull origin', 'Push origin']);
        expect(remoteActions(status({}, null), false).map(action => action.label)).toEqual(['Fetch origin', 'Pull origin', 'Publish branch']);
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
    const sync = (value: GitStatus | undefined, running: Parameters<typeof syncButton>[1] = undefined) => syncButton(value, running, NOW);

    it('is nothing for a place that is not a repository and for one that has not been read', () => {
        expect(sync({ isRepository: false })).toBeUndefined();
        expect(sync(undefined)).toBeUndefined();
    });

    it('says what is running, with the progress as its label, and cannot be pressed', () => {
        expect(sync(status(), 'fetch')).toMatchObject({ kind: 'running', label: 'Fetching origin', reason: 'An action is running' });
        expect(sync(status(), 'pull')).toMatchObject({ kind: 'running', label: 'Pulling origin' });
        expect(sync(status(), 'push')).toMatchObject({ kind: 'running', label: 'Pushing origin' });
        expect(sync(status({}, null), 'publish')).toMatchObject({ kind: 'running', label: 'Publishing branch' });
        expect(sync(status(), 'fetch')?.action).toBeUndefined();
    });

    it('says there is nothing to sync with when the repository has no origin, whatever the branch is', () => {
        expect(sync(status({ origin: false }))).toMatchObject({ kind: 'no_origin', label: 'No origin', line: 'Nothing to sync with', reason: 'No origin' });
        expect(sync(status({ origin: false }, null))?.action).toBeUndefined();
        expect(sync(status({ origin: false }), 'fetch')).toMatchObject({ kind: 'running' });
    });

    it('is Publish branch, off with the reason, for a HEAD on no branch and for a branch with no commit yet', () => {
        expect(sync(status({ head: { kind: 'detached', commit: 'a'.repeat(40) } }, null))).toMatchObject({ kind: 'blocked', label: 'Publish branch', line: 'HEAD is detached', reason: 'HEAD is detached' });
        expect(sync(status({ head: { kind: 'unborn', name: 'main' } }, null))).toMatchObject({ kind: 'blocked', label: 'Publish branch', line: 'No commits yet', reason: 'No commits yet' });
        expect(sync(status({ head: { kind: 'unborn', name: 'main' } }, null))?.action).toBeUndefined();
    });

    it('is Publish branch for a branch that is not on origin, and again for one whose upstream is gone, which it says as a warning', () => {
        expect(sync(status({}, null))).toMatchObject({ kind: 'publish', label: 'Publish branch', action: 'publish', line: 'Publish this branch to origin' });
        expect(sync(status({}, null))?.reason).toBeUndefined();
        expect(sync(status({}, { gone: true }))).toMatchObject({ kind: 'publish', label: 'Publish branch', action: 'publish', line: 'Upstream gone from origin', tone: 'warning' });
    });

    it('is Pull origin with the count for a branch that is behind, and says when the counts are from', () => {
        expect(sync(status({ lastFetchedAt: FETCHED }, { behind: 2 }))).toMatchObject({ kind: 'pull', label: 'Pull origin', behind: 2, action: 'pull', line: 'Last fetched 3 minutes ago' });
        expect(sync(status({}, { behind: 1 }))).toMatchObject({ kind: 'pull', behind: 1, line: 'Never fetched' });
        expect(sync(status({}, { behind: 1 }))?.ahead).toBeUndefined();
    });

    it('is Push origin with the count for a branch that is ahead', () => {
        expect(sync(status({ lastFetchedAt: FETCHED }, { ahead: 1 }))).toMatchObject({ kind: 'push', label: 'Push origin', ahead: 1, action: 'push', line: 'Last fetched 3 minutes ago' });
        expect(sync(status({}, { ahead: 4 }))?.behind).toBeUndefined();
    });

    it('is a Diverged button that cannot be pressed for a branch with commits on both sides, and says what to do about it, and with how far', () => {
        const view = sync(status({ lastFetchedAt: FETCHED }, { ahead: 1, behind: 2 }));

        expect(view).toMatchObject({ kind: 'diverged', label: 'Diverged', ahead: 1, behind: 2, reason: 'Diverged: 1 ahead, 2 behind', line: 'Merge or rebase in a terminal', tone: 'warning' });
        expect(view?.action).toBeUndefined();
        expect(view?.title).toContain('merge or rebase it in a terminal');
        // Neither Pull origin nor Force push origin is offered here: the app has no merge and no force.
        expect(JSON.stringify(view)).not.toMatch(/Force push/);
    });

    it('is Fetch origin with when the last fetch was for a branch that is level, or Never fetched', () => {
        expect(sync(status({ lastFetchedAt: FETCHED }))).toMatchObject({ kind: 'fetch', label: 'Fetch origin', action: 'fetch', line: 'Last fetched 3 minutes ago' });
        expect(sync(status())).toMatchObject({ kind: 'fetch', label: 'Fetch origin', action: 'fetch', line: 'Never fetched' });
        expect(sync(status())?.reason).toBeUndefined();
        expect(sync(status({ lastFetchedAt: FETCHED }))?.title).toBe('Fetch origin to look for new commits: origin/feature is up to date, last fetched 3 minutes ago');
    });

    it('is Fetch origin, with what is in the way as its line, for a branch that tracks something that is not on origin', () => {
        expect(sync(status({}, { name: 'upstream/main', ahead: 1 }))).toMatchObject({ kind: 'fetch', label: 'Fetch origin', action: 'fetch', line: 'Tracks upstream/main, not origin' });
    });

    it('is Fetch origin, not a Publish branch that the daemon would refuse, for an upstream that is gone from another remote', () => {
        expect(sync(status({}, { name: 'upstream/main', gone: true }))).toMatchObject({ kind: 'fetch', label: 'Fetch origin', action: 'fetch', line: 'Tracks upstream/main, not origin' });
    });

    it('goes down GitHub Desktop\'s order: running, no origin, no branch, not published, not on origin, diverged, behind, ahead, level', () => {
        const order = (value: GitStatus, running?: Parameters<typeof syncButton>[1]) => sync(value, running)?.kind;

        expect(order(status({ origin: false }, null), 'fetch')).toBe('running');
        expect(order(status({ origin: false, head: { kind: 'detached', commit: 'a'.repeat(40) } }, null))).toBe('no_origin');
        expect(order(status({ head: { kind: 'detached', commit: 'a'.repeat(40) } }, { ahead: 1 }))).toBe('blocked');
        expect(order(status({}, { name: 'upstream/x', ahead: 1, behind: 1 }))).toBe('fetch');
        expect(order(status({}, { ahead: 1, behind: 1 }))).toBe('diverged');
        expect(order(status({}, { ahead: 1, behind: 1, gone: true }))).toBe('publish');
        expect(order(status({}, { ahead: 3 }))).toBe('push');
        expect(order(status({}, { behind: 3 }))).toBe('pull');
        expect(order(status())).toBe('fetch');
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
        const texts = new Set<string>(['A commit summary is required to commit', 'Select one or more files to commit', commitLabel(3, 'main'), ...Object.values(RUNNING_WORDS)]);

        for (const value of statuses) {
            for (const view of [syncButton(value, undefined, NOW)]) for (const text of [view?.label, view?.line, view?.reason, view?.title]) if (text) texts.add(text);

            for (const action of remoteActions(value, false)) for (const text of [action.label, action.reason]) if (text) texts.add(text);

            const step = nextStep(value, { kind: 'ready', label: 'Create PR' });

            for (const text of [step?.title, step?.description, commitAndPushBlock(value)]) if (text) texts.add(text);
        }

        // At least the long tooltip of the diverged state has two sentences, so the check is not about nothing.
        expect([...texts].some(text => /\. [A-Z]/.test(text))).toBe(true);

        for (const text of texts) expect(/\. [A-Z]/.test(text) ? text.endsWith('.') : !text.endsWith('.')).toBe(true);
    });
});

describe('nextStep', () => {
    const ready = { kind: 'ready', label: 'Create PR' } as const;

    it('is Publish your branch for a branch that is not on origin, and for one whose upstream is gone, whatever Create PR says', () => {
        expect(nextStep(status({}, null), undefined)).toMatchObject({ kind: 'publish', title: 'Publish your branch' });
        expect(nextStep(status({}, { gone: true }), ready)).toMatchObject({ kind: 'publish', title: 'Publish your branch' });
    });

    it('is Pull for the commits origin has, with the number and the singular for one', () => {
        expect(nextStep(status({}, { behind: 2 }), ready)).toMatchObject({ kind: 'pull', title: 'Pull 2 commits from the origin remote' });
        expect(nextStep(status({}, { behind: 1 }), ready)).toMatchObject({ kind: 'pull', title: 'Pull 1 commit from the origin remote' });
    });

    it('is Push for the commits the branch has, with the number and the singular for one', () => {
        expect(nextStep(status({}, { ahead: 3 }), ready)).toMatchObject({ kind: 'push', title: 'Push 3 commits to the origin remote' });
        expect(nextStep(status({}, { ahead: 1 }), ready)).toMatchObject({ kind: 'push', title: 'Push 1 commit to the origin remote' });
    });

    it('is Create a Pull Request for a branch that is published and level, where Create PR is ready, and nothing where it is not', () => {
        expect(nextStep(status(), ready)).toMatchObject({ kind: 'pullRequest', title: 'Create a Pull Request from your current branch' });
        // The base branch, a branch with a pull request, a branch with no commit ahead of its base, and a pull request not read yet are none.
        expect(nextStep(status(), { kind: 'blocked', label: 'Create PR', reason: 'Switch to a feature branch' })).toBeUndefined();
        expect(nextStep(status(), undefined)).toBeUndefined();
    });

    it('is nothing for a branch that diverged, one that tracks another remote, no origin, a HEAD on no branch, a branch with no commit and a place that is no repository', () => {
        expect(nextStep(status({}, { ahead: 1, behind: 1 }), ready)).toBeUndefined();
        expect(nextStep(status({}, { name: 'upstream/main', behind: 1 }), ready)).toBeUndefined();
        expect(nextStep(status({}, { name: 'upstream/main', gone: true }), ready)).toBeUndefined();
        expect(nextStep(status({ origin: false }, null), ready)).toBeUndefined();
        expect(nextStep(status({ head: { kind: 'detached', commit: 'a'.repeat(40) } }, null), ready)).toBeUndefined();
        expect(nextStep(status({ head: { kind: 'unborn', name: 'main' } }, null), ready)).toBeUndefined();
        expect(nextStep({ isRepository: false }, ready)).toBeUndefined();
        expect(nextStep(undefined, ready)).toBeUndefined();
    });

    it('agrees with the Create PR button: where it is ready the step is the pull request, unless the branch is behind, which comes first', () => {
        for (const upstream of [null, {}, { ahead: 1 }, { behind: 1 }, { ahead: 1, behind: 1 }, { gone: true }, { name: 'upstream/feature' }, { name: 'upstream/feature', gone: true }] as Array<Partial<GitUpstream> | null>) {
            const value = status({}, upstream);
            const pr = createPullRequest({ status: value, hasPullRequest: false, onGitHub: true });

            if (pr?.kind === 'ready') expect(nextStep(value, pr)?.kind).toBe(upstream?.behind ? 'pull' : 'pullRequest');
            else expect(nextStep(value, pr)?.kind).not.toBe('pullRequest');
        }
    });
});

describe('the commit button', () => {
    it('counts the ticked files and names the branch: Commit 3 files to main, Commit 1 file to main', () => {
        expect(commitLabel(3, 'main')).toBe('Commit 3 files to main');
        expect(commitLabel(1, 'main')).toBe('Commit 1 file to main');
        expect(commitLabel(0, 'main')).toBe('Commit to main');
        expect(commitLabel(2, undefined)).toBe('Commit 2 files');
    });

    it('cuts a long branch name in its middle and keeps its start and its end', () => {
        expect(middleCut('main', 24)).toBe('main');
        expect(middleCut('a'.repeat(24), 24)).toBe('a'.repeat(24));
        expect(middleCut('clowdy/ab12cd34-weekend-surcharge', 24)).toBe('clowdy/ab12c…d-surcharge');
        expect(middleCut('clowdy/ab12cd34-weekend-surcharge', 24)).toHaveLength(24);
        expect(commitLabel(12, 'maksim-kachurin/feat/long-branch-name')).toBe('Commit 12 files to maksim-kachu…branch-name');
        expect(middleCut('abcdefghij', 6)).toBe('abc…ij');
    });

    it('never cuts a character in two: an emoji or an accented letter on the cut stays whole', () => {
        const wide = `😀${ 'a'.repeat(30) }😀`;

        // Each smiley is one character, though two UTF-16 units: cut by units, the end would start with half of one.
        expect(middleCut(wide, 24)).toBe(`😀${ 'a'.repeat(11) }…${ 'a'.repeat(10) }😀`);
        expect(middleCut('😀'.repeat(30), 24)).toBe(`${ '😀'.repeat(12) }…${ '😀'.repeat(11) }`);
        // The accent is the last character of the kept start: it goes with its letter.
        expect(middleCut(`${ 'a'.repeat(11) }e\u0301${ 'b'.repeat(25) }`, 24)).toBe(`${ 'a'.repeat(11) }e\u0301…${ 'b'.repeat(11) }`);
        // A text that fits is left as it is, whatever its characters are made of.
        expect(middleCut('😀'.repeat(24), 24)).toBe('😀'.repeat(24));
    });

    it('says why it cannot be pressed in GitHub Desktop\'s tooltips: the summary first, then the files', () => {
        expect(commitBlock('', 3)).toBe('A commit summary is required to commit');
        expect(commitBlock('  \n ', 0)).toBe('A commit summary is required to commit');
        expect(commitBlock('Fix it', 0)).toBe('Select one or more files to commit');
        expect(commitBlock('Fix it', 2)).toBeUndefined();
    });

    it('goes to the branch the work is compared with when the branch is its base, origin\'s or the local one', () => {
        expect(commitTarget(status({ head: { kind: 'branch', name: 'main', commit: 'a'.repeat(40) } }))).toEqual({ name: 'main', onBase: true });
        expect(commitTarget(status({ head: { kind: 'branch', name: 'main', commit: 'a'.repeat(40) }, base: { ...READY, name: 'main' } }))).toEqual({ name: 'main', onBase: true });
        expect(commitTarget(status())).toEqual({ name: 'feature', onBase: false });
        expect(commitTarget(status({ base: { state: 'no_base' }, head: { kind: 'branch', name: 'main', commit: 'a'.repeat(40) } }))).toEqual({ name: 'main', onBase: false });
        expect(commitTarget(status({ head: { kind: 'detached', commit: 'a'.repeat(40) } }, null))).toEqual({ name: 'detached HEAD', onBase: false });
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
        expect(state(status({}, { name: 'upstream/feature', gone: true }))).toEqual({ kind: 'blocked', label: 'Create PR', reason: 'Tracks upstream/feature, not origin' });
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
        expect(commitAndPushBlock(status({}, { name: 'fork/feature', gone: true }))).toBe('Tracks fork/feature, not origin');
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
