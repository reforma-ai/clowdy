import type { FolderWorktrees, ProjectFolder, WorktreeInfo } from '@clowdy/protocol';

const countOf = (changes: number) => `${changes} ${changes === 1 ? 'change' : 'changes'}`;

/** How much a worktree has changed, in a word: `No local changes`, or `3 changes` (git's status entries, an untracked folder as one). */
export function changesLabel(changes: number): string {
    return changes === 0 ? 'No local changes' : countOf(changes);
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
export function mergedMark({
    main,
    merged,
    base,
}: Pick<WorktreeInfo, 'main' | 'merged' | 'base'>): MergedMark | undefined {
    if (main || merged === undefined) return undefined;

    const into = base ?? 'its base';

    if (merged) return { label: 'Merged', tip: `Its commits are in ${into}`, color: 'success' };

    return {
        label: 'Not merged',
        tip: `Its commits are not in ${into} as last fetched. A squash merge shows as not merged.`,
        color: 'warning',
    };
}

/** What a lock says on hover: git's reason when it gave one. */
export function lockTip(locked: string): string {
    return locked === '' ? 'Git has it locked' : `Git has it locked: ${locked}`;
}

/** The one badge of a worktree's row: what it says, why (the tooltip), and the colour (the neutral grey when it has none). */
export interface WorktreeMark {
    label: 'Project checkout' | 'Missing on disk' | 'Locked' | MergedMark['label'];
    tip: string;
    color?: MergedMark['color'];
}

/**
 * The single badge of a row: of everything that could be said of a worktree, the one that matters most, from the most to the least. The folder's own checkout is what it is
 * and has nothing else to say. A worktree gone from the disk has only its record left, so its lock and its work mean nothing. A locked one is held: git was told to keep it
 * (an agent that works in it locks it for as long as it does), and that outweighs whether its work has reached the base. The base only comes last: `Merged` or `Not merged`,
 * and nothing where there is no base to compare with.
 */
export function worktreeMark(
    worktree: Pick<WorktreeInfo, 'main' | 'missing' | 'locked' | 'merged' | 'base'>
): WorktreeMark | undefined {
    if (worktree.main)
        return { label: 'Project checkout', tip: 'The folder itself, where a chat works without a worktree' };

    if (worktree.missing)
        return { label: 'Missing on disk', tip: 'Git lists it, but its folder is gone', color: 'warning' };

    if (worktree.locked !== undefined) return { label: 'Locked', tip: lockTip(worktree.locked) };

    return mergedMark(worktree);
}

/**
 * Why a worktree has no Remove to press, in a few words, or `undefined` when nothing stops it (the folder's own checkout has no Remove at all). The daemon's `blocked` says
 * which reason holds first; `main` on a row that is not the folder's own checkout is protected. Linked chats alone are no longer a blocker: the confirmation checks their runs and offers disposition.
 */
export function removeHint({ blocked, locked }: Pick<WorktreeInfo, 'blocked' | 'locked'>): string | undefined {
    if (blocked === 'locked') return lockTip(locked ?? '');

    if (blocked === 'main') return "The repository's own working tree, which git does not remove";

    return undefined;
}

/** What the branch of a worktree being removed may be deleted with it: its name, whether the box starts ticked, and what is known of its work. */
export interface BranchChoice {
    name: string;
    /** Ticked from the start only for a branch whose work is in the base; a branch that is not, or whose standing is unknown, is the person's to tick. */
    selected: boolean;
    /**
     * `merged`: the work is in the base. `unmerged`: it is not, so it is lost with the branch. `unknown`: no base to compare with. `base`: the branch is the base itself (or its local
     * copy), whose work is "in the base" by being it, so nothing shows another branch keeps it.
     */
    standing: 'merged' | 'unmerged' | 'unknown' | 'base';
}

/** Whether a branch is the base the worktree is compared with, or the local branch of the same name as a remote's (`main` for `origin/main`). */
const isBaseBranch = (branch: string, base: string | undefined) =>
    base !== undefined && (branch === base || branch === base.slice(base.indexOf('/') + 1));

function branchChoice(name: string, merged: boolean | undefined, base: string | undefined): BranchChoice {
    if (merged === undefined) return { name, selected: false, standing: 'unknown' };

    if (!merged) return { name, selected: false, standing: 'unmerged' };

    return isBaseBranch(name, base)
        ? { name, selected: false, standing: 'base' }
        : { name, selected: true, standing: 'merged' };
}

/**
 * What the confirmation of a removal asks and says, from the worktree as the list read it. `record`: the folder is gone from the disk, so only git's record of the worktree
 * goes. `discard`: something in the tree is not committed (a new file, an initialised submodule), which only a red confirmation removes (`discard: true`). `plain`: nothing is
 * lost with the folder but what git ignores. `changes` counts git's status entries, an untracked folder as one, so the warning counts changes and not files.
 */
export interface RemovalPlan {
    kind: 'record' | 'discard' | 'plain';
    title: string;
    confirmLabel: string;
    /** What goes, a phrase for each line. */
    notes: string[];
    /** Absent on a detached HEAD: there is no branch to delete. */
    branch?: BranchChoice;
    /** A detached HEAD whose commits are not in the base, and so may be in no branch: they can be lost with the worktree. */
    stranded: boolean;
}

/** What removing this worktree asks and says. The folder's own checkout has no removal, so it never gets here. */
export function removalPlan({
    branch,
    base,
    merged,
    missing,
    changes,
    submodules,
}: Pick<WorktreeInfo, 'branch' | 'base' | 'merged' | 'missing' | 'changes' | 'submodules'>): RemovalPlan {
    const choice = branch === undefined ? undefined : branchChoice(branch, merged, base);
    const common = { ...(choice && { branch: choice }), stranded: branch === undefined && merged === false };

    if (missing) {
        return {
            ...common,
            kind: 'record',
            title: 'Remove record?',
            confirmLabel: 'Remove record',
            notes: ['The worktree folder is missing. This removes its record from Git.'],
        };
    }

    const notes: string[] = [];

    if (changes > 0) notes.push(`${changes} uncommitted ${changes === 1 ? 'change' : 'changes'} will be lost`);

    if (submodules) notes.push('Checked-out submodules and any uncommitted changes in them will be removed');

    if (notes.length === 0) notes.push('The worktree folder will be deleted');

    return {
        ...common,
        kind: changes > 0 || submodules ? 'discard' : 'plain',
        title: 'Remove worktree?',
        confirmLabel: 'Remove worktree',
        notes,
    };
}

const BRANCH_WARNINGS: Record<BranchChoice['standing'], string | undefined> = {
    merged: undefined,
    unmerged: 'Unmerged commits may be lost if you delete this branch',
    unknown: 'Couldn’t verify that this branch is merged. Deleting it may lose commits.',
    base: 'This is the base branch',
};

/** What a branch that may be lost says beside its box, or `undefined` when its work is in the base. */
export function branchWarning({ standing }: BranchChoice): string | undefined {
    return BRANCH_WARNINGS[standing];
}

/** What a detached HEAD whose commits are not in the base says: git may know no branch that keeps them once the worktree is gone. */
export const STRANDED_WARNING = 'Commits that aren’t on a branch may be lost';

/** What the person chose in a removal's confirmation besides removing. `branchTouched` and `chatsTouched` say they changed a switch themselves. */
export interface RemoveChoice {
    deleteBranch: boolean;
    disposition: 'archive' | 'delete';
    branchTouched?: boolean;
    chatsTouched?: boolean;
}

type RemovedWorktree = Pick<WorktreeInfo, 'branch' | 'base' | 'merged' | 'missing' | 'changes' | 'submodules'>;

/** Whether the branch switch starts on: only for a clean worktree still on disk whose branch's work is in the base. */
export function deleteBranchByDefault(worktree: RemovedWorktree): boolean {
    return (
        !worktree.missing && worktree.changes === 0 && !worktree.submodules && !!removalPlan(worktree).branch?.selected
    );
}

/** The chats a removal takes with it, as counted: their ids and how many of them are threads in other places. */
export interface RemovedChats {
    ids: ReadonlySet<string>;
    outside: number;
}

/** What the confirmation showed before Git was read again: the row of the list, or only the branch name it showed, and the chats counted from the store. */
export interface RemovalPreview {
    worktree?: WorktreeInfo;
    label?: string;
    chats?: RemovedChats;
}

/** What changed between the preview and the worktree read now: the branch or its work, or the chats a removal takes. */
export interface RemovalDrift {
    branch: boolean;
    chats: boolean;
}

/** Compares the preview the person saw with the worktree and chats read now. Nothing previewed is nothing changed. */
export function removalDrift(preview: RemovalPreview, worktree: WorktreeInfo, chats: RemovedChats): RemovalDrift {
    const shown = preview.worktree;
    const identity = !!shown && (shown.path !== worktree.path || shown.workspaceId !== worktree.workspaceId);
    const branch = shown
        ? identity ||
          shown.headOid !== worktree.headOid ||
          shown.branch !== worktree.branch ||
          shown.head !== worktree.head ||
          shown.base !== worktree.base ||
          shown.merged !== worktree.merged ||
          shown.missing !== worktree.missing ||
          shown.changes !== worktree.changes ||
          shown.submodules !== worktree.submodules
        : preview.label !== undefined && preview.label !== worktree.branch;
    const before = preview.chats;
    const chatsChanged =
        identity ||
        (!!before &&
            (before.outside !== chats.outside ||
                before.ids.size !== chats.ids.size ||
                [...before.ids].some(id => !chats.ids.has(id))));

    return { branch, chats: chatsChanged };
}

/**
 * The choice once the worktree is read again. An untouched branch switch follows the worktree read now. A change the person did not see turns off what they chose:
 * the branch switch when the branch changed, and both switches when anything changed after they touched one.
 */
export function reconcileChoice(choice: RemoveChoice, worktree: RemovedWorktree, drift: RemovalDrift): RemoveChoice {
    if ((drift.branch || drift.chats) && (choice.branchTouched || choice.chatsTouched))
        return { ...choice, deleteBranch: false, disposition: 'archive' };

    if (!choice.branchTouched) return { ...choice, deleteBranch: deleteBranchByDefault(worktree) };

    return drift.branch ? { ...choice, deleteBranch: false } : choice;
}

/** What a confirmed removal still needs to hold when it is sent, beyond what the daemon checks itself. */
export interface ConfirmedRemoval {
    deleteBranch: boolean;
    discard: boolean;
    /** The confirmation counted no linked chat, so it asked nothing about chats. */
    noChats: boolean;
}

/**
 * Why a confirmed removal must not be sent now that the worktree reads as `current`, or `undefined` when it may. The branch switch authorises deleting the branch that was
 * shown, not a different checkout or new commits; the red confirmation discards the changes that were counted, not new ones; a confirmation that named no chat archives none.
 */
export function confirmedRemovalDrift(
    shown: WorktreeInfo,
    current: WorktreeInfo,
    linkedNow: number,
    { deleteBranch, discard, noChats }: ConfirmedRemoval
): string | undefined {
    if (shown.path !== current.path || shown.workspaceId !== current.workspaceId)
        return 'The worktree changed. Try again';

    if (noChats && linkedNow > 0) return 'The chats linked to this worktree changed. Try again';

    if (
        deleteBranch &&
        (current.branch !== shown.branch ||
            current.head !== shown.head ||
            current.headOid !== shown.headOid ||
            current.base !== shown.base ||
            current.merged !== shown.merged)
    )
        return 'The branch changed. Try again';

    if (
        discard &&
        (current.changes !== shown.changes ||
            current.submodules !== shown.submodules ||
            current.branch !== shown.branch ||
            current.head !== shown.head ||
            current.headOid !== shown.headOid)
    )
        return 'The local changes in this worktree changed. Try again';

    return undefined;
}

/** The folder groups still in the project, including folders that are not repositories. */
export function repositoryGroups(
    groups: readonly FolderWorktrees[],
    folders: readonly ProjectFolder[]
): { group: FolderWorktrees; folder: ProjectFolder }[] {
    return groups.flatMap(group => {
        const folder = folders.find(candidate => candidate.id === group.folderId);

        return folder ? [{ group, folder }] : [];
    });
}
