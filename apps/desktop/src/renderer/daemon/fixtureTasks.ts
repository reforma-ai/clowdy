import { ACTIVE_RUN_STATUSES, isClosedCategory, MAX_TASK_DEPTH } from '@clowdy/protocol';

import { DEFAULT_STATUSES, type FixtureData } from './fixtureData';
import { fail, type Outcome, ok } from './fixtureOutcome';
import { type CommandInput, type PageQuery, TransportError } from './transport';

import type {
    Chat,
    ErrorCode,
    EventData,
    Project,
    ProjectId,
    Task,
    TaskArchivePage,
    TaskComment,
    TaskCommentsPage,
    TaskId,
    TaskStatus,
    TaskStatusCategory,
} from '@clowdy/protocol';

/*
 * The task rules of the daemon (`apps/daemon/src/domain/tasks.ts`, `taskTree.ts`, `taskArchive.ts`, `taskComments.ts`) over the fixture's data: the same checks in the
 * same order, the same messages, the same events in the same order, so a screen that works against the fixture meets what the real daemon would answer.
 * It is a model written beside the daemon's code, not a copy of it, so a rule that moves there has to be moved here by hand.
 */

type Command<T extends CommandInput['type']> = Extract<CommandInput, { type: T }>;

/** What the daemon's domain throws when a caller's request cannot be done: the protocol's code and a message that names the reason. */
class Refusal extends Error {
    constructor(
        readonly code: ErrorCode,
        message: string
    ) {
        super(message);
    }
}

const invalid = (message: string) => new Refusal('invalid', message);
const conflict = (message: string) => new Refusal('conflict', message);
const notFound = (what: string, id: string) => new Refusal('not_found', `${what} ${id} does not exist`);

const STATUS_OF_REFUSAL: Partial<Record<ErrorCode, number>> = { invalid: 400, not_found: 404, conflict: 409 };

/** The page size the daemon's reads take: 25 without a `limit`, and a `limit` is held to 1 to 100. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** The size of a page for a `limit`, as the route and the domain settle it: a `limit` that is not a whole number of 0 or more is refused, and the rest is held to 1 to 100. */
function pageSize(limit: number | undefined): number {
    if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0))
        throw invalid('limit must be a non-negative integer');

    return Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

/** The most tasks an archive refusal names; the rest are counted. */
const MAX_NAMED = 5;

const byNumber = (a: Task, b: Task) => a.number - b.number;

/** A title is what a person reads on a card: whitespace around it is dropped, and nothing but whitespace is refused. */
function cleanTitle(title: string): string {
    const trimmed = title.trim();

    if (!trimmed) throw invalid('The task title cannot be empty');

    return trimmed;
}

/** A comment keeps its Markdown as written, less the whitespace at its end; one with nothing in it is no comment. */
function cleanBody(body: string): string {
    const trimmed = body.trimEnd();

    if (trimmed === '') throw invalid('A comment cannot be empty');

    return trimmed;
}

/** The parent and child links of one project's tasks, archived ones too. Every walk keeps a set of what it has seen, so a cycle in the data ends it. */
class Tree {
    readonly #byId: Map<TaskId, Task>;
    readonly #children = new Map<TaskId, Task[]>();

    constructor(tasks: readonly Task[]) {
        this.#byId = new Map(tasks.map(task => [task.id, task]));

        for (const task of [...tasks].sort(byNumber)) {
            if (task.parentId !== undefined)
                this.#children.set(task.parentId, [...(this.#children.get(task.parentId) ?? []), task]);
        }
    }

    parentOf(task: Task): Task | undefined {
        return task.parentId === undefined ? undefined : this.#byId.get(task.parentId);
    }

    childrenOf(taskId: TaskId): readonly Task[] {
        return this.#children.get(taskId) ?? [];
    }

    /** The tasks above `taskId`, the parent first. */
    ancestorsOf(taskId: TaskId): Task[] {
        const found: Task[] = [];
        const seen = new Set([taskId]);

        for (let current = this.#byId.get(taskId); current; ) {
            const parent = this.parentOf(current);

            if (!parent || seen.has(parent.id)) break;

            seen.add(parent.id);
            found.push(parent);
            current = parent;
        }

        return found;
    }

    /** Every task below `taskId`, level by level, each with its level under it (a child is 1). */
    descendantsOf(taskId: TaskId): { task: Task; level: number }[] {
        const found: { task: Task; level: number }[] = [];
        const seen = new Set([taskId]);
        let level = [taskId];

        for (let depth = 1; level.length > 0; depth++) {
            level = level
                .flatMap(id => this.childrenOf(id))
                .filter(child => !seen.has(child.id))
                .map(child => {
                    seen.add(child.id);
                    found.push({ task: child, level: depth });

                    return child.id;
                });
        }

        return found;
    }

    /** The level of `taskId` in its tree: a root is 1. */
    depthOf(taskId: TaskId): number {
        return this.ancestorsOf(taskId).length + 1;
    }

    /** How many levels lie below `taskId`. */
    heightOf(taskId: TaskId): number {
        return this.descendantsOf(taskId).reduce((height, { level }) => Math.max(height, level), 0);
    }
}

/** What the rules need of the transport that owns them: announcing a change, and ids that no other entity of the fixture has. */
export interface TasksHost {
    emit: (projectId: ProjectId, data: EventData) => void;
    id: (prefix: string) => string;
}

/** The tasks, their archive and their comments: the commands that change them, and the paged reads of what the snapshot leaves out. */
export class FixtureTasks {
    /** The next number of each project that has made a task: a counter like the daemon's, so the number of a deleted task is not given out again. */
    readonly #nextNumbers = new Map<ProjectId, number>();

    constructor(
        private readonly data: FixtureData,
        private readonly host: TasksHost
    ) {}

    /** Does the command's work and answers with a copy of what it returns; a refusal is the answer, anything else is a bug and goes on. */
    #answer(work: () => unknown): Outcome {
        try {
            return ok(structuredClone(work()));
        } catch (error) {
            if (error instanceof Refusal) return fail(error.code, error.message);

            throw error;
        }
    }

    /** Does a read's work; a refusal is the error the HTTP transport would throw for the daemon's status. */
    #read<T>(work: () => T): T {
        try {
            return structuredClone(work());
        } catch (error) {
            if (error instanceof Refusal) throw new TransportError(error.message, STATUS_OF_REFUSAL[error.code]);

            throw error;
        }
    }

    /* --------------------------------- Lookups -------------------------------- */

    #requireProject(projectId: ProjectId): Project {
        const project = this.data.projects.find(candidate => candidate.id === projectId);

        if (!project) throw notFound('Space', projectId);

        return project;
    }

    #requireChat(chatId: string): Chat {
        const chat = this.data.chats.find(candidate => candidate.id === chatId);

        if (!chat) throw notFound('Chat', chatId);

        return chat;
    }

    #requireTask(taskId: TaskId): Task {
        const task = this.data.tasks.find(candidate => candidate.id === taskId);

        if (!task) throw notFound('Task', taskId);

        return task;
    }

    #requireComment(taskId: TaskId, commentId: string): TaskComment {
        const comment = this.data.comments.find(candidate => candidate.id === commentId);

        // A comment of another task is as good as none.
        if (!comment || comment.taskId !== taskId) throw notFound('Comment', commentId);

        return comment;
    }

    #statuses(projectId: ProjectId): readonly TaskStatus[] {
        return this.data.statuses[projectId] ?? DEFAULT_STATUSES;
    }

    #requireStatus(projectId: ProjectId, statusId: string): TaskStatus {
        const status = this.#statuses(projectId).find(candidate => candidate.id === statusId);

        if (!status) throw invalid(`Status ${statusId} does not belong to space ${projectId}`);

        return status;
    }

    /** The project's first status of a category: where tasks land when logic, not a person, moves them. */
    #statusOfCategory(projectId: ProjectId, category: TaskStatusCategory): TaskStatus {
        const status = this.#statuses(projectId).find(candidate => candidate.category === category);

        if (!status) throw invalid(`Space ${projectId} has no status in the ${category} category`);

        return status;
    }

    #categoryOf(task: Task): TaskStatusCategory {
        return this.#statuses(task.projectId).find(candidate => candidate.id === task.statusId)?.category ?? 'todo';
    }

    #projectTasks(projectId: ProjectId): Task[] {
        return this.data.tasks.filter(task => task.projectId === projectId);
    }

    #tree(projectId: ProjectId): Tree {
        return new Tree(this.#projectTasks(projectId));
    }

    /** The next task number of the project: past every task it holds, the archived ones too, and every number it gave out. */
    #nextNumber(projectId: ProjectId): number {
        return Math.max(
            this.#nextNumbers.get(projectId) ?? 1,
            ...this.#projectTasks(projectId).map(task => task.number + 1)
        );
    }

    /** Gives the task held in the data its new fields, in place: the fixture's runs keep a reference to a task they will move to Review. */
    #replace(task: Task, next: Task): void {
        for (const key of Object.keys(task)) {
            if (!(key in next)) Reflect.deleteProperty(task, key);
        }

        Object.assign(task, next);
    }

    #announce(task: Task): void {
        this.host.emit(task.projectId, { type: 'task.upserted', task });
    }

    /* ------------------------------- Dependencies ------------------------------ */

    /** Whether `taskId` already depends on any of `dependencies`, directly or through other tasks. */
    #createsCycle(taskId: TaskId, dependencies: readonly TaskId[]): boolean {
        const seen = new Set<TaskId>();
        const stack = [...dependencies];

        while (stack.length > 0) {
            const current = stack.pop() as TaskId;

            if (current === taskId) return true;

            if (!seen.has(current)) {
                seen.add(current);
                stack.push(...(this.data.tasks.find(task => task.id === current)?.dependsOn ?? []));
            }
        }

        return false;
    }

    /** Validates a dependency list: tasks of the same project, no repeats, no cycle through `taskId`. */
    #checkDependencies(projectId: ProjectId, taskId: TaskId, references: readonly TaskId[]): TaskId[] {
        const ids = [...new Set(references)];

        for (const id of ids) {
            const dependency = this.#requireTask(id);

            if (dependency.projectId !== projectId) throw invalid(`Task ${dependency.key} belongs to another space`);

            if (this.#createsCycle(taskId, [id]))
                throw invalid(
                    `Circular dependency: the task would depend on ${dependency.key}, which already depends on it`
                );
        }

        return ids;
    }

    /* ---------------------------------- Parent --------------------------------- */

    /**
     * Validates the parent `parentId` for `task` (a task being made, or one being moved) and returns its id: a task of the same project, not the task itself nor
     * one inside it, the tree within `MAX_TASK_DEPTH` levels counting the levels of the task's own subtree, and not an archived task for a task on the board.
     */
    #checkParent(task: Pick<Task, 'id' | 'key' | 'projectId' | 'archivedAt'>, parentId: TaskId): TaskId {
        const parent = this.#requireTask(parentId);

        if (parent.projectId !== task.projectId) throw invalid(`Task ${parent.key} belongs to another space`);

        if (parent.id === task.id) throw invalid(`Task ${task.key} cannot be its own parent`);

        if (parent.archivedAt !== undefined && task.archivedAt === undefined)
            throw invalid(`Task ${parent.key} is archived: restore it before putting tasks inside it`);

        const tree = this.#tree(task.projectId);

        if (tree.ancestorsOf(parent.id).some(ancestor => ancestor.id === task.id))
            throw invalid(`Task ${parent.key} is inside ${task.key}, so it cannot be its parent`);

        const inside = tree.heightOf(task.id);
        const reach = tree.depthOf(parent.id) + 1 + inside;

        if (reach > MAX_TASK_DEPTH) {
            throw invalid(
                `Too deep: ${task.key} under ${parent.key} would reach level ${reach}${inside > 0 ? `, counting the ${inside} level${inside === 1 ? '' : 's'} of tasks inside it` : ''}, and a tree has at most ${MAX_TASK_DEPTH} levels`
            );
        }

        return parent.id;
    }

    /* ----------------------------- Create, update, delete ---------------------------- */

    create(command: Command<'task.create'>): Outcome {
        return this.#answer(() => {
            const project = this.#requireProject(command.projectId);
            const chat = command.chatId ? this.#requireChat(command.chatId) : undefined;

            if (chat && chat.projectId !== project.id) throw invalid('The chat belongs to another space');

            const status = command.statusId
                ? this.#requireStatus(project.id, command.statusId)
                : this.#statusOfCategory(project.id, 'todo');
            const id = this.host.id('t');
            const number = this.#nextNumber(project.id);
            const now = Date.now();
            const task: Task = {
                id,
                projectId: project.id,
                number,
                key: `${project.taskPrefix}-${number}`,
                title: cleanTitle(command.title),
                description: command.description ?? '',
                statusId: status.id,
                dependsOn: [],
                createdBy: { kind: 'user' },
                createdAt: now,
                updatedAt: now,
                ...(isClosedCategory(status.category) && { closedAt: now }),
            };

            task.dependsOn = this.#checkDependencies(project.id, id, command.dependsOn ?? []);

            if (command.parentId !== undefined) task.parentId = this.#checkParent(task, command.parentId);

            this.data.tasks.push(task);
            // Only a task that was made takes its number, as the daemon's counter is part of the transaction that makes it.
            this.#nextNumbers.set(project.id, number + 1);
            this.#announce(task);

            if (chat) {
                const link = { chatId: chat.id, taskId: id };

                this.data.chatTaskLinks.push(link);
                this.host.emit(project.id, { type: 'link.chatTask', link, present: true });
            }

            return { task };
        });
    }

    update(command: Command<'task.update'>): Outcome {
        return this.#answer(() => {
            const task = this.#requireTask(command.taskId);
            const next: Task = {
                ...task,
                title: command.title === undefined ? task.title : cleanTitle(command.title),
                description: command.description ?? task.description,
                statusId: command.statusId ? this.#requireStatus(task.projectId, command.statusId).id : task.statusId,
                dependsOn: command.dependsOn
                    ? this.#checkDependencies(task.projectId, task.id, command.dependsOn)
                    : task.dependsOn,
            };

            // A parent that does not change is not checked again: an edit of something else must not be refused for a tree that was fine when it was made.
            if (command.parentId === null) {
                delete next.parentId;
            } else if (command.parentId !== undefined && command.parentId !== task.parentId) {
                next.parentId = this.#checkParent(task, command.parentId);
            }

            if (
                next.title === task.title &&
                next.description === task.description &&
                next.statusId === task.statusId &&
                next.dependsOn.join() === task.dependsOn.join() &&
                next.parentId === task.parentId
            ) {
                return { task };
            }

            // An archived task is closed, and stays so until it is restored: reopening it would leave work hidden from the board.
            if (task.archivedAt !== undefined && !isClosedCategory(this.#categoryOf(next)))
                throw invalid(`Task ${task.key} is archived: restore it before reopening it`);

            const now = Date.now();

            // The closing time is when the task entered a closed status; a move between two closed ones (Done to Canceled) keeps it.
            if (!isClosedCategory(this.#categoryOf(next))) delete next.closedAt;
            else if (!isClosedCategory(this.#categoryOf(task))) next.closedAt = now;

            next.updatedAt = now;
            this.#replace(task, next);
            this.#announce(task);

            return { task };
        });
    }

    /**
     * Removes the task with its links and comments; tasks that depended on it lose that dependency, and the tasks inside it move up to its own parent (a root's
     * become roots). The events go in the daemon's order: the links that went, the tasks that changed, then the task.
     */
    delete(command: Command<'task.delete'>): Outcome {
        return this.#answer(() => {
            const task = this.#requireTask(command.taskId);
            const data = this.data;
            const chatLinks = data.chatTaskLinks.filter(link => link.taskId === task.id);
            const runLinks = data.runTaskLinks.filter(link => link.taskId === task.id);
            const now = Date.now();
            const changed = new Map<TaskId, Task>();

            for (const dependent of data.tasks.filter(candidate => candidate.dependsOn.includes(task.id))) {
                changed.set(dependent.id, {
                    ...dependent,
                    dependsOn: dependent.dependsOn.filter(id => id !== task.id),
                    updatedAt: now,
                });
            }

            for (const child of data.tasks.filter(candidate => candidate.parentId === task.id).sort(byNumber)) {
                const moved: Task = { ...(changed.get(child.id) ?? child), updatedAt: now };

                if (task.parentId === undefined) delete moved.parentId;
                else moved.parentId = task.parentId;

                changed.set(child.id, moved);
            }

            data.tasks = data.tasks.filter(candidate => candidate.id !== task.id);
            data.chatTaskLinks = data.chatTaskLinks.filter(link => link.taskId !== task.id);
            data.runTaskLinks = data.runTaskLinks.filter(link => link.taskId !== task.id);
            data.comments = data.comments.filter(comment => comment.taskId !== task.id);

            for (const link of chatLinks)
                this.host.emit(task.projectId, { type: 'link.chatTask', link, present: false });

            for (const link of runLinks) this.host.emit(task.projectId, { type: 'link.runTask', link, present: false });

            for (const [id, moved] of changed) {
                const held = this.#requireTask(id);

                this.#replace(held, moved);
                this.#announce(held);
            }

            this.host.emit(task.projectId, { type: 'task.deleted', taskId: task.id });

            return { taskId: task.id };
        });
    }

    /* ----------------------------------- Archive ----------------------------------- */

    /** The first run working on the task, which is what an archive refuses for: one assigned to it (not one that only created it) that has not finished. */
    #activeRunOf(taskId: TaskId): { name: string } | undefined {
        for (const link of this.data.runTaskLinks) {
            const run =
                link.taskId === taskId && link.relation !== 'created'
                    ? this.data.runs.find(candidate => candidate.id === link.runId)
                    : undefined;

            if (run && ACTIVE_RUN_STATUSES.includes(run.status)) return run;
        }

        return undefined;
    }

    /**
     * Archives the task with every task inside it that is not archived yet, all with one `archivedAt`, so restoring the task brings back exactly this batch. The
     * batch must be at rest (`conflict` for an active run, whatever `cancel` says) and closed (`invalid`, unless `cancel` moves the open ones to Canceled in the
     * same write). Archiving a task that is archived changes nothing.
     */
    archive(command: Command<'task.archive'>): Outcome {
        return this.#answer(() => {
            const task = this.#requireTask(command.taskId);

            if (task.archivedAt !== undefined) return { task, archived: [], canceled: [] };

            const tree = this.#tree(task.projectId);
            const batch = [
                task,
                ...tree
                    .descendantsOf(task.id)
                    .map(({ task: below }) => below)
                    .filter(below => below.archivedAt === undefined),
            ];

            for (const member of batch) {
                const active = this.#activeRunOf(member.id);

                if (active)
                    throw conflict(
                        `Task ${member.key}${member.id === task.id ? '' : `, inside ${task.key},`} has an active run (${active.name}): stop it first`
                    );
            }

            const statuses = this.#statuses(task.projectId);
            const statusOf = (member: Task) => statuses.find(candidate => candidate.id === member.statusId);
            const open = batch.filter(member => !isClosedCategory(statusOf(member)?.category ?? 'todo'));

            if (open.length > 0 && !command.cancel) {
                const named = open
                    .slice(0, MAX_NAMED)
                    .map(member => `${member.key} (${statusOf(member)?.name ?? 'To do'})`)
                    .join(', ');
                const more = open.length > MAX_NAMED ? ` and ${open.length - MAX_NAMED} more` : '';

                throw invalid(
                    `${named}${more} ${open.length === 1 ? 'is' : 'are'} not closed: close ${open.length === 1 ? 'it' : 'them'} first, or archive with cancel`
                );
            }

            const now = Date.now();
            // One batch, one time: a later batch never takes the value of an earlier one, whatever the clock says, so a restore cannot pick up a neighbour.
            const latest = Math.max(0, ...this.#projectTasks(task.projectId).map(member => member.archivedAt ?? 0));
            const archivedAt = Math.max(now, latest + 1);
            const canceledStatus = open.length > 0 ? this.#statusOfCategory(task.projectId, 'canceled') : undefined;
            const archived: Task[] = [];
            const canceled: Task[] = [];

            for (const member of batch) {
                const wasOpen = open.includes(member);
                const next: Task = {
                    ...member,
                    archivedAt,
                    ...(wasOpen && canceledStatus && { statusId: canceledStatus.id, closedAt: now, updatedAt: now }),
                };

                this.#replace(member, next);
                this.#announce(member);
                archived.push(member);

                if (wasOpen) canceled.push(member);
            }

            return {
                task: archived[0],
                archived: archived.map(member => member.id),
                canceled: canceled.map(member => member.id),
            };
        });
    }

    /** One archive batch: the task and the tasks below it that carry its `archivedAt`, each reached through tasks that carry it too. */
    #batchOf(tree: Tree, task: Task): Task[] {
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
     * Brings the task back with the tasks inside it that were archived with it; one archived on its own, earlier or later, stays archived. Refused (`invalid`)
     * while the task's parent is archived. Restoring a task that is not archived changes nothing.
     */
    unarchive(command: Command<'task.unarchive'>): Outcome {
        return this.#answer(() => {
            const task = this.#requireTask(command.taskId);

            if (task.archivedAt === undefined) return { task, restored: [] };

            const tree = this.#tree(task.projectId);
            const parent = tree.parentOf(task);

            if (parent?.archivedAt !== undefined)
                throw invalid(
                    `Task ${task.key} is inside ${parent.key}, which is archived: restore ${parent.key} first`
                );

            const restored = this.#batchOf(tree, task).map(member => {
                const { archivedAt: _, ...rest } = member;

                this.#replace(member, rest);
                this.#announce(member);

                return member;
            });

            return { task: restored[0], restored: restored.map(member => member.id) };
        });
    }

    /** A page of the project's archived tasks, the latest archived first and the tasks of one batch by number. The cursor is `<archivedAt>.<number>`. */
    archivedPage(projectId: ProjectId, { limit, cursor }: PageQuery = {}): TaskArchivePage {
        return this.#read(() => {
            const size = pageSize(limit);
            const match = cursor === undefined ? undefined : /^(\d+)\.(\d+)$/.exec(cursor);

            if (cursor !== undefined && !match)
                throw invalid(`"${cursor}" is not a cursor: pass the nextCursor of the previous page unchanged`);

            this.#requireProject(projectId);

            const [after, position] = match ? [Number(match[1]), Number(match[2])] : [undefined, 0];
            const archived = this.#projectTasks(projectId)
                .filter(task => task.archivedAt !== undefined)
                .sort((a, b) => b.archivedAt! - a.archivedAt! || a.number - b.number);
            const found = archived
                .filter(
                    task =>
                        after === undefined ||
                        task.archivedAt! < after ||
                        (task.archivedAt === after && task.number > position)
                )
                .slice(0, size + 1);
            const tasks = found.slice(0, size);
            const last = tasks.at(-1);

            return {
                tasks,
                total: archived.length,
                ...(last && found.length > size && { nextCursor: `${last.archivedAt}.${last.number}` }),
            };
        });
    }

    /* ----------------------------------- Comments ----------------------------------- */

    /** An id whose text order is its creation order, in the shape the daemon's cursor expects (`cmt_` and capital letters or digits). */
    #commentId(): string {
        return `cmt_${this.host.id('c').split('-')[1].padStart(8, '0')}`;
    }

    addComment(command: Command<'task.comment.add'>): Outcome {
        return this.#answer(() => {
            const task = this.#requireTask(command.taskId);
            // A command comes from the person's app, so the comment is the person's.
            const comment: TaskComment = {
                id: this.#commentId(),
                taskId: task.id,
                author: { kind: 'user' },
                body: cleanBody(command.body),
                createdAt: Date.now(),
            };

            this.data.comments.push(comment);
            this.host.emit(task.projectId, { type: 'task.comment.upserted', comment });

            return { comment };
        });
    }

    /** Replaces the body and stamps `editedAt`; the same body is no edit, so it neither stamps nor announces anything. */
    editComment(command: Command<'task.comment.edit'>): Outcome {
        return this.#answer(() => {
            const task = this.#requireTask(command.taskId);
            const comment = this.#requireComment(task.id, command.commentId);
            const body = cleanBody(command.body);

            if (body === comment.body) return { comment };

            Object.assign(comment, { body, editedAt: Date.now() });
            this.host.emit(task.projectId, { type: 'task.comment.upserted', comment });

            return { comment };
        });
    }

    deleteComment(command: Command<'task.comment.delete'>): Outcome {
        return this.#answer(() => {
            const task = this.#requireTask(command.taskId);
            const comment = this.#requireComment(task.id, command.commentId);

            this.data.comments = this.data.comments.filter(candidate => candidate.id !== comment.id);
            this.host.emit(task.projectId, { type: 'task.comment.deleted', taskId: task.id, commentId: comment.id });

            return { taskId: task.id, commentId: comment.id };
        });
    }

    /** A page of the task's comments, oldest first. The cursor is `<createdAt>.<id>`. */
    commentsPage(taskId: TaskId, { limit, cursor }: PageQuery = {}): TaskCommentsPage {
        return this.#read(() => {
            const size = pageSize(limit);
            const match = cursor === undefined ? undefined : /^(\d+)\.(cmt_[0-9A-Z]+)$/.exec(cursor);

            if (cursor !== undefined && !match)
                throw invalid(`"${cursor}" is not a cursor: pass the nextCursor of the previous page unchanged`);

            const task = this.#requireTask(taskId);
            const all = this.data.comments
                .filter(comment => comment.taskId === task.id)
                .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : Number(a.id > b.id)));
            const [createdAt, id] = match ? [Number(match[1]), match[2]] : [undefined, ''];
            const found = all
                .filter(
                    comment =>
                        createdAt === undefined ||
                        comment.createdAt > createdAt ||
                        (comment.createdAt === createdAt && comment.id > id)
                )
                .slice(0, size + 1);
            const comments = found.slice(0, size);
            const last = comments.at(-1);

            return {
                comments,
                total: all.length,
                ...(last && found.length > size && { nextCursor: `${last.createdAt}.${last.id}` }),
            };
        });
    }
}
