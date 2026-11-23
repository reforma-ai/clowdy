import { describe, expect, test } from 'vitest';

import { commitScope, type GitStatus, parseGitScope, ROUTES, turnScope, turnScopeTrees } from './index';

describe('parseGitScope', () => {
    test('takes the three words and a commit by its hash, short or whole, in any case', () => {
        expect(parseGitScope('all')).toBe('all');
        expect(parseGitScope('branch')).toBe('branch');
        expect(parseGitScope('uncommitted')).toBe('uncommitted');
        expect(parseGitScope('commit:ABCDEF1234')).toBe('commit:abcdef1234');
        expect(parseGitScope(commitScope('0123456'))).toBe('commit:0123456');
        expect(parseGitScope(`commit:${'a'.repeat(64)}`)).toBe(`commit:${'a'.repeat(64)}`);
    });

    test('takes nothing else: a hash that is too short or too long, a name, an option, another word', () => {
        for (const text of [
            'commit:abc',
            `commit:${'a'.repeat(65)}`,
            'commit:main',
            'commit:--all1234567',
            'commit:',
            'HEAD',
            'All',
            'working',
            '',
        ]) {
            expect(parseGitScope(text)).toBeUndefined();
        }
    });
});

describe('the scope of a run', () => {
    const start = 'a'.repeat(40);
    const end = 'b0'.repeat(20);

    test('is two whole tree ids, of 40 or 64 digits and of one length, joined by a colon, and keeps its letters lower case', () => {
        expect(parseGitScope(`turn:${start}:${end}`)).toBe(`turn:${start}:${end}`);
        expect(parseGitScope(turnScope(start, end))).toBe(turnScope(start, end));
        expect(parseGitScope(`turn:${start.toUpperCase()}:${end.toUpperCase()}`)).toBe(turnScope(start, end));
        expect(parseGitScope(`turn:${'c'.repeat(64)}:${'d'.repeat(64)}`)).toBe(
            `turn:${'c'.repeat(64)}:${'d'.repeat(64)}`
        );
        expect(turnScopeTrees(turnScope(start, end))).toEqual({ startTree: start, endTree: end });
    });

    test('takes nothing else: a short id, ids of two lengths, a name, an option, a third part, one id', () => {
        for (const text of [
            `turn:${start}`,
            `turn:${start}:`,
            'turn:abc:def',
            `turn:${start}:${'b'.repeat(64)}`,
            `turn:main:${end}`,
            `turn:--all:${end}`,
            `turn:${start}:${end}:${end}`,
            `turn:${'a'.repeat(41)}:${end}`,
            'turn:',
        ]) {
            expect(parseGitScope(text)).toBeUndefined();
            expect(turnScopeTrees(text)).toBeUndefined();
        }
    });
});

describe('ROUTES git reads', () => {
    test("are read from beside the folder's own git, with the project id made safe for a path", () => {
        expect(ROUTES.projectGitStatus('prj_1')).toBe('/v1/projects/prj_1/git/status');
        expect(ROUTES.projectGitChanges('prj_1')).toBe('/v1/projects/prj_1/git/changes');
        expect(ROUTES.projectGitFile('a/b?c')).toBe('/v1/projects/a%2Fb%3Fc/git/file');
        expect(ROUTES.projectGitViewed('a/b?c')).toBe('/v1/projects/a%2Fb%3Fc/git/viewed');
    });
});

describe('ROUTES git branches', () => {
    test('are beside the reads and the writes of the place, with the project id made safe for a path', () => {
        expect(ROUTES.projectGitBranches('prj_1')).toBe('/v1/projects/prj_1/git/branches');
        expect(ROUTES.projectGitBranches('a/b?c')).toBe('/v1/projects/a%2Fb%3Fc/git/branches');
        expect(ROUTES.projectGitSwitch('prj_1')).toBe('/v1/projects/prj_1/git/switch');
        expect(ROUTES.projectGitSwitch('a/b?c')).toBe('/v1/projects/a%2Fb%3Fc/git/switch');
    });
});

describe('ROUTES git writes', () => {
    test('are beside the reads of the place', () => {
        expect(ROUTES.projectGitCommit('prj_1')).toBe('/v1/projects/prj_1/git/commit');
        expect(ROUTES.projectGitMessage('a/b?c')).toBe('/v1/projects/a%2Fb%3Fc/git/message');
    });

    test('are one route for each of the three actions that reach origin', () => {
        expect(ROUTES.projectGitRemote('prj_1', 'fetch')).toBe('/v1/projects/prj_1/git/fetch');
        expect(ROUTES.projectGitRemote('prj_1', 'pull')).toBe('/v1/projects/prj_1/git/pull');
        expect(ROUTES.projectGitRemote('a/b?c', 'push')).toBe('/v1/projects/a%2Fb%3Fc/git/push');
    });
});

describe('GitStatus.lastFetchedAt', () => {
    const repository = {
        isRepository: true,
        head: { kind: 'branch', name: 'main', commit: 'a'.repeat(40) },
        origin: true,
        base: { state: 'unborn' },
    } as const;

    test('is the time of the last fetch in milliseconds, and is left out of a repository that has never fetched', () => {
        const fetched: GitStatus = { ...repository, entries: [], lastFetchedAt: 1_700_000_000_000 };
        const never: GitStatus = { ...repository, entries: [] };

        expect(fetched).toHaveProperty('lastFetchedAt', 1_700_000_000_000);
        expect(never).not.toHaveProperty('lastFetchedAt');
    });

    test('is a number, and a place that is no repository has none', () => {
        // @ts-expect-error a time is a number of milliseconds, not a text
        const text: GitStatus = { ...repository, entries: [], lastFetchedAt: '3 minutes ago' };
        // @ts-expect-error a place that is no repository says nothing else
        const none: GitStatus = { isRepository: false, lastFetchedAt: 1 };

        expect([text, none]).toHaveLength(2);
    });
});
