import { useEffect, useRef } from 'react';

import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { samePath } from './workspaceChoice';

import type { ChatWorkspace, ChatWorkspaceChoice, FolderId, ProjectId } from '@clowdy/protocol';

/**
 * Asks the daemon for the row of the worktree the new-chat page has chosen, when it is one that exists (`workspace.open`), and keeps it for the window's places
 * (`ProjectUi.draftWorkspaceRow`): the tabs and the `@` list show the worktree's files before the chat exists, and the first message makes a chat that shares that same row, so
 * nothing changes under them when it starts. The selected path is checked by the daemon even while the folder listing is refreshing. The row is
 * dropped when the choice goes. A new worktree has no row until the first message makes it. A refusal or a daemon that cannot be reached leaves the page in the folder's own
 * checkout without a word: the chat's creation says what is wrong when it comes to it. An answer for a choice that changed meanwhile is dropped. The daemon drops a worktree's row
 * with the last chat that works in it, so a row that had a chat and has none now is gone: it is asked for again, and the page's place and its first message share the new one.
 */
export function useDraftWorkspaceRow(
    projectId: ProjectId,
    folderId: FolderId,
    choice: ChatWorkspaceChoice | undefined
): void {
    const root = useRootStore();
    const ui = useProjectUi();
    const { chats } = useProjectState();
    const path = choice?.mode === 'existing' ? choice.path : undefined;
    const { draftWorkspaceRow: row } = ui;
    const asked = row !== null && path !== undefined && row.folderId === folderId && samePath(row.path, path);
    const shared = row !== null && [...chats.values()].some(chat => chat.workspace?.id === row.id);
    // Whether a chat has worked in the row since it was answered: a row nobody has used yet has no chat and is not gone for it.
    const hadChat = useRef(false);

    useEffect(() => {
        if (row === null) {
            hadChat.current = false;
        } else if (shared) {
            hadChat.current = true;
        } else if (hadChat.current) {
            hadChat.current = false;
            ui.setDraftWorkspaceRow(null);
        }
    }, [row, shared, ui]);

    useEffect(() => {
        if (path === undefined) {
            if (ui.draftWorkspaceRow) ui.setDraftWorkspaceRow(null);

            return;
        }

        if (asked) return;

        let stale = false;

        void root.command({ type: 'workspace.open', projectId, folderId, path }).then(result => {
            const { workspace } = (result.ok ? result.data : {}) as { workspace?: ChatWorkspace };

            if (!stale && workspace) ui.setDraftWorkspaceRow(workspace);
        });

        return () => {
            stale = true;
        };
    }, [root, ui, projectId, folderId, path, asked]);
}
