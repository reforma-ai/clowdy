import { isTerminalRunStatus } from '@clowdy/protocol';

import { createChat, DEFAULT_CHAT_TITLE, renameChat, requireChat, saveChat, setChatMode } from '../domain/chats';
import { appendItem } from '../domain/items';
import { requireProject } from '../domain/projects';
import { invalid } from '../errors';
import { firstMessage } from '../runs/prompts';

import type { Handlers, Services } from './context';

const TITLE_LENGTH = 60;

export function titleFrom(text: string): string {
    const line = text.split('\n')[0].trim();

    return line.length > TITLE_LENGTH ? `${ line.slice(0, TITLE_LENGTH - 1) }…` : line;
}

/**
 * The first message creates the chat's orchestrator run and names the chat after it (unless it was renamed).
 * Later messages go to the live session. A message to a finished chat, or to an orchestrator parked until its
 * children finish, starts a new turn of the same run: its stream keeps growing and its session is resumed.
 */
function send({ store, runs, driver }: Services, chatId: string, rawText: string) {
    const text = rawText.trim();

    if (!text) {
        throw invalid('The message is empty');
    }

    const chat = requireChat(store, chatId);
    const now = Date.now();

    if (!chat.orchestratorRunId) {
        const title = chat.title === DEFAULT_CHAT_TITLE ? titleFrom(text) : chat.title;
        const run = runs.createRun({ project: requireProject(store, chat.projectId), role: 'orchestrator', chatId, summary: title, nextPrompt: firstMessage('orchestrator', chat.mode, text) });

        appendItem(store, run.id, { kind: 'user', text });
        saveChat(store, { ...chat, title, orchestratorRunId: run.id, updatedAt: now });
        driver.launch(run.id);

        return { chatId, runId: run.id };
    }

    const run = runs.require(chat.orchestratorRunId);

    appendItem(store, run.id, { kind: 'user', text });
    saveChat(store, { ...chat, updatedAt: now });

    if (isTerminalRunStatus(run.status) || run.status === 'waiting_children') {
        runs.resume(run.id, text);
        driver.launch(run.id);
    }
    else {
        driver.deliver(run.id, text);
    }

    return { chatId, runId: run.id };
}

export const chatHandlers: Pick<Handlers, 'chat.create' | 'chat.rename' | 'chat.setMode' | 'chat.send'> = {
    'chat.create': ({ store }, command) => ({ chat: createChat(store, { ...command, mode: command.mode ?? requireProject(store, command.projectId).settings.chatMode }) }),

    'chat.rename': ({ store }, command) => ({ chat: renameChat(store, command.chatId, command.title) }),

    'chat.setMode': ({ store }, command) => ({ chat: setChatMode(store, command.chatId, command.mode) }),

    'chat.send': (services, command) => send(services, command.chatId, command.text),
};
