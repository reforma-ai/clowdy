import { openChat } from '../chats/archiveChat';
import { docPaths } from '../chats/mentionItems';
import { isHiddenPath, treeLayout } from '../files';
import { compareDocs } from '../files/docsScope';
import { filesManagerOf as managerOf, showFilesTab, tabOf } from '../files/openInFiles';
import { foundChats } from './quickSearchChats';

import type { FileManager } from '@clowdy/file-manager';
import type { DocsTree, ProjectFolder, ProjectId } from '@clowdy/protocol';
import type { ProjectState, RootStore } from '../../stores';
import type { Found, FoundChat, FoundDoc, QuickSearchSource } from './QuickSearchModel';

/** The most files the daemon is asked for by the project's list: its own cap. */
const FILE_LIMIT = 100;

/** How well a path answers the words typed, the way the daemon ranks a name: its name starts with the first word, has it, or only the path has it. */
function scoreOf(path: string, first: string): number {
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf('/') + 1);

    return name.startsWith(first) ? 0 : name.includes(first) ? 1 : 2;
}

/**
 * The files of two lists, as one: the ones that name the words best first, then the ones that are not hidden (a file in a dot folder, a dotfile) before the ones that are,
 * then the shorter paths, the project's list before the other where they tie (the sort is stable), each file once.
 */
export function mergeFiles(query: string, ...lists: ReadonlyArray<readonly string[]>): string[] {
    const first = query.trim().toLowerCase().split(/\s+/)[0] ?? '';

    return [...new Set(lists.flat())].toSorted((a, b) => scoreOf(a, first) - scoreOf(b, first) || Number(isHiddenPath(a)) - Number(isHiddenPath(b)) || a.length - b.length);
}

/**
 * The documents whose path has every word of `query` (any case), ranked by `compareDocs`: the names that start with the first word first, then the ones that have it, then the
 * ones only the path has, the shorter name first; the order they came in is kept where they tie, which is the order of the sources and of their trees, so Briefback comes first. A path is the
 * document's own in the project folder, so its source's root is part of it (and no document is hidden for being in a dot folder: that is where they are).
 */
export function matchDocs(query: string, paths: readonly string[]): string[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const first = words[0] ?? '';

    return [...new Set(paths)]
        .filter((path) => {
            const lower = path.toLowerCase();

            return words.every(word => lower.includes(word));
        })
        .toSorted(compareDocs(query));
}

/**
 * Opens a result in the side panel's Files tab: the panel shows, the tab is the Files one, and the file is in a tab of the editor, with the match selected
 * when the result is a line. The tab shows the folder the window is working in, which is the one the palette searched.
 */
export async function openFound(root: RootStore, projectId: ProjectId, folder: ProjectFolder, found: Exclude<Found, FoundChat | FoundDoc>): Promise<void> {
    const tab = tabOf(found.path);

    showFilesTab(root, projectId, tab);

    const manager = await managerOf(root, projectId, folder, tab);

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

    // The Docs tab is the same editor, over tabs of its own: the selection is the one of the tab on show.
    if (!ui.sidePanelOpen || (ui.sidePanelTab !== 'files' && ui.sidePanelTab !== 'docs')) return undefined;

    return (await managerOf(root, projectId, folder, ui.sidePanelTab)).selectedText();
}

/**
 * Whether a path of the project's list is not what a person looks for by name: a file in a folder of dependencies (vendored code, if git tracks it) or one the file
 * manager of the system leaves behind, which a folder outside a repository lists as it lists every file.
 */
const isNoise = (path: string) => path.split('/').some(name => name === 'node_modules' || name === '.DS_Store' || name === 'Thumbs.db');

/**
 * The palette's search of one folder of a project. The names come from the daemon's list of the project's files (git's tracked and unignored ones) and from the folder's
 * file tree, so a file the tree shows is found whether git ignores it or not; the content from the folder's file manager, which searches through the daemon (ripgrep) and, where a provider has no search, reads the files itself. A hidden file that git
 * tracks (`.briefback/acp/plan.md`, `.github/workflows/ci.yml`, `.eslintrc`) is found by its name though the tree does not show it, after the files that are not hidden where they match
 * alike: it is part of the project. The hidden files that only the tree knows (git ignores them: caches, `.DS_Store`, a local `.env`) are left out unless the tree shows them.
 */
export function quickSearchSource(root: RootStore, project: ProjectState, folder: ProjectFolder): QuickSearchSource {
    const projectId = project.id;
    let manager: FileManager | undefined;
    // The documents are read from the disk once for the palette that is open: it is a few seconds of someone typing, not a watch.
    let documents: Promise<DocsTree> | undefined;

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

            // What the tree lists is already as the tree shows it, hidden files or not.
            return mergeFiles(query, treeLayout.showHidden ? tracked : tracked.filter(path => !isNoise(path)), shown.status === 'fulfilled' ? shown.value : []);
        },
        docs: async (query) => {
            // The daemon reads the folder's document sources from the disk (`.briefback`, `.clowdy/docs`, the roots of Spec Kit, OpenSpec and Kiro), which the file names leave out as
            // hidden: the Docs tab's own tree is the same files. A path is the document's own in the folder, the root of its source first.
            documents ??= root.transport.getDocsTree(projectId);

            const tree = await documents.catch((error: unknown) => {
                documents = undefined;

                throw error;
            });
            const mine = tree.find(entry => entry.folderId === folder.id);

            return matchDocs(query, mine?.sources.flatMap(({ root: sourceRoot, nodes }) => docPaths(nodes).map(path => `${ sourceRoot }/${ path }`)) ?? []);
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
            else if (found.kind === 'doc') void openFound(root, projectId, folder, { kind: 'file', id: found.id, path: found.path });
            else void openFound(root, projectId, folder, found);
        },
        dispose: () => manager?.search.dispose(),
    };
}
