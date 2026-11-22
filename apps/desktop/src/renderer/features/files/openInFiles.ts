import type { FileManager } from '@clowdy/file-manager';
import type { ProjectFolder, ProjectId } from '@clowdy/protocol';
import type { RootStore } from '../../stores';

/** The file manager of a folder, which is loaded when something needs it: the manager and the editor behind it are a chunk of their own, kept out of the window's first load. */
export async function filesManagerOf(root: RootStore, projectId: ProjectId, folder: ProjectFolder): Promise<FileManager> {
    const { filesStoreOf } = await import('./useFilesStore');

    return filesStoreOf(root.transport).startedManagerOf(projectId, folder.id);
}

/** Shows the side panel on its Files tab. The tab shows the folder the window is working in. */
export function showFilesTab(root: RootStore, projectId: ProjectId): void {
    const ui = root.ui.forProject(projectId);

    if (!ui.sidePanelOpen) ui.toggleSidePanel();

    ui.showSidePanelTab('files');
}

/**
 * Opens a file in a tab of the Files tab, or a folder in its tree, and shows the panel. `relative` is the path inside the folder, empty for the folder itself (the tab
 * only shows). Resolves `false`, with nothing opened and the panel as it was, when the file cannot be read: it is not there.
 */
export async function openInFiles(root: RootStore, projectId: ProjectId, folder: ProjectFolder, relative: string): Promise<boolean> {
    const manager = await filesManagerOf(root, projectId, folder);
    const document = await manager.open(relative);

    // A path that is not on the disk still gets a tab, which says why it cannot be shown: that is not a file opened, so the tab goes.
    if (document?.status === 'error') {
        manager.close(relative);

        return false;
    }

    showFilesTab(root, projectId);

    return true;
}
