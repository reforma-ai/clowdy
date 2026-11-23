import { useEffect, useState } from 'react';

import { useRootStore } from '../../stores';
import { type WorkspaceRef, workspaceHead } from './workspaceHead';

import type { FolderId, ProjectId, ProjectWorkspaceInfo } from '@clowdy/protocol';
import type { FolderGit } from './openTarget';

interface Read {
    key: string;
    /** The folder's own head, `undefined` when the answer has no such folder. */
    git: FolderGit | undefined;
    workspaces: ProjectWorkspaceInfo[] | undefined;
}

/** The reads of the folders that are on show now, each asked to read again by `refreshFolderGit`. */
const listeners = new Set<(projectId: ProjectId, folderId: FolderId) => void>();

/**
 * Asks everything that shows a folder's branch (`useFolderGit`: the chat's folder chip, the Files and Info tabs, the Changes sidebar) to read it again at once: what changed the branch
 * (a switch made from the Changes sidebar) knows it before the window's next focus does.
 */
export function refreshFolderGit(projectId: ProjectId, folderId: FolderId): void {
    for (const listener of listeners) listener(projectId, folderId);
}

/** Listens for `refreshFolderGit`, for a reader of the folder's git that is not `useFolderGit` (the new-chat page's branches and worktrees); gives back what ends the listening. */
export function onFolderGitRefresh(listener: (projectId: ProjectId, folderId: FolderId) => void): () => void {
    listeners.add(listener);

    return () => void listeners.delete(listener);
}

/**
 * What git says about a folder of a project (its `origin` and the branch that is checked out), read from the daemon when the component is drawn, when the folder
 * changes and when the window gets focus again, since the branch changes in a terminal or by an agent while the app is in the background. Nothing until the
 * answer for this folder comes (never another folder's), and nothing when it fails: the menu then has no link and the label no branch.
 *
 * With the `workspace` of a chat that works in a worktree, the branch is the worktree's, read the same way (`ProjectInfo.workspaces`, see `workspaceHead`): the branch it has
 * now, nothing until the read has answered, the branch it will be made on while it is not made yet, and `gone` once it was made and is no longer on the disk. The `origin` is the folder's.
 */
export function useFolderGit(
    projectId: ProjectId,
    folderId: FolderId,
    workspace?: WorkspaceRef
): FolderGit | undefined {
    const root = useRootStore();
    // A worktree that gets made is a change of its own: it is read again then, whatever the window did.
    const key = `${projectId}/${folderId}/${workspace ? `${workspace.id}:${workspace.ready}` : ''}`;
    const [read, setRead] = useState<Read>();

    useEffect(() => {
        // The number of the latest read: an answer that comes after a newer read was made, or after this effect ended, is out of date.
        let latest = 0;

        const readGit = () => {
            const request = ++latest;

            root.transport.getProjectsInfo(projectId).then(
                infos => {
                    if (request !== latest) return;

                    const info = infos.find(entry => entry.projectId === projectId);
                    const folder = info?.folders.find(entry => entry.folderId === folderId);

                    setRead({
                        key,
                        git: folder && {
                            remoteUrl: folder.remoteUrl,
                            branch: folder.branch,
                            detached: folder.detached,
                        },
                        workspaces: info?.workspaces,
                    });
                },
                () => undefined
            );
        };

        const onRefresh = (changedProject: ProjectId, changedFolder: FolderId) => {
            if (changedProject === projectId && changedFolder === folderId) readGit();
        };

        readGit();
        window.addEventListener('focus', readGit);
        listeners.add(onRefresh);

        return () => {
            latest++;
            window.removeEventListener('focus', readGit);
            listeners.delete(onRefresh);
        };
    }, [root, projectId, folderId, key]);

    const current = read?.key === key ? read : undefined;

    if (!workspace) return current?.git;

    const head = workspaceHead(workspace, current?.workspaces);

    return head && { remoteUrl: current?.git?.remoteUrl, ...head };
}
