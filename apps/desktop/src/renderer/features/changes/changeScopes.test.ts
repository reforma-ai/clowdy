import { commitScope, turnScope } from '@clowdy/protocol';
import { describe, expect, it } from 'vitest';

import {
    ALL_CHANGES_LABEL,
    commitOfScope,
    isCommitScope,
    isRunScope,
    LAST_RUN_LABEL,
    LAST_RUN_NOTE,
    scopeOptions,
    usableScope,
} from './changeScopes';

import type { GitBase, GitCommit } from '@clowdy/protocol';

const commit = (sha: string, subject: string): GitCommit => ({
    sha: sha.repeat(40).slice(0, 40),
    shortSha: sha.repeat(7).slice(0, 7),
    subject,
    author: 'Dana',
    committedAt: new Date(2026, 10, 20, 12).getTime(),
});
const NEWEST = commit('b', 'Charge a weekend surcharge');
const OLDEST = {
    ...commit('a', 'Price a booking by the day'),
    committedAt: new Date(2026, 10, 19, 23, 59).getTime(),
};
const now = new Date(2026, 10, 20, 13).getTime();

const ready: GitBase = {
    state: 'ready',
    name: 'origin/main',
    commit: 'c'.repeat(40),
    mergeBase: 'd'.repeat(40),
    ahead: 2,
    behind: 0,
    commits: [NEWEST, OLDEST],
};

describe('the scope menu', () => {
    it("has all changes, the branch, what is not committed, and a commit for each of the branch's, newest first with the subject and local time before the hash", () => {
        const options = scopeOptions(ready, undefined, now);

        expect(options.map(option => option.label)).toEqual([
            ALL_CHANGES_LABEL,
            'Branch',
            'Uncommitted',
            'Charge a weekend surcharge',
            'Price a booking by the day',
        ]);
        expect(options.map(option => option.scope)).toEqual([
            'all',
            'branch',
            'uncommitted',
            commitScope(NEWEST.sha),
            commitScope(OLDEST.sha),
        ]);
        expect(options[3]?.commit).toBe(NEWEST);
        expect(options[3]?.note).toBe('12:00 (bbbbbbb)');
        expect(options[4]?.note).toBe('19 Nov, 23:59 (aaaaaaa)');
    });

    it('includes the year for older commits and keeps the hash if the timestamp is invalid', () => {
        const options = scopeOptions(
            {
                ...ready,
                commits: [
                    { ...NEWEST, committedAt: new Date(2025, 10, 20, 9, 5).getTime() },
                    { ...OLDEST, committedAt: Number.NaN },
                ],
            },
            undefined,
            now
        );

        expect(options[3]?.note).toBe('20 Nov 2025, 09:05 (bbbbbbb)');
        expect(options[4]?.note).toBe('aaaaaaa');
    });

    it('leaves the branch and its commits out while the base is not there, whatever the reason', () => {
        for (const base of [
            undefined,
            { state: 'unborn' },
            { state: 'no_base' },
            { state: 'no_merge_base', name: 'origin/main', commit: 'c'.repeat(40) },
        ] as const) {
            const options = scopeOptions(base);

            expect(options.map(option => option.label)).toEqual([ALL_CHANGES_LABEL, 'Uncommitted']);
            expect(options[0]?.note).toBe('Local changes until a comparison base is available');
        }
    });

    it("has the open chat's last run after what is not committed, whatever the base is, with a line that says the edits of others are in it", () => {
        const run = turnScope('a'.repeat(40), 'b'.repeat(40));

        expect(scopeOptions(ready, run).map(option => option.label)).toEqual([
            ALL_CHANGES_LABEL,
            'Branch',
            'Uncommitted',
            LAST_RUN_LABEL,
            'Charge a weekend surcharge',
            'Price a booking by the day',
        ]);
        expect(scopeOptions(ready, run)[3]).toEqual({ scope: run, label: 'Last run', note: LAST_RUN_NOTE });
        expect(scopeOptions(undefined, run).map(option => option.label)).toEqual([
            ALL_CHANGES_LABEL,
            'Uncommitted',
            LAST_RUN_LABEL,
        ]);
        // None for a chat that has no run that changed files.
        expect(scopeOptions(ready).map(option => option.label)).not.toContain(LAST_RUN_LABEL);
        expect(scopeOptions(ready).every(option => option.note.length > 0)).toBe(true);
        expect(LAST_RUN_NOTE).not.toMatch(/\.$/);
    });

    it("knows a run's scope by its two trees", () => {
        expect(isRunScope(turnScope('a'.repeat(40), 'b'.repeat(40)))).toBe(true);
        expect(isRunScope(commitScope('a'.repeat(40)))).toBe(false);
        expect(isRunScope('all')).toBe(false);
        expect(usableScope(turnScope('a'.repeat(40), 'b'.repeat(40)), { state: 'no_base' })).toBe(
            turnScope('a'.repeat(40), 'b'.repeat(40))
        );
    });

    it('has no commit entry for a branch with no commits yet, and keeps the branch', () => {
        expect(scopeOptions({ ...ready, ahead: 0, commits: [] }).map(option => option.label)).toEqual([
            ALL_CHANGES_LABEL,
            'Branch',
            'Uncommitted',
        ]);
    });
});

describe('the scope that is read', () => {
    it('reads the branch against a base only while there is one: without it the branch is all changes, and with a base not read yet the choice stands', () => {
        expect(usableScope('branch', ready)).toBe('branch');
        expect(usableScope('branch', { state: 'no_base' })).toBe('all');
        expect(usableScope('branch', { state: 'unborn' })).toBe('all');
        expect(usableScope('branch', undefined)).toBe('branch');
    });

    it('leaves every other scope as it is', () => {
        for (const scope of ['all', 'uncommitted', commitScope(OLDEST.sha)] as const) {
            expect(usableScope(scope, { state: 'no_base' })).toBe(scope);
            expect(usableScope(scope, ready)).toBe(scope);
        }
    });

    it("knows a commit's scope and the commit of the branch that it is", () => {
        expect(isCommitScope('all')).toBe(false);
        expect(isCommitScope(commitScope(NEWEST.sha))).toBe(true);
        expect(commitOfScope(commitScope(OLDEST.sha), ready)).toBe(OLDEST);
        expect(commitOfScope(commitScope('f'.repeat(40)), ready)).toBeUndefined();
        expect(commitOfScope('all', ready)).toBeUndefined();
        expect(commitOfScope(commitScope(OLDEST.sha), { state: 'no_base' })).toBeUndefined();
    });
});
