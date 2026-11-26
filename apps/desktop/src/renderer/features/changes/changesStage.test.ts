import { MAX_GIT_STATUS_ENTRIES } from '@clowdy/protocol';
import { describe, expect, it } from 'vitest';

import { changesSummary } from './changesStage';

import type { GitPullRequest, GitStatus } from '@clowdy/protocol';

type Repository = Extract<GitStatus, { isRepository: true }>;

const status = (fields: Partial<Repository> = {}, ahead = 0): Repository => ({
    isRepository: true,
    head: { kind: 'branch', name: 'feature', commit: '1'.repeat(40) },
    origin: true,
    entries: [],
    base: {
        state: 'ready',
        name: 'origin/main',
        commit: '2'.repeat(40),
        mergeBase: '3'.repeat(40),
        ahead,
        behind: 0,
        commits: [],
    },
    ...fields,
});
const pullRequest = (fields: Partial<GitPullRequest> = {}): GitPullRequest => ({
    number: 12,
    title: 'Add a thing',
    url: 'https://github.com/acme/app/pull/12',
    state: 'open',
    base: 'main',
    head: 'feature',
    headCommit: '1'.repeat(40),
    updatedAt: 0,
    checks: { state: 'passing', passing: 2, failing: 0, pending: 0, skipped: 0 },
    ...fields,
});
const files = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ path: `f${index}.ts`, untracked: true as const }));

describe('changesSummary', () => {
    it('says nothing until the status is read, and for a folder that is no repository', () => {
        expect(changesSummary(undefined, undefined)).toBeUndefined();
        expect(changesSummary({ isRepository: false }, undefined)).toBeUndefined();
    });

    it('is clean with no line when nothing is uncommitted, ahead or open', () => {
        expect(changesSummary(status(), undefined)).toEqual({ stage: 'clean', uncommitted: 0 });
    });

    it('counts the uncommitted files apart from the stage, whatever the stage is', () => {
        expect(changesSummary(status({ entries: files(1) }), undefined)).toMatchObject({
            stage: 'clean',
            uncommitted: 1,
            uncommittedLine: '1 uncommitted file',
        });
        expect(changesSummary(status({ entries: files(4) }, 2), pullRequest())).toMatchObject({
            stage: 'pullRequest',
            uncommitted: 4,
            stageLine: 'Pull request #12 is open',
            uncommittedLine: '4 uncommitted files',
        });
    });

    it('marks a list that git cut', () => {
        expect(changesSummary(status({ entries: files(3), truncated: true }), undefined)).toMatchObject({
            uncommittedLine: '3+ uncommitted files',
        });
        // A list as long as the most git lists has been cut whether or not it says so.
        expect(changesSummary(status({ entries: files(MAX_GIT_STATUS_ENTRIES) }), undefined)?.uncommittedLine).toBe(
            `${MAX_GIT_STATUS_ENTRIES}+ uncommitted files`
        );
    });

    it('is ahead when the branch has commits its base does not, and there is no open pull request', () => {
        expect(changesSummary(status({}, 3), undefined)).toMatchObject({
            stage: 'ahead',
            stageLine: '3 commits not in origin/main',
        });
        expect(changesSummary(status({}, 1), pullRequest({ state: 'closed' }))).toMatchObject({
            stage: 'ahead',
            stageLine: '1 commit not in origin/main',
        });
    });

    it('is not ahead when the base is not known, and a merged pull request stands for the branch even before the base was fetched', () => {
        expect(changesSummary(status({ base: { state: 'no_base' } }), undefined)?.stage).toBe('clean');
        expect(changesSummary(status({ base: { state: 'unborn' } }), undefined)?.stage).toBe('clean');
        expect(
            changesSummary(
                status({ base: { state: 'no_merge_base', name: 'origin/main', commit: '2'.repeat(40) } }),
                undefined
            )?.stage
        ).toBe('clean');
        expect(changesSummary(status({}, 3), pullRequest({ state: 'merged' }))).toMatchObject({
            stage: 'merged',
            stageLine: 'Pull request #12 is merged',
        });
    });

    it('is not ahead when only the base has moved', () => {
        const behind = status();

        if (behind.base.state === 'ready') behind.base.behind = 4;

        expect(changesSummary(behind, undefined)?.stage).toBe('clean');
    });

    it('takes no pull request that is not the branch checked out: the answer in hand can be the previous branch', () => {
        const other = pullRequest({ head: 'another-branch' });

        expect(changesSummary(status({}, 3), other)).toMatchObject({
            stage: 'ahead',
            stageLine: '3 commits not in origin/main',
        });
        expect(changesSummary(status(), other)?.stage).toBe('clean');
        expect(
            changesSummary(
                status(),
                pullRequest({
                    head: 'another-branch',
                    checks: { state: 'failing', passing: 0, failing: 1, pending: 0, skipped: 0 },
                })
            )?.stage
        ).toBe('clean');
        // A merged pull request of another branch does not clear the commits of this one.
        expect(changesSummary(status({}, 2), pullRequest({ head: 'another-branch', state: 'merged' }))?.stage).toBe(
            'ahead'
        );
    });

    it('takes no pull request for a head on no branch, or on a branch with no commit', () => {
        expect(
            changesSummary(status({ head: { kind: 'detached', commit: '1'.repeat(40) } }, 2), pullRequest())?.stage
        ).toBe('ahead');
        expect(changesSummary(status({ head: { kind: 'unborn', name: 'feature' } }), pullRequest())?.stage).toBe(
            'clean'
        );
    });

    it('is a pull request while one is open or a draft, and says when its checks are running', () => {
        expect(changesSummary(status({}, 3), pullRequest())).toMatchObject({
            stage: 'pullRequest',
            stageLine: 'Pull request #12 is open',
        });
        expect(changesSummary(status({}, 3), pullRequest({ state: 'draft' }))?.stageLine).toBe(
            'Draft pull request #12'
        );
        expect(
            changesSummary(
                status({}, 3),
                pullRequest({ checks: { state: 'pending', passing: 1, failing: 0, pending: 1, skipped: 0 } })
            )?.stageLine
        ).toBe('Pull request #12 is open, checks are running');
    });

    it('is a problem for a merge with conflicts, a paused rebase, failing checks, requested changes or a pull request that conflicts', () => {
        expect(changesSummary(status({ merging: { conflicts: 2 } }), undefined)).toMatchObject({
            stage: 'problem',
            stageLine: 'Merge has conflicts',
        });
        expect(changesSummary(status({ merging: { conflicts: 0 } }), undefined)?.stage).toBe('clean');
        expect(changesSummary(status({ rebasing: true }), undefined)).toMatchObject({
            stage: 'problem',
            stageLine: 'Rebase is paused',
        });
        expect(
            changesSummary(
                status(),
                pullRequest({ checks: { state: 'failing', passing: 0, failing: 1, pending: 0, skipped: 0 } })
            )?.stageLine
        ).toBe('Checks are failing on #12');
        expect(changesSummary(status(), pullRequest({ reviewDecision: 'changes_requested' }))?.stageLine).toBe(
            'Changes requested on #12'
        );
        expect(changesSummary(status(), pullRequest({ mergeability: 'conflicts' }))?.stageLine).toBe(
            'Pull request #12 conflicts with main'
        );
    });

    it('puts a stopped merge or rebase before the pull request, and over a pull request that landed', () => {
        expect(changesSummary(status({ merging: { conflicts: 1 } }, 2), pullRequest())).toMatchObject({
            stage: 'problem',
            stageLine: 'Merge has conflicts',
        });
        expect(changesSummary(status({ rebasing: true }), pullRequest({ state: 'merged' }))?.stage).toBe('problem');
    });

    it('does not count a merged or closed pull request as a problem', () => {
        const failing = { state: 'failing' as const, passing: 0, failing: 1, pending: 0, skipped: 0 };

        expect(changesSummary(status(), pullRequest({ state: 'merged', checks: failing }))?.stage).toBe('merged');
        expect(changesSummary(status(), pullRequest({ state: 'closed', checks: failing }))?.stage).toBe('clean');
    });
});

describe('changesSummary, the count of the sync button', () => {
    const upstream = (ahead: number, behind: number) => ({ upstream: { name: 'origin/feature', ahead, behind } });
    /** A status whose base has commits that the branch lacks, which is what the button's Update from the base is for. */
    const baseBehind = (behind: number, fields: Partial<Repository> = {}): Repository => {
        const place = status(fields);

        return place.base.state === 'ready' ? { ...place, base: { ...place.base, behind } } : place;
    };

    it('counts the commits to push before those to pull, as the button shows them, and says both in its line', () => {
        expect(changesSummary(status(upstream(3, 0)), undefined)?.sync).toEqual({
            arrow: 'up',
            count: 3,
            line: '3 commits to push',
        });
        expect(changesSummary(status(upstream(0, 2)), undefined)?.sync).toEqual({
            arrow: 'down',
            count: 2,
            line: '2 commits to pull',
        });
        expect(changesSummary(status(upstream(1, 2)), undefined)?.sync).toEqual({
            arrow: 'up',
            count: 1,
            line: '2 commits to pull and 1 commit to push',
        });
    });

    it('counts the commits to merge from the base when the branch has nothing to push or pull, as Update from the base does', () => {
        const merge = (count: number) => ({ arrow: 'down', count, line: `${count} commits to merge from main` });

        expect(changesSummary(baseBehind(17, upstream(0, 0)), undefined)?.sync).toEqual(merge(17));
        // A branch that tracks something that is not on origin is moved by nothing else.
        expect(
            changesSummary(baseBehind(4, { upstream: { name: 'fork/feature', ahead: 1, behind: 0 } }), undefined)?.sync
        ).toEqual(merge(4));
        // What the button has to push or pull comes before the base's commits.
        expect(changesSummary(baseBehind(5, upstream(2, 0)), undefined)?.sync).toMatchObject({ arrow: 'up', count: 2 });
    });

    it('has no count while the button has none: level, not published, or stopped in a merge or a rebase', () => {
        expect(changesSummary(status(upstream(0, 0)), undefined)?.sync).toBeUndefined();
        expect(changesSummary(status(), undefined)?.sync).toBeUndefined();
        expect(changesSummary(status({ ...upstream(2, 0), rebasing: true }), undefined)?.sync).toBeUndefined();
        expect(
            changesSummary(status({ ...upstream(2, 0), merging: { conflicts: 0 } }), undefined)?.sync
        ).toBeUndefined();
        expect(changesSummary(status({ ...upstream(2, 0), origin: false }), undefined)?.sync).toBeUndefined();
    });

    it('has no count for a branch that is to be published, and none for a head that is on no branch', () => {
        const head = { kind: 'detached' as const, commit: '1'.repeat(40) };

        // The upstream is gone from origin, or is on origin under another name: the button offers Publish branch, whatever the base has.
        expect(
            changesSummary(
                baseBehind(3, { upstream: { name: 'origin/feature', ahead: 0, behind: 0, gone: true } }),
                undefined
            )?.sync
        ).toBeUndefined();
        expect(
            changesSummary(baseBehind(3, { upstream: { name: 'origin/other', ahead: 2, behind: 0 } }), undefined)?.sync
        ).toBeUndefined();
        expect(changesSummary(baseBehind(3, { head }), undefined)?.sync).toBeUndefined();
        expect(
            changesSummary(baseBehind(3, { head: { kind: 'unborn', name: 'feature' } }), undefined)?.sync
        ).toBeUndefined();
    });

    it('has no count of the base for the branch that is the base', () => {
        const main = { kind: 'branch' as const, name: 'main', commit: '1'.repeat(40) };

        expect(
            changesSummary(
                baseBehind(3, { head: main, upstream: { name: 'origin/main', ahead: 0, behind: 0 } }),
                undefined
            )?.sync
        ).toBeUndefined();
    });
});
