import { projectChatMode } from '@clowdy/protocol';

import { createChat, deleteChat, renameChat, requireChat, setChatArchived, setChatMode, setChatModel } from '../domain/chats';
import { requireProject } from '../domain/projects';
import { invalid } from '../errors';
import { prepareEdit } from '../runs/edit';
import { prepareFork } from '../runs/fork';
import { requireEnabled, sendMessage } from '../runs/messages';
import { isAtRest } from '../runs/queue';

import type { AsyncHandlers, Handlers } from './context';

type ChatCommand = 'chat.create' | 'chat.rename' | 'chat.setMode' | 'chat.setModel' | 'chat.compact' | 'chat.setArchived' | 'chat.delete' | 'chat.send'
    | 'chat.removeQueued' | 'chat.moveQueued' | 'chat.sendQueued';

export const chatHandlers: Pick<Handlers, ChatCommand> = {
    /** A `workspace` is checked here and its row made; the worktree itself is made by the chat's first turn (`prepareWorkspace`). */
    'chat.create': ({ store, runs, config }, command) => {
        const project = requireProject(store, command.projectId);

        // An unknown agent is refused here; one that is switched off waits for the first message, which says so.
        if (command.engine) {
            runs.resolveEngine(project, command.engine);
        }

        return { chat: createChat(store, { ...command, mode: command.mode ?? projectChatMode(project.settings) }, config) };
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
     * report of the compaction is what the stream shows. An orchestrator that works or waits for background work gets it once it has finished, through the
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

    /** Archiving takes the chat's threads along; bringing it back brings only the chat (`setChatArchived`). */
    'chat.setArchived': ({ store }, command) => ({ chat: setChatArchived(store, command.chatId, command.archived) }),

    /** The chat goes with every thread below it, each announced on its own (`deleteChat`). */
    'chat.delete': ({ store, attachments }, command) => {
        deleteChat(store, command.chatId, attachments);

        return { chatId: command.chatId };
    },

    /** The person's message: see `sendMessage`. */
    'chat.send': (services, command) => {
        const { chatId, runId } = sendMessage(services, command.chatId, { text: command.text, attachmentIds: command.attachmentIds, mode: command.mode });

        return { chatId, runId };
    },

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

/** `chat.fork` and `chat.edit` ask the agent to copy its session first, so they are the chat commands that wait: see `prepareFork` and `prepareEdit`. */
export const chatAsyncHandlers: Pick<AsyncHandlers, 'chat.fork' | 'chat.edit'> = {
    'chat.fork': (services, command) => prepareFork(services, command.chatId, command.itemId),

    'chat.edit': (services, command) => prepareEdit(services, command.chatId, command.itemId, { text: command.text, attachmentIds: command.attachmentIds }),
};
