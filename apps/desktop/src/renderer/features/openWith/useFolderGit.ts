import { useEffect, useState } from 'react';

import { useRootStore } from '../../stores';

import type { FolderId, ProjectId } from '@clowdy/protocol';
import type { FolderGit } from './openTarget';

/**
 * What git says about a folder of a project (its `origin` and the branch that is checked out), read from the daemon when the component is drawn, when the folder
 * changes and when the window gets focus again, since the branch changes in a terminal or by an agent while the app is in the background. Nothing until the
 * answer comes, and nothing when it fails: the menu then has no link and the label no branch.
 */
export function useFolderGit(projectId: ProjectId, folderId: FolderId): FolderGit | undefined {
    const root = useRootStore();
    const [git, setGit] = useState<FolderGit>();

    useEffect(() => {
        let isCurrent = true;

        const read = () => {
            root.transport.getProjectsInfo(projectId).then(
                (infos) => {
                    const folder = infos.find(info => info.projectId === projectId)?.folders.find(entry => entry.folderId === folderId);

                    if (isCurrent) setGit(folder && { remoteUrl: folder.remoteUrl, branch: folder.branch, detached: folder.detached });
                },
                () => undefined
            );
        };

        read();
        window.addEventListener('focus', read);

        return () => {
            isCurrent = false;
            window.removeEventListener('focus', read);
        };
    }, [root, projectId, folderId]);

    return git;
}
