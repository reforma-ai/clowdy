import { mainFolder } from '@clowdy/protocol';

import { chatFolder, draftTarget } from '../agents/agentTree';

import type { ProjectFolder } from '@clowdy/protocol';
import type { ProjectState, ProjectUi } from '../../stores';

/**
 * The folder the window is working in: the folder of the new chat that is being made, else that of the open chat, and the project's main folder when no chat is open.
 * The new-chat page comes first: it is opened over the chat that was open and leaves it remembered (`ProjectUi.openDraft` keeps `chatId`, so the chat comes back when the
 * page is left), and what the window shows is the page, whose folder the select under the message box names.
 */
export function currentFolder(project: Pick<ProjectState, 'chats' | 'project'>, ui: Pick<ProjectUi, 'chatId' | 'draft' | 'draftFolderId'>): ProjectFolder {
    const { folders } = project.project;

    if (ui.draft) return draftTarget(folders, ui.draftFolderId).folder;

    const found = ui.chatId ? chatFolder(project.chats, folders, ui.chatId) : undefined;

    return found ? found.folder : mainFolder(project.project);
}
