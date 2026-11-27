import { existsSync } from 'node:fs';
import { projectChatMode } from '@clowdy/protocol';

import { setRunWork } from '../db/runs';
import {
    chatFolder,
    createChat,
    deleteChat,
    renameChat,
    requireChat,
    setChatArchived,
    setChatMode,
    setChatModel,
} from '../domain/chats';
import { resolvePlace } from '../domain/places';
import { requireProject } from '../domain/projects';
import { removeChatWorkspace } from '../domain/workspaceRemoval';
import { readRepository } from '../domain/workspaces';
import { invalid } from '../errors';
import { prepareEdit } from '../runs/edit';
import { prepareFork } from '../runs/fork';
import { requireEnabled, sendMessage } from '../runs/messages';
import { isAtRest } from '../runs/queue';

import type { ChatWorkspaceChoice, ChatWorktreeChoice } from '@clowdy/protocol';
import type { RepositoryFacts } from '../domain/workspaces';
import type { AsyncHandlers, CommandOf, Handlers, Services } from './context';

type ChatCommand =
    | 'chat.create'
    | 'chat.rename'
    | 'chat.setMode'
    | 'chat.setModel'
    | 'chat.compact'
    | 'chat.setArchived'
    | 'chat.delete'
    | 'chat.send'
    | 'chat.removeQueued'
    | 'chat.moveQueued'
    | 'chat.sendQueued';

/** The worktree a `chat.create` asks for: `main` is the folder's own checkout, which has no worktree row. */
const worktreeOf = (choice: ChatWorkspaceChoice | undefined): ChatWorktreeChoice | undefined =>
    choice?.mode === 'main' ? undefined : choice;

/**
 * Makes the chat of a `chat.create`: the project and the agent are judged, the worktree row is made from what the async handler read of the repository (a `main` choice has none: the
 * chat works in the folder as it is, and what the choice asks of git is done before this runs). In a transaction, as every handler is.
 */
function makeChat({ store, runs, config }: Services, command: CommandOf<'chat.create'>, repository?: RepositoryFacts) {
    const project = requireProject(store, command.projectId);

    // An unknown agent is refused here; one that is switched off waits for the first message, which says so.
    if (command.engine) {
        runs.resolveEngine(project, command.engine);
    }

    const { workspace, ...rest } = command;
    const worktree = worktreeOf(workspace);

    return createChat(
        store,
        {
            ...rest,
            ...(worktree && { workspace: worktree }),
            ...(repository && { repository }),
            mode: command.mode ?? projectChatMode(project.settings),
        },
        config
    );
}

export const chatHandlers: Pick<Handlers, ChatCommand> = {
    /** A chat with no `workspace`, which works in the folder as it is. Any `workspace` waits for git and is the async handler's: `executeCommand` never gives it to this one. */
    'chat.create': (services, command) => {
        if (command.workspace !== undefined) {
            throw new Error('chat.create with a workspace waits for git: run it with executeCommandAsync');
        }

        return { chat: makeChat(services, command) };
    },

    'chat.rename': ({ store }, command) => ({ chat: renameChat(store, command.chatId, command.title) }),

    'chat.setMode': ({ store }, command) => ({ chat: setChatMode(store, command.chatId, command.mode) }),

    'chat.setModel': ({ store, runs }, command) => {
        if (command.engine) {
            runs.resolveEngine(requireProject(store, requireChat(store, command.chatId).projectId), command.engine);
        }

        const before = requireChat(store, command.chatId);
        const chat = setChatModel(store, command.chatId, command);

        // The orchestrator's next turn reads its own row.
        if (chat.orchestratorRunId) {
            runs.setChoice(chat.orchestratorRunId, { model: chat.model, effort: chat.effort });
            if (chat.model !== before.model || chat.engine !== before.engine) {
                setRunWork(store.db, chat.orchestratorRunId, { strictModel: null });
            }
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
            throw invalid(`${agents.nameOf(run.engine)} has no command to compact its conversation`);
        }

        requireEnabled(agents, run.engine);
        queue.compact(chat, run, message);

        return { chatId: chat.id, runId: run.id };
    },

    /** Archiving takes the chat's threads along; bringing it back brings only the chat (`setChatArchived`). */
    'chat.setArchived': ({ store }, command) => ({ chat: setChatArchived(store, command.chatId, command.archived) }),

    /** The chat goes with every thread below it, each announced on its own (`deleteChat`). The worktree and its branch stay; one that is to go is `chatAsyncHandlers`'s. */
    'chat.delete': ({ store, attachments }, command) => {
        deleteChat(store, command.chatId, attachments);

        return { chatId: command.chatId };
    },

    /** The person's message: see `sendMessage`. */
    'chat.send': (services, command) => {
        const { chatId, runId } = sendMessage(services, command.chatId, {
            text: command.text,
            attachmentIds: command.attachmentIds,
            mode: command.mode,
        });

        return { chatId, runId };
    },

    'chat.removeQueued': ({ queue }, command) => ({
        chat: queue.remove(command.chatId, command.itemId, command.keepFiles),
    }),

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

/**
 * `chat.fork` and `chat.edit` ask the agent to copy its session first, so they are the chat commands that wait: see `prepareFork` and `prepareEdit`. `chat.delete` waits
 * only with `removeWorkspace`, for git to remove the worktree and its branch (`removeChatWorkspace`, which refuses with a `conflict` that says why when it must): the
 * chat is deleted after it, in the transaction, and nothing is deleted when the removal fails.
 */
export const chatAsyncHandlers: Pick<AsyncHandlers, 'chat.create' | 'chat.fork' | 'chat.edit' | 'chat.delete'> = {
    /**
     * A chat with a `workspace`, which waits for git; one with none is not given to this handler (`waitsWhen`). The agent, the folder and the project are judged before git runs.
     *
     * A worktree, new or existing: the repository is read first (`readRepository`), and the transaction checks the choice against what was read and makes the row, with no git inside
     * it. The worktree itself is made by the chat's first turn (`prepareWorkspace`).
     *
     * The folder's own checkout **on a branch** (`{ mode: 'main', branch }`): the checkout is switched first, by the Changes sidebar's own switch (`GitSwitch`, with all of its
     * refusals, on the folder's line of writes), and the chat is made only once git is done, in the transaction, so a refusal leaves no chat and the repository as it was, and the first
     * turn can only start on the branch the person chose. What is left to go wrong after the switch is the store itself. A switch that was made with something to tell (a failing
     * `post-checkout` hook, commits a detached HEAD left on no branch) gives it back as `warning`. A branch the checkout is on is the answer it already is, and no git changes anything.
     */
    'chat.create': async (services, command) => {
        const { store, runs, gitSwitch } = services;
        const choice = command.workspace;

        if (choice === undefined) {
            throw new Error('chat.create waits for git only with a workspace');
        }

        const project = requireProject(store, command.projectId);

        if (command.engine) {
            runs.resolveEngine(project, command.engine);
        }

        const folder = chatFolder(project, command.folderId);

        if (choice.mode !== 'main') {
            if (!existsSync(folder.path)) {
                throw invalid(`The folder ${folder.path} is missing`);
            }

            const repository = await readRepository(folder);

            return () => ({ chat: makeChat(services, command, repository) });
        }

        const { warning } = await gitSwitch.switch(project, resolvePlace(store, project, folder.id), {
            branch: choice.branch,
        });

        return () => ({ chat: makeChat(services, command), ...(warning !== undefined && { warning }) });
    },

    'chat.fork': (services, command) => prepareFork(services, command.chatId, command.itemId),

    'chat.edit': (services, command) =>
        prepareEdit(services, command.chatId, command.itemId, {
            text: command.text,
            attachmentIds: command.attachmentIds,
        }),

    'chat.delete': async ({ store, config, attachments }, command) => {
        await removeChatWorkspace(store, config, command.chatId);

        return () => {
            deleteChat(store, command.chatId, attachments);

            return { chatId: command.chatId };
        };
    },
};
