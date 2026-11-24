import { isPlaceReady, type Place } from '../sidePanel/currentPlace';
import { isDocumentPath } from './docsScope';
import { treeLayout } from './treeLayout';

import type { FileEntry, FileKind, FileManager } from '@clowdy/file-manager';
import type { ProjectId } from '@clowdy/protocol';
import type { RootStore } from '../../stores';

/**
 * The file manager of a place (a folder's own checkout, or the worktree of a chat), the Files tab's or the Docs tab's (each has its own tabs), which is loaded when something
 * needs it: the manager and the editor behind it are a chunk of their own, kept out of the window's first load. The place has to be ready (`isPlaceReady`): a worktree that
 * is not made yet has no files, and its manager would keep the failed listing after the worktree is made.
 */
export async function filesManagerOf(
    root: RootStore,
    projectId: ProjectId,
    place: Place,
    kind: 'files' | 'docs' = 'files'
): Promise<FileManager> {
    const { filesStoreOf } = await import('./useFilesStore');

    return filesStoreOf(root).startedManagerOf(projectId, place, kind);
}

/** The tab a path belongs on: a document is opened in the Docs tab, any other file in the Files tab. */
export const tabOf = (path: string): 'files' | 'docs' => (isDocumentPath(path) ? 'docs' : 'files');

/** Shows the side panel on its Files tab, or on the Docs tab, which is the same view with the place's documents for its tree and tabs of its own. The tab shows the place the window is working in. */
export function showFilesTab(root: RootStore, projectId: ProjectId, tab: 'files' | 'docs' = 'files'): void {
    root.ui.forProject(projectId).openSidePanelTab(tab);
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

        return (await manager.provider.list(slash === -1 ? '' : path.slice(0, slash), 1)).find(
            entry => entry.path === path
        );
    } catch {
        return undefined;
    }
}

/** Whether a path inside a place is a file or a folder on the disk, or nothing when it is not there (or the place cannot be read, or is a worktree that is not made yet). */
export async function kindOnDisk(
    root: RootStore,
    projectId: ProjectId,
    place: Place,
    relative: string
): Promise<FileKind | undefined> {
    if (!isPlaceReady(place)) return undefined;

    if (relative === '') return 'directory';

    return (await entryOf(await filesManagerOf(root, projectId, place), relative))?.kind;
}

/** Latest navigation wins when a slow folder listing overlaps a newer request. */
const navigation = new WeakMap<RootStore, number>();

/**
 * Opens a file in a tab of the Files tab, a document in a tab of the Docs tab, or a folder in the Files tree, and shows the panel. `relative` is the path inside the
 * place (the folder's own checkout, or the worktree of the chat), empty for the place itself (the tab only shows). Resolves `false`, with nothing opened and the panel and
 * the tabs as they were, when the path is not there, the file cannot be read or the place is a worktree that is not made yet.
 */
export async function openInFiles(
    root: RootStore,
    projectId: ProjectId,
    place: Place,
    relative: string
): Promise<boolean> {
    const generation = (navigation.get(root) ?? 0) + 1;
    navigation.set(root, generation);
    const stale = () => navigation.get(root) !== generation;
    if (!isPlaceReady(place)) return false;

    const initial = await filesManagerOf(root, projectId, place);
    const entry = relative === '' ? undefined : await entryOf(initial, relative);

    if (stale()) return true;
    if (relative !== '' && !entry) return false;

    if (relative === '' || entry?.kind === 'directory') {
        try {
            // Check access even when the tree already has a cached listing.
            await initial.provider.list(relative, 1);
            const parts = relative.split('/').filter(Boolean);
            for (let i = 1; i <= parts.length; i++) {
                await initial.tree.load(parts.slice(0, i).join('/'));
            }
        } catch {
            return stale();
        }
        if (initial.filterQuery) await initial.filter('');
        const { filesStoreOf } = await import('./useFilesStore');
        if (stale()) return true;
        filesStoreOf(root).clearOtherReveals(initial);
        initial.tree.revealPath(relative || null);
        if (!treeLayout.open) treeLayout.toggle();
        if (relative) initial.reveal(relative, true);
        else initial.clearReveal();
        showFilesTab(root, projectId, 'files');
        return true;
    }

    const tab = tabOf(relative);
    const manager = tab === 'files' ? initial : await filesManagerOf(root, projectId, place, tab);
    if (stale()) return true;
    const document = await manager.open(relative);
    if (stale()) return true;

    // A file that is there but cannot be read gets a tab that says why, which is not a file opened, so the tab goes.
    if (document?.status === 'error') {
        manager.close(relative);

        return false;
    }

    // A document is shown beside the tree of documents, in the tabs of the Docs tab; any other file beside the tree of files, in the Files tab's.
    showFilesTab(root, projectId, tab);

    return true;
}
