import { getChat, upsertChat } from '../db/chats';
import { getRun } from '../db/runs';
import { conflict, invalid, notFound } from '../errors';
import { newId } from '../ids';
import { requireProject } from './projects';

import type { Chat, ChatMode } from '@clowdy/protocol';
import type { Store } from '../store';

export const DEFAULT_CHAT_TITLE = 'New chat';

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

export function createChat(store: Store, input: { projectId: string; title?: string; mode?: ChatMode }): Chat {
    return store.tx(() => {
        requireProject(store, input.projectId);

        const now = Date.now();

        return saveChat(store, {
            id: newId('cht'),
            projectId: input.projectId,
            title: input.title?.trim() || DEFAULT_CHAT_TITLE,
            mode: input.mode ?? 'autopilot',
            createdAt: now,
            updatedAt: now,
        });
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
