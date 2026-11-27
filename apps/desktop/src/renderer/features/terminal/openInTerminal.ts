import { toast } from '@clowdy/components/Toast';

import { isPlaceReady, type Place } from '../sidePanel/currentPlace';
import { terminalsStoreOf } from './useTerminalsStore';

import type { ProjectId } from '@clowdy/protocol';
import type { RootStore } from '../../stores';

/**
 * Starts a shell of the Terminal tab in a place of the project (a folder's own checkout, or the worktree of a chat), or in a folder below it (`relative`, empty for the place
 * itself), and shows the tab with that shell chosen. Always a new shell: the ones the place has may be busy. Resolves `false`, with a toast that says why and the panel as it
 * was, when no shell could be started (the folder is gone from the disk, the limit of shells is reached, the worktree is not made yet). The tab shows the place the window works
 * in, so a caller offers this only for that place.
 */
export async function openInTerminal(
    root: RootStore,
    projectId: ProjectId,
    place: Place,
    relative: string,
    isCurrent?: () => boolean
): Promise<boolean> {
    const ui = root.ui.forProject(projectId);
    const version = isCurrent ? undefined : ui.beginSidePanelNavigation();
    const navigation = ui.navigationVersion;
    const current = isCurrent ?? (() => ui.sidePanelPlaceVersion === version && ui.navigationVersion === navigation);
    const store = terminalsStoreOf(root.transport);

    if (!isPlaceReady(place)) {
        toast.error({ title: 'Couldn’t start a terminal', message: 'The worktree is not made yet' });

        return false;
    }

    // The shells the daemon already runs are read first: a read that comes after the new shell was made would not have it, and forgets what it does not find.
    await store.load(projectId);

    if (!current()) return false;
    const session = await store.start(projectId, place.folder.id, relative || undefined, place.workspace?.id);

    if (!session) {
        toast.error({ title: 'Couldn’t start a terminal', message: store.error || undefined });

        return false;
    }

    if (!current()) return false;
    root.ui.forProject(projectId).setSidePanelPlace(place);
    root.ui.forProject(projectId).openSidePanelTab('terminal');

    return true;
}
