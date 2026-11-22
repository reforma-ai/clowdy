import type { FileEntry, FileKind, FileManager } from '@clowdy/file-manager';
import type { ProjectFolder, ProjectId } from '@clowdy/protocol';
import type { RootStore } from '../../stores';

/** The file manager of a folder, which is loaded when something needs it: the manager and the editor behind it are a chunk of their own, kept out of the window's first load. */
export async function filesManagerOf(root: RootStore, projectId: ProjectId, folder: ProjectFolder): Promise<FileManager> {
    const { filesStoreOf } = await import('./useFilesStore');

    return filesStoreOf(root).startedManagerOf(projectId, folder.id);
}

/** Shows the side panel on its Files tab. The tab shows the folder the window is working in. */
export function showFilesTab(root: RootStore, projectId: ProjectId): void {
    const ui = root.ui.forProject(projectId);

    ui.openSidePanelTab('files');
}

/**
 * What a path is on the disk, a file or a folder: the tree says so for what it has listed, and the path's own folder is listed to find out for the rest
 * (the tree lists a folder only once it is opened, and a file made a moment ago may not have reached it yet). The file manager's package is not imported here: this
 * module is in the window's first load.
 */
async function entryOf(manager: FileManager, path: string): Promise<FileEntry | undefined> {
    const known = manager.tree.get(path);

    if (known) return known;

    try {
        const slash = path.lastIndexOf('/');

        return (await manager.provider.list(slash === -1 ? '' : path.slice(0, slash), 1)).find(entry => entry.path === path);
    }
    catch {
        return undefined;
    }
}

/** Whether a path inside a folder is a file or a folder on the disk, or nothing when it is not there (or the folder cannot be read). */
export async function kindOnDisk(root: RootStore, projectId: ProjectId, folder: ProjectFolder, relative: string): Promise<FileKind | undefined> {
    if (relative === '') return 'directory';

    return (await entryOf(await filesManagerOf(root, projectId, folder), relative))?.kind;
}

/**
 * Opens a file in a tab of the Files tab, or a folder in its tree, and shows the panel. `relative` is the path inside the folder, empty for the folder itself (the tab
 * only shows). Resolves `false`, with nothing opened and the panel and the tabs as they were, when the path is not there or the file cannot be read.
 */
export async function openInFiles(root: RootStore, projectId: ProjectId, folder: ProjectFolder, relative: string): Promise<boolean> {
    const manager = await filesManagerOf(root, projectId, folder);

    // Asked before opening: opening a path that is not there still adds a tab, which takes the focus and, at the most tabs, closes the one used least, before it fails.
    if (relative !== '' && !await entryOf(manager, relative)) return false;

    const document = await manager.open(relative);

    // A file that is there but cannot be read gets a tab that says why, which is not a file opened, so the tab goes.
    if (document?.status === 'error') {
        manager.close(relative);

        return false;
    }

    showFilesTab(root, projectId);

    return true;
}
