import { chatIdsOfTask, insertChatTaskLink } from '../db/chats';
import { listStatuses } from '../db/projects';
import { takeTaskNumber } from '../db/projects';
import { insertRunTaskLink, linksOfTask } from '../db/runs';
import { deleteTask as deleteTaskRow, dependenciesOf, dependentsOf, getTask, getTaskByNumber, upsertTask } from '../db/tasks';
import { invalid, notFound } from '../errors';
import { newId } from '../ids';
import { requireChat } from './chats';
import { requireProject, requireStatus, statusOfCategory } from './projects';

import type { Actor, ChatTaskLink, RunTaskLink, Task, TaskStatusCategory } from '@clowdy/protocol';
import type { Store } from '../store';

export function requireTask(store: Store, taskId: string): Task {
    const task = getTask(store.db, taskId);

    if (!task) {
        throw notFound('Task', taskId);
    }

    return task;
}

/** Accepts a task id or a key such as `CLW-12` within the project; the orchestrator sees keys. */
export function resolveTask(store: Store, projectId: string, reference: string): Task {
    const byId = getTask(store.db, reference);

    if (byId) {
        if (byId.projectId !== projectId) {
            throw invalid(`Task ${ reference } belongs to another project`);
        }

        return byId;
    }

    const project = requireProject(store, projectId);
    const match = /^(.+)-(\d+)$/.exec(reference);
    const byKey = match && match[1].toUpperCase() === project.taskPrefix ? getTaskByNumber(store.db, projectId, Number(match[2])) : undefined;

    if (!byKey) {
        throw notFound('Task', reference);
    }

    return byKey;
}

/** Whether `taskId` already depends on any of `dependencies`, directly or through other tasks. */
function createsCycle(store: Store, taskId: string, dependencies: string[]): boolean {
    const seen = new Set<string>();
    const stack = [...dependencies];

    while (stack.length > 0) {
        const current = stack.pop() as string;

        if (current === taskId) {
            return true;
        }

        if (!seen.has(current)) {
            seen.add(current);
            stack.push(...dependenciesOf(store.db, current));
        }
    }

    return false;
}

/** Validates a dependency list: tasks of the same project, no repeats, no cycle through `taskId`. */
function checkDependencies(store: Store, projectId: string, taskId: string, references: string[]): string[] {
    const ids = [...new Set(references)];

    for (const id of ids) {
        const dependency = requireTask(store, id);

        if (dependency.projectId !== projectId) {
            throw invalid(`Task ${ dependency.key } belongs to another project`);
        }

        if (createsCycle(store, taskId, [id])) {
            throw invalid(`Circular dependency: the task would depend on ${ dependency.key }, which already depends on it`);
        }
    }

    return ids;
}

export interface NewTask {
    projectId: string;
    title: string;
    description?: string;
    statusId?: string;
    dependsOn?: string[];
    createdBy: Actor;
    /** The chat to link the task to. */
    chatId?: string;
}

export function createTask(store: Store, input: NewTask): Task {
    return store.tx(() => {
        const project = requireProject(store, input.projectId);
        const chat = input.chatId ? requireChat(store, input.chatId) : undefined;

        if (chat && chat.projectId !== project.id) {
            throw invalid('The chat belongs to another project');
        }

        const statusId = input.statusId ? requireStatus(store, project.id, input.statusId).id : statusOfCategory(store, project.id, 'todo').id;
        const id = newId('tsk');
        const number = takeTaskNumber(store.db, project.id);
        const now = Date.now();
        const task: Task = {
            id,
            projectId: project.id,
            number,
            key: `${ project.taskPrefix }-${ number }`,
            title: input.title.trim(),
            description: input.description ?? '',
            statusId,
            dependsOn: [],
            createdBy: input.createdBy,
            createdAt: now,
            updatedAt: now,
        };

        task.dependsOn = checkDependencies(store, project.id, id, input.dependsOn ?? []);
        upsertTask(store.db, task);
        store.emit(project.id, { type: 'task.upserted', task });

        if (chat) {
            linkChatTask(store, project.id, { chatId: chat.id, taskId: id });
        }

        return task;
    });
}

export interface TaskPatch {
    title?: string;
    description?: string;
    statusId?: string;
    dependsOn?: string[];
}

export function updateTask(store: Store, taskId: string, patch: TaskPatch): Task {
    return store.tx(() => {
        const task = requireTask(store, taskId);
        const next: Task = {
            ...task,
            title: patch.title?.trim() ?? task.title,
            description: patch.description ?? task.description,
            statusId: patch.statusId ? requireStatus(store, task.projectId, patch.statusId).id : task.statusId,
            dependsOn: patch.dependsOn ? checkDependencies(store, task.projectId, task.id, patch.dependsOn) : task.dependsOn,
        };

        if (next.title === task.title && next.description === task.description && next.statusId === task.statusId
            && next.dependsOn.join() === task.dependsOn.join()) {
            return task;
        }

        next.updatedAt = Date.now();
        upsertTask(store.db, next);
        store.emit(task.projectId, { type: 'task.upserted', task: next });

        return next;
    });
}

/** Moves a task to the project's first status of `category` (logic moving a task, not a person choosing a column). */
export function moveTask(store: Store, taskId: string, category: TaskStatusCategory): Task {
    return store.tx(() => updateTask(store, taskId, { statusId: statusOfCategory(store, requireTask(store, taskId).projectId, category).id }));
}

export function categoryOf(store: Store, task: Task): TaskStatusCategory {
    const status = listStatuses(store.db, task.projectId).find(candidate => candidate.id === task.statusId);

    return status?.category ?? 'todo';
}

/** Removes the task with its links; tasks that depended on it lose that dependency. */
export function deleteTask(store: Store, taskId: string): void {
    store.tx(() => {
        const task = requireTask(store, taskId);
        const chatLinks: ChatTaskLink[] = chatIdsOfTask(store.db, taskId).map(chatId => ({ chatId, taskId }));
        const runLinks = linksOfTask(store.db, taskId);
        const dependents = dependentsOf(store.db, taskId).map((id) => {
            const dependent = requireTask(store, id);

            return { ...dependent, dependsOn: dependent.dependsOn.filter(dependencyId => dependencyId !== taskId), updatedAt: Date.now() };
        });

        deleteTaskRow(store.db, taskId);

        for (const link of chatLinks) {
            store.emit(task.projectId, { type: 'link.chatTask', link, present: false });
        }

        for (const link of runLinks) {
            store.emit(task.projectId, { type: 'link.runTask', link, present: false });
        }

        for (const dependent of dependents) {
            upsertTask(store.db, dependent);
            store.emit(task.projectId, { type: 'task.upserted', task: dependent });
        }

        store.emit(task.projectId, { type: 'task.deleted', taskId });
    });
}

export function linkChatTask(store: Store, projectId: string, link: ChatTaskLink): void {
    store.tx(() => {
        if (insertChatTaskLink(store.db, link)) {
            store.emit(projectId, { type: 'link.chatTask', link, present: true });
        }
    });
}

export function linkRunTask(store: Store, projectId: string, link: RunTaskLink): void {
    store.tx(() => {
        if (insertRunTaskLink(store.db, link)) {
            store.emit(projectId, { type: 'link.runTask', link, present: true });
        }
    });
}
