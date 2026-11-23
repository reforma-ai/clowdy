import { isTerminalRunStatus } from '@clowdy/protocol';

import { deleteChatAndRuns, getChat, listChatDescendants, runsOfChat, upsertChat } from '../db/chats';
import { getRun } from '../db/runs';
import { chatsOfWorkspace, deleteWorkspace, getWorkspace, toChatWorkspace } from '../db/workspaces';
import { conflict, invalid, notFound } from '../errors';
import { newId } from '../ids';
import { requireProject } from './projects';
import { createWorkspace, inheritWorkspace } from './workspaces';

import type { Chat, ChatMode, ChatWorkspace, ChatWorkspaceChoice, EngineId, Run } from '@clowdy/protocol';
import type { AttachmentsService } from '../attachments/service';
import type { Config } from '../config';
import type { Store } from '../store';

export const DEFAULT_CHAT_TITLE = 'New chat';

const TITLE_LENGTH = 60;

/** A title from a text: its first line, cut at `TITLE_LENGTH` characters. */
export function titleFrom(text: string): string {
    const line = text.split('\n')[0].trim();

    return line.length > TITLE_LENGTH ? `${ line.slice(0, TITLE_LENGTH - 1) }…` : line;
}

/**
 * The title a chat gets from its first message, before an agent names it: the first words of what the person wrote, or the name of the first file
 * when they wrote nothing. A chat whose title is still this has not been named by anybody.
 */
export function firstWords({ text, attachments }: { text: string; attachments?: readonly { name: string }[] }): string {
    return titleFrom(text || attachments?.[0]?.name || '');
}

export function requireChat(store: Store, chatId: string): Chat {
    const chat = getChat(store.db, chatId);

    if (!chat) {
        throw notFound('Chat', chatId);
    }

    return chat;
}

/**
 * Writes the chat and publishes it. A chat that works in a worktree is published with the worktree as it is now: the copy the caller holds may be older than
 * the turn that made the worktree ready.
 */
export function saveChat(store: Store, chat: Chat): Chat {
    const record = chat.workspace && getWorkspace(store.db, chat.workspace.id);
    const saved: Chat = record ? { ...chat, workspace: toChatWorkspace(record) } : chat;

    upsertChat(store.db, saved);
    store.emit(saved.projectId, { type: 'chat.upserted', chat: saved });

    return saved;
}

export interface ChatChoice {
    engine?: EngineId;
    model?: string;
    effort?: string;
}

/** What a run runs on, as the chat that started it records it, so the chat shows what really ran (the project's defaults included). */
export function choiceOf(run: Run): ChatChoice {
    return { engine: run.engine, ...(run.model && { model: run.model }), ...(run.effort && { effort: run.effort }) };
}

/** What a new chat may be given beyond its title, mode and agent. */
export interface NewChat extends ChatChoice {
    projectId: string;
    title?: string;
    mode?: ChatMode;
    /** Makes the chat a thread of that chat (an agent of it started this one), which the caller has checked. */
    parentChatId?: string;
    /** The folder of the project the chat works in, which must be one of its folders; without it the chat follows the main folder. */
    folderId?: string;
    /**
     * The worktree the chat works in (`createWorkspace`): a new one its first turn makes, or one that exists. It needs `workspaces` too, for the folder of the
     * worktree to be made into a path. The chat then has the folder the worktree is a checkout of, the main folder's own id when none was named, so it stays
     * with it whichever folder the project makes main later.
     */
    workspace?: ChatWorkspaceChoice;
    /** The worktree of another chat, taken as it is (the same row): a thread's, a fork's. */
    workspaceId?: string;
}

/**
 * A new chat. A chat that is given a worktree is checked against the repository with a few synchronous reads of git, and nothing is made on the disk: the
 * worktree is made by its first turn.
 */
export function createChat(store: Store, input: NewChat, workspaces?: Pick<Config, 'workspacesDir'>): Chat {
    return store.tx(() => {
        const project = requireProject(store, input.projectId);

        if (input.folderId !== undefined && !project.folders.some(folder => folder.id === input.folderId)) {
            throw invalid(`Folder ${ input.folderId } does not belong to project ${ project.id }`);
        }

        if (input.workspace && input.workspaceId) {
            throw invalid('A chat is given a new worktree or the worktree of another chat, not both');
        }

        if (input.workspace && !workspaces) {
            throw new Error('createChat needs the workspaces folder to make a worktree');
        }

        const id = newId('cht');
        let workspace: ChatWorkspace | undefined;

        if (input.workspace && workspaces) {
            workspace = createWorkspace(store, workspaces, { project, chatId: id, folderId: input.folderId, choice: input.workspace });
        }
        else if (input.workspaceId) {
            workspace = inheritWorkspace(store, project, input.workspaceId, input.folderId);
        }

        const folderId = workspace?.folderId ?? input.folderId;
        const now = Date.now();

        return saveChat(store, {
            id,
            projectId: input.projectId,
            title: input.title?.trim() || DEFAULT_CHAT_TITLE,
            mode: input.mode ?? 'autopilot',
            ...(input.engine && { engine: input.engine }),
            ...(input.model && { model: input.model }),
            ...(input.effort && { effort: input.effort }),
            ...(input.parentChatId && { parentChatId: input.parentChatId }),
            ...(folderId && { folderId }),
            ...(workspace && { workspace }),
            createdAt: now,
            updatedAt: now,
        });
    });
}

/* ------------------------------- Thread tree ------------------------------ */

/**
 * The chats above `chat`, its parent first and its root chat last; none for a chat the person made. A thread's parent is set when the thread is made, to
 * a chat that exists, so the chain cannot loop; the walk stops at a chat it has seen all the same, and at a parent that is gone.
 */
export function parentChain(store: Store, chat: Chat): Chat[] {
    const chain: Chat[] = [];
    const seen = new Set([chat.id]);
    let parentId = chat.parentChatId;

    while (parentId && !seen.has(parentId)) {
        const parent = getChat(store.db, parentId);

        if (!parent) {
            break;
        }

        chain.push(parent);
        seen.add(parent.id);
        parentId = parent.parentChatId;
    }

    return chain;
}

/** The chat at the top of `chat`'s thread tree: the chat the person made, which is `chat` itself for a chat that is no thread. */
export function rootChatOf(store: Store, chat: Chat): Chat {
    return parentChain(store, chat).at(-1) ?? chat;
}

/** How deep `chat` is in its thread tree: a chat the person made is 1, its thread 2, a thread of that thread 3. */
export function chatDepth(store: Store, chat: Chat): number {
    return parentChain(store, chat).length + 1;
}

/** Whether `chat` is below `ancestorId`: a thread of it, or a thread of one of its threads. A chat is not below itself. */
export function isBelow(store: Store, ancestorId: string, chat: Chat): boolean {
    return parentChain(store, chat).some(parent => parent.id === ancestorId);
}

/** Whether two chats belong to the same thread tree: they have the same root chat. */
export function inSameTree(store: Store, a: Chat, b: Chat): boolean {
    return rootChatOf(store, a).id === rootChatOf(store, b).id;
}

/**
 * The chat and every chat below it, a parent before its threads, once every run of them is over (one in `waiting_background` is not): refuses otherwise,
 * naming the thread at work when it is not `chat` itself, the one the person acts on.
 */
export function stoppedSubtree(store: Store, chat: Chat): Chat[] {
    const chats = [chat, ...listChatDescendants(store.db, chat.id).map(entry => entry.chat)];
    const busy = chats.find(candidate => runsOfChat(store.db, candidate.id).some(run => !isTerminalRunStatus(run.status)));

    if (busy?.id === chat.id) {
        throw conflict('The agents of this chat are still working. Stop the chat first.');
    }

    if (busy) {
        throw conflict(`The thread "${ busy.title }" below this chat is still working. Stop it first.`);
    }

    return chats;
}

/**
 * Removes the chat with every thread below it, their runs, and the files sent in them. Their agents must have stopped: a live run would be left without
 * its row, so one at work anywhere in the tree refuses the whole delete. Each chat is announced on its own (`chat.deleted`, the deepest first), so a client
 * drops them all. The files' folders go once the transaction commits. Returns the ids of every run removed.
 *
 * A worktree's row goes with the last chat that points at it, so a row never outlives its chats; the worktree on the disk and its branch are not touched here
 * (a delete that removes them does it first: `removeChatWorkspace`), and a worktree that stays is listed by git as any other.
 */
export function deleteChat(store: Store, chatId: string, attachments: AttachmentsService): string[] {
    return store.tx(() => {
        const chats = stoppedSubtree(store, requireChat(store, chatId));
        const workspaceIds = new Set(chats.flatMap(each => (each.workspace ? [each.workspace.id] : [])));
        const runIds = chats.reverse().flatMap((each) => {
            const runIdsOfChat = runsOfChat(store.db, each.id).map(run => run.id);

            attachments.removeOfChat(each.id);
            deleteChatAndRuns(store.db, each.id);
            store.emit(each.projectId, { type: 'chat.deleted', chatId: each.id, runIds: runIdsOfChat });

            return runIdsOfChat;
        });

        for (const workspaceId of workspaceIds) {
            if (chatsOfWorkspace(store.db, workspaceId).length === 0) {
                deleteWorkspace(store.db, workspaceId);
            }
        }

        return runIds;
    });
}

/**
 * Archives the chat with every thread below it, or brings the chat back. Only the flag changes: the runs, tasks and stream stay, and each chat keeps its
 * place in the order of activity. A chat whose agents are working cannot be archived, as it cannot be deleted: it would drop out of sight while still
 * busy, and so would a thread at work below it, which refuses the whole archive. Bringing a chat back brings only that chat: its threads stay archived.
 * Setting what is set already changes nothing.
 */
export function setChatArchived(store: Store, chatId: string, archived: boolean): Chat {
    return store.tx(() => {
        const chat = requireChat(store, chatId);

        if ((chat.archivedAt !== undefined) === archived) {
            return chat;
        }

        const { archivedAt: _, ...rest } = chat;

        if (!archived) {
            return saveChat(store, rest);
        }

        const chats = stoppedSubtree(store, chat);
        const now = Date.now();

        for (const thread of chats.slice(1).filter(candidate => candidate.archivedAt === undefined)) {
            saveChat(store, { ...thread, archivedAt: now });
        }

        return saveChat(store, { ...rest, archivedAt: now });
    });
}

export function renameChat(store: Store, chatId: string, title: string): Chat {
    return store.tx(() => {
        const chat = requireChat(store, chatId);
        const trimmed = title.trim();

        if (!trimmed) {
            throw invalid('The title cannot be empty');
        }

        return saveChat(store, { ...chat, title: trimmed, updatedAt: Date.now() });
    });
}

/** The mode is fixed while the chat's orchestrator is working on a cycle. */
export function setChatMode(store: Store, chatId: string, mode: ChatMode): Chat {
    return store.tx(() => {
        const chat = requireChat(store, chatId);
        const run = chat.orchestratorRunId ? getRun(store.db, chat.orchestratorRunId) : undefined;

        if (chat.mode === mode) {
            return chat;
        }

        if (run && !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status)) {
            throw conflict('The mode cannot change while the orchestrator is working on this chat');
        }

        return saveChat(store, { ...chat, mode, updatedAt: Date.now() });
    });
}

/** What a field becomes when a call may name it: the value it names, nothing for `null`, and `kept` when the call leaves it out. */
const named = <T>(change: T | null | undefined, kept: T | undefined): T | undefined => change === undefined ? kept : change ?? undefined;

/**
 * Changes what the chat runs on. Like archiving, it is not activity: the chat keeps its place in the order. `model` and `effort` may change at any time (`null` clears one); the agent only while no orchestrator exists.
 * A field the call leaves out is kept, unless it can no longer hold: a different agent has other models, and a different model has other
 * levels, so what the same call does not name again is dropped. The chat alone changes here: the caller carries the choice to the
 * orchestrator run, which is what the next turn reads.
 */
export function setChatModel(store: Store, chatId: string, change: { engine?: EngineId; model?: string | null; effort?: string | null }): Chat {
    return store.tx(() => {
        const chat = requireChat(store, chatId);
        const { engine: currentEngine, model: currentModel, effort: currentEffort, ...rest } = chat;
        const engine = change.engine ?? currentEngine;
        const switched = engine !== currentEngine;

        if (switched && chat.orchestratorRunId) {
            throw conflict('The provider of a chat is fixed once its first message was sent');
        }

        const model = named(change.model, switched ? undefined : currentModel);
        const effort = named(change.effort, switched || model !== currentModel ? undefined : currentEffort);

        if (!switched && model === currentModel && effort === currentEffort) {
            return chat;
        }

        return saveChat(store, {
            ...rest,
            ...(engine && { engine }),
            ...(model && { model }),
            ...(effort && { effort }),
        });
    });
}
