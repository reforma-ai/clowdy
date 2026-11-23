import { projectChatMode } from '@clowdy/protocol';

import { choiceOf, createChat, saveChat, titleFrom } from '../domain/chats';
import { appendItem } from '../domain/items';
import { requireProject } from '../domain/projects';
import { archiveTask, unarchiveTask } from '../domain/taskArchive';
import { addTaskComment, deleteTaskComment, editTaskComment } from '../domain/taskComments';
import { createTask, deleteTask, linkChatTask, requireNotArchived, requireTask, updateTask } from '../domain/tasks';
import { CommandError } from '../errors';
import { requireEnabled } from '../runs/messages';
import { firstMessage, taskMessage } from '../runs/prompts';

import type { Handlers } from './context';

export const taskHandlers: Pick<
    Handlers,
    | 'task.create'
    | 'task.update'
    | 'task.delete'
    | 'task.archive'
    | 'task.unarchive'
    | 'task.start'
    | 'task.comment.add'
    | 'task.comment.edit'
    | 'task.comment.delete'
> = {
    'task.create': ({ store }, command) => ({ task: createTask(store, { ...command, createdBy: { kind: 'user' } }) }),

    'task.update': ({ store }, command) => ({ task: updateTask(store, command.taskId, command) }),

    'task.delete': ({ store }, command) => {
        deleteTask(store, command.taskId);

        return { taskId: command.taskId };
    },

    'task.archive': ({ store, runs }, command) => {
        const { task, archived, canceled } = archiveTask(store, runs, command.taskId, { cancel: command.cancel });

        return { task, archived: archived.map(entry => entry.id), canceled: canceled.map(entry => entry.id) };
    },

    'task.unarchive': ({ store }, command) => {
        const { task, restored } = unarchiveTask(store, command.taskId);

        return { task, restored: restored.map(entry => entry.id) };
    },

    /**
     * Opens a new chat named after the task, linked to it, with an orchestrator assigned to the task (it waits while the task's dependencies are not closed, Done or Canceled)
     * whose first message is the task itself. One active run per task unless `force`: the run of a chat already started from it. An archived task is
     * refused: it comes back first.
     */
    'task.start': ({ store, runs, driver, agents }, command) => {
        const task = requireTask(store, command.taskId);

        requireNotArchived(task);

        const project = requireProject(store, task.projectId);
        const [active] = runs.activeRunsOfTask(task.id);

        if (active && !command.force) {
            throw new CommandError('already_running', `Task ${task.key} already has an active run (${active.name})`);
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

    // A command comes from the person's app, so the comment is the person's; an agent leaves its own through the `task_comment` tool.
    'task.comment.add': ({ store }, command) => ({
        comment: addTaskComment(store, { taskId: command.taskId, author: { kind: 'user' }, body: command.body }),
    }),

    'task.comment.edit': ({ store }, command) => ({
        comment: editTaskComment(store, command.taskId, command.commentId, command.body),
    }),

    'task.comment.delete': ({ store }, command) => {
        deleteTaskComment(store, command.taskId, command.commentId);

        return { taskId: command.taskId, commentId: command.commentId };
    },
};
