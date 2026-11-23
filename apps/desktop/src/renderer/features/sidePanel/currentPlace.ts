import { mainFolder } from '@clowdy/protocol';

import { chatFolder, draftTarget, folderById } from '../agents/agentTree';

import type { Chat, ChatWorkspace, FolderId, ProjectFolder, WorkspaceId } from '@clowdy/protocol';
import type { ProjectState, ProjectUi } from '../../stores';

/**
 * Where the window works: a folder of the project, and the worktree of that folder the open chat works in, when it has one. The side panel's Files, Docs, Terminal and
 * Info tabs, the quick search and the `@` menu all read the same place, so they list the same files. A chat in the folder's own checkout has no `workspace`.
 */
export interface Place {
    folder: ProjectFolder;
    /**
     * The worktree the chat works in, in place of the folder's checkout, whether it is made or not: a worktree is made by the chat's first turn, and `isPlaceReady` says
     * whether there is anything of it to show yet.
     */
    workspace?: ChatWorkspace;
}

/**
 * What a place's tabs and tree are kept under: the worktree's id, else the folder's (ids of a folder and of a workspace never meet), so a worktree has its own tabs and tree,
 * shared by the chats that share it, and none of the folder's. The shells are kept the same way, by ids (`TerminalsStore`), since a shell knows no more than its ids.
 */
export const placeKey = ({ folder, workspace }: Place): FolderId | WorkspaceId => workspace?.id ?? folder.id;

/** The place alone of something that has one and more (a menu's target): the folder, and the worktree when it is in one. */
export const placeOf = ({ folder, workspace }: Place): Place => (workspace ? { folder, workspace } : { folder });

/** Where a place is on the disk: the worktree's path, else the folder's own. */
export const placePath = ({ folder, workspace }: Place): string => workspace?.path ?? folder.path;

/** Whether a place has anything to show: the folder always has, a worktree once the chat's first turn made it. Until then the tabs have an empty state, not the main checkout. */
export const isPlaceReady = ({ workspace }: Place): boolean => workspace === undefined || workspace.ready;

/** Whether two places are the same one: the same worktree, or the same folder's own checkout. */
export const isSamePlace = (a: Place, b: Place): boolean => a.folder.id === b.folder.id && a.workspace?.id === b.workspace?.id;

/**
 * The place a chat works in: the folder it works in (`folder` when the caller knows it, else the chat's own `folderId`, which a thread has from its parent) and the worktree
 * the chat has, if it is a checkout of that folder (the daemon pins a chat with a worktree to the worktree's folder, so a mismatch is a stale read and the worktree is left out).
 */
export function chatPlace(folders: readonly ProjectFolder[], chat: Pick<Chat, 'folderId' | 'workspace'>, folder: ProjectFolder = folderById(folders, chat.folderId)): Place {
    return chat.workspace?.folderId === folder.id ? { folder, workspace: chat.workspace } : { folder };
}

/**
 * The place the window is working in: that of the new chat that is being made, else that of the open chat, and the project's main folder when no chat is open.
 * The new-chat page comes first: it is opened over the chat that was open and leaves it remembered (`ProjectUi.openDraft` keeps `chatId`, so the chat comes back when the
 * page is left), and what the window shows is the page, whose folder the select under the message box names. The page has no worktree to show: a new worktree is made by the
 * first message, and one that exists has no workspace of Clowdy's until the chat is made, so a new chat's place is its folder's own checkout.
 */
export function currentPlace(project: Pick<ProjectState, 'chats' | 'project'>, ui: Pick<ProjectUi, 'chatId' | 'draft' | 'draftFolderId'>): Place {
    const { folders } = project.project;

    if (ui.draft) return { folder: draftTarget(folders, ui.draftFolderId).folder };

    const chat = ui.chatId ? project.chats.get(ui.chatId) : undefined;

    return chat ? chatPlace(folders, chat, chatFolder(project.chats, folders, chat.id)?.folder) : { folder: mainFolder(project.project) };
}
