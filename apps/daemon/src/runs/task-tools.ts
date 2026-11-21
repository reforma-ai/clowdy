import { z } from 'zod';

import { taskIdsOfChat } from '../db/chats';
import { listStatuses } from '../db/projects';
import { dependentsOf, getTask, listTasks } from '../db/tasks';
import { DEFAULT_LIMIT, isoTime, MAX_LIMIT, parseSince, queryTasks } from '../domain/taskQuery';
import { categoryOf, createTask, linkRunTask, resolveTask, updateTask } from '../domain/tasks';
import { invalid } from '../errors';
import { defineTool, taskRef } from './tool-kit';

import type { Actor, Run, Task, TaskStatus } from '@clowdy/protocol';
import type { ToolDefinition } from '../engine/types';
import type { Store } from '../store';
import type { ToolDeps } from './tool-kit';

const CATEGORIES = 'backlog, todo, active, review, done, canceled';

const statusField = z.string().optional().describe(`A status: its id, its name ("In progress") or its category (${ CATEGORIES }). task_list shows the project's statuses`);

/** Looks a status up by id, then by name, then by category (case-insensitive); the error lists what exists. */
export function resolveStatus(store: Store, projectId: string, value: string): TaskStatus {
    const statuses = listStatuses(store.db, projectId);
    const wanted = value.trim().toLowerCase();
    const found = statuses.find(candidate => candidate.id === value)
        ?? statuses.find(candidate => candidate.name.toLowerCase() === wanted)
        ?? statuses.find(candidate => candidate.category === wanted);

    if (!found) {
        throw new Error(`Unknown status "${ value }". Use the id of one of: ${ statuses.map(candidate => `${ candidate.id } (${ candidate.name }, ${ candidate.category })`).join('; ') }`);
    }

    return found;
}

/** The statuses a filter value names: one by its id or name, every status of the category when it names a category. */
function statusesNamed(store: Store, projectId: string, value: string): TaskStatus[] {
    const found = resolveStatus(store, projectId, value);
    const exact = found.id === value || found.name.toLowerCase() === value.trim().toLowerCase();

    return exact ? [found] : listStatuses(store.db, projectId).filter(candidate => candidate.category === found.category);
}

const authorOf = (actor: Actor) => (actor.kind === 'user' ? 'user' : actor.kind === 'run' ? 'agent' : actor.provider);

/**
 * A task as the models read it: keys everywhere, the status spelled out, what it waits for and what waits for it (each as key, title and status), and who
 * is working on it. The description is whole; a listing leaves it out (`TaskRow`).
 */
export function describeTask({ store, runs }: ToolDeps, task: Task) {
    const statuses = listStatuses(store.db, task.projectId);
    const statusName = (of: Task) => statuses.find(candidate => candidate.id === of.statusId)?.name;
    const summaries = (ids: string[]) => ids.flatMap(id => getTask(store.db, id) ?? []).map(related => ({ key: related.key, title: related.title, status: statusName(related) }));

    return {
        id: task.id,
        key: task.key,
        title: task.title,
        description: task.description,
        status: statusName(task),
        category: categoryOf(store, task),
        dependsOn: summaries(task.dependsOn),
        blocks: summaries(dependentsOf(store.db, task.id)),
        activeRuns: runs.activeRunsOfTask(task.id).map(run => ({ runId: run.id, name: run.name, role: run.role, status: run.status })),
        createdBy: authorOf(task.createdBy),
        createdAt: isoTime(task.createdAt),
        updatedAt: isoTime(task.updatedAt),
    };
}

/** The tools that read tasks. */
function readTaskTools(deps: ToolDeps, run: Run): ToolDefinition[] {
    const { store, runs } = deps;

    return [
        defineTool('task_get', 'Reads one task: key, title, full description, status, the tasks it depends on and the tasks waiting for it (key, title, status), the runs working on it now, who created it and when it last changed.', z.strictObject({ taskId: taskRef }), input => ({
            task: describeTask(deps, resolveTask(store, run.projectId, input.taskId)),
        }), { cli: { positional: ['taskId'] } }),

        defineTool('task_list', `Lists the project's tasks, one short row each (key, title, status, dependencies, what blocks it, whether a run works on it); task_get has the description. By default it shows the work in flight (todo, active and review), not the backlog and not closed (done, canceled) work: the counts of every category come with the answer, so ask for the rest when you need it. A text query searches every task, closed ones too: use it to find tasks about one thing before you create duplicates. Pages hold ${ DEFAULT_LIMIT } rows unless limit says otherwise (at most ${ MAX_LIMIT }); the answer carries nextCursor while more are left. Newest change first. The first page also lists the project's statuses with their ids.`, z.strictObject({
            query: z.string().optional().describe('Only tasks whose key, title or description contain this text; searches closed tasks too'),
            status: z.array(z.string()).optional().describe(`Only tasks in these statuses; each is an id, a status name or a category (${ CATEGORIES })`),
            all: z.boolean().optional().describe('Every task: backlog and closed ones as well (a status filter wins over it)'),
            ready: z.boolean().optional().describe('Only tasks that can start now: not closed, every dependency done'),
            blocked: z.boolean().optional().describe('Only tasks that wait for another: not closed, a dependency not done'),
            running: z.boolean().optional().describe('Only tasks a run is working on now'),
            mine: z.boolean().optional().describe('Only tasks linked to this chat: the ones it created and the one it was started from'),
            updatedSince: z.string().optional().describe('Only tasks changed since an ISO date or time (2026-11-01) or a duration back from now (90m, 12h, 7d, 2w)'),
            sort: z.enum(['updated', 'created', 'number']).optional().describe('updated (default) and created put the newest first; number goes up from the first task'),
            reverse: z.boolean().optional().describe('Turn the order round'),
            limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`How many rows, 1 to ${ MAX_LIMIT }; default ${ DEFAULT_LIMIT }`),
            cursor: z.string().optional().describe('The nextCursor of the previous page, to get the next one'),
        }), (input) => {
            const statuses = listStatuses(store.db, run.projectId);
            const mine = new Set(run.chatId ? taskIdsOfChat(store.db, run.chatId) : []);
            const page = queryTasks({
                tasks: listTasks(store.db, run.projectId),
                statuses,
                isRunning: taskId => runs.activeRunsOfTask(taskId).length > 0,
                linkedToChat: taskId => mine.has(taskId),
            }, {
                ...input,
                statusIds: input.status?.length ? new Set(input.status.flatMap(value => statusesNamed(store, run.projectId, value).map(status => status.id))) : undefined,
                updatedSince: input.updatedSince === undefined ? undefined : parseSince(input.updatedSince),
            });

            return { ...page, ...(input.cursor === undefined && { statuses }) };
        }, { cli: {} }),
    ];
}

/** The ids of the tasks `references` name, in the project of `run`. */
const idsOf = (store: Store, run: Run, references: string[] | undefined) => (references ?? []).map(reference => resolveTask(store, run.projectId, reference).id);

/** The dependency list a `task_update` asks for: the whole new one, or the old one with some taken off and some put on; `undefined` when the call leaves it alone. */
function dependenciesAfter(store: Store, run: Run, task: Task, input: { dependsOn?: string[]; addDependsOn?: string[]; removeDependsOn?: string[] }): string[] | undefined {
    if (input.dependsOn !== undefined) {
        return idsOf(store, run, input.dependsOn);
    }

    if (input.addDependsOn === undefined && input.removeDependsOn === undefined) {
        return undefined;
    }

    const removed = new Set(idsOf(store, run, input.removeDependsOn));

    return [...task.dependsOn.filter(id => !removed.has(id)), ...idsOf(store, run, input.addDependsOn)];
}

/** `note` after a blank line at the end of `description`; a description with nothing in it is replaced by the note. */
const appended = (description: string, note: string) => (description.trim() ? `${ description.trimEnd() }\n\n${ note }` : note);

/** What an orchestrator may do with tasks: create them, change anything about them. */
export function orchestratorTaskTools(deps: ToolDeps, run: Run): ToolDefinition[] {
    const { store } = deps;

    return [
        ...readTaskTools(deps, run),

        defineTool('task_create', 'Creates a task in the project, linked to this chat. Create the tasks it depends on first. It can also make existing tasks wait for the new one. Without a status the task starts in To do.', z.strictObject({
            title: z.string().min(1).describe('The outcome in a few words'),
            description: z.string().optional().describe('Outcome, Owns, Needs, Check, Out of scope'),
            dependsOn: z.array(taskRef).optional().describe('Tasks that must be Done before this one can start'),
            blocks: z.array(taskRef).optional().describe('Existing tasks that depend on the new one: each one waits until it is Done'),
            status: statusField,
        }), input => store.tx(() => {
            const task = createTask(store, {
                projectId: run.projectId,
                title: input.title,
                description: input.description,
                statusId: input.status === undefined ? undefined : resolveStatus(store, run.projectId, input.status).id,
                dependsOn: idsOf(store, run, input.dependsOn),
                createdBy: { kind: 'run', runId: run.id },
                chatId: run.chatId,
            });

            linkRunTask(store, run.projectId, { runId: run.id, taskId: task.id, relation: 'created' });

            for (const reference of input.blocks ?? []) {
                const waiting = resolveTask(store, run.projectId, reference);

                updateTask(store, waiting.id, { dependsOn: [...waiting.dependsOn, task.id] });
            }

            return { task: describeTask(deps, task) };
        }), { cli: { positional: ['title'] } }),

        defineTool('task_update', 'Changes a task: its title, its description (replaced, or added to at the end), the tasks it depends on (replaced, or added to and taken from) or its status. Set Done only after the work is verified; a run waiting for this task starts by itself once it is Done.', z.strictObject({
            taskId: taskRef,
            title: z.string().min(1).optional(),
            description: z.string().optional().describe('The whole new text; read the task first to keep what is there, or use append'),
            append: z.string().trim().min(1).optional().describe('Text added at the end of the description after a blank line: for notes, a check report, an assumption'),
            dependsOn: z.array(taskRef).optional().describe('The complete list of tasks this one depends on'),
            addDependsOn: z.array(taskRef).optional().describe('Tasks to add to the ones this task depends on'),
            removeDependsOn: z.array(taskRef).optional().describe('Tasks to take off the ones this task depends on'),
            status: statusField,
        }), input => store.tx(() => {
            if (input.description !== undefined && input.append !== undefined) {
                throw invalid('description replaces the text and append adds to it: give one of them');
            }

            if (input.dependsOn !== undefined && (input.addDependsOn !== undefined || input.removeDependsOn !== undefined)) {
                throw invalid('dependsOn is the whole list; do not combine it with addDependsOn or removeDependsOn');
            }

            const task = resolveTask(store, run.projectId, input.taskId);
            const updated = updateTask(store, task.id, {
                title: input.title,
                description: input.append === undefined ? input.description : appended(task.description, input.append),
                statusId: input.status === undefined ? undefined : resolveStatus(store, run.projectId, input.status).id,
                dependsOn: dependenciesAfter(store, run, task, input),
            });

            return { task: describeTask(deps, updated) };
        }), { cli: { positional: ['taskId'] } }),
    ];
}
