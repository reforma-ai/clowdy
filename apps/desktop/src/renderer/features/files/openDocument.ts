import { toast } from '@clowdy/components/Toast';

import { currentFolder } from '../sidePanel/currentFolder';
import { DOCS_ROOT } from './docsScope';
import { openInFiles } from './openInFiles';

import type { FolderId } from '@clowdy/protocol';
import type { ProjectState, RootStore } from '../../stores';

/**
 * Opens a document on the side panel's Docs tab: `path` is under the docs folder of the folder `folderId` names (the main folder when none is). The tab shows the folder
 * the window is working in, so a document of another folder is not shown and a toast says so, as does a path that is not there. Resolves whether it opened.
 */
export async function openDocument(root: RootStore, project: ProjectState, path: string, folderId: FolderId | null = null): Promise<boolean> {
    const [main] = project.project.folders;
    const folder = project.project.folders.find(candidate => candidate.id === folderId) ?? main;
    const current = currentFolder(project, root.ui.forProject(project.id));

    if (!folder || folder.id !== current.id) {
        toast.error({ message: 'That document is in another folder of the project' });

        return false;
    }

    const opened = await openInFiles(root, project.id, folder, `${ DOCS_ROOT }/${ path }`);

    if (!opened) toast.error({ message: 'That document is not on the disk' });

    return opened;
}
