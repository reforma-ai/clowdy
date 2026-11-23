import { describe, expect, it } from 'vitest';

import { chatsUsing, effectiveChoice, modeOf, pickableWorktrees, repositoryOf, samePath, worktreeLabel } from './workspaceChoice';

import type { Chat, FolderGit } from '@clowdy/protocol';
import type { FolderRepository } from './useFolderRepository';

const git: Extract<FolderGit, { isRepository: true }> = {
    isRepository: true,
    branch: 'main',
    defaultBranch: 'origin/main',
    branches: [{ name: 'main', remote: false }, { name: 'dev', remote: false }, { name: 'origin/main', remote: true }],
    worktrees: [
        { path: '/work/api', branch: 'main', head: 'a1b2c3d', main: true, dirty: false },
        { path: '/work/api-fix', branch: 'fix/price', head: '9f8e7d6', main: false, dirty: true },
        { path: '/work/api-detached', head: '5c4d3e2', main: false, dirty: false },
    ],
};
const ready = (answer: FolderGit): FolderRepository => ({ status: 'ready', git: answer });

describe('the repository of a folder', () => {
    it('is there only once the daemon says the folder is one', () => {
        expect(repositoryOf(ready(git))).toBe(git);
        expect(repositoryOf(ready({ isRepository: false }))).toBeUndefined();
        expect(repositoryOf({ status: 'loading' })).toBeUndefined();
        expect(repositoryOf({ status: 'failed', reason: 'git did not answer' })).toBeUndefined();
    });

    it('offers every worktree but the folder\'s own checkout, named by its branch or the commit it is on', () => {
        expect(pickableWorktrees(git).map(worktree => worktree.path)).toEqual(['/work/api-fix', '/work/api-detached']);
        expect(pickableWorktrees(git).map(worktreeLabel)).toEqual(['fix/price', 'Detached at 5c4d3e2']);
        expect(worktreeLabel({ head: '' })).toBe('Detached HEAD');
    });
});

describe('what a new chat is sent with', () => {
    it('is Project checkout, which sends nothing, for no choice', () => {
        expect(effectiveChoice(null, ready(git))).toBeUndefined();
        expect(modeOf(undefined)).toBe('checkout');
    });

    it('sends nothing, whatever was chosen, for a folder that is no repository, one that could not be read and one still being read', () => {
        const choice = { mode: 'new' as const, base: 'dev' };

        expect(effectiveChoice(choice, ready({ isRepository: false }))).toBeUndefined();
        expect(effectiveChoice(choice, { status: 'failed', reason: '' })).toBeUndefined();
        expect(effectiveChoice(choice, { status: 'loading' })).toBeUndefined();
    });

    it('keeps a new worktree with the base that was picked, and none when the default one is used', () => {
        expect(effectiveChoice({ mode: 'new' }, ready(git))).toEqual({ mode: 'new' });
        expect(effectiveChoice({ mode: 'new', base: 'dev' }, ready(git))).toEqual({ mode: 'new', base: 'dev' });
        expect(effectiveChoice({ mode: 'new', base: 'origin/main' }, ready(git))).toEqual({ mode: 'new', base: 'origin/main' });
    });

    it('drops a base the repository no longer has, which is the default one, and takes the commit a detached HEAD gives as the default', () => {
        expect(effectiveChoice({ mode: 'new', base: 'gone' }, ready(git))).toEqual({ mode: 'new' });
        expect(effectiveChoice({ mode: 'new', base: '5c4d3e2' }, ready({ ...git, defaultBranch: '5c4d3e2' }))).toEqual({ mode: 'new', base: '5c4d3e2' });
    });

    it('has no new worktree where the repository has no commit to start from', () => {
        expect(effectiveChoice({ mode: 'new' }, ready({ ...git, defaultBranch: undefined, branches: [] }))).toBeUndefined();
    });

    it('keeps an existing worktree the folder still lists, by the path the daemon wrote, and never the folder\'s own checkout or one that is gone', () => {
        expect(effectiveChoice({ mode: 'existing', path: '/work/api-fix' }, ready(git))).toEqual({ mode: 'existing', path: '/work/api-fix' });
        expect(effectiveChoice({ mode: 'existing', path: '/work/api-fix/' }, ready(git))).toEqual({ mode: 'existing', path: '/work/api-fix' });
        expect(effectiveChoice({ mode: 'existing', path: '/work/api' }, ready(git))).toBeUndefined();
        expect(effectiveChoice({ mode: 'existing', path: '/work/removed' }, ready(git))).toBeUndefined();
    });
});

describe('paths', () => {
    it('are the same one with or without a trailing separator, and on Windows in any case and either kind of separator', () => {
        expect(samePath('/work/api', '/work/api/')).toBe(true);
        expect(samePath('/work/api', '/work/API')).toBe(false);
        expect(samePath('C:\\Work\\Api', 'c:/work/api/')).toBe(true);
        expect(samePath('C:\\Work\\Api', 'C:\\Work\\Other')).toBe(false);
    });
});

describe('the chats that use a worktree', () => {
    const chat = (id: string, rest: Partial<Chat>): Chat => ({ id, projectId: 'p', title: id, mode: 'autopilot', createdAt: 1, updatedAt: 1, ...rest });
    const workspace = { id: 'wks_1', folderId: 'f', path: '/work/api-fix', managed: false, ready: true };

    it('are the ones the person made and has not put away, and not the threads that share it', () => {
        const chats = [
            chat('a', { workspace }),
            chat('b', { workspace: { ...workspace, path: '/work/api-fix/' } }),
            chat('thread', { workspace, parentChatId: 'a' }),
            chat('archived', { workspace, archivedAt: 5 }),
            chat('elsewhere', { workspace: { ...workspace, path: '/work/other' } }),
            chat('plain', {}),
        ];

        expect(chatsUsing(chats, '/work/api-fix').map(found => found.id)).toEqual(['a', 'b']);
    });
});
