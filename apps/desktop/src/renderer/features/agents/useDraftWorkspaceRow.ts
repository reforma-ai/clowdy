import { useEffect } from 'react';

import { useProjectUi, useRootStore } from '../../stores';
import { samePath } from './workspaceChoice';

import type { ChatWorkspace, ChatWorkspaceChoice, FolderId, ProjectId } from '@clowdy/protocol';

/**
 * Asks the daemon for the row of the worktree the new-chat page has chosen, when it is one that exists (`workspace.open`), and keeps it for the window's places
 * (`ProjectUi.draftWorkspaceRow`): the tabs and the `@` list show the worktree's files before the chat exists, and the first message makes a chat that shares that same row, so
 * nothing changes under them when it starts. `choice` is what the folder's read bears out (`effectiveChoice`), so a worktree that is gone is not asked for, and the row of one is
 * dropped when the choice goes. A new worktree has no row until the first message makes it. A refusal or a daemon that cannot be reached leaves the page in the folder's own
 * checkout without a word: the chat's creation says what is wrong when it comes to it. An answer for a choice that changed meanwhile is dropped.
 */
export function useDraftWorkspaceRow(projectId: ProjectId, folderId: FolderId, choice: ChatWorkspaceChoice | undefined): void {
    const root = useRootStore();
    const ui = useProjectUi();
    const path = choice?.mode === 'existing' ? choice.path : undefined;
    const { draftWorkspaceRow: row } = ui;
    const asked = row !== null && path !== undefined && row.folderId === folderId && samePath(row.path, path);

    useEffect(() => {
        if (path === undefined) {
            if (ui.draftWorkspaceRow) ui.setDraftWorkspaceRow(null);

            return;
        }

        if (asked) return;

        let stale = false;

        void root.command({ type: 'workspace.open', projectId, folderId, path }).then((result) => {
            const { workspace } = (result.ok ? result.data : {}) as { workspace?: ChatWorkspace };

            if (!stale && workspace) ui.setDraftWorkspaceRow(workspace);
        });

        return () => {
            stale = true;
        };
    }, [root, ui, projectId, folderId, path, asked]);
}
