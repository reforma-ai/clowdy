import { isHiddenPath, treeLayout } from '../files';

import type { FileManager } from '@clowdy/file-manager';
import type { ProjectFolder, ProjectId } from '@clowdy/protocol';
import type { RootStore } from '../../stores';
import type { Found, QuickSearchSource } from './QuickSearchModel';

/** The most files the daemon is asked for: its own cap. */
const FILE_LIMIT = 100;

/** The file manager of a folder, which the palette loads when it needs it: the manager and the editor behind it are a chunk of their own, kept out of the window's first load. */
async function managerOf(root: RootStore, projectId: ProjectId, folder: ProjectFolder): Promise<FileManager> {
    const { filesStoreOf } = await import('../files/useFilesStore');

    return filesStoreOf(root.transport).startedManagerOf(projectId, folder.id);
}

/**
 * Opens a result in the side panel's Files tab: the panel shows, the tab is the Files one, and the file is in a tab of the editor, with the match selected
 * when the result is a line. The tab shows the folder the window is working in, which is the one the palette searched.
 */
export async function openFound(root: RootStore, projectId: ProjectId, folder: ProjectFolder, found: Found): Promise<void> {
    const ui = root.ui.forProject(projectId);

    if (!ui.sidePanelOpen) ui.toggleSidePanel();

    ui.showSidePanelTab('files');

    const manager = await managerOf(root, projectId, folder);

    if (found.kind === 'file') {
        await manager.open(found.path);

        return;
    }

    const [first] = found.ranges;
    const length = first ? first.end - first.start : 0;

    await manager.open(found.path, { from: { line: found.line, column: found.column }, to: { line: found.line, column: found.column + length } });
}

/** What a person has selected in the open file of the Files tab, on one line: what a search of the text starts with. Nothing when the tab is not on show. */
export async function selectedText(root: RootStore, projectId: ProjectId, folder: ProjectFolder): Promise<string | undefined> {
    const ui = root.ui.forProject(projectId);

    if (!ui.sidePanelOpen || ui.sidePanelTab !== 'files') return undefined;

    return (await managerOf(root, projectId, folder)).selectedText();
}

/**
 * The palette's search of one folder of a project. The names come from the daemon's list of the project's files (git's tracked and unignored ones, best match first); the
 * content from the folder's file manager, which searches through the daemon (ripgrep) and, where a provider has no search, reads the files itself. Hidden files are left out
 * unless the tree shows them: what the tree does not show is not searched either.
 */
export function quickSearchSource(root: RootStore, projectId: ProjectId, folder: ProjectFolder): QuickSearchSource {
    let manager: FileManager | undefined;

    return {
        files: async (query) => {
            const matches = await root.transport.getProjectFiles(projectId, query, FILE_LIMIT);

            return matches.filter(match => match.folderId === folder.id && (treeLayout.showHidden || !isHiddenPath(match.path))).map(match => match.path);
        },
        text: async (query) => {
            manager = await managerOf(root, projectId, folder);

            const { search, tree } = manager;

            tree.setShowHidden(treeLayout.showHidden);
            search.set({ query, matchCase: false, wholeWord: false });
            await search.run();

            if (search.error) throw new Error(search.error);

            return search.result ?? { files: [], truncated: false };
        },
        open: found => void openFound(root, projectId, folder, found),
        dispose: () => manager?.search.dispose(),
    };
}
