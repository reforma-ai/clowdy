import { mainFolder } from '@clowdy/protocol';
import { statSync } from 'node:fs';

import { getChat } from '../db/chats';
import { getRunWork, listActiveRuns } from '../db/runs';
import { getWorkspace } from '../db/workspaces';
import { invalid, notFound, unavailable } from '../errors';
import { samePlace } from './workspaces';

import type { Chat, FolderId, Project, ProjectFolder, WorkspaceId } from '@clowdy/protocol';
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
 * made (`ready`) and on the disk (`unavailable` otherwise: the chat's first turn makes it, and the next turn makes it again when Clowdy made it and it was removed by
 * hand). An empty `workspaceId` is none. The roots read are the project's folders' and the worktrees recorded for its folders, and what is below a root is judged against
 * its real path by whoever reads (`FsService`); the row's path is the daemon's own record (a path git named for the folder's repository, or one under the workspaces
 * folder), so a worktree directory that someone replaced by a link is as much the person's doing as a folder that was.
 */
export function resolvePlace(store: Store, project: Project, folderId: FolderId, workspaceId?: WorkspaceId): Place {
    if (!folderId) {
        throw invalid('The folder is not given');
    }

    const folder = project.folders.find(candidate => candidate.id === folderId);

    if (!folder) {
        throw notFound('Folder', folderId);
    }

    if (!workspaceId) {
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

/**
 * Whether a place belongs to the project: its folder is one of the project's, and its worktree, when it has one, is a worktree of that folder recorded for this project.
 * `resolvePlace` only makes places that do; this is for what takes a place from its caller (`FsService`, `TerminalService`), so a place made for another project, or
 * made by hand, cannot read what the project does not own.
 */
export function ownsPlace(project: Project, place: Place): boolean {
    const folder = project.folders.find(candidate => candidate.id === place.folder.id);

    if (!folder) {
        return false;
    }

    if (!place.workspace) {
        return place.path === folder.path;
    }

    return place.workspace.projectId === project.id && place.workspace.folderId === folder.id && place.path === place.workspace.path;
}

/**
 * The folder a turn works in: the one the run names (a thread's own `cwd`), else the worktree of its chat (`Chat.workspace`), else the folder of the project
 * its chat works in (`Chat.folderId`), else the main folder. A chat whose folder the project no longer has was handed back to the main folder when the folder
 * left (its worktree with it), so a stale id reads as none.
 */
export function workingFolder(project: Project, chat: Chat | undefined, own: string | undefined): string {
    if (own) {
        return own;
    }

    if (chat?.workspace) {
        return chat.workspace.path;
    }

    const folder = chat?.folderId === undefined ? undefined : project.folders.find(candidate => candidate.id === chat.folderId);

    return (folder ?? mainFolder(project)).path;
}

/**
 * How many chats of the project have a run that is not over (one waiting for an answer, for a slot or for its background work counts: its session is open and may write
 * at once) working in `path`, which is a folder's own checkout or a worktree: where each orchestrator's turn starts is `workingFolder`, the same rule the run uses, compared by
 * the real path so a link to the folder is the folder. Sub-agents live in their parent's session and are not counted twice; a thread is a chat of its own.
 */
export function chatsWorkingIn(store: Store, project: Project, path: string): number {
    const working = new Set<string>();

    for (const run of listActiveRuns(store.db)) {
        if (run.projectId !== project.id || run.role !== 'orchestrator') continue;

        const chat = run.chatId === undefined ? undefined : getChat(store.db, run.chatId);

        if (samePlace(workingFolder(project, chat, getRunWork(store.db, run.id).cwd), path)) working.add(chat?.id ?? run.id);
    }

    return working.size;
}
