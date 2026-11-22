import { parseChecklist } from '@clowdy/lib/checklist';
import { MAX_TASK_DEPTH } from '@clowdy/protocol';
import { z } from 'zod';

import { taskIdsOfChat } from '../db/chats';
import { listStatuses } from '../db/projects';
import { countTaskComments, latestTaskComments } from '../db/taskComments';
import { childIdsOf, dependentsOf, getTask, listAllTasks } from '../db/tasks';
import { archiveTask, unarchiveTask } from '../domain/taskArchive';
import { addTaskComment, taskCommentsPage } from '../domain/taskComments';
import { countByCategory, DEFAULT_LIMIT, isoTime, MAX_LIMIT, parseSince, queryTasks } from '../domain/taskQuery';
import { categoryOf, createTask, linkRunTask, resolveTask, updateTask } from '../domain/tasks';
import { sameArchiveSide, TaskTree } from '../domain/taskTree';
import { invalid } from '../errors';
import { clip, defineTool, taskRef } from './tool-kit';

import type { Actor, Run, Task, TaskComment, TaskStatus } from '@clowdy/protocol';
import type { ToolDefinition } from '../engine/types';
import type { Store } from '../store';
import type { ToolDeps } from './tool-kit';

const CATEGORIES = 'backlog, todo, active, review, done, canceled';

/** The most children `task_get` names: an epic with hundreds of them would fill the model's context, and `childrenTotal` says how many there are. */
const MAX_CHILDREN = 50;

/** How many comments `task_get` shows, the newest ones, and how many characters of each: `task_comments` reads the rest, whole. */
const LATEST_COMMENTS = 3;
const COMMENT_PREVIEW_CHARS = 300;

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

/** A comment as the models read it; `preview` cuts a long body short, for the few `task_get` shows beside the task. */
function describeComment(comment: TaskComment, preview = false) {
    return {
        id: comment.id,
        author: authorOf(comment.author),
        createdAt: isoTime(comment.createdAt),
        ...(comment.editedAt !== undefined && { editedAt: isoTime(comment.editedAt) }),
        body: preview ? clip(comment.body, COMMENT_PREVIEW_CHARS) : comment.body,
    };
}

/** How many comments the task has and the latest ones, cut short; nothing for a task with none, so it reads as before. */
function commentsOf(store: Store, task: Task) {
    const total = countTaskComments(store.db, task.id);

    return total === 0 ? {} : { commentCount: total, latestComments: latestTaskComments(store.db, task.id, LATEST_COMMENTS).map(comment => describeComment(comment, true)) };
}

/**
 * What a task holds, as `describeTask` tells it: the tasks directly inside it as key, title and status (at most `MAX_CHILDREN`, with their total), and
 * every task below it counted by category. Nothing for a task with no children, so a leaf reads as before. Archived tasks are not counted for a task on
 * the board, and an archived task holds the archived tasks inside it.
 */
function contents(store: Store, task: Task, statuses: readonly TaskStatus[]) {
    if (childIdsOf(store.db, task.id).length === 0) {
        return {};
    }

    const tree = new TaskTree(listAllTasks(store.db, task.projectId));
    const children = tree.childrenOf(task.id).filter(child => sameArchiveSide(child, task));
    const statusOf = (of: Task) => statuses.find(candidate => candidate.id === of.statusId);

    if (children.length === 0) {
        return {};
    }

    return {
        children: children.slice(0, MAX_CHILDREN).map(child => ({ key: child.key, title: child.title, status: statusOf(child)?.name })),
        childrenTotal: children.length,
        descendants: countByCategory(tree.descendantsOf(task.id).filter(({ task: below }) => sameArchiveSide(below, task)).map(({ task: below }) => statusOf(below)?.category ?? 'todo')),
    };
}

/**
 * A task as the models read it: keys everywhere, the status spelled out, what it waits for and what waits for it (each as key, title and status), the task
 * it is inside and the tasks inside it, whether it is archived, and who is working on it. The description is whole; a listing leaves it out (`TaskRow`).
 */
export function describeTask({ store, runs }: ToolDeps, task: Task) {
    const statuses = listStatuses(store.db, task.projectId);
    const statusName = (of: Task) => statuses.find(candidate => candidate.id === of.statusId)?.name;
    const summaries = (ids: string[]) => ids.flatMap(id => getTask(store.db, id) ?? []).map(related => ({ key: related.key, title: related.title, status: statusName(related) }));
    const parent = task.parentId === undefined ? undefined : getTask(store.db, task.parentId);
    const checklist = parseChecklist(task.description);

    return {
        id: task.id,
        key: task.key,
        title: task.title,
        description: task.description,
        ...(checklist && { checklist }),
        status: statusName(task),
        category: categoryOf(store, task),
        ...(task.archivedAt !== undefined && { archived: true as const, archivedAt: isoTime(task.archivedAt) }),
        ...(parent && { parent: { key: parent.key, title: parent.title } }),
        dependsOn: summaries(task.dependsOn),
        blocks: summaries(dependentsOf(store.db, task.id)),
        ...contents(store, task, statuses),
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
        defineTool('task_get', 'Reads one task, an archived one too (it says archived: true and when): key, title, full description (with its checklist count), status, the task it is inside, the tasks inside it (key, title, status; at most 50, with the total, and the tasks below it counted by category), the tasks it depends on and the tasks waiting for it (key, title, status), the runs working on it now, who created it and when it last changed, and its comments (how many, and the last three cut short: task_comments reads them whole).', z.strictObject({ taskId: taskRef }), (input) => {
            const task = resolveTask(store, run.projectId, input.taskId);

            return { task: { ...describeTask(deps, task), ...commentsOf(store, task) } };
        }, { cli: { positional: ['taskId'] } }),

        defineTool('task_list', `Lists the project's tasks, one short row each (key, title, status, the task it is inside, dependencies, what blocks it, how many tasks are inside it by category, its checklist count, whether a run works on it); task_get has the description. parent, under and roots each list one part of the tree (give only one of them), and the counts then describe that part. By default it shows the work in flight (todo, active and review), not the backlog and not closed (done, canceled) work: the counts of every category come with the answer, so ask for the rest when you need it. A text query searches every task, closed ones too: use it to find tasks about one thing before you create duplicates. Archived tasks are in none of these: archived lists only them, whatever their status (query, status and the tree filters narrow that listing), and the answer's archived is how many the project has in its archive. Pages hold ${ DEFAULT_LIMIT } rows unless limit says otherwise (at most ${ MAX_LIMIT }); the answer carries nextCursor while more are left. Newest change first. The first page also lists the project's statuses with their ids.`, z.strictObject({
            query: z.string().optional().describe('Only tasks whose key, title or description contain this text; searches closed tasks too'),
            parent: taskRef.optional().describe('Only the tasks directly inside this task'),
            under: taskRef.optional().describe('Only the tasks anywhere below this task: its children, theirs, and so on'),
            roots: z.boolean().optional().describe('Only the top-level tasks, the ones inside no task (with archived: the tops of the archived pieces, also a task archived alone out of a task that stayed)'),
            archived: z.boolean().optional().describe('Only the archived tasks, instead of the tasks on the board: closed work that was put away, found by key and restored with task_unarchive'),
            status: z.array(z.string()).optional().describe(`Only tasks in these statuses; each is an id, a status name or a category (${ CATEGORIES })`),
            all: z.boolean().optional().describe('Every task: backlog and closed ones as well (a status filter wins over it)'),
            ready: z.boolean().optional().describe('Only tasks that can start now: not closed, every dependency closed (done or canceled)'),
            blocked: z.boolean().optional().describe('Only tasks that wait for another: not closed, a dependency not closed'),
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
                tasks: listAllTasks(store.db, run.projectId),
                statuses,
                isRunning: taskId => runs.activeRunsOfTask(taskId).length > 0,
                linkedToChat: taskId => mine.has(taskId),
            }, {
                ...input,
                parentId: input.parent === undefined ? undefined : resolveTask(store, run.projectId, input.parent).id,
                underId: input.under === undefined ? undefined : resolveTask(store, run.projectId, input.under).id,
                statusIds: input.status?.length ? new Set(input.status.flatMap(value => statusesNamed(store, run.projectId, value).map(status => status.id))) : undefined,
                updatedSince: input.updatedSince === undefined ? undefined : parseSince(input.updatedSince),
            });

            return { ...page, ...(input.cursor === undefined && { statuses }) };
        }, { cli: {} }),

        defineTool('task_comments', `Lists the comments on a task, oldest first: each has its id, who wrote it, when it was written (and edited), and its full text. task_get shows only the last three, cut short. Pages hold ${ DEFAULT_LIMIT } comments unless limit says otherwise (at most ${ MAX_LIMIT }); the answer carries total, and nextCursor while more are left.`, z.strictObject({
            taskId: taskRef,
            limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`How many comments, 1 to ${ MAX_LIMIT }; default ${ DEFAULT_LIMIT }`),
            cursor: z.string().optional().describe('The nextCursor of the previous page, to get the next one'),
        }), (input) => {
            const page = taskCommentsPage(store, resolveTask(store, run.projectId, input.taskId).id, input);

            return { comments: page.comments.map(comment => describeComment(comment)), total: page.total, shown: page.shown, ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }) };
        }, { cli: { positional: ['taskId'] } }),
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

/** The tasks `references` name, each once, those nearest the root first: a task given with one inside it then takes it into its own archive batch, whatever the order of the words. */
function shallowFirst(store: Store, run: Run, references: string[]): Task[] {
    const tasks = [...new Map(references.map(reference => resolveTask(store, run.projectId, reference)).map(task => [task.id, task])).values()];
    const tree = new TaskTree(listAllTasks(store.db, run.projectId));

    return tasks.toSorted((left, right) => tree.depthOf(left.id) - tree.depthOf(right.id));
}

/** What an orchestrator may do with tasks: create them, change anything about them. */
export function orchestratorTaskTools(deps: ToolDeps, run: Run): ToolDefinition[] {
    const { store } = deps;

    return [
        ...readTaskTools(deps, run),

        defineTool('task_create', 'Creates a task in the project, linked to this chat. Create the tasks it depends on first. It can also make existing tasks wait for the new one, and put the new task inside another one. Without a status the task starts in To do.', z.strictObject({
            title: z.string().min(1).describe('The outcome in a few words'),
            description: z.string().optional().describe('Outcome, Owns, Needs, Check, Out of scope'),
            dependsOn: z.array(taskRef).optional().describe('Tasks that must be closed (Done or Canceled) before this one can start'),
            blocks: z.array(taskRef).optional().describe('Existing tasks that depend on the new one: each one waits until it is closed (Done or Canceled)'),
            parent: taskRef.optional().describe(`The task the new one is part of, such as the epic a stage belongs to; tasks nest up to ${ MAX_TASK_DEPTH } levels`),
            status: statusField,
        }), input => store.tx(() => {
            const task = createTask(store, {
                projectId: run.projectId,
                title: input.title,
                description: input.description,
                statusId: input.status === undefined ? undefined : resolveStatus(store, run.projectId, input.status).id,
                dependsOn: idsOf(store, run, input.dependsOn),
                parentId: input.parent === undefined ? undefined : resolveTask(store, run.projectId, input.parent).id,
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

        defineTool('task_update', 'Changes a task: its title, its description (replaced whole), the tasks it depends on (replaced, or added to and taken from), its status, or the task it is inside. A note goes in a comment (task_comment), not in the description. Set Done only after the work is verified; a run waiting for this task starts by itself once it is Done or Canceled.', z.strictObject({
            taskId: taskRef,
            title: z.string().min(1).optional(),
            description: z.string().optional().describe('The whole new text; read the task first to keep what is there'),
            dependsOn: z.array(taskRef).optional().describe('The complete list of tasks this one depends on'),
            addDependsOn: z.array(taskRef).optional().describe('Tasks to add to the ones this task depends on'),
            removeDependsOn: z.array(taskRef).optional().describe('Tasks to take off the ones this task depends on'),
            parent: taskRef.optional().describe(`Move the task, with the tasks inside it, under this task; tasks nest up to ${ MAX_TASK_DEPTH } levels`),
            clearParent: z.boolean().optional().describe('Make the task a top-level task again, inside no task (not together with parent)'),
            status: statusField,
        }), input => store.tx(() => {
            if (input.dependsOn !== undefined && (input.addDependsOn !== undefined || input.removeDependsOn !== undefined)) {
                throw invalid('dependsOn is the whole list; do not combine it with addDependsOn or removeDependsOn');
            }

            if (input.parent !== undefined && input.clearParent) {
                throw invalid('parent moves the task under another task and clearParent makes it a top-level task: give one of them');
            }

            const task = resolveTask(store, run.projectId, input.taskId);
            const updated = updateTask(store, task.id, {
                title: input.title,
                description: input.description,
                statusId: input.status === undefined ? undefined : resolveStatus(store, run.projectId, input.status).id,
                dependsOn: dependenciesAfter(store, run, task, input),
                parentId: input.clearParent ? null : input.parent === undefined ? undefined : resolveTask(store, run.projectId, input.parent).id,
            });

            return { task: describeTask(deps, updated) };
        }), { cli: { positional: ['taskId'] } }),

        defineTool('task_comment', 'Adds a comment to a task: a note for whoever reads the task next, the person included, such as what you found, what you decided or how a check went. Markdown. A comment keeps its place and its author; the description is not touched. task_comments reads them back. Returns the comment and how many the task has now.', z.strictObject({
            taskId: taskRef,
            body: z.string().describe('The comment, in Markdown'),
        }), (input) => {
            const task = resolveTask(store, run.projectId, input.taskId);
            const comment = addTaskComment(store, { taskId: task.id, author: { kind: 'run', runId: run.id }, body: input.body });

            return { comment: describeComment(comment), total: countTaskComments(store.db, task.id) };
        }, { cli: { positional: ['taskId', 'body'], stdin: 'body' } }),

        defineTool('task_archive', 'Archives closed tasks, each with every task inside it: the batch leaves the board and every listing (task_list archived lists it, task_get still reads it by key) and task_unarchive brings it back. Only closed tasks (Done, Canceled) are archived: a task that is open, or has an open task inside it, is refused, unless cancel is set, which first moves the open ones to Canceled (the tasks that waited for them are released, as when you cancel by hand) and archives them with the rest. A task a run is working on, or one inside it, is refused whatever cancel says: stop that run first (your own run does not count). Several tasks go in one call, all of them or none. Returns the keys archived (the tasks inside included) and, when cancel closed some, the keys it canceled.', z.strictObject({
            taskId: z.array(taskRef).min(1).describe('The tasks to archive, each by key; the tasks inside each one go with it'),
            cancel: z.boolean().optional().describe('Cancel the open tasks among them first, then archive; without it an open task refuses the archive'),
        }), input => store.tx(() => {
            const archived: Task[] = [];
            const canceled: Task[] = [];

            for (const task of shallowFirst(store, run, input.taskId)) {
                const result = archiveTask(store, deps.runs, task.id, { cancel: input.cancel, exceptRunId: run.id });

                archived.push(...result.archived);
                canceled.push(...result.canceled);
            }

            return { archived: archived.map(task => task.key), ...(canceled.length > 0 && { canceled: canceled.map(task => task.key) }) };
        }), { cli: { positional: ['taskId'] } }),

        defineTool('task_unarchive', 'Brings archived tasks back to the board, each with the tasks inside it that were archived together with it (one archived on its own earlier stays archived). A task whose parent is archived is refused: restore the parent first. Several tasks go in one call, all of them or none. Returns the keys restored; a task that is not archived changes nothing.', z.strictObject({
            taskId: z.array(taskRef).min(1).describe('The archived tasks to bring back, each by key; the tasks archived with each one come with it'),
        }), input => store.tx(() => {
            const restored: Task[] = [];

            for (const task of shallowFirst(store, run, input.taskId)) {
                restored.push(...unarchiveTask(store, task.id).restored);
            }

            return { restored: restored.map(task => task.key) };
        }), { cli: { positional: ['taskId'] } }),
    ];
}
