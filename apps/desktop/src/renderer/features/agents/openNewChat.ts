import { mainFolder } from '@clowdy/protocol';

import { groupFolderOf, resolveSelection, visibleChats } from './agentTree';

import type { FolderId } from '@clowdy/protocol';
import type { ProjectState, ProjectUi } from '../../stores';

/** Start a draft in the open chat's place unless a folder action points to another folder. */
export function openNewChat(project: ProjectState | undefined, ui: ProjectUi, folderId?: FolderId): void {
    if (!project) {
        if (ui.draft && folderId === undefined) ui.showChat();
        else ui.openDraft();
        return;
    }

    const { chats, runs } = project;
    const main = mainFolder(project.project).id;
    // Reopening the new-chat page must keep its chosen place, including when
    // the shortcut is used before the first message has created a chat.
    if (ui.draft && (folderId === undefined || folderId === (ui.draftFolderId ?? main))) {
        ui.showChat();
        return;
    }
    const { chat } = resolveSelection(
        chats,
        visibleChats(project.chatList, ui.chatOrder),
        runs,
        ui.chatId,
        ui.runId,
        ui.draft
    );
    const activeFolder = chat && groupFolderOf(chats, project.project.folders, chat.id);
    const target = folderId ?? activeFolder ?? main;
    const workspace = activeFolder === target ? chat?.workspace : undefined;

    ui.openDraft(
        [],
        target === main ? null : target,
        workspace?.folderId === target ? { mode: 'existing', path: workspace.path } : null
    );
}
