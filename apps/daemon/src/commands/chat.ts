import { isTerminalRunStatus } from '@clowdy/protocol';

import { messageWithFiles } from '../attachments/message';
import { toAttachment } from '../attachments/service';
import { createChat, DEFAULT_CHAT_TITLE, deleteChat, renameChat, requireChat, saveChat, setChatArchived, setChatMode } from '../domain/chats';
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
 *
 * A message may carry files uploaded to the chat's project (`attachmentIds`), with no text at all. The stream shows the
 * person's own text and the files; the agent gets the text and, after a blank line, the list of where the files are
 * (`messageWithFiles`). That one string goes down every path below, as the text always did.
 */
function send({ store, runs, driver, attachments }: Services, chatId: string, rawText: string, attachmentIds: readonly string[] = []) {
    const text = rawText.trim();

    if (!text && attachmentIds.length === 0) {
        throw invalid('The message is empty');
    }

    // A message to an archived chat brings it back: nobody writes to a chat they have put away.
    const { archivedAt: _, ...chat } = requireChat(store, chatId);
    const files = attachments.claim(chat.projectId, attachmentIds);
    const content = messageWithFiles(text, files.map(file => ({ path: attachments.pathOf(file), mediaType: file.mediaType, size: file.size })));
    const body = { kind: 'user' as const, text, ...(files.length > 0 && { attachments: files.map(toAttachment) }) };
    const now = Date.now();

    if (!chat.orchestratorRunId) {
        const title = chat.title === DEFAULT_CHAT_TITLE ? titleFrom(text || files[0].name) : chat.title;
        const run = runs.createRun({ project: requireProject(store, chat.projectId), role: 'orchestrator', chatId, summary: title, nextPrompt: firstMessage('orchestrator', chat.mode, content) });

        attachments.markSent(files, chatId, run.id);
        appendItem(store, run.id, body);
        saveChat(store, { ...chat, title, orchestratorRunId: run.id, updatedAt: now });
        driver.launch(run.id);

        return { chatId, runId: run.id };
    }

    const run = runs.require(chat.orchestratorRunId);

    attachments.markSent(files, chatId, run.id);
    appendItem(store, run.id, body);
    saveChat(store, { ...chat, updatedAt: now });

    if (isTerminalRunStatus(run.status) || run.status === 'waiting_children') {
        runs.resume(run.id, content);
        driver.launch(run.id);
    }
    else {
        driver.deliver(run.id, content);
    }

    return { chatId, runId: run.id };
}

export const chatHandlers: Pick<Handlers, 'chat.create' | 'chat.rename' | 'chat.setMode' | 'chat.setArchived' | 'chat.delete' | 'chat.send'> = {
    'chat.create': ({ store }, command) => ({ chat: createChat(store, { ...command, mode: command.mode ?? requireProject(store, command.projectId).settings.chatMode }) }),

    'chat.rename': ({ store }, command) => ({ chat: renameChat(store, command.chatId, command.title) }),

    'chat.setMode': ({ store }, command) => ({ chat: setChatMode(store, command.chatId, command.mode) }),

    'chat.setArchived': ({ store }, command) => ({ chat: setChatArchived(store, command.chatId, command.archived) }),

    'chat.delete': ({ store, attachments }, command) => {
        deleteChat(store, command.chatId, attachments);

        return { chatId: command.chatId };
    },

    'chat.send': (services, command) => send(services, command.chatId, command.text, command.attachmentIds),
};
