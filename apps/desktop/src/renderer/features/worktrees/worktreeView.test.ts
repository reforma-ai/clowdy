import { describe, expect, it } from 'vitest';

import {
    branchWarning,
    changesLabel,
    confirmedRemovalDrift,
    deleteBranchByDefault,
    lockTip,
    mergedMark,
    reconcileChoice,
    removalDrift,
    removalPlan,
    removeHint,
    repositoryGroups,
    worktreeMark,
} from './worktreeView';

import type { FolderWorktrees, ProjectFolder, WorktreeInfo } from '@clowdy/protocol';

describe('changesLabel', () => {
    it('says a tree with nothing changed has no local changes, and else how many changes', () => {
        expect(changesLabel(0)).toBe('No local changes');
        expect(changesLabel(1)).toBe('1 change');
        expect(changesLabel(12)).toBe('12 changes');
    });
});

describe('worktreeMark', () => {
    const plain = { main: false, missing: false, merged: false, base: 'origin/main' };

    it("gives the one badge that matters most: the folder's own checkout, then gone from the disk, then locked, then the work in the base", () => {
        expect(worktreeMark({ ...plain, main: true, locked: '', missing: true })).toMatchObject({
            label: 'Project checkout',
        });
        expect(worktreeMark({ ...plain, missing: true, locked: 'on a drive' })).toEqual({
            label: 'Missing on disk',
            tip: 'Git lists it, but its folder is gone',
            color: 'warning',
        });
        expect(worktreeMark({ ...plain, locked: 'claude agent agent-a58e (pid 42120)', merged: false })).toEqual({
            label: 'Locked',
            tip: 'Git has it locked: claude agent agent-a58e (pid 42120)',
        });
        expect(worktreeMark({ ...plain })).toMatchObject({ label: 'Not merged', color: 'warning' });
        expect(worktreeMark({ ...plain, merged: true })).toMatchObject({ label: 'Merged', color: 'success' });
    });

    it('counts a lock with no reason as a lock, and says nothing for a worktree with no base to compare with', () => {
        expect(worktreeMark({ ...plain, locked: '' })).toEqual({ label: 'Locked', tip: 'Git has it locked' });
        expect(worktreeMark({ main: false, missing: false })).toBeUndefined();
    });
});

describe('mergedMark', () => {
    it('says a worktree whose work is in the base is merged, and names the base', () => {
        expect(mergedMark({ main: false, merged: true, base: 'origin/main' })).toEqual({
            label: 'Merged',
            tip: 'Its commits are in origin/main',
            color: 'success',
        });
    });

    it('says one whose work is not is not merged, and that a squash merge reads like that', () => {
        const mark = mergedMark({ main: false, merged: false, base: 'origin/main' })!;

        expect(mark.label).toBe('Not merged');
        expect(mark.color).toBe('warning');
        expect(mark.tip).toBe(
            'Its commits are not in origin/main as last fetched. A squash merge shows as not merged.'
        );
    });

    it("has no mark for the folder's own checkout, or when no base resolves", () => {
        expect(mergedMark({ main: true, merged: true, base: 'origin/main' })).toBeUndefined();
        expect(mergedMark({ main: false })).toBeUndefined();
    });
});

describe('removeHint', () => {
    it("gives the reason that stops a worktree, the lock with git's own words", () => {
        expect(removeHint({ blocked: 'locked', locked: 'on an external drive' })).toBe(
            'Git has it locked: on an external drive'
        );
        expect(removeHint({ blocked: 'locked', locked: '' })).toBe('Git has it locked');
        expect(removeHint({ blocked: 'chats' })).toBeUndefined();
    });

    it("says the repository's own working tree, which a row that is not the folder's checkout can be, is one git does not remove", () => {
        expect(removeHint({ blocked: 'main' })).toBe("The repository's own working tree, which git does not remove");
    });

    it('gives none for a worktree nothing stops', () => {
        expect(removeHint({})).toBeUndefined();
    });
});

describe('removalPlan', () => {
    const clean = { branch: 'feature/done', merged: true, missing: false, changes: 0, submodules: false } as const;

    it("is a plain confirm for a clean worktree, with its branch ticked when the branch's work is in the base", () => {
        const plan = removalPlan(clean);

        expect(plan).toMatchObject({
            kind: 'plain',
            title: 'Remove worktree?',
            confirmLabel: 'Remove worktree',
            stranded: false,
            branch: { name: 'feature/done', selected: true, standing: 'merged' },
        });
    });

    it('leaves the branch unticked when its work is not in the base, and says so', () => {
        expect(removalPlan({ ...clean, merged: false }).branch).toEqual({
            name: 'feature/done',
            selected: false,
            standing: 'unmerged',
        });
        expect(branchWarning({ name: 'x', selected: false, standing: 'unmerged' })).toBe(
            'Unmerged commits may be lost if you delete this branch'
        );
    });

    it('leaves it unticked when no base says whether it is merged, and says so too', () => {
        const { merged: _merged, ...unknown } = clean;

        expect(removalPlan(unknown).branch).toEqual({ name: 'feature/done', selected: false, standing: 'unknown' });
        expect(branchWarning({ name: 'x', selected: false, standing: 'unknown' })).toContain(
            'Couldn’t verify that this branch is merged'
        );
        expect(branchWarning({ name: 'x', selected: true, standing: 'merged' })).toBeUndefined();
    });

    it('leaves the base branch itself unticked, or its local copy of the same name as the remote one, since being the base is not a merge', () => {
        expect(removalPlan({ ...clean, branch: 'main', base: 'main' }).branch).toEqual({
            name: 'main',
            selected: false,
            standing: 'base',
        });
        expect(removalPlan({ ...clean, branch: 'main', base: 'origin/main' }).branch).toEqual({
            name: 'main',
            selected: false,
            standing: 'base',
        });
        expect(branchWarning({ name: 'main', selected: false, standing: 'base' })).toBe('This is the base branch');
        // Another branch of the same tail, or one the base does not name, is an ordinary merged branch.
        expect(removalPlan({ ...clean, branch: 'feature/main', base: 'origin/main' }).branch).toMatchObject({
            selected: true,
            standing: 'merged',
        });
        expect(removalPlan({ ...clean, branch: 'feature/done', base: 'origin/main' }).branch).toMatchObject({
            selected: true,
            standing: 'merged',
        });
    });

    it('does not take the base for merged when its work is not in it: a local `main` ahead of `origin/main` is plainly not merged', () => {
        expect(removalPlan({ ...clean, branch: 'main', base: 'origin/main', merged: false }).branch).toEqual({
            name: 'main',
            selected: false,
            standing: 'unmerged',
        });
    });

    it('asks for the red confirmation, with the number of changes, when something is not committed', () => {
        expect(removalPlan({ ...clean, changes: 1 })).toMatchObject({
            kind: 'discard',
            confirmLabel: 'Remove worktree',
            notes: ['1 uncommitted change will be lost'],
        });
        expect(removalPlan({ ...clean, changes: 4 })).toMatchObject({
            kind: 'discard',
            confirmLabel: 'Remove worktree',
            notes: ['4 uncommitted changes will be lost'],
        });
    });

    it('asks for it for an initialised submodule too, naming it, and counts no change when there is none', () => {
        expect(removalPlan({ ...clean, submodules: true })).toMatchObject({
            kind: 'discard',
            confirmLabel: 'Remove worktree',
        });
        expect(removalPlan({ ...clean, changes: 2, submodules: true }).notes).toContain(
            'Checked-out submodules and any uncommitted changes in them will be removed'
        );
        expect(removalPlan({ ...clean, changes: 2, submodules: true }).confirmLabel).toBe('Remove worktree');
    });

    it('removes only the record of a worktree whose folder is gone, with no discard, and still offers its branch', () => {
        expect(removalPlan({ ...clean, missing: true })).toMatchObject({
            kind: 'record',
            title: 'Remove record?',
            confirmLabel: 'Remove record',
            branch: { name: 'feature/done' },
        });
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
        for (const branch of ['main', 'release/1.0', 'clowdy/ab12cd34', 'feature/payments'])
            expect(removalPlan({ ...clean, branch }).branch?.name).toBe(branch);
    });
});

describe('lockTip', () => {
    it("puts git's reason after the lock, when there is one", () => {
        expect(lockTip('')).toBe('Git has it locked');
        expect(lockTip('keep')).toBe('Git has it locked: keep');
    });
});

describe('repositoryGroups', () => {
    const group = (folderId: string, isRepository: boolean): FolderWorktrees => ({
        folderId,
        name: folderId,
        isRepository,
        worktrees: [],
    });

    it('keeps the groups of all folders, in the order given', () => {
        const folders: ProjectFolder[] = [
            { id: 'a', path: '/a' },
            { id: 'b', path: '/b' },
            { id: 'c', path: '/c' },
        ];

        expect(
            repositoryGroups([group('a', true), group('b', false), group('c', true)], folders).map(entry => [
                entry.group.folderId,
                entry.folder.path,
            ])
        ).toEqual([
            ['a', '/a'],
            ['b', '/b'],
            ['c', '/c'],
        ]);
    });

    it('drops a group whose folder left the project since the read', () => {
        expect(repositoryGroups([group('gone', true)], [{ id: 'a', path: '/a' }])).toEqual([]);
    });
});

/** A clean worktree on a merged branch, as Git's list reads it. */
const tree = (fields: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
    path: '/Users/dev/worktrees/car-rental/done',
    branch: 'feature/done',
    head: 'aaa1111',
    headOid: 'aaa1111000000000000000000000000000000000',
    main: false,
    missing: false,
    changes: 0,
    submodules: false,
    merged: true,
    base: 'origin/main',
    managed: false,
    chats: [],
    ...fields,
});

const chats = (ids: string[], outside = 0) => ({ ids: new Set(ids), outside });

describe('deleteBranchByDefault', () => {
    it('turns the branch switch on only for a clean worktree on disk whose branch is merged', () => {
        expect([
            deleteBranchByDefault(tree()),
            deleteBranchByDefault(tree({ merged: false })),
            deleteBranchByDefault(tree({ changes: 1 })),
            deleteBranchByDefault(tree({ submodules: true })),
            deleteBranchByDefault(tree({ missing: true })),
            deleteBranchByDefault(tree({ branch: undefined })),
        ]).toEqual([true, false, false, false, false, false]);
    });
});

describe('removalDrift', () => {
    it('finds nothing changed when Git reads the worktree and chats as previewed', () => {
        expect(removalDrift({ worktree: tree(), chats: chats(['c-1']) }, tree(), chats(['c-1']))).toEqual({
            branch: false,
            chats: false,
        });
    });

    it('sees a new commit on the previewed branch as a branch change', () => {
        expect(removalDrift({ worktree: tree() }, tree({ headOid: 'bbb' }), chats([]))).toEqual({
            branch: true,
            chats: false,
        });
    });

    it('compares only the branch name when the list showed no row', () => {
        expect(removalDrift({ label: 'feature/done' }, tree({ branch: 'feature/other' }), chats([]))).toEqual({
            branch: true,
            chats: false,
        });
    });

    it('sees a chat swapped for another one of the same count as a chat change', () => {
        expect(removalDrift({ worktree: tree(), chats: chats(['c-1']) }, tree(), chats(['c-2']))).toEqual({
            branch: false,
            chats: true,
        });
    });

    it('takes a different workspace record at the same path for a change of both', () => {
        expect(
            removalDrift({ worktree: tree({ workspaceId: 'w-1' }) }, tree({ workspaceId: 'w-2' }), chats([]))
        ).toEqual({ branch: true, chats: true });
    });
});

describe('reconcileChoice', () => {
    const nothing = { branch: false, chats: false };

    it('lets an untouched branch switch follow the worktree read now', () => {
        expect(
            reconcileChoice({ deleteBranch: true, disposition: 'archive' }, tree({ merged: false }), nothing)
        ).toEqual({ deleteBranch: false, disposition: 'archive' });
    });

    it("keeps the person's choice when nothing changed", () => {
        const choice = { deleteBranch: true, disposition: 'delete', branchTouched: true, chatsTouched: true } as const;

        expect(reconcileChoice(choice, tree({ merged: false }), nothing)).toEqual(choice);
    });

    it('turns both switches off when anything changed after the person touched one', () => {
        expect(
            reconcileChoice({ deleteBranch: true, disposition: 'delete', chatsTouched: true }, tree(), {
                branch: false,
                chats: true,
            })
        ).toEqual({ deleteBranch: false, disposition: 'archive', chatsTouched: true });
    });
});

describe('confirmedRemovalDrift', () => {
    const plain = { deleteBranch: false, discard: false, noChats: false };

    it('lets a removal go when what it authorised is unchanged', () => {
        expect(
            confirmedRemovalDrift(tree(), tree(), 0, { deleteBranch: true, discard: false, noChats: true })
        ).toBeUndefined();
    });

    it('refuses a removal that named no chat once a chat is linked', () => {
        expect(confirmedRemovalDrift(tree(), tree(), 1, { ...plain, noChats: true })).toBe(
            'The chats linked to this worktree changed. Try again'
        );
    });

    it('never deletes a branch other than the one shown', () => {
        expect(
            confirmedRemovalDrift(tree(), tree({ branch: 'feature/other' }), 0, { ...plain, deleteBranch: true })
        ).toBe('The branch changed. Try again');
    });

    it('keeps the branch question out of a removal that keeps the branch', () => {
        expect(confirmedRemovalDrift(tree(), tree({ branch: 'feature/other' }), 0, plain)).toBeUndefined();
    });

    it('does not discard changes made after they were counted', () => {
        expect(confirmedRemovalDrift(tree({ changes: 1 }), tree({ changes: 2 }), 0, { ...plain, discard: true })).toBe(
            'The local changes in this worktree changed. Try again'
        );
    });
});
