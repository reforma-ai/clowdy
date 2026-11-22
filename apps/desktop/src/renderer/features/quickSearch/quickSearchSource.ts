import { openChat } from '../chats/archiveChat';
import { isHiddenPath, treeLayout } from '../files';
import { isDocumentPath } from '../files/docsScope';
import { filesManagerOf as managerOf, showFilesTab } from '../files/openInFiles';
import { foundChats } from './quickSearchChats';

import type { FileManager } from '@clowdy/file-manager';
import type { ProjectFolder, ProjectId } from '@clowdy/protocol';
import type { ProjectState, RootStore } from '../../stores';
import type { Found, FoundChat, QuickSearchSource } from './QuickSearchModel';

/** The most files the daemon is asked for by the project's list: its own cap. */
const FILE_LIMIT = 100;

/** How well a path answers the words typed, the way the daemon ranks a name: its name starts with the first word, has it, or only the path has it. */
function scoreOf(path: string, first: string): number {
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf('/') + 1);

    return name.startsWith(first) ? 0 : name.includes(first) ? 1 : 2;
}

/**
 * The files of two lists, as one: the ones that name the words best first, then the shorter paths, the project's list before the other where they tie (the sort is
 * stable), each file once.
 */
export function mergeFiles(query: string, ...lists: ReadonlyArray<readonly string[]>): string[] {
    const first = query.trim().toLowerCase().split(/\s+/)[0] ?? '';

    return [...new Set(lists.flat())].toSorted((a, b) => scoreOf(a, first) - scoreOf(b, first) || a.length - b.length);
}

/**
 * Opens a result in the side panel's Files tab: the panel shows, the tab is the Files one, and the file is in a tab of the editor, with the match selected
 * when the result is a line. The tab shows the folder the window is working in, which is the one the palette searched.
 */
export async function openFound(root: RootStore, projectId: ProjectId, folder: ProjectFolder, found: Exclude<Found, FoundChat>): Promise<void> {
    showFilesTab(root, projectId, isDocumentPath(found.path) ? 'docs' : 'files');

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

    // The Docs tab is the same editor.
    if (!ui.sidePanelOpen || (ui.sidePanelTab !== 'files' && ui.sidePanelTab !== 'docs')) return undefined;

    return (await managerOf(root, projectId, folder)).selectedText();
}

/**
 * The palette's search of one folder of a project. The names come from the daemon's list of the project's files (git's tracked and unignored ones) and from the folder's
 * file tree, so a file the tree shows is found whether git ignores it or not; the content from the folder's file manager, which searches through the daemon (ripgrep) and, where a provider has no search, reads the files itself. Hidden files are left out
 * unless the tree shows them: what the tree does not show is not searched either.
 */
export function quickSearchSource(root: RootStore, project: ProjectState, folder: ProjectFolder): QuickSearchSource {
    const projectId = project.id;
    let manager: FileManager | undefined;

    return {
        chats: query => foundChats(project, query),
        files: async (query) => {
            // Two answers: the project's list (git's tracked and unignored files, the words matched one by one), and the files the tree has, which is what the person
            // sees: a file that git ignores is in the tree and not in that list. Either one on its own is an answer; a failure is one only when both fail.
            const [listed, shown] = await Promise.allSettled([
                root.transport.getProjectFiles(projectId, query, FILE_LIMIT),
                managerOf(root, projectId, folder).then((manager) => {
                    manager.tree.setShowHidden(treeLayout.showHidden);

                    return manager.listedFiles(query);
                }),
            ]);

            if (listed.status === 'rejected' && shown.status === 'rejected') throw listed.reason;

            const tracked = listed.status === 'fulfilled' ? listed.value.filter(match => match.folderId === folder.id).map(match => match.path) : [];
            const files = mergeFiles(query, tracked, shown.status === 'fulfilled' ? shown.value : []);

            return treeLayout.showHidden ? files : files.filter(path => !isHiddenPath(path));
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
        open: (found) => {
            if (found.kind === 'chat') void openChat(root, project, root.ui.forProject(projectId), found.chatId);
            else void openFound(root, projectId, folder, found);
        },
        dispose: () => manager?.search.dispose(),
    };
}
