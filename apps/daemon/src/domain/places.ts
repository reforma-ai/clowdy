import { statSync } from 'node:fs';

import { getWorkspace } from '../db/workspaces';
import { invalid, notFound, unavailable } from '../errors';

import type { FolderId, Project, ProjectFolder, WorkspaceId } from '@clowdy/protocol';
import type { WorkspaceRecord } from '../db/workspaces';
import type { Store } from '../store';

/**
 * A folder of a project at the place it is read in: its own checkout, or a worktree of it that a chat works in (a workspace). What the file system, the terminals, the
 * documents and the file names read of a folder, so they read the worktree of a chat that has one: a file an agent wrote there is not in the main checkout.
 */
export interface Place {
    /** The project's folder, as the project has it: its id and its name, whichever checkout is read. */
    folder: ProjectFolder;
    /** The worktree read in place of the folder's own checkout. Absent for the checkout itself. */
    workspace?: WorkspaceRecord;
    /** The directory that is read: the worktree's path, else the folder's. Whether it is there is for whoever reads it to find out again: it may go at any time. */
    path: string;
}

/** Whether something that is a folder is at the path. */
function isDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}

/**
 * Where a request that names a folder, and maybe a workspace, is read. Without a workspace it is the folder's own checkout. With one, the workspace has to belong to
 * this project and to this folder (`not_found` otherwise, whoever's it is: a client learns nothing of a worktree that is not its project's), and its worktree has to be
 * made (`ready`) and on the disk (`unavailable` otherwise: the chat's first turn makes it, and a worktree that was removed by hand is made again by the next turn).
 * No request reaches a path the project does not own: the paths read are the project's folders' and its workspaces' only, and what is below them is judged against the
 * real path of the root by whoever reads (`FsService`).
 */
export function resolvePlace(store: Store, project: Project, folderId: FolderId, workspaceId?: WorkspaceId): Place {
    if (!folderId) {
        throw invalid('The folder is not given');
    }

    const folder = project.folders.find(candidate => candidate.id === folderId);

    if (!folder) {
        throw notFound('Folder', folderId);
    }

    if (workspaceId === undefined) {
        return { folder, path: folder.path };
    }

    const workspace = getWorkspace(store.db, workspaceId);

    if (!workspace || workspace.projectId !== project.id || workspace.folderId !== folder.id) {
        throw notFound('Workspace', workspaceId);
    }

    if (!workspace.ready) {
        throw unavailable(`The worktree ${ workspace.path } is not made yet`);
    }

    if (!isDirectory(workspace.path)) {
        throw unavailable(`The worktree ${ workspace.path } is missing`);
    }

    return { folder, workspace, path: workspace.path };
}

/** The place of a workspace alone, for the routes that are not given its folder (the documents and the file names): the folder is the workspace's own. */
export function resolveWorkspacePlace(store: Store, project: Project, workspaceId: WorkspaceId): Place {
    const workspace = getWorkspace(store.db, workspaceId);

    if (!workspace || workspace.projectId !== project.id) {
        throw notFound('Workspace', workspaceId);
    }

    return resolvePlace(store, project, workspace.folderId, workspaceId);
}
