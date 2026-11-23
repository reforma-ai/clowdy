import { describe, expect, test } from 'vitest';

import { commitScope, parseGitScope, ROUTES } from './index';

describe('parseGitScope', () => {
    test('takes the three words and a commit by its hash, short or whole, in any case', () => {
        expect(parseGitScope('all')).toBe('all');
        expect(parseGitScope('branch')).toBe('branch');
        expect(parseGitScope('uncommitted')).toBe('uncommitted');
        expect(parseGitScope('commit:ABCDEF1234')).toBe('commit:abcdef1234');
        expect(parseGitScope(commitScope('0123456'))).toBe('commit:0123456');
        expect(parseGitScope(`commit:${ 'a'.repeat(64) }`)).toBe(`commit:${ 'a'.repeat(64) }`);
    });

    test('takes nothing else: a hash that is too short or too long, a name, an option, another word', () => {
        for (const text of ['commit:abc', `commit:${ 'a'.repeat(65) }`, 'commit:main', 'commit:--all1234567', 'commit:', 'HEAD', 'All', 'working', '']) {
            expect(parseGitScope(text)).toBeUndefined();
        }
    });
});

describe('ROUTES git reads', () => {
    test('are read from beside the folder\'s own git, with the project id made safe for a path', () => {
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
