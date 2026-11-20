import { isTerminalRunStatus } from '@clowdy/protocol';

import type { Actor, Artifact, Chat, Run, RunId, RunTaskLink, Task, TaskExternalRef, TaskId, TaskStatus } from '@clowdy/protocol';
import type { StatusTone } from '../../shared';
import type { TasksView } from '../../stores';

/* ---------------------------------- Runs ---------------------------------- */

const byCreatedAt = (a: Run, b: Run) => a.createdAt - b.createdAt || a.id.localeCompare(b.id);

/**
 * Every task's assigned runs (the orchestrators of the chats working on it), oldest first. A run that only created the task is not listed, and a run
 * assigned twice to one task is listed once.
 */
export function runsByTask(links: Iterable<RunTaskLink>, runs: ReadonlyMap<RunId, Run>): Map<TaskId, Run[]> {
    const byTask = new Map<TaskId, Map<RunId, Run>>();

    for (const { runId, taskId, relation } of links) {
        const run = runs.get(runId);

        if (!run || relation !== 'assigned') continue;

        byTask.set(taskId, (byTask.get(taskId) ?? new Map<RunId, Run>()).set(runId, run));
    }

    return new Map([...byTask].map(([taskId, taskRuns]) => [taskId, [...taskRuns.values()].sort(byCreatedAt)]));
}

/** The runs executing the task right now: what a card shows and what blocks another start. */
export function activeExecutors(taskRuns: readonly Run[] = []): Run[] {
    return taskRuns.filter(run => !isTerminalRunStatus(run.status));
}

/** Why "Start" is unavailable, or `null` when it is. The daemon allows one executing run per task. */
export function startBlockedReason(taskRuns: readonly Run[] = []): string | null {
    const active = activeExecutors(taskRuns);

    if (active.length === 0) return null;

    return active.length === 1 ? `${ active[0].name } is already working on this task.` : `${ active.length } agents are already working on this task.`;
}

/* --------------------------------- Filters -------------------------------- */

export interface TaskFilter {
    query: string;
    /** Empty means every status. */
    statusIds: string[];
    /** Empty means any agent; otherwise a task needs a run among these. */
    runIds: RunId[];
}

export const NO_FILTER: TaskFilter = { query: '', statusIds: [], runIds: [] };

/** How many of the popover's facets (status, agent) are narrowing the list. The search box is not one of them. */
export function facetCount(filter: TaskFilter): number {
    return Number(filter.statusIds.length > 0) + Number(filter.runIds.length > 0);
}

export function isFiltering(filter: TaskFilter): boolean {
    return facetCount(filter) > 0 || filter.query.trim() !== '';
}

export function filterTasks(tasks: readonly Task[], filter: TaskFilter, runsOfTask: ReadonlyMap<TaskId, readonly Run[]>): Task[] {
    const query = filter.query.trim().toLowerCase();

    return tasks.filter((task) => {
        if (query && !`${ task.key } ${ task.title } ${ task.description }`.toLowerCase().includes(query)) return false;

        if (filter.statusIds.length > 0 && !filter.statusIds.includes(task.statusId)) return false;

        return filter.runIds.length === 0 || (runsOfTask.get(task.id) ?? []).some(run => filter.runIds.includes(run.id));
    });
}

/** The runs a person may filter by: those linked to some task, the working ones first. */
export function agentOptions(runsOfTask: ReadonlyMap<TaskId, readonly Run[]>): Run[] {
    const runs = new Map<RunId, Run>();

    for (const taskRuns of runsOfTask.values()) for (const run of taskRuns) runs.set(run.id, run);

    const rank = (run: Run) => (isTerminalRunStatus(run.status) ? 1 : 0);

    return [...runs.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'en', { numeric: true }));
}

export function groupByStatus(tasks: readonly Task[]): Map<string, Task[]> {
    const groups = new Map<string, Task[]>();

    for (const task of tasks) groups.set(task.statusId, [...groups.get(task.statusId) ?? [], task]);

    return groups;
}

/** The board's columns: a column per status in workflow order, with the tasks of that status. A task whose status is gone sits in none. */
export function boardColumns(statuses: readonly TaskStatus[], tasks: readonly Task[]): { status: TaskStatus; tasks: Task[] }[] {
    const byStatus = groupByStatus(tasks);

    return statuses.map(status => ({ status, tasks: byStatus.get(status.id) ?? [] }));
}

/**
 * The ids the cursor walks, in the order the view draws them: the board's columns in workflow order, or the list's one column in the order it is given.
 * `tasks` is what the view shows, in task order.
 */
export function taskGrid(view: TasksView, tasks: readonly Task[], statuses: readonly TaskStatus[]): TaskId[][] {
    if (view === 'board') return boardColumns(statuses, tasks).map(column => column.tasks.map(task => task.id));

    return [tasks.map(task => task.id)];
}

/* ------------------------------- Dependencies ------------------------------ */

/**
 * The tasks `taskId` may still depend on: not itself, not one it already depends on, and none that would close a
 * loop (a task that depends on it, directly or through others). Without `taskId` (a task not created yet) only
 * `taken` is left out.
 */
export function dependencyCandidates(tasks: readonly Task[], { taskId, taken }: { taskId?: TaskId; taken: readonly TaskId[] }): Task[] {
    const dependents = new Set<TaskId>(taskId ? [taskId] : []);
    let grew = taskId !== undefined;

    while (grew) {
        grew = false;

        for (const task of tasks) {
            if (!dependents.has(task.id) && task.dependsOn.some(id => dependents.has(id))) {
                dependents.add(task.id);
                grew = true;
            }
        }
    }

    return tasks.filter(task => !dependents.has(task.id) && !taken.includes(task.id));
}

/**
 * The tasks that may still start to depend on `taskId`: not itself, none that already does, and none it depends on,
 * directly or through others, because that would close a loop the other way round.
 */
export function blockingCandidates(tasks: readonly Task[], { taskId }: { taskId: TaskId }): Task[] {
    const byId = new Map(tasks.map(task => [task.id, task]));
    const upstream = new Set<TaskId>();
    const pending = [...byId.get(taskId)?.dependsOn ?? []];

    for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
        if (upstream.has(id)) continue;

        upstream.add(id);
        pending.push(...byId.get(id)?.dependsOn ?? []);
    }

    return tasks.filter(task => task.id !== taskId && !upstream.has(task.id) && !task.dependsOn.includes(taskId));
}

/** What the "blocked by" picker lists for a task: the tasks it depends on (to remove) and those it may still depend on (to add), in task order. */
export function blockedByOptions(tasks: readonly Task[], task: Pick<Task, 'id' | 'dependsOn'>): Task[] {
    const listed = new Set([...task.dependsOn, ...dependencyCandidates(tasks, { taskId: task.id, taken: task.dependsOn }).map(({ id }) => id)]);

    return tasks.filter(({ id }) => listed.has(id));
}

/** What the "blocking" picker lists for a task: the tasks that depend on it (to remove) and those that may start to (to add), in task order. */
export function blockingOptions(tasks: readonly Task[], task: Pick<Task, 'id'>): Task[] {
    const listed = new Set([...tasks.filter(({ dependsOn }) => dependsOn.includes(task.id)), ...blockingCandidates(tasks, { taskId: task.id })].map(({ id }) => id));

    return tasks.filter(({ id }) => listed.has(id));
}

/** The dependency list with `id` taken out when it is there and added at the end when it is not. `task.update` replaces the whole list, so this is what to send. */
export function toggleDependency(dependsOn: readonly TaskId[], id: TaskId): TaskId[] {
    return dependsOn.includes(id) ? dependsOn.filter(candidate => candidate !== id) : [...dependsOn, id];
}

/* --------------------------------- Statuses -------------------------------- */

/** The status one step along the workflow from `statusId`, or nothing at either end and for a status the workflow no longer has. */
export function adjacentStatus(statuses: readonly TaskStatus[], statusId: string, step: 1 | -1): TaskStatus | undefined {
    const index = statuses.findIndex(status => status.id === statusId);

    return index < 0 ? undefined : statuses[index + step];
}

/* --------------------------------- Sources -------------------------------- */

const PROVIDER_NAMES: Record<string, string> = { linear: 'Linear' };

export function providerName(provider: string): string {
    return PROVIDER_NAMES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** Where the list comes from: `Internal`, `Internal + Linear` when some tasks are mirrored, `Linear` when all are. */
export function tasksSource(tasks: readonly Pick<Task, 'external'>[]): string {
    const providers = [...new Set(tasks.flatMap(task => (task.external ? [providerName(task.external.provider)] : [])))];

    if (providers.length === 0) return 'Internal';

    return (tasks.every(task => task.external) ? providers : ['Internal', ...providers]).join(' + ');
}

/** The task in its provider, for "Open in Linear". Only web addresses: a provider's link is data, not a command. */
export function externalLink(external: TaskExternalRef | undefined): { label: string; url: string } | null {
    if (!external?.url || !/^https?:\/\//i.test(external.url)) return null;

    return { label: providerName(external.provider), url: external.url };
}

/* --------------------------------- Activity -------------------------------- */

export interface Activity {
    id: string;
    at: number;
    text: string;
    /** More about the event: a run's report or error. */
    detail?: string;
    /** The run that did it, when a run did. */
    run?: Run;
}

const FINISHED_TEXT: Record<string, string> = {
    succeeded: 'finished',
    failed: 'failed',
    cancelled: 'was cancelled',
    interrupted: 'was interrupted',
};

function createdText(actor: Actor, creator: Run | undefined): string {
    switch (actor.kind) {
        case 'user':
            return 'You created the task';
        case 'run':
            return `${ creator?.name ?? 'An agent' } created the task`;
        case 'provider':
            return `Imported from ${ providerName(actor.provider) }`;
    }
}

/** What happened to the task, newest first, derived from the task and the runs on it. */
export function taskActivity(task: Task, taskRuns: readonly Run[], runsById: ReadonlyMap<RunId, Run>, limit = 5): Activity[] {
    const activity: Activity[] = [];
    const creator = task.createdBy.kind === 'run' ? runsById.get(task.createdBy.runId) : undefined;

    activity.push({ id: 'created', at: task.createdAt, text: createdText(task.createdBy, creator), run: creator });

    if (task.updatedAt - task.createdAt > 1000) activity.push({ id: 'updated', at: task.updatedAt, text: 'Task updated' });

    for (const run of taskRuns) {
        if (run.startedAt === undefined) {
            activity.push({ id: `${ run.id }:queued`, at: run.createdAt, text: `${ run.name } is waiting to start`, run });
        }
        else {
            activity.push({ id: `${ run.id }:started`, at: run.startedAt, text: `${ run.name } started working`, run });
        }

        if (run.finishedAt !== undefined && FINISHED_TEXT[run.status]) {
            activity.push({ id: `${ run.id }:finished`, at: run.finishedAt, text: `${ run.name } ${ FINISHED_TEXT[run.status] }`, detail: run.error ?? run.result, run });
        }
    }

    return activity.sort((a, b) => b.at - a.at).slice(0, limit);
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const calendar = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });

/** `just now`, `2 minutes ago`, `yesterday`, then the date once it is a week old. */
export function formatAgo(at: number, now: number): string {
    const minutes = Math.round((now - at) / 60_000);

    if (minutes < 1) return 'just now';

    if (minutes < 60) return relative.format(-minutes, 'minute');

    const hours = Math.round(minutes / 60);

    if (hours < 24) return relative.format(-hours, 'hour');

    const days = Math.round(hours / 24);

    return days < 7 ? relative.format(-days, 'day') : calendar.format(at);
}

/* --------------------------------- Results --------------------------------- */

export interface ResultRow {
    id: string;
    kind: Artifact['kind'];
    title: string;
    /** Smaller text after the title: the change size, the commit. */
    meta?: string;
    /** A pill for rows that have a verdict. */
    verdict?: { label: string; tone: StatusTone };
    /** A document the row opens. */
    docPath?: string;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const count = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

function artifactRow(artifact: Artifact): ResultRow {
    const { id, kind, title, ref } = artifact;
    const row: ResultRow = { id, kind, title };

    if (kind === 'diff') {
        const added = count(ref.added);
        const removed = count(ref.removed);

        if (added !== undefined || removed !== undefined) row.meta = `+${ added ?? 0 } −${ removed ?? 0 }`;
    }
    else if (kind === 'commit') {
        row.meta = text(ref.sha)?.slice(0, 7);
    }
    else if (kind === 'check') {
        const exitCode = count(ref.exitCode);

        row.verdict = exitCode === undefined ? { label: 'Waiting', tone: 'warning' } : exitCode === 0 ? { label: 'Passed', tone: 'success' } : { label: 'Failed', tone: 'danger' };
    }
    else if (kind === 'doc') {
        row.docPath = text(ref.path);
    }
    else {
        row.meta = text(ref.path);
    }

    return row;
}

/**
 * The task's results, newest first. While an agent works and no check has reported, a "Checks" row says they
 * are still to come.
 */
export function resultRows(artifacts: readonly Artifact[], { expectChecks }: { expectChecks: boolean }): ResultRow[] {
    const rows = [...artifacts].sort((a, b) => b.createdAt - a.createdAt).map(artifactRow);

    if (expectChecks && !artifacts.some(artifact => artifact.kind === 'check')) {
        rows.push({ id: 'checks-waiting', kind: 'check', title: 'Checks', verdict: { label: 'Waiting', tone: 'warning' } });
    }

    return rows;
}

/** The path of the document the task produced last, which is the first document row of `resultRows`. A document artifact that names no file is not one. */
export function newestDocPath(artifacts: readonly Artifact[]): string | null {
    return resultRows(artifacts, { expectChecks: false }).find(row => row.docPath)?.docPath ?? null;
}

/** The chat that was active last among the chats that discuss a task. */
export function newestChat<T extends Pick<Chat, 'updatedAt'>>(chats: readonly T[]): T | undefined {
    return chats.reduce<T | undefined>((newest, chat) => (newest === undefined || chat.updatedAt > newest.updatedAt ? chat : newest), undefined);
}

/** The id of the task a `task.create` answered with. The daemon answers `{ task }`, the fixture daemon the task itself. */
export function createdTaskId(data: unknown): TaskId | undefined {
    const task = data && typeof data === 'object' && 'task' in data ? data.task : data;

    return task && typeof task === 'object' && 'id' in task && typeof task.id === 'string' ? task.id : undefined;
}
