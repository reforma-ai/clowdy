import { homedir } from 'node:os';

import { readBranchPrefix, readDelegation } from '../db/appSettings';
import { listArtifactsOfTask } from '../db/artifacts';
import { chatIdsOfTask, listChats, listChatTaskLinks } from '../db/chats';
import { listProjects, listStatuses } from '../db/projects';
import { listRuns, listRunTaskLinks, runIdsOfTask } from '../db/runs';
import { listTasks } from '../db/tasks';
import { notFound } from '../errors';
import { requireProject } from './projects';
import { findTaskByKey, requireTask } from './tasks';

import type { ProjectSnapshot, RootSnapshot, Task, TaskDetail } from '@clowdy/protocol';
import type { Store } from '../store';

/** The cursor and the state are read in one transaction, so a client resuming at `cursor` misses and repeats nothing. */
export function rootSnapshot(store: Store): RootSnapshot {
    return store.read(() => ({
        cursor: store.headCursor(),
        projects: listProjects(store.db),
        home: homedir(),
        branchPrefix: readBranchPrefix(store.db),
        delegation: readDelegation(store.db),
    }));
}

export function projectSnapshot(store: Store, projectId: string): ProjectSnapshot {
    return store.read(() => ({
        cursor: store.headCursor(),
        project: requireProject(store, projectId),
        statuses: listStatuses(store.db, projectId),
        chats: listChats(store.db, projectId),
        tasks: listTasks(store.db, projectId),
        runs: listRuns(store.db, projectId),
        chatTaskLinks: listChatTaskLinks(store.db, projectId),
        runTaskLinks: listRunTaskLinks(store.db, projectId),
    }));
}

/** A task with its chats, runs and artifacts. The task is read whether or not it is archived: the snapshot has no archived tasks, and this is how a client opens one. */
export function taskDetail(store: Store, taskId: string): TaskDetail {
    return store.read(() => detailOf(store, requireTask(store, taskId)));
}

/**
 * `taskDetail` for the task a key such as `CAR-12` names in the project, the archived one too: how a client reads a task it met as a key in a message, with no id to ask
 * for. `not_found` for a project that does not exist and for anything that is not a key of that project (`findTaskByKey`), never `invalid`: a client reads it as "no such task".
 */
export function taskDetailByKey(store: Store, projectId: string, key: string): TaskDetail {
    return store.read(() => {
        const task = findTaskByKey(store, requireProject(store, projectId), key);

        if (!task) {
            throw notFound('Task', key);
        }

        return detailOf(store, task);
    });
}

function detailOf(store: Store, task: Task): TaskDetail {
    return {
        taskId: task.id,
        task,
        chatIds: chatIdsOfTask(store.db, task.id),
        runIds: runIdsOfTask(store.db, task.id),
        artifacts: listArtifactsOfTask(store.db, task.id),
    };
}
