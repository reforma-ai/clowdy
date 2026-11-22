import { useEffect, useState } from 'react';

import { useRootStore } from '../../stores';

import type { FolderId, ProjectId } from '@clowdy/protocol';
import type { FolderGit } from './openTarget';

/**
 * What git says about a folder of a project (its `origin` and the branch that is checked out), read from the daemon when the component is drawn, when the folder
 * changes and when the window gets focus again, since the branch changes in a terminal or by an agent while the app is in the background. Nothing until the
 * answer for this folder comes (never another folder's), and nothing when it fails: the menu then has no link and the label no branch.
 */
export function useFolderGit(projectId: ProjectId, folderId: FolderId): FolderGit | undefined {
    const root = useRootStore();
    const key = `${ projectId }/${ folderId }`;
    const [read, setRead] = useState<{ key: string; git: FolderGit | undefined }>();

    useEffect(() => {
        // The number of the latest read: an answer that comes after a newer read was made, or after this effect ended, is out of date.
        let latest = 0;

        const readGit = () => {
            const request = ++latest;

            root.transport.getProjectsInfo(projectId).then(
                (infos) => {
                    if (request !== latest) return;

                    const folder = infos.find(info => info.projectId === projectId)?.folders.find(entry => entry.folderId === folderId);

                    setRead({ key, git: folder && { remoteUrl: folder.remoteUrl, branch: folder.branch, detached: folder.detached } });
                },
                () => undefined
            );
        };

        readGit();
        window.addEventListener('focus', readGit);

        return () => {
            latest++;
            window.removeEventListener('focus', readGit);
        };
    }, [root, projectId, folderId, key]);

    return read?.key === key ? read.git : undefined;
}
