import { isClosedCategory } from '@clowdy/protocol';

import { listStatuses } from '../db/projects';
import { countArchivedTasks, latestArchiveTime, listAllTasks, listArchivedTasks, upsertTask } from '../db/tasks';
import { conflict, invalid } from '../errors';
import { requireProject, statusOfCategory } from './projects';
import { DEFAULT_LIMIT, MAX_LIMIT } from './taskQuery';
import { requireTask } from './tasks';
import { TaskTree } from './taskTree';

import type { Task } from '@clowdy/protocol';
import type { ArchivePosition } from '../db/tasks';
import type { Store } from '../store';

/** What archiving asks of the runs: the runs working on a task now. `RunService` is one. */
export interface RunLookup {
    activeRunsOfTask(taskId: string, exceptRunId?: string): readonly { name: string }[];
}

export interface ArchiveOptions {
    /** Close the open work along with the archive: the task and every open task inside it go to the project's first Canceled status first. */
    cancel?: boolean;
    /** The run that asks, an agent archiving the task it works on: its own work on a task does not stop the archive, since it cannot stop itself first. */
    exceptRunId?: string;
}

export interface Archived {
    /** The task that was asked for, as it is now. */
    task: Task;
    /** Every task that went into the archive with this call, as they are now: the task first, then those inside it. Empty when the task was archived already. */
    archived: Task[];
    /** The tasks among them that `cancel` moved to Canceled. */
    canceled: Task[];
}

/** The most tasks a refusal names; the rest are counted. */
const MAX_NAMED = 5;

/**
 * Archives the task with every task inside it that is not archived yet, all with one `archivedAt`, so restoring the task brings back exactly this batch. The
 * batch must be at rest and closed: a task with a run working on it, or one inside it, refuses the whole archive (`conflict`, whatever `cancel` says), and
 * an open task refuses it (`invalid`) unless `cancel` moves it to Canceled, in the same write that archives it, so a client sees one `task.upserted` per task
 * with its final state. Nothing else is touched: `updatedAt` keeps the place of a task that was already closed, and dependencies stay as they are (a closed
 * task has released its dependents already). A task inside the batch that was archived earlier on its own keeps its own `archivedAt`. Archiving a task that
 * is archived changes nothing.
 */
export function archiveTask(store: Store, runs: RunLookup, taskId: string, options: ArchiveOptions = {}): Archived {
    return store.tx(() => {
        const task = requireTask(store, taskId);

        if (task.archivedAt !== undefined) {
            return { task, archived: [], canceled: [] };
        }

        const tree = new TaskTree(listAllTasks(store.db, task.projectId));
        const batch = [task, ...tree.descendantsOf(task.id).map(({ task: below }) => below).filter(below => below.archivedAt === undefined)];

        for (const member of batch) {
            const [active] = runs.activeRunsOfTask(member.id, options.exceptRunId);

            if (active) {
                throw conflict(`Task ${ member.key }${ member.id === task.id ? '' : `, inside ${ task.key },` } has an active run (${ active.name }): stop it first`);
            }
        }

        const statuses = listStatuses(store.db, task.projectId);
        const statusOf = (member: Task) => statuses.find(candidate => candidate.id === member.statusId);
        const open = batch.filter(member => !isClosedCategory(statusOf(member)?.category ?? 'todo'));

        if (open.length > 0 && !options.cancel) {
            const named = open.slice(0, MAX_NAMED).map(member => `${ member.key } (${ statusOf(member)?.name ?? 'To do' })`).join(', ');
            const more = open.length > MAX_NAMED ? ` and ${ open.length - MAX_NAMED } more` : '';

            throw invalid(`${ named }${ more } ${ open.length === 1 ? 'is' : 'are' } not closed: close ${ open.length === 1 ? 'it' : 'them' } first, or archive with cancel`);
        }

        const now = Date.now();
        // One batch, one time: a later batch never takes the value of an earlier one, whatever the clock says, so a restore cannot pick up a neighbour.
        const archivedAt = Math.max(now, latestArchiveTime(store.db, task.projectId) + 1);
        const canceledStatus = open.length > 0 ? statusOfCategory(store, task.projectId, 'canceled') : undefined;
        const archived: Task[] = [];
        const canceled: Task[] = [];

        for (const member of batch) {
            const wasOpen = open.includes(member);
            const next: Task = { ...member, archivedAt, ...(wasOpen && canceledStatus && { statusId: canceledStatus.id, closedAt: now, updatedAt: now }) };

            upsertTask(store.db, next);
            store.emit(next.projectId, { type: 'task.upserted', task: next });
            archived.push(next);

            if (wasOpen) {
                canceled.push(next);
            }
        }

        return { task: archived[0], archived, canceled };
    });
}

export interface Unarchived {
    /** The task that was asked for, as it is now. */
    task: Task;
    /** Every task that came back, as they are now: the task first, then those inside it. Empty when the task was not archived. */
    restored: Task[];
}

/**
 * The task and the tasks below it that carry its `archivedAt`, each reached through tasks that carry it too: one archive batch. A task with the same value
 * that was moved under another archived task since is not part of it, so a restore never leaves a task on the board under a parent that stays archived.
 */
function batchOf(tree: TaskTree, task: Task): Task[] {
    const batch = [task];
    const seen = new Set([task.id]);

    for (const member of batch) {
        for (const child of tree.childrenOf(member.id)) {
            if (child.archivedAt === task.archivedAt && !seen.has(child.id)) {
                seen.add(child.id);
                batch.push(child);
            }
        }
    }

    return batch;
}

/**
 * Brings the task back with the tasks inside it that carry its `archivedAt`, the ones archived with it; one that was archived on its own, earlier or later,
 * stays archived. It is refused (`invalid`) while the task's parent is archived: the task would be on the board under a parent that is off it, so the
 * parent comes back first (which brings this task along when they were archived together). Restoring a task that is not archived changes nothing.
 */
export function unarchiveTask(store: Store, taskId: string): Unarchived {
    return store.tx(() => {
        const task = requireTask(store, taskId);

        if (task.archivedAt === undefined) {
            return { task, restored: [] };
        }

        const tree = new TaskTree(listAllTasks(store.db, task.projectId));
        const parent = tree.parentOf(task);

        if (parent?.archivedAt !== undefined) {
            throw invalid(`Task ${ task.key } is inside ${ parent.key }, which is archived: restore ${ parent.key } first`);
        }

        const restored = batchOf(tree, task).map((member): Task => {
            const { archivedAt: _, ...rest } = member;

            upsertTask(store.db, rest);
            store.emit(rest.projectId, { type: 'task.upserted', task: rest });

            return rest;
        });

        return { task: restored[0], restored };
    });
}

/** A cursor names the last task of a page by its place in the archive's order, so tasks that are archived or restored between pages neither repeat nor shift the rest. */
const encodeCursor = (task: Task) => `${ task.archivedAt }.${ task.number }`;

function decodeCursor(cursor: string): ArchivePosition {
    const match = /^(\d+)\.(\d+)$/.exec(cursor);

    if (!match) {
        throw invalid(`"${ cursor }" is not a cursor: pass the nextCursor of the previous page unchanged`);
    }

    return { archivedAt: Number(match[1]), number: Number(match[2]) };
}

export interface ArchiveQuery {
    /** How many tasks, 1 to `MAX_LIMIT`; `DEFAULT_LIMIT` when absent. */
    limit?: number;
    /** The `nextCursor` of the previous page. */
    cursor?: string;
}

export interface ArchivePage {
    tasks: Task[];
    /** How many tasks the project has in the archive, whatever the page holds. */
    total: number;
    nextCursor?: string;
}

/** One page of the project's archived tasks, the latest archived first and the tasks of one batch by number, read in one transaction so `total` and the page agree. */
export function archivedTasksPage(store: Store, projectId: string, query: ArchiveQuery = {}): ArchivePage {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);

    return store.read(() => {
        requireProject(store, projectId);

        // One more than the page holds says whether another page follows without a second query.
        const found = listArchivedTasks(store.db, projectId, limit + 1, after);
        const tasks = found.slice(0, limit);
        const last = tasks.at(-1);

        return { tasks, total: countArchivedTasks(store.db, projectId), ...(last && found.length > limit && { nextCursor: encodeCursor(last) }) };
    });
}
