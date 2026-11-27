import { folderNames } from '@clowdy/protocol';

import { folderById } from './agentTree';

import type { Chat, ChatWorkspace, FolderWorktrees, ProjectFolder, ProjectInfo, WorktreeInfo } from '@clowdy/protocol';

/** A path-based key survives a workspace record being created for an external worktree. */
export function worktreeKey(folderId: string, path: string): string {
    const bare = path.replace(/[\\/]+$/, '');
    const normalized = /^[a-z]:[\\/]/i.test(bare) ? bare.replaceAll('\\', '/').toLowerCase() : bare;
    return `@worktree:${encodeURIComponent(folderId)}:${encodeURIComponent(normalized)}`;
}

/** Prefer the actual card's path when Git canonicalizes a workspace path (for example /private/var on macOS). */
export function chatWorktreeKey(chat: Chat, cards: readonly WorktreeCard[] = []): string | undefined {
    const workspace = chat.workspace;
    if (!workspace) return undefined;

    return (
        cards.find(card => card.actual?.workspaceId === workspace.id || card.workspace?.id === workspace.id)?.key ??
        worktreeKey(workspace.folderId, workspace.path)
    );
}

export interface WorktreeCard {
    key: string;
    main?: boolean;
    folder: ProjectFolder;
    folderName: string;
    path: string;
    branch?: string;
    head?: string;
    missing: boolean;
    pending: boolean;
    used: boolean;
    roots: Chat[];
    /** Active linked chats, including threads listed under a root in another card. */
    linkedChats: Chat[];
    workspace?: ChatWorkspace;
    actual?: WorktreeInfo;
    group?: FolderWorktrees;
}

/** Actual Git worktrees supply the list; active chat workspace records keep pending and missing places visible. Threads never become roots of a card. */
export function worktreeCards(
    roots: readonly Chat[],
    chats: Iterable<Chat>,
    folders: readonly ProjectFolder[],
    actual: readonly FolderWorktrees[] | undefined,
    info: ProjectInfo | undefined,
    order: readonly string[]
): WorktreeCard[] {
    const cards = new Map<string, WorktreeCard>();
    const names = folderNames(folders);
    const make = (folder: ProjectFolder, path: string): WorktreeCard => ({
        key: worktreeKey(folder.id, path),
        folder,
        folderName: names[folders.indexOf(folder)] ?? folder.path,
        path,
        missing: false,
        pending: false,
        used: false,
        roots: [],
        linkedChats: [],
    });

    for (const group of actual ?? []) {
        const folder = folders.find(candidate => candidate.id === group.folderId);
        if (!folder) continue;
        for (const tree of group.worktrees) {
            if (tree.main) continue;
            const card = make(folder, tree.path);
            cards.set(card.key, {
                ...card,
                branch: tree.branch,
                head: tree.head,
                missing: tree.missing,
                // The live project chat store, not this asynchronous Git read, decides whether a card is used.
                actual: tree,
                group,
            });
        }
    }

    const keysByWorkspace = new Map<string, string>();
    for (const card of cards.values()) {
        if (card.actual?.workspaceId) keysByWorkspace.set(card.actual.workspaceId, card.key);
    }

    for (const chat of chats) {
        const workspace = chat.workspace;
        if (!workspace || chat.archivedAt !== undefined) continue;
        const folder =
            folders.find(candidate => candidate.id === workspace.folderId) ?? folderById(folders, chat.folderId);
        const key = keysByWorkspace.get(workspace.id) ?? worktreeKey(workspace.folderId, workspace.path);
        keysByWorkspace.set(workspace.id, key);
        const card = cards.get(key) ?? { ...make(folder, workspace.path), key };
        const state = info?.workspaces?.find(candidate => candidate.workspaceId === workspace.id);
        card.workspace = workspace;
        card.used = true;
        card.linkedChats.push(chat);
        if (!card.actual) {
            card.pending = !workspace.ready;
            card.missing = workspace.ready && (state?.exists === false || (actual !== undefined && !state?.exists));
            card.branch = state?.detached ? undefined : (state?.branch ?? workspace.branch);
            card.head = state?.detached ? state.branch : undefined;
        }
        cards.set(key, card);
    }

    for (const chat of roots) {
        const key = chat.workspace && keysByWorkspace.get(chat.workspace.id);
        if (key) cards.get(key)?.roots.push(chat);
    }

    const rank = new Map(order.map((key, index) => [key, index]));
    return [...cards.values()].sort((a, b) => (rank.get(a.key) ?? Infinity) - (rank.get(b.key) ?? Infinity));
}
