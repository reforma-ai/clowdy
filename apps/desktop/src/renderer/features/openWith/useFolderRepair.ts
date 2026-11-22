import { useProjectState, useRootStore } from '../../stores';
import { locateFolderByDialog, removeFolder } from '../settings/projects/projectActions';

import type { ProjectFolder } from '@clowdy/protocol';

/** What puts right a folder of the project that is gone from the disk: the items `OpenWithMenu` adds under its note. */
export interface FolderRepair {
    /** Asks for the folder's new place, and moves the folder there: its chats stay with it. */
    locate: () => void;
    /** Takes the folder out of the project (asking first when chats work in it, or when it is the main one); absent for the project's only folder. */
    remove?: () => void;
}

/**
 * The repair of a folder that is gone from the disk, or nothing for a folder that is there. Nothing too for the personal space, which makes its folder again at
 * its next start, and where the window cannot ask for a folder (no desktop bridge: tests, the screenshot harness).
 */
export function useFolderRepair(folder: ProjectFolder, missing: boolean): FolderRepair | undefined {
    const root = useRootStore();
    const state = useProjectState();
    if (!missing || state.project.personal || !window.desktop?.chooseDirectories) return undefined;

    const chats = [...state.chats.values()].filter(chat => chat.folderId === folder.id).length;

    return {
        locate: () => void locateFolderByDialog(root, state.project, folder),
        remove: state.project.folders.length > 1 ? () => void removeFolder(root, state.project, folder, chats) : undefined,
    };
}
