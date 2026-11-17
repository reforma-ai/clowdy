import { listArtifactsOfTask } from '../db/artifacts';
import { chatIdsOfTask, listChats, listChatTaskLinks } from '../db/chats';
import { listProjects, listStatuses } from '../db/projects';
import { listRuns, listRunTaskLinks, runIdsOfTask } from '../db/runs';
import { listTasks } from '../db/tasks';
import { requireProject } from './projects';
import { requireTask } from './tasks';

import type { ProjectSnapshot, RootSnapshot, TaskDetail } from '@clowdy/protocol';
import type { Store } from '../store';

/** The cursor and the state are read in one transaction, so a client resuming at `cursor` misses and repeats nothing. */
export function rootSnapshot(store: Store): RootSnapshot {
    return store.read(() => ({ cursor: store.headCursor(), projects: listProjects(store.db) }));
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

export function taskDetail(store: Store, taskId: string): TaskDetail {
    return store.read(() => {
        requireTask(store, taskId);

        return {
            taskId,
            chatIds: chatIdsOfTask(store.db, taskId),
            runIds: runIdsOfTask(store.db, taskId),
            artifacts: listArtifactsOfTask(store.db, taskId),
        };
    });
}
