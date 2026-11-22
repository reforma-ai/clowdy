import { isClosedCategory, MAX_TASK_DEPTH } from '@clowdy/protocol';

import { chatIdsOfTask, insertChatTaskLink } from '../db/chats';
import { listStatuses } from '../db/projects';
import { takeTaskNumber } from '../db/projects';
import { insertRunTaskLink, linksOfTask } from '../db/runs';
import { childIdsOf, deleteTask as deleteTaskRow, dependenciesOf, dependentsOf, getTask, getTaskByNumber, listTasks, upsertTask } from '../db/tasks';
import { invalid, notFound } from '../errors';
import { newId } from '../ids';
import { requireChat } from './chats';
import { requireProject, requireStatus, statusOfCategory } from './projects';
import { TaskTree } from './taskTree';

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

/**
 * Validates the parent `parentId` for `task` (a task being made, or one being moved) and returns its id. The parent is a task of the same project, not
 * the task itself nor one of the tasks inside it (that would close a loop), and the tree stays within `MAX_TASK_DEPTH` levels counting the levels of the
 * task's own subtree, so moving an epic under a deep task is refused as one move.
 */
function checkParent(store: Store, task: Pick<Task, 'id' | 'key' | 'projectId'>, parentId: string): string {
    const parent = requireTask(store, parentId);

    if (parent.projectId !== task.projectId) {
        throw invalid(`Task ${ parent.key } belongs to another project`);
    }

    if (parent.id === task.id) {
        throw invalid(`Task ${ task.key } cannot be its own parent`);
    }

    const tree = new TaskTree(listTasks(store.db, task.projectId));

    if (tree.ancestorsOf(parent.id).some(ancestor => ancestor.id === task.id)) {
        throw invalid(`Task ${ parent.key } is inside ${ task.key }, so it cannot be its parent`);
    }

    const inside = tree.heightOf(task.id);
    const reach = tree.depthOf(parent.id) + 1 + inside;

    if (reach > MAX_TASK_DEPTH) {
        throw invalid(`Too deep: ${ task.key } under ${ parent.key } would reach level ${ reach }${ inside > 0 ? `, counting the ${ inside } level${ inside === 1 ? '' : 's' } of tasks inside it` : '' }, and a tree has at most ${ MAX_TASK_DEPTH } levels`);
    }

    return parent.id;
}

/** A title is what a person reads on a card: whitespace around it is dropped, and nothing but whitespace is refused. */
function cleanTitle(title: string): string {
    const trimmed = title.trim();

    if (!trimmed) {
        throw invalid('The task title cannot be empty');
    }

    return trimmed;
}

export interface NewTask {
    projectId: string;
    title: string;
    description?: string;
    statusId?: string;
    dependsOn?: string[];
    /** The id of the task this one is part of. */
    parentId?: string;
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

        const status = input.statusId ? requireStatus(store, project.id, input.statusId) : statusOfCategory(store, project.id, 'todo');
        const id = newId('tsk');
        const number = takeTaskNumber(store.db, project.id);
        const now = Date.now();
        const task: Task = {
            id,
            projectId: project.id,
            number,
            key: `${ project.taskPrefix }-${ number }`,
            title: cleanTitle(input.title),
            description: input.description ?? '',
            statusId: status.id,
            dependsOn: [],
            createdBy: input.createdBy,
            createdAt: now,
            updatedAt: now,
            ...(isClosedCategory(status.category) && { closedAt: now }),
        };

        task.dependsOn = checkDependencies(store, project.id, id, input.dependsOn ?? []);

        if (input.parentId !== undefined) {
            task.parentId = checkParent(store, task, input.parentId);
        }

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
    /** The id of the new parent; `null` makes the task a root; absent leaves it where it is. */
    parentId?: string | null;
}

export function updateTask(store: Store, taskId: string, patch: TaskPatch): Task {
    return store.tx(() => {
        const task = requireTask(store, taskId);
        const next: Task = {
            ...task,
            title: patch.title === undefined ? task.title : cleanTitle(patch.title),
            description: patch.description ?? task.description,
            statusId: patch.statusId ? requireStatus(store, task.projectId, patch.statusId).id : task.statusId,
            dependsOn: patch.dependsOn ? checkDependencies(store, task.projectId, task.id, patch.dependsOn) : task.dependsOn,
        };

        // A parent that does not change is not checked again: an edit of something else must not be refused for a tree that was fine when it was made.
        if (patch.parentId === null) {
            delete next.parentId;
        }
        else if (patch.parentId !== undefined && patch.parentId !== task.parentId) {
            next.parentId = checkParent(store, task, patch.parentId);
        }

        if (next.title === task.title && next.description === task.description && next.statusId === task.statusId
            && next.dependsOn.join() === task.dependsOn.join() && next.parentId === task.parentId) {
            return task;
        }

        const now = Date.now();

        // The closing time is when the task entered a closed status; a move between two closed ones (Done to Canceled) keeps it.
        if (!isClosedCategory(categoryOf(store, next))) {
            delete next.closedAt;
        }
        else if (!isClosedCategory(categoryOf(store, task))) {
            next.closedAt = now;
        }

        next.updatedAt = now;
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

/**
 * Removes the task with its links; tasks that depended on it lose that dependency, and the tasks inside it move up to its own parent (a root's become
 * roots), so the structure stays and no tree gets deeper. Its comments go with the row (foreign key cascade) and are announced by `task.deleted`
 * alone: they are not in the snapshot, so a client holds them only as the task's, and drops them with it.
 */
export function deleteTask(store: Store, taskId: string): void {
    store.tx(() => {
        const task = requireTask(store, taskId);
        const chatLinks: ChatTaskLink[] = chatIdsOfTask(store.db, taskId).map(chatId => ({ chatId, taskId }));
        const runLinks = linksOfTask(store.db, taskId);
        const now = Date.now();
        const changed = new Map<string, Task>();

        for (const id of dependentsOf(store.db, taskId)) {
            const dependent = requireTask(store, id);

            changed.set(id, { ...dependent, dependsOn: dependent.dependsOn.filter(dependencyId => dependencyId !== taskId), updatedAt: now });
        }

        for (const id of childIdsOf(store.db, taskId)) {
            const moved: Task = { ...changed.get(id) ?? requireTask(store, id), updatedAt: now };

            if (task.parentId === undefined) {
                delete moved.parentId;
            }
            else {
                moved.parentId = task.parentId;
            }

            changed.set(id, moved);
        }

        deleteTaskRow(store.db, taskId);

        for (const link of chatLinks) {
            store.emit(task.projectId, { type: 'link.chatTask', link, present: false });
        }

        for (const link of runLinks) {
            store.emit(task.projectId, { type: 'link.runTask', link, present: false });
        }

        for (const moved of changed.values()) {
            upsertTask(store.db, moved);
            store.emit(task.projectId, { type: 'task.upserted', task: moved });
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
