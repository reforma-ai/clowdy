import { describe, expect, it } from 'vitest';

import { isSamePlace } from '../sidePanel/currentPlace';
import { changesLabel, lockTip, mergedMark, removeHint, repositoryGroups, worktreeTarget } from './worktreeView';

import type { FolderWorktrees, ProjectFolder, WorktreeInfo } from '@clowdy/protocol';

const FOLDER: ProjectFolder = { id: 'fld_a', path: '/work/a' };

const worktree = (overrides: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
    path: '/work/a-feature',
    branch: 'feature',
    head: '1a2b3c4',
    main: false,
    missing: false,
    changes: 0,
    submodules: false,
    managed: false,
    chats: [],
    ...overrides,
});

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

describe('worktreeTarget', () => {
    it('is the worktree\'s folder on the disk, in the folder it is a checkout of', () => {
        const target = worktreeTarget('p-1', FOLDER, worktree({ workspaceId: 'wks_1', managed: true }));

        expect(target).toMatchObject({ projectId: 'p-1', folder: FOLDER, path: '/work/a-feature', relative: '', kind: 'directory' });
        expect(target.workspace).toMatchObject({ folderId: 'fld_a', path: '/work/a-feature', branch: 'feature', managed: true, ready: true });
    });

    it('is never a place of the window, a worktree with a record or without one and the folder\'s own checkout alike, so the menu has no Open in Files', () => {
        const place = { folder: FOLDER };
        const record = { folder: FOLDER, workspace: { id: 'wks_1', folderId: 'fld_a', path: '/work/a-feature', managed: true, ready: true } };

        for (const info of [worktree({ workspaceId: 'wks_1' }), worktree(), worktree({ main: true, path: '/work/a' })]) {
            const { folder, workspace } = worktreeTarget('p-1', FOLDER, info);

            expect(isSamePlace({ folder, workspace }, place)).toBe(false);
            expect(isSamePlace({ folder, workspace }, record)).toBe(false);
        }
    });

    it('marks a worktree whose folder is gone as not made', () => {
        expect(worktreeTarget('p-1', FOLDER, worktree({ missing: true })).workspace?.ready).toBe(false);
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
