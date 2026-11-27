import { isTerminalRunStatus } from '@clowdy/protocol';

import { ancestorChats, chatOfRun } from '../agents/agentTree';
import { samePath } from '../agents/workspaceChoice';
import { refreshFolderGit } from '../openWith/useFolderGit';
import { confirmedRemovalDrift, removalDrift, removalPlan, removeHint } from './worktreeView';

import type { Chat, FolderId, ProjectId, ProjectSnapshot, WorktreeInfo } from '@clowdy/protocol';
import type { RootStore } from '../../stores';
import type { RemovalDrift, RemovalPlan, RemovalPreview, RemoveChoice } from './worktreeView';

export interface WorktreeTarget {
    root: RootStore;
    projectId: ProjectId;
    folderId: FolderId;
    path: string;
    workspaceId?: string;
    reload?: () => Promise<void>;
    preview?: WorktreeInfo;
    previewLabel?: string;
}

export async function readWorktree({ root, projectId, folderId, path, workspaceId }: WorktreeTarget) {
    const folders = await root.transport.getProjectWorktrees(projectId);
    const rows = folders.find(group => group.folderId === folderId)?.worktrees ?? [];
    const worktree = workspaceId
        ? rows.find(row => row.workspaceId === workspaceId)
        : rows.find(row => samePath(row.path, path));
    if (!worktree) throw new Error('This worktree is no longer listed by Git');
    const snapshot = await root.transport.getProjectSnapshot(projectId);
    return { worktree, snapshot };
}

/** Direct links as reported by Git's worktree list or the more recent chat snapshot. */
export function linkedChatIds(
    worktree: Pick<WorktreeInfo, 'path' | 'workspaceId' | 'chats'>,
    snapshot: Pick<ProjectSnapshot, 'chats' | 'runs'>,
    folderId: FolderId
): Set<string> {
    const linked = new Set(worktree.chats.map(chat => chat.id));
    for (const chat of snapshot.chats) {
        if (
            chat.workspace &&
            ((worktree.workspaceId && chat.workspace.id === worktree.workspaceId) ||
                (chat.workspace.folderId === folderId && samePath(chat.workspace.path, worktree.path)))
        )
            linked.add(chat.id);
    }
    return linked;
}

/** The linked roots and the full cascade, including threads that work in a different place. */
export function affectedChats(
    worktree: Pick<WorktreeInfo, 'path' | 'workspaceId' | 'chats'>,
    snapshot: Pick<ProjectSnapshot, 'chats' | 'runs'>,
    folderId: FolderId
) {
    const chats = new Map(snapshot.chats.map(chat => [chat.id, chat]));
    const linked = linkedChatIds(worktree, snapshot, folderId);
    if ([...linked].some(id => !chats.has(id))) throw new Error('The chats linked to this worktree changed. Try again');
    const affected = snapshot.chats.filter(
        chat => linked.has(chat.id) || ancestorChats(chats, chat.id).some(parent => linked.has(parent.id))
    );
    const candidates = affected.filter(chat => linked.has(chat.id));
    const candidateIds = new Set(candidates.map(chat => chat.id));
    const roots = candidates.filter(chat => !ancestorChats(chats, chat.id).some(parent => candidateIds.has(parent.id)));
    const ids = new Set(affected.map(chat => chat.id));
    const busy = snapshot.runs.find(
        run =>
            !isTerminalRunStatus(run.status) &&
            affected.some(chat => run.chatId === chat.id || run.rootRunId === chat.orchestratorRunId)
    );
    const busyChat = busy && (chats.get(busy.chatId ?? '') ?? chatOfRun(affected, busy));
    return {
        roots,
        affected,
        ids,
        outside: affected.filter(chat => !linked.has(chat.id)).length,
        blocker: busyChat && `The chat "${busyChat.title}" is still working`,
    };
}

/** The archive outcome for the chats shown in a removal preview. */
export function archiveConsequence(chats: readonly Chat[]): string {
    const unarchived = chats.filter(chat => chat.archivedAt === undefined).length;
    const archived = chats.length - unarchived;
    const parts = [
        ...(unarchived ? [`${unarchived} ${unarchived === 1 ? 'chat' : 'chats'} will be archived`] : []),
        ...(archived ? [`${archived} already archived`] : []),
    ];
    return parts.join('; ');
}

/** A confirmation names chats and shows their archive state, which may change without changing their IDs. */
export function chatPreviewChanged(shown: readonly Chat[], current: readonly Chat[]): boolean {
    const byId = new Map(current.map(chat => [chat.id, chat]));
    return shown.some(chat => {
        const now = byId.get(chat.id);
        return (
            !!now && (now.title !== chat.title || (now.archivedAt === undefined) !== (chat.archivedAt === undefined))
        );
    });
}

export async function refreshWorktreeTarget(target: Omit<WorktreeTarget, 'path'>, affected: readonly Chat[] = []) {
    const { root, projectId, folderId, reload } = target;
    refreshFolderGit(projectId, folderId);
    if (reload) await reload();
    else if (!root.ui.forProject(projectId).groupByWorktree)
        await root.transport.getProjectWorktrees(projectId).catch(() => undefined);
    // Read actual chat state after even a partial failure. Only clear the selection if it still
    // points to a chat that went away; never select a different project or override a new draft.
    if (!affected.length) return;
    try {
        const snapshot = await root.transport.getProjectSnapshot(projectId);
        const ui = root.ui.forProject(projectId);
        const selected = ui.runId ? undefined : ui.chatId;
        if (
            root.selectedProjectId === projectId &&
            !ui.draft &&
            !ui.sidePanelCoversChat &&
            selected &&
            affected.some(chat => chat.id === selected) &&
            !snapshot.chats.some(chat => chat.id === selected && chat.archivedAt === undefined)
        ) {
            ui.openChat(null);
        }
    } catch {
        // The event feed also resolves archived/deleted selections.
    }
}

export type AffectedChats = ReturnType<typeof affectedChats>;

/** A worktree read again for its removal: the row, what removing it asks, the chats it takes, and whether any of it changed since the preview. */
export interface RemovalRead {
    worktree: WorktreeInfo;
    plan: RemovalPlan;
    chats: AffectedChats;
    drift: RemovalDrift;
}

/** Reads the worktree and its chats for the confirmation, and refuses one that moved, is the project checkout, or cannot be removed now. */
export async function readRemoval(target: WorktreeTarget, preview: RemovalPreview): Promise<RemovalRead> {
    const { worktree, snapshot } = await readWorktree(target);
    if (!samePath(worktree.path, target.path))
        throw new Error('The worktree location changed. Close and reopen this dialog');
    const chats = affectedChats(worktree, snapshot, target.folderId);
    const hint = worktree.main ? 'This is the project checkout' : (removeHint(worktree) ?? chats.blocker);
    if (hint) throw new Error(hint);
    return { worktree, plan: removalPlan(worktree), chats, drift: removalDrift(preview, worktree, chats) };
}

/**
 * Removes the worktree the confirmation showed, with the person's choice. When the removal would delete the branch, discard changes or archive no chat, Git and the chats
 * are read again first, and anything that changed since the confirmation refuses it (the daemon checks the chat ids and the branch commit itself).
 */
export async function removeWorktree(
    target: WorktreeTarget,
    { worktree, plan, chats }: Pick<RemovalRead, 'worktree' | 'plan' | 'chats'>,
    { deleteBranch, disposition }: RemoveChoice
): Promise<void> {
    if (deleteBranch && (!worktree.branch || !worktree.headOid)) throw new Error('Could not verify the branch commit');
    const discard = plan.kind === 'discard';
    const noChats = chats.ids.size === 0;
    try {
        const current = await readWorktree(target);
        const currentChats = affectedChats(current.worktree, current.snapshot, target.folderId);
        if (chatPreviewChanged(chats.affected, currentChats.affected))
            throw new Error('The linked chats changed. Try again');
        const linkedNow = noChats ? currentChats.ids.size : 0;
        const drift = confirmedRemovalDrift(worktree, current.worktree, linkedNow, {
            deleteBranch,
            discard,
            noChats,
        });
        if (drift) throw new Error(drift);
    } catch (error) {
        await refreshWorktreeTarget(target);
        throw error;
    }
    const result = await target.root.command({
        type: 'workspace.remove',
        projectId: target.projectId,
        folderId: target.folderId,
        path: worktree.path,
        ...(discard && { discard: true }),
        ...(plan.branch &&
            deleteBranch &&
            worktree.headOid && {
                deleteBranch: true,
                expectedBranch: { name: plan.branch.name, commit: worktree.headOid },
            }),
        ...(!noChats && { chatDisposition: disposition, expectedChatIds: [...chats.ids] }),
    });
    await refreshWorktreeTarget(target, chats.affected);
    if (!result.ok) throw new Error(result.error.message);
}
