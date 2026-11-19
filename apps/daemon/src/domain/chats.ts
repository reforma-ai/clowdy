import { isTerminalRunStatus } from '@clowdy/protocol';

import { deleteChatAndRuns, getChat, runsOfChat, upsertChat } from '../db/chats';
import { getRun } from '../db/runs';
import { conflict, invalid, notFound } from '../errors';
import { newId } from '../ids';
import { requireProject } from './projects';

import type { Chat, ChatMode, EngineId, Run } from '@clowdy/protocol';
import type { AttachmentsService } from '../attachments/service';
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

/** Writes the chat and publishes it. */
export function saveChat(store: Store, chat: Chat): Chat {
    upsertChat(store.db, chat);
    store.emit(chat.projectId, { type: 'chat.upserted', chat });

    return chat;
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

export function createChat(store: Store, input: { projectId: string; title?: string; mode?: ChatMode } & ChatChoice): Chat {
    return store.tx(() => {
        requireProject(store, input.projectId);

        const now = Date.now();

        return saveChat(store, {
            id: newId('cht'),
            projectId: input.projectId,
            title: input.title?.trim() || DEFAULT_CHAT_TITLE,
            mode: input.mode ?? 'autopilot',
            ...(input.engine && { engine: input.engine }),
            ...(input.model && { model: input.model }),
            ...(input.effort && { effort: input.effort }),
            createdAt: now,
            updatedAt: now,
        });
    });
}

/**
 * Removes the chat and its runs, and the files sent in it. Their agents must have stopped: a live run would be left without its row.
 * The files' folders go once the transaction commits.
 */
export function deleteChat(store: Store, chatId: string, attachments: AttachmentsService): string[] {
    return store.tx(() => {
        const chat = requireChat(store, chatId);
        const runs = runsOfChat(store.db, chatId);

        if (runs.some(run => !isTerminalRunStatus(run.status))) {
            throw conflict('The agents of this chat are still working. Stop the chat first.');
        }

        const runIds = runs.map(run => run.id);

        attachments.removeOfChat(chatId);
        deleteChatAndRuns(store.db, chatId);
        store.emit(chat.projectId, { type: 'chat.deleted', chatId, runIds });

        return runIds;
    });
}

/**
 * Archives the chat, or brings it back. Only the flag changes: the runs, tasks and stream stay, and the chat keeps its place in
 * the order of activity. A chat whose agents are working cannot be archived, as it cannot be deleted: it would drop out of sight
 * while still busy. Setting what is set already changes nothing.
 */
export function setChatArchived(store: Store, chatId: string, archived: boolean): Chat {
    return store.tx(() => {
        const chat = requireChat(store, chatId);

        if ((chat.archivedAt !== undefined) === archived) {
            return chat;
        }

        if (archived && runsOfChat(store.db, chatId).some(run => !isTerminalRunStatus(run.status))) {
            throw conflict('The agents of this chat are still working. Stop the chat first.');
        }

        const { archivedAt: _, ...rest } = chat;

        return saveChat(store, archived ? { ...rest, archivedAt: Date.now() } : rest);
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
