import { z } from 'zod';

import { listStatuses } from '../db/projects';
import { linksOfRun } from '../db/runs';
import { getTask, listTasks } from '../db/tasks';
import { categoryOf, createTask, linkRunTask, resolveTask, updateTask } from '../domain/tasks';
import { clip, defineTool, taskRef } from './tool-kit';

import type { Run, Task, TaskStatus } from '@clowdy/protocol';
import type { ToolDefinition } from '../engine/types';
import type { Store } from '../store';
import type { ToolDeps } from './tool-kit';

/** `task_list` shows this much of each description; `task_get` has all of it. */
const LIST_DESCRIPTION_CHARS = 400;

const statusField = {
    statusId: z.string().optional().describe('The id of a status from task_list. A status name ("In progress") or category ("review") is accepted too.'),
    status: z.string().optional().describe('Same as statusId, written as a status name or category'),
};

/** Looks a status up by id, then by name, then by category (case-insensitive); the error lists what exists. */
export function resolveStatus(store: Store, projectId: string, value: string): TaskStatus {
    const statuses = listStatuses(store.db, projectId);
    const wanted = value.trim().toLowerCase();
    const found = statuses.find(status => status.id === value)
        ?? statuses.find(status => status.name.toLowerCase() === wanted)
        ?? statuses.find(status => status.category === wanted);

    if (!found) {
        throw new Error(`Unknown status "${ value }". Use the id of one of: ${ statuses.map(status => `${ status.id } (${ status.name }, ${ status.category })`).join('; ') }`);
    }

    return found;
}

/** The status a call asks for, if any. */
export function requestedStatus(store: Store, projectId: string, input: { statusId?: string; status?: string }): TaskStatus | undefined {
    const value = input.statusId ?? input.status;

    return value === undefined ? undefined : resolveStatus(store, projectId, value);
}

/** A task as the models read it: keys everywhere, the status spelled out, and who is working on it. */
export function describeTask({ store, runs }: ToolDeps, task: Task, descriptionChars?: number) {
    const status = listStatuses(store.db, task.projectId).find(candidate => candidate.id === task.statusId);

    return {
        id: task.id,
        key: task.key,
        title: task.title,
        description: descriptionChars === undefined ? task.description : clip(task.description, descriptionChars),
        statusId: task.statusId,
        status: status?.name,
        category: categoryOf(store, task),
        dependsOn: task.dependsOn.map(id => getTask(store.db, id)?.key ?? id),
        activeRuns: runs.activeRunsOfTask(task.id).map(run => ({ runId: run.id, name: run.name, role: run.role, status: run.status })),
    };
}

/** Adds a dated line under the task's `Notes` heading, the way the skills ask agents to leave a record. */
export function appendNote(description: string, role: string, note: string): string {
    const line = `${ new Date().toISOString().slice(0, 10) } (${ role }): ${ note.trim() }`;

    return /^## Notes$/m.test(description) ? `${ description.trimEnd() }\n${ line }` : `${ description.trimEnd() }${ description.trim() ? '\n\n' : '' }## Notes\n${ line }`;
}

/** The tools that read tasks; every run has them. */
export function readTaskTools(deps: ToolDeps, run: Run): ToolDefinition[] {
    const { store } = deps;

    return [
        defineTool('task_get', 'Reads one task: key, title, full description, status, the tasks it depends on and the runs working on it now.', z.object({ taskId: taskRef }), input => ({
            task: describeTask(deps, resolveTask(store, run.projectId, input.taskId)),
        })),

        defineTool('task_list', 'Lists the project\'s tasks (descriptions are cut short; task_get has the rest) and its statuses with their ids. Use `query` to find tasks about one thing before you create duplicates.', z.object({
            query: z.string().optional().describe('Only tasks whose key, title or description contain this text'),
            status: z.string().optional().describe('Only tasks in this status (an id, a name or a category)'),
        }), (input) => {
            const statuses = listStatuses(store.db, run.projectId);
            const wanted = input.status === undefined ? undefined : resolveStatus(store, run.projectId, input.status);
            const query = input.query?.trim().toLowerCase();
            const tasks = listTasks(store.db, run.projectId).filter(task => (
                (!wanted || task.statusId === wanted.id)
                && (!query || [task.key, task.title, task.description].some(text => text.toLowerCase().includes(query)))
            ));

            return { statuses, tasks: tasks.map(task => describeTask(deps, task, LIST_DESCRIPTION_CHARS)) };
        }),
    ];
}

/** What an orchestrator may do with tasks: create them, change anything about them. */
export function orchestratorTaskTools(deps: ToolDeps, run: Run): ToolDefinition[] {
    const { store } = deps;

    return [
        ...readTaskTools(deps, run),

        defineTool('task_create', 'Creates a task in the project, linked to this chat. Create dependencies first and pass their keys in dependsOn. Without a status the task starts in To do.', z.object({
            title: z.string().min(1).describe('The outcome in a few words'),
            description: z.string().optional().describe('Outcome, Owns, Needs, Check, Out of scope'),
            dependsOn: z.array(taskRef).optional().describe('Tasks that must be Done before this one can start'),
            ...statusField,
        }), input => store.tx(() => {
            const task = createTask(store, {
                projectId: run.projectId,
                title: input.title,
                description: input.description,
                statusId: requestedStatus(store, run.projectId, input)?.id,
                dependsOn: (input.dependsOn ?? []).map(reference => resolveTask(store, run.projectId, reference).id),
                createdBy: { kind: 'run', runId: run.id },
                chatId: run.chatId,
            });

            linkRunTask(store, run.projectId, { runId: run.id, taskId: task.id, relation: 'created' });

            return { task: describeTask(deps, task) };
        })),

        defineTool('task_update', 'Changes a task: title, description (send the whole text; read it first to keep what is there), dependencies, or status. Only you set Done, after the work is verified; a run waiting for this task starts by itself once it is Done.', z.object({
            taskId: taskRef,
            title: z.string().min(1).optional(),
            description: z.string().optional(),
            dependsOn: z.array(taskRef).optional().describe('The complete list of tasks this one depends on'),
            ...statusField,
        }), input => store.tx(() => {
            const task = resolveTask(store, run.projectId, input.taskId);
            const updated = updateTask(store, task.id, {
                title: input.title,
                description: input.description,
                statusId: requestedStatus(store, run.projectId, input)?.id,
                dependsOn: input.dependsOn?.map(reference => resolveTask(store, run.projectId, reference).id),
            });

            return { task: describeTask(deps, updated) };
        })),
    ];
}

/** Executors and verifiers change only the tasks they work on and may never mark them Done or Canceled. */
export function workerTaskTools(deps: ToolDeps, run: Run): ToolDefinition[] {
    const { store } = deps;

    return [
        ...readTaskTools(deps, run),

        defineTool('task_update', 'Changes one of your own tasks: its description (send the whole text, with your dated Notes entry added at the end; never remove the orchestrator\'s text) or its status, up to Review. You cannot set Done: only the orchestrator does that after verification.', z.object({
            taskId: taskRef,
            description: z.string().optional(),
            ...statusField,
        }), input => store.tx(() => {
            const task = ownTask(deps, run, input.taskId);
            const status = requestedStatus(store, run.projectId, input);

            if (status) {
                refuseFinalStatus(status);
            }

            return { task: describeTask(deps, updateTask(store, task.id, { description: input.description, statusId: status?.id })) };
        })),
    ];
}

export function ownTask({ store }: ToolDeps, run: Run, reference: string): Task {
    const task = resolveTask(store, run.projectId, reference);

    if (!linksOfRun(store.db, run.id).some(link => link.taskId === task.id)) {
        throw new Error(`Task ${ task.key } is not one of this run's tasks. You may change only the tasks you were given.`);
    }

    return task;
}

export function refuseFinalStatus(status: TaskStatus): void {
    if (status.category === 'done' || status.category === 'canceled') {
        throw new Error(`Only the orchestrator moves a task to ${ status.name }, after the work is verified. Move it to Review and say so in your report.`);
    }
}
