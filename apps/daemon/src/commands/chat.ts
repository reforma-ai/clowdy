import { isTerminalRunStatus } from '@clowdy/protocol';

import { messageWithFiles } from '../attachments/message';
import { toAttachment } from '../attachments/service';
import { choiceOf, createChat, DEFAULT_CHAT_TITLE, deleteChat, renameChat, requireChat, saveChat, setChatArchived, setChatMode, setChatModel } from '../domain/chats';
import { appendItem } from '../domain/items';
import { requireProject } from '../domain/projects';
import { invalid, unavailable } from '../errors';
import { firstMessage } from '../runs/prompts';

import type { AgentRegistry } from '../engine/acp/registry';
import type { Handlers, Services } from './context';

const TITLE_LENGTH = 60;

export function titleFrom(text: string): string {
    const line = text.split('\n')[0].trim();

    return line.length > TITLE_LENGTH ? `${ line.slice(0, TITLE_LENGTH - 1) }…` : line;
}

/** Says now, with the agent's name, that it is switched off: a run that failed on it later would only show a failed chat. */
export function requireEnabled(agents: AgentRegistry, engine: string): void {
    if (!agents.isEnabled(engine)) {
        throw unavailable(`${ agents.nameOf(engine) } is switched off in Clowdy. Turn it on in Settings > Providers, or continue in a new chat with another provider.`);
    }
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
function send({ store, runs, driver, attachments, agents }: Services, chatId: string, rawText: string, attachmentIds: readonly string[] = []) {
    const text = rawText.trim();

    if (!text && attachmentIds.length === 0) {
        throw invalid('The message is empty');
    }

    // A message to an archived chat brings it back: nobody writes to a chat they have put away.
    const { archivedAt: _, ...chat } = requireChat(store, chatId);
    const project = requireProject(store, chat.projectId);
    const engine = runs.resolveEngine(project, chat.engine);

    requireEnabled(agents, engine);

    const files = attachments.claim(chat.projectId, attachmentIds);
    const content = messageWithFiles(text, files.map(file => ({ path: attachments.pathOf(file), mediaType: file.mediaType, size: file.size })));
    const body = { kind: 'user' as const, text, ...(files.length > 0 && { attachments: files.map(toAttachment) }) };
    const now = Date.now();

    if (!chat.orchestratorRunId) {
        const title = chat.title === DEFAULT_CHAT_TITLE ? titleFrom(text || files[0].name) : chat.title;
        const run = runs.createRun({ project, role: 'orchestrator', chatId, summary: title, engine: chat.engine, model: chat.model, effort: chat.effort, nextPrompt: firstMessage('orchestrator', chat.mode, content) });

        attachments.markSent(files, chatId, run.id);
        appendItem(store, run.id, body);
        saveChat(store, { ...chat, ...choiceOf(run), title, orchestratorRunId: run.id, updatedAt: now });
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

export const chatHandlers: Pick<Handlers, 'chat.create' | 'chat.rename' | 'chat.setMode' | 'chat.setModel' | 'chat.setArchived' | 'chat.delete' | 'chat.send'> = {
    'chat.create': ({ store, runs }, command) => {
        const project = requireProject(store, command.projectId);

        // An unknown agent is refused here; one that is switched off waits for the first message, which says so.
        if (command.engine) {
            runs.resolveEngine(project, command.engine);
        }

        return { chat: createChat(store, { ...command, mode: command.mode ?? project.settings.chatMode }) };
    },

    'chat.rename': ({ store }, command) => ({ chat: renameChat(store, command.chatId, command.title) }),

    'chat.setMode': ({ store }, command) => ({ chat: setChatMode(store, command.chatId, command.mode) }),

    'chat.setModel': ({ store, runs }, command) => {
        if (command.engine) {
            runs.resolveEngine(requireProject(store, requireChat(store, command.chatId).projectId), command.engine);
        }

        const chat = setChatModel(store, command.chatId, command);

        // The orchestrator's next turn reads its own row.
        if (chat.orchestratorRunId) {
            runs.setChoice(chat.orchestratorRunId, { model: chat.model, effort: chat.effort });
        }

        return { chat };
    },

    'chat.setArchived': ({ store }, command) => ({ chat: setChatArchived(store, command.chatId, command.archived) }),

    'chat.delete': ({ store, attachments }, command) => {
        deleteChat(store, command.chatId, attachments);

        return { chatId: command.chatId };
    },

    'chat.send': (services, command) => send(services, command.chatId, command.text, command.attachmentIds),
};
