import { toast } from '@clowdy/components/Toast';

import { currentPlace, isPlaceReady } from '../sidePanel/currentPlace';
import { DOCS_ROOT } from './docsScope';
import { openInFiles } from './openInFiles';

import type { FolderId } from '@clowdy/protocol';
import type { ProjectState, RootStore } from '../../stores';

/**
 * Opens a document on the side panel's Docs tab: `path` is under the docs folder of the folder `folderId` names (the main folder when none is). The tab shows the place
 * the window is working in, which is that folder's own checkout or the worktree of the open chat, so a document of another folder is not shown and a toast says so, as does
 * a path that is not there. Resolves whether it opened.
 */
export async function openDocument(root: RootStore, project: ProjectState, path: string, folderId: FolderId | null = null): Promise<boolean> {
    const [main] = project.project.folders;
    const folder = project.project.folders.find(candidate => candidate.id === folderId) ?? main;
    const current = currentPlace(project, root.ui.forProject(project.id));

    if (!folder || folder.id !== current.folder.id) {
        toast.error({ message: 'That document is in another folder of the project' });

        return false;
    }

    // A worktree that is not made yet has no document; one that is made may lack a document the folder's own checkout has.
    if (!isPlaceReady(current)) {
        toast.error({ message: 'The worktree is not made yet' });

        return false;
    }

    const opened = await openInFiles(root, project.id, current, `${ DOCS_ROOT }/${ path }`);

    if (!opened) toast.error({ message: current.workspace ? 'That document is not in this worktree' : 'That document is not on the disk' });

    return opened;
}
