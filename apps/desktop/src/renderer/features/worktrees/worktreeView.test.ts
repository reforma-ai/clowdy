import { describe, expect, it } from 'vitest';

import { branchWarning, changesLabel, discardLabel, lockTip, mergedMark, removalPlan, removeHint, repositoryGroups } from './worktreeView';

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

    it('says the repository\'s own working tree, which a row that is not the folder\'s checkout can be, is one git does not remove', () => {
        expect(removeHint({ blocked: 'main' })).toBe('The repository\'s own working tree, which git does not remove');
    });

    it('gives none for a worktree nothing stops', () => {
        expect(removeHint({})).toBeUndefined();
    });
});

describe('discardLabel', () => {
    it('counts the changes, git\'s status entries, and does not call them files', () => {
        expect(discardLabel(1)).toBe('Discard 1 change and remove');
        expect(discardLabel(3)).toBe('Discard 3 changes and remove');
    });
});

describe('removalPlan', () => {
    const clean = { branch: 'feature/done', merged: true, missing: false, changes: 0, submodules: false } as const;

    it('is a plain confirm for a clean worktree, with its branch ticked when the branch\'s work is in the base', () => {
        const plan = removalPlan(clean);

        expect(plan).toMatchObject({ kind: 'plain', confirmLabel: 'Remove', stranded: false, branch: { name: 'feature/done', selected: true, standing: 'merged' } });
    });

    it('leaves the branch unticked when its work is not in the base, and says so', () => {
        expect(removalPlan({ ...clean, merged: false }).branch).toEqual({ name: 'feature/done', selected: false, standing: 'unmerged' });
        expect(branchWarning({ name: 'x', selected: false, standing: 'unmerged' })).toBe('Its changes are lost when the branch goes');
    });

    it('leaves it unticked when no base says whether it is merged, and says so too', () => {
        const { merged: _merged, ...unknown } = clean;

        expect(removalPlan(unknown).branch).toEqual({ name: 'feature/done', selected: false, standing: 'unknown' });
        expect(branchWarning({ name: 'x', selected: false, standing: 'unknown' })).toContain('Not compared with a base');
        expect(branchWarning({ name: 'x', selected: true, standing: 'merged' })).toBeUndefined();
    });

    it('asks for the red confirmation, with the number of changes, when something is not committed', () => {
        expect(removalPlan({ ...clean, changes: 1 })).toMatchObject({ kind: 'discard', confirmLabel: 'Discard 1 change and remove', notes: ['1 change that is not committed is deleted for good with it'] });
        expect(removalPlan({ ...clean, changes: 4 })).toMatchObject({ kind: 'discard', confirmLabel: 'Discard 4 changes and remove', notes: ['4 changes that are not committed are deleted for good with it'] });
    });

    it('asks for it for an initialised submodule too, naming it, and counts no change when there is none', () => {
        expect(removalPlan({ ...clean, submodules: true })).toMatchObject({ kind: 'discard', confirmLabel: 'Remove with submodules' });
        expect(removalPlan({ ...clean, changes: 2, submodules: true }).notes).toContain('Its submodules are checked out and go with it');
        expect(removalPlan({ ...clean, changes: 2, submodules: true }).confirmLabel).toBe('Discard 2 changes and remove');
    });

    it('removes only the record of a worktree whose folder is gone, with no discard, and still offers its branch', () => {
        expect(removalPlan({ ...clean, missing: true })).toMatchObject({ kind: 'record', title: 'Remove the record?', confirmLabel: 'Remove record', branch: { name: 'feature/done' } });
    });

    it('offers no branch on a detached HEAD, and warns when its commits are in no branch', () => {
        const { branch: _branch, ...detached } = clean;

        expect(removalPlan({ ...detached, merged: false })).toMatchObject({ kind: 'plain', stranded: true });
        expect(removalPlan({ ...detached, merged: false }).branch).toBeUndefined();
        expect(removalPlan(detached)).toMatchObject({ stranded: false });
        expect(removalPlan(detached).branch).toBeUndefined();
        expect(removalPlan({ ...detached, merged: undefined })).toMatchObject({ stranded: false });
    });

    it('offers the branch whatever it is called', () => {
        for (const branch of ['main', 'release/1.0', 'clowdy/ab12cd34', 'feature/payments']) expect(removalPlan({ ...clean, branch }).branch?.name).toBe(branch);
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
