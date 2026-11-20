import { projectChatMode } from '@clowdy/protocol';

import { choiceOf, createChat, saveChat, titleFrom } from '../domain/chats';
import { appendItem } from '../domain/items';
import { requireProject } from '../domain/projects';
import { createTask, deleteTask, linkChatTask, requireTask, updateTask } from '../domain/tasks';
import { CommandError } from '../errors';
import { firstMessage, taskMessage } from '../runs/prompts';
import { requireEnabled } from './chat';

import type { Handlers } from './context';

export const taskHandlers: Pick<Handlers, 'task.create' | 'task.update' | 'task.delete' | 'task.start'> = {
    'task.create': ({ store }, command) => ({ task: createTask(store, { ...command, createdBy: { kind: 'user' } }) }),

    'task.update': ({ store }, command) => ({ task: updateTask(store, command.taskId, command) }),

    'task.delete': ({ store }, command) => {
        deleteTask(store, command.taskId);

        return { taskId: command.taskId };
    },

    /**
     * Opens a new chat named after the task, linked to it, with an orchestrator assigned to the task (it waits while the task's dependencies are not Done)
     * whose first message is the task itself. One active run per task unless `force`: the run of a chat already started from it.
     */
    'task.start': ({ store, runs, driver, agents }, command) => {
        const task = requireTask(store, command.taskId);
        const project = requireProject(store, task.projectId);
        const [active] = runs.activeRunsOfTask(task.id);

        if (active && !command.force) {
            throw new CommandError('already_running', `Task ${ task.key } already has an active run (${ active.name })`);
        }

        requireEnabled(agents, runs.resolveEngine(project, command.engine));

        const title = titleFrom(task.title);
        const chat = createChat(store, { projectId: project.id, title, mode: projectChatMode(project.settings) });
        const text = taskMessage(task);
        const run = runs.createRun({
            project,
            role: 'orchestrator',
            chatId: chat.id,
            summary: title,
            engine: command.engine,
            assigned: [task],
            nextPrompt: firstMessage(chat.mode, text),
        });

        linkChatTask(store, project.id, { chatId: chat.id, taskId: task.id });
        appendItem(store, run.id, { kind: 'user', text });
        saveChat(store, { ...chat, ...choiceOf(run), orchestratorRunId: run.id });
        driver.launch(run.id);

        return { runId: run.id, chatId: chat.id };
    },
};
