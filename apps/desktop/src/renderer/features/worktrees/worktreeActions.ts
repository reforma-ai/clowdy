import { openConfirmModal } from '@clowdy/components/modals';
import { toast } from '@clowdy/components/Toast';
import { isTerminalRunStatus } from '@clowdy/protocol';

import { ancestorChats, chatOfRun } from '../agents/agentTree';
import { samePath } from '../agents/workspaceChoice';
import { refreshFolderGit } from '../openWith/useFolderGit';

import type { Chat, FolderId, ProjectId, ProjectSnapshot, WorktreeInfo } from '@clowdy/protocol';
import type { RootStore } from '../../stores';

export interface WorktreeTarget {
    root: RootStore;
    projectId: ProjectId;
    folderId: FolderId;
    path: string;
    workspaceId?: string;
    reload?: () => Promise<void>;
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
export function linkedChatIds(worktree: WorktreeInfo, snapshot: ProjectSnapshot, folderId: FolderId): Set<string> {
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
    worktree: WorktreeInfo,
    snapshot: ProjectSnapshot,
    folderId: FolderId,
    archiveOnly = false
) {
    const chats = new Map(snapshot.chats.map(chat => [chat.id, chat]));
    const linked = linkedChatIds(worktree, snapshot, folderId);
    if ([...linked].some(id => !chats.has(id))) throw new Error('The chats linked to this worktree changed. Try again');
    const affected = snapshot.chats.filter(
        chat => linked.has(chat.id) || ancestorChats(chats, chat.id).some(parent => linked.has(parent.id))
    );
    // An already archived root is a no-op for chat.setArchived. Use the unarchived
    // descendants as archive roots in that case, without restoring old history.
    const candidates = archiveOnly
        ? affected.filter(chat => chat.archivedAt === undefined)
        : affected.filter(chat => linked.has(chat.id));
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

export function affectedSummary(count: number, outside: number): string {
    return `${count} ${count === 1 ? 'chat' : 'chats'} affected${outside ? `, including ${outside} ${outside === 1 ? 'thread' : 'threads'} outside this worktree` : ''}`;
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

function idsEqual(a: Set<string>, b: Set<string>): boolean {
    return a.size === b.size && [...a].every(id => b.has(id));
}

export async function openArchiveWorktreeChats(target: WorktreeTarget) {
    try {
        const { worktree, snapshot } = await readWorktree(target);
        const plan = affectedChats(worktree, snapshot, target.folderId, true);
        const count = plan.affected.filter(chat => chat.archivedAt === undefined).length;
        if (plan.blocker) throw new Error(plan.blocker);
        if (!count) throw new Error('There are no unarchived chats in this worktree');
        openConfirmModal({
            title: 'Archive all chats?',
            message: `${affectedSummary(plan.affected.length, plan.outside)}. ${count} will be archived; existing archives and the worktree will stay.`,
            confirmLabel: 'Archive chats',
            initialFocus: 'cancel',
            onConfirm: async () => {
                const errors: string[] = [];
                try {
                    const current = await readWorktree(target);
                    const latest = affectedChats(current.worktree, current.snapshot, target.folderId, true);
                    if (latest.blocker || !idsEqual(plan.ids, latest.ids))
                        throw new Error(latest.blocker ?? 'The chats linked to this worktree changed. Try again');
                    for (const chat of latest.roots) {
                        const result = await target.root.command({
                            type: 'chat.setArchived',
                            chatId: chat.id,
                            archived: true,
                        });
                        if (!result.ok) errors.push(`${chat.title}: ${result.error.message}`);
                    }
                } catch (error) {
                    errors.push(error instanceof Error ? error.message : String(error));
                }
                await refreshWorktreeTarget(target, plan.affected);
                if (errors.length) toast.error({ title: "Couldn't archive all chats", message: errors.join('\n') });
            },
        });
    } catch (error) {
        toast.error({
            title: "Couldn't archive chats",
            message: error instanceof Error ? error.message : String(error),
        });
    }
}
