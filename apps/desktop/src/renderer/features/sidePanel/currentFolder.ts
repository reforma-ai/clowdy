import { mainFolder } from '@clowdy/protocol';

import { chatFolder, draftTarget } from '../agents/agentTree';

import type { ProjectFolder } from '@clowdy/protocol';
import type { ProjectState, ProjectUi } from '../../stores';

/**
 * The folder the window is working in: the folder of the open chat, or of the new chat that is being made, and the project's main folder when no chat is
 * open.
 */
export function currentFolder(project: Pick<ProjectState, 'chats' | 'project'>, ui: Pick<ProjectUi, 'chatId' | 'draft' | 'draftFolderId'>): ProjectFolder {
    const { folders } = project.project;
    const found = ui.chatId ? chatFolder(project.chats, folders, ui.chatId) : undefined;

    if (found) return found.folder;

    if (ui.draft) return draftTarget(folders, ui.draftFolderId).folder;

    return mainFolder(project.project);
}
