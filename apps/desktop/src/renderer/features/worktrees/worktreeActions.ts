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
