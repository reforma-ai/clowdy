import { projectChatMode } from '@clowdy/protocol';

import { messageWithFiles } from '../attachments/message';
import { toAttachment } from '../attachments/service';
import { choiceOf, createChat, DEFAULT_CHAT_TITLE, deleteChat, firstWords, renameChat, requireChat, saveChat, setChatArchived, setChatMode, setChatModel } from '../domain/chats';
import { appendItem } from '../domain/items';
import { requireProject } from '../domain/projects';
import { invalid, unavailable } from '../errors';
import { firstMessage } from '../runs/prompts';
import { isAtRest } from '../runs/queue';

import type { QueuedMessageMode } from '@clowdy/protocol';
import type { AgentRegistry } from '../engine/acp/registry';
import type { Handlers, Services } from './context';

/** Says now, with the agent's name, that it is switched off: a run that failed on it later would only show a failed chat. */
export function requireEnabled(agents: AgentRegistry, engine: string): void {
    if (!agents.isEnabled(engine)) {
        throw unavailable(`${ agents.nameOf(engine) } is switched off in Clowdy. Turn it on in Settings > Providers, or continue in a new chat with another provider.`);
    }
}

/**
 * The first message creates the chat's orchestrator run and names the chat after it (unless it was renamed). A message to a finished chat, or to an
 * orchestrator parked until its children finish, starts a new turn of the same run: its stream keeps growing and its session is resumed. A message to
 * a busy orchestrator waits in the chat's queue, as a steer of the running turn or for the next turn (`mode`), and reaches the stream only when the
 * agent gets it (`ChatQueue`).
 *
 * A message may carry files uploaded to the chat's project (`attachmentIds`), with no text at all. The stream shows the
 * person's own text and the files; the agent gets the text and, after a blank line, the list of where the files are
 * (`messageWithFiles`). That one string goes down every path below, as the text always did.
 */
function send({ store, runs, driver, attachments, agents, queue }: Services, chatId: string, rawText: string, attachmentIds: readonly string[] = [], mode: QueuedMessageMode = 'queue') {
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
        const title = chat.title === DEFAULT_CHAT_TITLE ? firstWords({ text, attachments: body.attachments }) : chat.title;
        const run = runs.createRun({ project, role: 'orchestrator', chatId, summary: title, engine: chat.engine, model: chat.model, effort: chat.effort, nextPrompt: firstMessage('orchestrator', chat.mode, content) });

        attachments.markSent(files, chatId, run.id);
        appendItem(store, run.id, body);
        saveChat(store, { ...chat, ...choiceOf(run), title, orchestratorRunId: run.id, updatedAt: now });
        driver.launch(run.id);

        return { chatId, runId: run.id };
    }

    const run = runs.require(chat.orchestratorRunId);

    if (!isAtRest(run)) {
        queue.enqueue({ ...chat, updatedAt: now }, run, { mode, text, files, content });

        return { chatId, runId: run.id };
    }

    // A paused queue stays paused: this message is the person's own next turn, not one of those they held back.
    attachments.markSent(files, chatId, run.id);
    appendItem(store, run.id, body);
    saveChat(store, { ...chat, updatedAt: now });
    runs.resume(run.id, content);
    driver.launch(run.id);

    return { chatId, runId: run.id };
}

type ChatCommand = 'chat.create' | 'chat.rename' | 'chat.setMode' | 'chat.setModel' | 'chat.compact' | 'chat.setArchived' | 'chat.delete' | 'chat.send'
    | 'chat.removeQueued' | 'chat.moveQueued' | 'chat.sendQueued';

export const chatHandlers: Pick<Handlers, ChatCommand> = {
    'chat.create': ({ store, runs }, command) => {
        const project = requireProject(store, command.projectId);

        // An unknown agent is refused here; one that is switched off waits for the first message, which says so.
        if (command.engine) {
            runs.resolveEngine(project, command.engine);
        }

        return { chat: createChat(store, { ...command, mode: command.mode ?? projectChatMode(project.settings) }) };
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

    /**
     * The agent's own compact command, as a turn of the orchestrator: the person's message is not in the stream (they did not write it), and the agent's
     * report of the compaction is what the stream shows. An orchestrator that works or waits for its children gets it once it has finished, through the
     * chat's queue (`ChatQueue.compact`). Like `chat.setModel` it is not activity, so the chat's `updatedAt` stays.
     */
    'chat.compact': ({ store, runs, agents, queue }, command) => {
        const chat = requireChat(store, command.chatId);
        const run = chat.orchestratorRunId ? runs.require(chat.orchestratorRunId) : undefined;

        if (!run?.sessionId) {
            throw invalid('This chat has no conversation to compact yet');
        }

        const message = agents.compactCommand(run.engine);

        if (!message) {
            throw invalid(`${ agents.nameOf(run.engine) } has no command to compact its conversation`);
        }

        requireEnabled(agents, run.engine);
        queue.compact(chat, run, message);

        return { chatId: chat.id, runId: run.id };
    },

    'chat.setArchived': ({ store }, command) => ({ chat: setChatArchived(store, command.chatId, command.archived) }),

    'chat.delete': ({ store, attachments }, command) => {
        deleteChat(store, command.chatId, attachments);

        return { chatId: command.chatId };
    },

    'chat.send': (services, command) => send(services, command.chatId, command.text, command.attachmentIds, command.mode),

    'chat.removeQueued': ({ queue }, command) => ({ chat: queue.remove(command.chatId, command.itemId, command.keepFiles) }),

    'chat.moveQueued': ({ queue }, command) => ({ chat: queue.move(command.chatId, command.itemId, command.index) }),

    /** A message that goes out at once is refused like `chat.send` for an agent that is switched off; a steer of a running turn needs nothing new of it. */
    'chat.sendQueued': ({ store, runs, agents, queue }, command) => {
        const chat = requireChat(store, command.chatId);
        const run = chat.orchestratorRunId ? runs.require(chat.orchestratorRunId) : undefined;

        if (run && isAtRest(run)) {
            requireEnabled(agents, run.engine);
        }

        return queue.sendNow(command.chatId, command.itemId);
    },
};
