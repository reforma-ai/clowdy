import { describe, expect, it } from 'vitest';

import { changesLabel, lockTip, mergedMark, removeHint, repositoryGroups } from './worktreeView';

import type { FolderWorktrees, ProjectFolder } from '@clowdy/protocol';

describe('changesLabel', () => {
    it('says a clean tree is clean, and else how many files are changed', () => {
        expect(changesLabel(0)).toBe('Clean');
        expect(changesLabel(1)).toBe('1 changed');
        expect(changesLabel(12)).toBe('12 changed');
    });
});

describe('mergedMark', () => {
    it('says a worktree whose work is in the base is merged, and names the base', () => {
        expect(mergedMark({ main: false, merged: true, base: 'origin/main' })).toEqual({ label: 'Merged', tip: 'Its work is in origin/main', color: 'success' });
    });

    it('says one whose work is not is not merged, and that a squash merge reads like that', () => {
        const mark = mergedMark({ main: false, merged: false, base: 'origin/main' })!;

        expect(mark.label).toBe('Not merged');
        expect(mark.color).toBe('warning');
        expect(mark.tip).toBe('Its work is not in origin/main as last fetched. A squash merge shows as not merged.');
    });

    it('has no mark for the folder\'s own checkout, or when no base resolves', () => {
        expect(mergedMark({ main: true, merged: true, base: 'origin/main' })).toBeUndefined();
        expect(mergedMark({ main: false })).toBeUndefined();
    });
});

describe('removeHint', () => {
    it('gives the reason that stops a worktree, the lock with git\'s own words', () => {
        expect(removeHint({ blocked: 'locked', locked: 'on an external drive' })).toBe('Git has it locked: on an external drive');
        expect(removeHint({ blocked: 'locked', locked: '' })).toBe('Git has it locked');
        expect(removeHint({ blocked: 'chats' })).toBe('A chat works in it');
    });

    it('gives none for a worktree nothing stops, and none for the folder\'s own checkout, which has no Remove to explain', () => {
        expect(removeHint({})).toBeUndefined();
        expect(removeHint({ blocked: 'main' })).toBeUndefined();
    });
});

describe('lockTip', () => {
    it('puts git\'s reason after the lock, when there is one', () => {
        expect(lockTip('')).toBe('Git has it locked');
        expect(lockTip('keep')).toBe('Git has it locked: keep');
    });
});

describe('repositoryGroups', () => {
    const group = (folderId: string, isRepository: boolean): FolderWorktrees => ({ folderId, name: folderId, isRepository, worktrees: [] });

    it('keeps the groups of repositories, each with its folder, in the order given', () => {
        const folders: ProjectFolder[] = [{ id: 'a', path: '/a' }, { id: 'b', path: '/b' }, { id: 'c', path: '/c' }];

        expect(repositoryGroups([group('a', true), group('b', false), group('c', true)], folders).map(entry => [entry.group.folderId, entry.folder.path])).toEqual([['a', '/a'], ['c', '/c']]);
    });

    it('drops a group whose folder left the project since the read', () => {
        expect(repositoryGroups([group('gone', true)], [{ id: 'a', path: '/a' }])).toEqual([]);
    });
});
