import { folderNames } from '@clowdy/protocol';

import { openFolderWorkspace } from '../settings/projects/FolderWorkspaceDialog';

import type { FolderId, ProjectId } from '@clowdy/protocol';
import type { RootStore } from '../../stores';

export interface ManageWorktreesProps {
    root: RootStore;
    projectId: ProjectId;
    folderId?: FolderId;
    initialTab?: 'settings' | 'worktrees';
}

/** Open the settings and worktrees of the folder that supplied the entry point. */
export function openManageWorktrees({
    root,
    projectId,
    folderId,
    initialTab = 'worktrees',
}: ManageWorktreesProps): void {
    const project = root.projects.find(candidate => candidate.id === projectId);
    const index = folderId ? project?.folders.findIndex(folder => folder.id === folderId) : 0;
    const folder = index === undefined || index < 0 ? undefined : project?.folders[index];
    if (!folder || !project) return;

    openFolderWorkspace({
        root,
        projectId,
        folderId: folder.id,
        initialTab,
        name: folderNames(project.folders)[index!] ?? folder.path,
    });
}
