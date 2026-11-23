import type { FolderWorktrees, ProjectFolder, WorktreeInfo } from '@clowdy/protocol';

/** How many files a worktree has changed, in a word: `Clean`, or `3 changed`. */
export function changesLabel(changes: number): string {
    return changes === 0 ? 'Clean' : `${ changes } changed`;
}

/** The mark a worktree's work has in the base: what it says, why, and the colour of its badge. */
export interface MergedMark {
    label: 'Merged' | 'Not merged';
    tip: string;
    color: 'success' | 'warning';
}

/**
 * Whether the worktree's work is in the base (`WorktreeInfo.merged`), for the badge. Nothing for the folder's own checkout, which is the base's own place, and for a
 * worktree with no base to compare with. A squash merge reads as not merged, so the tip of that mark says so.
 */
export function mergedMark({ main, merged, base }: Pick<WorktreeInfo, 'main' | 'merged' | 'base'>): MergedMark | undefined {
    if (main || merged === undefined) return undefined;

    const into = base ?? 'its base';

    if (merged) return { label: 'Merged', tip: `Its work is in ${ into }`, color: 'success' };

    return { label: 'Not merged', tip: `Its work is not in ${ into } as last fetched. A squash merge shows as not merged.`, color: 'warning' };
}

/** What a lock says on hover: git's reason when it gave one. */
export function lockTip(locked: string): string {
    return locked === '' ? 'Git has it locked' : `Git has it locked: ${ locked }`;
}

/**
 * Why a worktree has no Remove to press, in a few words, or `undefined` when nothing stops it (the folder's own checkout has no Remove at all). The daemon's `blocked` says
 * which reason holds first; `main` on a row that is not the folder's own checkout is the repository's primary working tree, which git itself never removes.
 */
export function removeHint({ blocked, locked }: Pick<WorktreeInfo, 'blocked' | 'locked'>): string | undefined {
    if (blocked === 'locked') return lockTip(locked ?? '');

    if (blocked === 'main') return 'The repository\'s own working tree, which git does not remove';

    return blocked === 'chats' ? 'A chat works in it' : undefined;
}

/** What the branch of a worktree being removed may be deleted with it: its name, whether the box starts ticked, and what is known of its work. */
export interface BranchChoice {
    name: string;
    /** Ticked from the start only for a branch whose work is in the base; a branch that is not, or whose standing is unknown, is the person's to tick. */
    selected: boolean;
    /** `merged`: the work is in the base. `unmerged`: it is not, so it is lost with the branch. `unknown`: no base to compare with. */
    standing: 'merged' | 'unmerged' | 'unknown';
}

/**
 * What the confirmation of a removal asks and says, from the worktree as the list read it. `record`: the folder is gone from the disk, so only git's record of the worktree
 * goes. `discard`: something in the tree is not committed (a new file, an initialised submodule), which only a red confirmation removes (`discard: true`). `plain`: nothing is
 * lost with the folder but what git ignores. `changes` counts git's status entries, an untracked folder as one, so the button says changes and not files.
 */
export interface RemovalPlan {
    kind: 'record' | 'discard' | 'plain';
    title: string;
    confirmLabel: string;
    /** What goes, a phrase for each line. */
    notes: string[];
    /** Absent on a detached HEAD: there is no branch to delete. */
    branch?: BranchChoice;
    /** A detached HEAD whose commits are in no branch: they are lost with the worktree. */
    stranded: boolean;
}

const countOf = (changes: number) => `${ changes } ${ changes === 1 ? 'change' : 'changes' }`;

/** The red button of a changed tree: how many entries git's status counts go with it. */
export function discardLabel(changes: number): string {
    return `Discard ${ countOf(changes) } and remove`;
}

/** What removing this worktree asks and says. The folder's own checkout has no removal, so it never gets here. */
export function removalPlan({ branch, merged, missing, changes, submodules }: Pick<WorktreeInfo, 'branch' | 'merged' | 'missing' | 'changes' | 'submodules'>): RemovalPlan {
    const choice: BranchChoice | undefined = branch === undefined ? undefined : { name: branch, selected: merged === true, standing: merged === undefined ? 'unknown' : merged ? 'merged' : 'unmerged' };
    const common = { ...(choice && { branch: choice }), stranded: branch === undefined && merged === false };

    if (missing) {
        return { ...common, kind: 'record', title: 'Remove the record?', confirmLabel: 'Remove record', notes: ['Git still lists it, but its folder is gone from the disk', 'Only git\'s record of it is removed'] };
    }

    if (changes > 0) {
        const notes = [`${ countOf(changes) } that ${ changes === 1 ? 'is' : 'are' } not committed ${ changes === 1 ? 'is' : 'are' } deleted for good with it`];

        if (submodules) notes.push('Its submodules are checked out and go with it');

        return { ...common, kind: 'discard', title: 'Discard changes and remove?', confirmLabel: discardLabel(changes), notes };
    }

    if (submodules) {
        return { ...common, kind: 'discard', title: 'Remove with its submodules?', confirmLabel: 'Remove with submodules', notes: ['Its submodules are checked out and go with it, and so does anything in them that is not committed'] };
    }

    return { ...common, kind: 'plain', title: 'Remove the worktree?', confirmLabel: 'Remove', notes: ['Its folder is removed from the disk'] };
}

/** What a branch that may be lost says beside its box, or `undefined` when its work is in the base. */
export function branchWarning({ standing }: BranchChoice): string | undefined {
    if (standing === 'unmerged') return 'Its changes are lost when the branch goes';

    return standing === 'unknown' ? 'Not compared with a base, so its changes may be in no other branch' : undefined;
}

/** What a detached HEAD whose commits are in no branch says: nothing keeps them once the worktree is gone. */
export const STRANDED_WARNING = 'Its commits are in no branch, so they are lost with the worktree';

/** The groups of the project that are repositories and whose folder is still in the project, each with its folder, in the project's order. */
export function repositoryGroups(groups: readonly FolderWorktrees[], folders: readonly ProjectFolder[]): { group: FolderWorktrees; folder: ProjectFolder }[] {
    return groups.flatMap((group) => {
        const folder = folders.find(candidate => candidate.id === group.folderId);

        return group.isRepository && folder ? [{ group, folder }] : [];
    });
}
