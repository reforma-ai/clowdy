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
 * Why a worktree has no Remove to press, in a few words, or `undefined` when nothing stops it (the folder's own checkout has no Remove at all, so it has no hint
 * either). The daemon's `blocked` says which reason holds first.
 */
export function removeHint({ blocked, locked }: Pick<WorktreeInfo, 'blocked' | 'locked'>): string | undefined {
    if (blocked === 'locked') return lockTip(locked ?? '');

    return blocked === 'chats' ? 'A chat works in it' : undefined;
}

/** The groups of the project that are repositories and whose folder is still in the project, each with its folder, in the project's order. */
export function repositoryGroups(groups: readonly FolderWorktrees[], folders: readonly ProjectFolder[]): { group: FolderWorktrees; folder: ProjectFolder }[] {
    return groups.flatMap((group) => {
        const folder = folders.find(candidate => candidate.id === group.folderId);

        return group.isRepository && folder ? [{ group, folder }] : [];
    });
}
