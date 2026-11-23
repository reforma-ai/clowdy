import { parseChecklist } from '@clowdy/lib/checklist';
import { isClosedCategory } from '@clowdy/protocol';

import { invalid } from '../errors';
import { sameArchiveSide, TaskTree } from './taskTree';

import type { Checklist } from '@clowdy/lib/checklist';
import type { Task, TaskStatus, TaskStatusCategory } from '@clowdy/protocol';

/** The categories of work in flight: what `task_list` shows when it is asked for nothing else. Backlog is parked, `done` and `canceled` are closed. */
export const OPEN_CATEGORIES: readonly TaskStatusCategory[] = ['todo', 'active', 'review'];

const CATEGORIES: readonly TaskStatusCategory[] = ['backlog', 'todo', 'active', 'review', 'done', 'canceled'];

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export type TaskSort = 'updated' | 'created' | 'number';

/** What a person or an agent asked a task listing for; `parentId`, `underId` and `roots` pick the structural scope, the other fields narrow what `scopeOf` picks. */
export interface TaskQuery {
    /** Only the tasks directly inside this task (an id). */
    parentId?: string;
    /** Only the tasks anywhere below this task (an id), its own children included. */
    underId?: string;
    /** Only the tasks that have no parent. */
    roots?: boolean;
    /** Text found in the key, title or description, in any case. */
    query?: string;
    /** The ids of the statuses to show, already resolved from the ids, names and categories the caller was given. */
    statusIds?: ReadonlySet<string>;
    /** Every task, closed and parked ones included. */
    all?: boolean;
    /**
     * The archive instead of the board: only archived tasks, whatever their status (what the other filters narrow, `status` included), where without it
     * archived tasks are in no listing at all. `parentId`, `underId` and `roots` then pick that part of the tree among the archived tasks.
     */
    archived?: boolean;
    /** Not closed, and every dependency closed (done or canceled). */
    ready?: boolean;
    /** Not closed, and some dependency not closed. */
    blocked?: boolean;
    /** A run works on it now. */
    running?: boolean;
    /** Linked to the chat that asks. */
    mine?: boolean;
    /** Changed at or after this time (epoch milliseconds). */
    updatedSince?: number;
    sort?: TaskSort;
    reverse?: boolean;
    limit?: number;
    cursor?: string;
}

/** What a listing reads besides the tasks: the project's statuses and the two facts that live outside a task row. */
export interface TaskQueryContext {
    /** Every task of the project, the archived ones too: a listing leaves them out itself, but a dependency or a parent on one is still named by its key. */
    tasks: readonly Task[];
    statuses: readonly TaskStatus[];
    isRunning(taskId: string): boolean;
    linkedToChat(taskId: string): boolean;
}

/** A task as a listing shows it: nothing that makes a row long, so a page of them stays small. */
export interface TaskRow {
    key: string;
    title: string;
    status: string;
    category: TaskStatusCategory;
    /** The key of the task this one is inside; absent for a root. */
    parent?: string;
    dependsOn: string[];
    /** The dependencies that are not closed yet; absent when there are none. */
    blockedBy?: string[];
    /** The tasks directly inside it, counted by category (only the categories that have any); absent when there are none. An archived task counts its archived tasks. */
    children?: CategoryCounts;
    /** The ticked and all `- [ ]` lines of its description; absent when it has none. */
    checklist?: Checklist;
    /** Present (true) when a run works on the task now. */
    running?: true;
    updatedAt: string;
    /** When the task was archived; only a listing of the archive has such rows. */
    archivedAt?: string;
}

/** A count by category, with only the categories that have any task. */
export type CategoryCounts = Partial<Record<TaskStatusCategory, number>>;

export interface TaskPage {
    tasks: TaskRow[];
    /** How many tasks matched, whatever the page holds. */
    total: number;
    shown: number;
    /** Passed as `cursor` it gives the next page; absent on the last one. */
    nextCursor?: string;
    /** Every task of the structural scope (the whole project when the query names none) by category: what a listing that hid closed or parked work did not show. */
    counts: Record<TaskStatusCategory, number>;
    /** How many tasks the project has in the archive, whatever the query asked for and whether it asked for them. */
    archived: number;
}

/** The ISO text of a time, to the second: a row's date is for reading. */
export const isoTime = (milliseconds: number) => new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z');

const DURATION = /^(\d+)\s*([mhdw])$/i;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

/** The time `since` names: a duration back from `now` (`90m`, `12h`, `7d`, `2w`), or an ISO date or time. */
export function parseSince(since: string, now = Date.now()): number {
    const text = since.trim();
    const duration = DURATION.exec(text);

    if (duration) {
        return now - Number(duration[1]) * UNIT_MS[duration[2].toLowerCase() as keyof typeof UNIT_MS];
    }

    const time = /^\d{4}-\d{2}-\d{2}/.test(text) ? Date.parse(text) : Number.NaN;

    if (Number.isNaN(time)) {
        throw invalid(
            `"${since}" is not a time: write an ISO date or time (2026-11-01, 2026-11-01T09:30:00Z) or a duration back from now (90m, 12h, 7d, 2w)`
        );
    }

    return time;
}

/** The categories a listing counts and the order it names them in. */
export const emptyCounts = (): Record<TaskStatusCategory, number> =>
    Object.fromEntries(CATEGORIES.map(category => [category, 0])) as Record<TaskStatusCategory, number>;

/** The categories counted, in the order a listing names them, leaving out the ones with no task. */
export function countByCategory(categories: Iterable<TaskStatusCategory>): CategoryCounts {
    const counts = emptyCounts();

    for (const category of categories) {
        counts[category]++;
    }

    return Object.fromEntries(
        CATEGORIES.filter(category => counts[category] > 0).map(category => [category, counts[category]])
    );
}

/** Where a task stands in a sort: the value it is ordered by, and its number, which settles a tie. */
interface Position {
    value: number;
    number: number;
}

const valueOf = (task: Task, sort: TaskSort) =>
    sort === 'updated' ? task.updatedAt : sort === 'created' ? task.createdAt : task.number;

/** Negative when `left` comes before `right`: `updated` and `created` go newest first, `number` goes up, and `reverse` turns that round. */
function compare(left: Position, right: Position, sort: TaskSort, reverse: boolean): number {
    const byValue = sort === 'number' ? left.value - right.value : right.value - left.value;
    const order = byValue === 0 ? left.number - right.number : byValue;

    return reverse ? -order : order;
}

/** A cursor names the last task of a page by its place in the sort, so tasks that change between pages neither repeat nor shift the rest. */
const encodeCursor = (position: Position) => `${position.value}.${position.number}`;

function decodeCursor(cursor: string): Position {
    const match = /^(\d+)\.(\d+)$/.exec(cursor);

    if (!match) {
        throw invalid(`"${cursor}" is not a cursor: pass the nextCursor of the previous page unchanged`);
    }

    return { value: Number(match[1]), number: Number(match[2]) };
}

/**
 * The scope a listing starts from, which the other filters narrow: a status filter is those statuses, the most specific ask; `all` is every task; a text
 * query is every task, so a check for duplicates finds closed work; with none of them it is the work in flight (`OPEN_CATEGORIES`), which hides the parked
 * and the closed. The archive holds closed work only, so a listing of it shows every status unless asked for some.
 */
function scopeOf(query: TaskQuery): (category: TaskStatusCategory, statusId: string) => boolean {
    const { statusIds } = query;

    if (statusIds) {
        return (_category, statusId) => statusIds.has(statusId);
    }

    if (query.all || query.archived) {
        return () => true;
    }

    if (query.query?.trim()) {
        return () => true;
    }

    return category => OPEN_CATEGORIES.includes(category);
}

/**
 * The tasks a listing starts from: those directly inside a task, all below it, the roots, or every task of the project; on the board, or in the archive when
 * the query asks for it. The tree is walked through every task, so a task that is on the board below an archived one (it cannot be made so, but the store
 * would hold it) is still found.
 */
function structuralScope(tree: TaskTree, tasks: readonly Task[], query: TaskQuery): readonly Task[] {
    const wanted = (task: Task) => (task.archivedAt !== undefined) === Boolean(query.archived);
    const byId = new Map(tasks.map(task => [task.id, task]));
    // In the archive a root is the top of an archived piece: a task with no parent, or one whose parent stays on the board (it was archived alone).
    const isRoot = (task: Task) =>
        task.parentId === undefined || (Boolean(query.archived) && byId.get(task.parentId)?.archivedAt === undefined);

    if (query.parentId !== undefined) {
        return tree.childrenOf(query.parentId).filter(wanted);
    }

    if (query.underId !== undefined) {
        return tree
            .descendantsOf(query.underId)
            .map(({ task }) => task)
            .filter(wanted);
    }

    return tasks.filter(task => wanted(task) && (!query.roots || isRoot(task)));
}

/** The tasks a listing shows, sorted, with the page `cursor` and `limit` ask for, and the counts of its structural scope. */
export function queryTasks(context: TaskQueryContext, query: TaskQuery): TaskPage {
    const sort = query.sort ?? 'updated';
    const reverse = query.reverse ?? false;
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    if (query.ready && query.blocked) {
        throw invalid('ready and blocked exclude each other: a task is one or the other');
    }

    if ([query.parentId !== undefined, query.underId !== undefined, query.roots].filter(Boolean).length > 1) {
        throw invalid('parent, under and roots each pick a different part of the tree: give one of them');
    }

    const { tasks, statuses } = context;
    const tree = new TaskTree(tasks);
    const byId = new Map(tasks.map(task => [task.id, task]));
    const statusById = new Map(statuses.map(status => [status.id, status]));
    const categoryOf = (task: Task): TaskStatusCategory => statusById.get(task.statusId)?.category ?? 'todo';
    const unfinished = (task: Task) =>
        task.dependsOn.filter(id => byId.has(id) && !isClosedCategory(categoryOf(byId.get(id) as Task)));
    const inScope = scopeOf(query);
    const text = query.query?.trim().toLowerCase();
    const scoped = structuralScope(tree, tasks, query);
    const counts = emptyCounts();

    for (const task of scoped) {
        counts[categoryOf(task)]++;
    }

    const archived = tasks.reduce((count, task) => count + (task.archivedAt === undefined ? 0 : 1), 0);
    const matching = scoped.filter(task => {
        const category = categoryOf(task);
        const open = !isClosedCategory(category);

        return (
            inScope(category, task.statusId) &&
            (!text || [task.key, task.title, task.description].some(field => field.toLowerCase().includes(text))) &&
            (query.updatedSince === undefined || task.updatedAt >= query.updatedSince) &&
            (!query.ready || (open && unfinished(task).length === 0)) &&
            (!query.blocked || (open && unfinished(task).length > 0)) &&
            (!query.mine || context.linkedToChat(task.id)) &&
            (!query.running || context.isRunning(task.id))
        );
    });
    const position = (task: Task): Position => ({ value: valueOf(task, sort), number: task.number });
    const ordered = matching.toSorted((left, right) => compare(position(left), position(right), sort, reverse));
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const rest = after ? ordered.filter(task => compare(position(task), after, sort, reverse) > 0) : ordered;
    const page = rest.slice(0, limit);
    const last = page.at(-1);

    return {
        tasks: page.map((task): TaskRow => {
            const blockedBy = unfinished(task).map(id => (byId.get(id) as Task).key);
            const category = categoryOf(task);
            const parent = tree.parentOf(task);
            const children = tree.childrenOf(task.id).filter(child => sameArchiveSide(child, task));
            const checklist = parseChecklist(task.description);

            return {
                key: task.key,
                title: task.title,
                status: statusById.get(task.statusId)?.name ?? category,
                category,
                ...(parent && { parent: parent.key }),
                dependsOn: task.dependsOn.flatMap(id => byId.get(id)?.key ?? []),
                ...(blockedBy.length > 0 && { blockedBy }),
                ...(children.length > 0 && { children: countByCategory(children.map(categoryOf)) }),
                ...(checklist && { checklist }),
                ...(context.isRunning(task.id) && { running: true as const }),
                updatedAt: isoTime(task.updatedAt),
                ...(task.archivedAt !== undefined && { archivedAt: isoTime(task.archivedAt) }),
            };
        }),
        total: matching.length,
        shown: page.length,
        ...(last && rest.length > page.length && { nextCursor: encodeCursor(position(last)) }),
        counts,
        archived,
    };
}
