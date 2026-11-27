import { openFormDialog } from '@clowdy/components/modals';
import { folderNames } from '@clowdy/protocol';

import { RootStoreProvider } from '../../stores';
import { openFolderWorkspace } from '../settings/projects/FolderWorkspaceDialog';
import { FolderWorktreesList } from './FolderWorktreesList';

import type { FolderId, ProjectId } from '@clowdy/protocol';
import type { RootStore } from '../../stores';

export interface ManageWorktreesProps {
    root: RootStore;
    projectId: ProjectId;
    folderId?: FolderId;
    initialTab?: 'settings' | 'worktrees';
    initialTidy?: boolean;
}

/** Open the settings and worktrees of the folder that supplied the entry point. */
export function openManageWorktrees({
    root,
    projectId,
    folderId,
    initialTab = 'worktrees',
    initialTidy = false,
}: ManageWorktreesProps): void {
    const project = root.projects.find(candidate => candidate.id === projectId);
    const index = folderId ? project?.folders.findIndex(folder => folder.id === folderId) : 0;
    const folder = index === undefined || index < 0 ? undefined : project?.folders[index];
    if (!folder || !project) return;

    if (initialTab === 'settings') {
        openFolderWorkspace({
            root,
            projectId,
            folderId: folder.id,
            name: folderNames(project.folders)[index!] ?? folder.path,
        });
        return;
    }
    openFormDialog({
        width: 540,
        component: (
            <RootStoreProvider value={root}>
                <FolderWorktreesList projectId={projectId} initialTidy={initialTidy} />
            </RootStoreProvider>
        ),
    });
}
