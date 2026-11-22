import { folderNames, isTerminalRunStatus, mainFolder, shownRunStatus, type Chat, type ChatId, type FolderId, type ProjectFolder, type Run, type RunId } from '@clowdy/protocol';

import { isRunActive } from '../chats/chatRun';

import type { StatusTone } from '../../shared';
import type { ChatSort } from './chatListPreferences';

/** One line of the Agents list: a chat, at the depth of the thread tree it sits in (0 for a chat the person made). */
export interface AgentRow {
    id: ChatId;
    chat: Chat;
    depth: number;
    /** How many threads the list has below this row, shown or folded away. A row with none has no fold. */
    childCount: number;
    isExpanded: boolean;
}

export interface AgentRowsInput {
    /** The chats at depth 0, in the list's order (`visibleChats`). */
    roots: readonly Chat[];
    /** The threads a chat started directly, oldest first; archived ones are left out here. */
    threadsOf: (chatId: ChatId) => readonly Chat[];
    runs: ReadonlyMap<RunId, Run>;
    /** The chats whose threads are open. Every other chat is folded. */
    expanded: ReadonlySet<ChatId>;
    /** List a thread whose run is over. */
    showFinished: boolean;
    /** The chat the screen shows: it stays listed whatever the filter says. */
    openChatId?: ChatId;
}

/** The orchestrator of a chat, once its first message started one. */
export function orchestratorOf(chat: Chat, runs: ReadonlyMap<RunId, Run>): Run | undefined {
    return chat.orchestratorRunId === undefined ? undefined : runs.get(chat.orchestratorRunId);
}

/** A thread is finished when its orchestrator's run is over: done, failed, stopped or interrupted. One that never started is not. */
export function isFinishedThread(chat: Chat, runs: ReadonlyMap<RunId, Run>): boolean {
    const run = orchestratorOf(chat, runs);

    return run !== undefined && isTerminalRunStatus(run.status);
}

/** A thread works while its orchestrator is queued, running, blocked, waits for the person or for its background work. */
export function isActiveThread(chat: Chat, runs: ReadonlyMap<RunId, Run>): boolean {
    return isRunActive(orchestratorOf(chat, runs));
}

/**
 * The list as rows, top to bottom: each root chat, followed by its threads (and theirs, at any depth) in the order they were made when it is
 * expanded. Archived threads are not rows. Without `showFinished`, a finished thread is left out unless a thread below it is listed (it still
 * works, or it is the open chat) or it is the open chat itself; a row's fold counts only the threads that are listed.
 */
export function agentRows({ roots, threadsOf, runs, expanded, showFinished, openChatId }: AgentRowsInput): AgentRow[] {
    const listed = new Map<ChatId, Chat[]>();
    const visiting = new Set<ChatId>();

    // The threads of a chat that the filter keeps, worked out bottom up so that a thread kept for its own sake keeps its parents too.
    const listedThreads = (chatId: ChatId): Chat[] => {
        const known = listed.get(chatId);

        if (known) return known;

        visiting.add(chatId);

        const kept = threadsOf(chatId).filter((thread) => {
            // Chats form a tree by contract; the guard keeps a corrupt parent cycle from looping.
            if (thread.archivedAt !== undefined || visiting.has(thread.id)) return false;

            const below = listedThreads(thread.id);

            return showFinished || thread.id === openChatId || below.length > 0 || !isFinishedThread(thread, runs);
        });

        visiting.delete(chatId);
        listed.set(chatId, kept);

        return kept;
    };

    const rows: AgentRow[] = [];
    const walk = (chat: Chat, depth: number) => {
        const threads = listedThreads(chat.id);
        const isExpanded = threads.length > 0 && expanded.has(chat.id);

        rows.push({ id: chat.id, chat, depth, childCount: threads.length, isExpanded });

        if (isExpanded) threads.forEach(thread => walk(thread, depth + 1));
    };

    roots.forEach(root => walk(root, 0));

    return rows;
}

/**
 * The chats at the top of the list: the ones in use that the person made, newest first. A thread is never here: it is a row below the chat that
 * started it. A chat is either in the list or in the archive, which has its own list; there is no chat that is open and archived. `chatList`
 * comes by last activity; `sort` `created` puts the newest chat first instead. A thread whose parent is not in use (gone, or put away while the
 * thread came back on its own) stands here, so it is not lost.
 */
export function visibleChats(chatList: readonly Chat[], sort: ChatSort = 'activity'): Chat[] {
    const ordered = sort === 'created' ? [...chatList].sort((a, b) => b.createdAt - a.createdAt) : chatList;
    const inUse = new Set(chatList.filter(chat => chat.archivedAt === undefined).map(chat => chat.id));

    return ordered.filter(chat => chat.archivedAt === undefined && (chat.parentChatId === undefined || !inUse.has(chat.parentChatId)));
}

/** One folder's part of the grouped list: its chats at depth 0, in the order `visibleChats` gave them. */
export interface AgentGroup {
    folder: ProjectFolder;
    /** The folder's short name, which tells the project's folders apart (`folderNames`). */
    name: string;
    isMain: boolean;
    roots: Chat[];
}

/** The folder with this id, else the main one: no id follows the main folder, and one the project no longer has was handed back to it. */
export function folderById(folders: readonly ProjectFolder[], folderId: FolderId | null | undefined): ProjectFolder {
    return folders.find(folder => folder.id === folderId) ?? mainFolder({ folders: [...folders] });
}

/** The folder a new chat of the grouped list is for: the one `draftFolderId` names, else the main one (see `folderById`), with its short name. */
export function draftTarget(folders: readonly ProjectFolder[], draftFolderId: FolderId | null | undefined): Pick<AgentGroup, 'folder' | 'name' | 'isMain'> {
    const folder = folderById(folders, draftFolderId);
    const index = folders.indexOf(folder);

    return { folder, name: folderNames(folders)[index] ?? folder.path, isMain: index === 0 };
}

/**
 * The root chats split by folder, one group per folder of the project in the project's order (main first), a folder with no chat included. A chat with
 * no folder follows the main folder, so it stands in the main group. Each group keeps the order of `roots`.
 */
export function agentGroups(roots: readonly Chat[], folders: readonly ProjectFolder[]): AgentGroup[] {
    const names = folderNames(folders);
    const groups = folders.map((folder, index): AgentGroup => ({ folder, name: names[index] ?? folder.path, isMain: index === 0, roots: [] }));

    for (const chat of roots) {
        const { id } = folderById(folders, chat.folderId);

        groups.find(group => group.folder.id === id)?.roots.push(chat);
    }

    return groups;
}

/** The folder whose group lists a chat: the folder of the chat the person made that it sits below (a thread is below its parent, in its group). */
export function groupFolderOf(chats: ReadonlyMap<ChatId, Chat>, folders: readonly ProjectFolder[], chatId: ChatId): FolderId | undefined {
    const chat = chats.get(chatId);

    if (!chat) return undefined;

    return folderById(folders, (ancestorChats(chats, chatId).at(-1) ?? chat).folderId).id;
}

/** The folder a chat works in, with its short name: the one whose group lists it (`groupFolderOf`), so a thread works where the chat it is below does. */
export function chatFolder(chats: ReadonlyMap<ChatId, Chat>, folders: readonly ProjectFolder[], chatId: ChatId): Pick<AgentGroup, 'folder' | 'name'> | undefined {
    const id = groupFolderOf(chats, folders, chatId);
    const index = folders.findIndex(folder => folder.id === id);
    const folder = folders[index];

    return folder && { folder, name: folderNames(folders)[index] ?? folder.path };
}

/**
 * The chats the archive lists, the one put away last first. A thread put away with its parent is part of the parent's cascade and has no entry of
 * its own; one put away alone, while its parent is in use, has one.
 */
export function archivedChats(chatList: readonly Chat[]): (Chat & { archivedAt: number })[] {
    const archived = new Set(chatList.filter(chat => chat.archivedAt !== undefined).map(chat => chat.id));

    return chatList
        .filter((chat): chat is Chat & { archivedAt: number } => chat.archivedAt !== undefined && (chat.parentChatId === undefined || !archived.has(chat.parentChatId)))
        .sort((a, b) => b.archivedAt - a.archivedAt);
}

/** The chats a thread sits below, nearest first: its parent, the parent's parent, up to the chat the person made. Empty for such a chat. */
export function ancestorChats(chats: ReadonlyMap<ChatId, Chat>, chatId: ChatId): Chat[] {
    const ancestors: Chat[] = [];

    for (let parent = chats.get(chatId)?.parentChatId; parent !== undefined && parent !== chatId; parent = chats.get(parent)?.parentChatId) {
        const chat = chats.get(parent);

        if (!chat || ancestors.includes(chat)) break;

        ancestors.push(chat);
    }

    return ancestors;
}

/** The chat a run belongs to: the one whose orchestrator is the root of the run's tree. A thread's orchestrator is a root run of its own. */
export function chatOfRun(chats: Iterable<Chat>, run: Pick<Run, 'rootRunId'>): Chat | undefined {
    return [...chats].find(chat => chat.orchestratorRunId === run.rootRunId);
}

/** What the main pane shows: a chat (a thread is one too), and a sub-agent's run of that chat when the person opened one, or the new-chat row. */
export interface AgentSelection {
    chat: Chat | undefined;
    /** A native sub-agent below the chat's orchestrator. The orchestrator itself is the chat, so it is never here. */
    run: Run | undefined;
    /** The new-chat row: asked for, or the only thing there is to show because the project has no chat yet. */
    draft: boolean;
}

/**
 * The selection the screen shows, from what the UI remembers. A remembered run wins when its chat is known (a run is
 * opened from a chip or from an agent's card), and a root run is its chat. Anything gone, and a chat that is in the archive (it has
 * no page: opening one brings it back first, `openChat`), falls back to the chat that was selected, and then to the first
 * chat of `chatList`, the chats the list shows; with no chat at all the new-chat page is what shows.
 */
export function resolveSelection(chats: ReadonlyMap<ChatId, Chat>, chatList: readonly Chat[], runs: ReadonlyMap<RunId, Run>, chatId: ChatId | null, runId: RunId | null, draft = false): AgentSelection {
    if (draft) return { chat: undefined, run: undefined, draft: true };

    const run = runId === null ? undefined : runs.get(runId);
    const owner = run ? chatOfRun(chats.values(), run) : undefined;

    if (run && owner && owner.archivedAt === undefined) return { chat: owner, run: run.parentRunId === undefined ? undefined : run, draft: false };

    const remembered = chatId === null ? undefined : chats.get(chatId);
    const chat = (remembered?.archivedAt === undefined ? remembered : undefined) ?? chatList[0];

    return { chat, run: undefined, draft: chat === undefined };
}

/**
 * The dot on the icon of a chat's row, from what its orchestrator is doing: green while it works (or waits for its own background work),
 * blue when it has asked the person something (also while the run rests for its background work and a card is open: `shownRunStatus`), red when it failed.
 * A run that is blocked or queued shows its usual tone.
 * A chat at rest whose own threads work (`threadsWorking`) is green too: its work goes on in them.
 * Nothing for a chat that has not started or whose run is over (done, stopped, interrupted): no news is no dot.
 */
export function chatDotTone(run: Run | undefined, threadsWorking = false): StatusTone | undefined {
    switch (run && shownRunStatus(run)) {
        case 'running':
        case 'waiting_background':
            return 'success';
        case 'waiting_user':
            return 'accent';
        case 'failed':
            return 'danger';
        case 'blocked':
            return 'warning';
        case 'queued':
            return 'neutral';
        default:
            return threadsWorking ? 'success' : undefined;
    }
}
