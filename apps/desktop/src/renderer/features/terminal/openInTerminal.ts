import { toast } from '@clowdy/components/Toast';

import { terminalsStoreOf } from './useTerminalsStore';

import type { ProjectFolder, ProjectId } from '@clowdy/protocol';
import type { RootStore } from '../../stores';

/**
 * Starts a shell of the Terminal tab in a folder of the project, or in a folder below it (`relative`, empty for the folder itself), and shows the tab with that
 * shell chosen. Always a new shell: the ones the folder has may be busy. Resolves `false`, with a toast that says why and the panel as it was, when no shell
 * could be started (the folder is gone from the disk, the limit of shells is reached). The tab shows the folder the window works in, so a caller offers this only
 * for that folder.
 */
export async function openInTerminal(root: RootStore, projectId: ProjectId, folder: ProjectFolder, relative: string): Promise<boolean> {
    const store = terminalsStoreOf(root.transport);

    // The shells the daemon already runs are read first: a read that comes after the new shell was made would not have it, and forgets what it does not find.
    await store.load(projectId);

    const session = await store.start(projectId, folder.id, relative || undefined);

    if (!session) {
        toast.error({ title: 'Couldn’t start a terminal', message: store.error || undefined });

        return false;
    }

    root.ui.forProject(projectId).openSidePanelTab('terminal');

    return true;
}
