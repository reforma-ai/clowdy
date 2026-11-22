import { mainFolder } from '@clowdy/protocol';

import { chatFolder, draftTarget } from '../agents/agentTree';

import type { ProjectFolder } from '@clowdy/protocol';
import type { ProjectState, ProjectUi } from '../../stores';

/**
 * The folder the window is working in: the folder of the open chat, or of the new chat that is being made, while the Agents section is on show, and the
 * project's main folder in every other case, since the other sections belong to the project and not to a folder.
 */
export function currentFolder(project: Pick<ProjectState, 'chats' | 'project'>, ui: Pick<ProjectUi, 'section' | 'chatId' | 'draft' | 'draftFolderId'>): ProjectFolder {
    const { folders } = project.project;

    if (ui.section === 'agents') {
        const found = ui.chatId ? chatFolder(project.chats, folders, ui.chatId) : undefined;

        if (found) return found.folder;

        if (ui.draft) return draftTarget(folders, ui.draftFolderId).folder;
    }

    return mainFolder(project.project);
}
