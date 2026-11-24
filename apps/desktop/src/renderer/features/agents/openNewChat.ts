import { mainFolder } from '@clowdy/protocol';

import { groupFolderOf, resolveSelection, visibleChats } from './agentTree';

import type { FolderId } from '@clowdy/protocol';
import type { ProjectState, ProjectUi } from '../../stores';

/** Start a draft in the open chat's place unless a folder action points to another folder. */
export function openNewChat(project: ProjectState | undefined, ui: ProjectUi, folderId?: FolderId): void {
    if (!project) {
        ui.openDraft();
        return;
    }

    const { chats, runs } = project;
    const main = mainFolder(project.project).id;
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
