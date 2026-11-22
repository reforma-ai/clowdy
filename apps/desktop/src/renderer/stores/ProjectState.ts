import { makeAutoObservable, observableRef, observableShallow, runInAction } from 'mobx';

import { TransportError } from '../daemon/transport';

import type {
    Chat,
    ChatId,
    ChatTaskLink,
    ClowdyEvent,
    EventData,
    FolderId,
    Project,
    ProjectId,
    ProjectSnapshot,
    Run,
    RunId,
    RunTaskLink,
    Task,
    TaskId,
    TaskStatus,
} from '@clowdy/protocol';
import type { Transport } from '../daemon/transport';

export type LoadStatus = 'loading' | 'ready' | 'failed';

/** The most archived tasks a project remembers (`ProjectState.archivedKnown`): the ones read longest ago are let go first. */
export const ARCHIVED_MEMORY_LIMIT = 500;

/** The most keys a project remembers having asked the daemon about to no avail (`ProjectState.taskOfKey`): the ones asked longest ago are let go first. */
export const UNRESOLVED_KEYS_LIMIT = 500;

const chatLinkKey = (link: ChatTaskLink) => `${ link.chatId }:${ link.taskId }`;
const runLinkKey = (link: RunTaskLink) => `${ link.runId }:${ link.taskId }:${ link.relation }`;

function group<K, V>(items: Iterable<V>, keyOf: (item: V) => K): Map<K, V[]> {
    const groups = new Map<K, V[]>();

    for (const item of items) {
        const key = keyOf(item);

        groups.set(key, [...groups.get(key) ?? [], item]);
    }

    return groups;
}

const byNumber = (a: Task, b: Task) => a.number - b.number;
const byCreatedAt = (a: Run, b: Run) => a.createdAt - b.createdAt || a.id.localeCompare(b.id);

/**
 * One loaded project: its snapshot, kept current by the event feed. Entities are replaced whole, never edited,
 * so the maps hold them by reference. Stream items live in `StreamStore`.
 */
export class ProjectState {
    readonly id: ProjectId;
    project: Project;
    statuses: TaskStatus[] = [];
    chats = new Map<ChatId, Chat>();
    tasks = new Map<TaskId, Task>();
    runs = new Map<RunId, Run>();
    chatTaskLinks = new Map<string, ChatTaskLink>();
    runTaskLinks = new Map<string, RunTaskLink>();
    status: LoadStatus = 'loading';
    error = '';
    /** Cursor of the last event this project has taken in: the snapshot's, then each applied event's. */
    cursor = 0;
    /** Counts `artifact.added` events; a task detail that shows artifacts refetches when it changes. */
    artifactsRevision = 0;
    /**
     * Comments are not in the snapshot, so whatever shows a task's comments reads them from the daemon and must read them again when they change: each
     * `task.comment.upserted`, `task.comment.deleted` and `task.deleted` of a task counts here, under that task (read it with `commentsRevision`).
     */
    commentsRevisions = new Map<TaskId, number>();
    /** Counts the snapshots taken in: after a reload the event feed may have missed comment events, so every task's comments are read again. */
    commentsReload = 0;
    /**
     * The archived tasks this window has read or seen archived, by id, in memory only: the snapshot leaves the archive out, and a mention, a dependency or the history
     * names an archived task by its id or its key. The ones read longest ago are let go past `ARCHIVED_MEMORY_LIMIT`, and a task that is restored or deleted is dropped
     * at once, so it holds archived tasks only. A task that is not here may still be archived: `readTask` asks the daemon.
     */
    archivedKnown = new Map<TaskId, Task>();
    /**
     * Counts what may have changed the archive: a task archived, restored or deleted, a snapshot taken in again (the feed may have missed events). A view of the archive
     * reads the archive again when it changes. It only grows, and its value means nothing else. A task made on the board counts too (it cannot be told from a restored one).
     */
    archiveRevision = 0;
    /** Events that arrived while the first snapshot was loading. */
    readonly #queue: ClowdyEvent[] = [];
    #loadId = 0;
    /** The reads of tasks the project does not hold that are on their way, so two parts of the screen asking for one task make one request. */
    readonly #reading = new Map<TaskId, Promise<Task | undefined>>();
    /**
     * The keys `taskOfKey` is reading from the daemon right now, one request per key. Plain, not observable: `taskOfKey` runs while a component renders, and it must not change
     * what the render observes.
     */
    readonly #readingKeys = new Set<string>();
    /** The keys the daemon was asked about and gave nothing to show (no such task, a read that failed, a task that is not archived), so they are not asked again until a snapshot is taken in. Plain, bounded. */
    readonly #unresolvedKeys = new Set<string>();

    constructor(private readonly transport: Transport, project: Project) {
        this.id = project.id;
        this.project = project;
        makeAutoObservable<ProjectState, 'transport'>(this, {
            transport: false,
            project: observableRef,
            statuses: observableRef,
            chats: observableShallow,
            tasks: observableShallow,
            runs: observableShallow,
            chatTaskLinks: observableShallow,
            runTaskLinks: observableShallow,
            commentsRevisions: observableShallow,
            archivedKnown: observableShallow,
        });
    }

    /**
     * Loads the snapshot, or reloads it after the event feed lost its place (a reload keeps showing the old data).
     * Resolves to whether the snapshot arrived; a failure is also recorded in `status` and `error`.
     */
    async load(): Promise<boolean> {
        const loadId = ++this.#loadId;

        if (this.status !== 'ready') this.status = 'loading';

        try {
            const snapshot = await this.transport.getProjectSnapshot(this.id);

            // A newer load took over while this one was in flight.
            if (loadId === this.#loadId) this.applySnapshot(snapshot);

            return true;
        }
        catch (error) {
            if (loadId === this.#loadId) {
                runInAction(() => {
                    if (this.status !== 'ready') this.status = 'failed';

                    this.error = error instanceof Error ? error.message : String(error);
                    this.#queue.length = 0;
                });
            }

            return false;
        }
    }

    applySnapshot(snapshot: ProjectSnapshot): void {
        this.project = snapshot.project;
        this.statuses = snapshot.statuses;
        this.chats = new Map(snapshot.chats.map(chat => [chat.id, chat]));
        this.tasks = new Map(snapshot.tasks.map(task => [task.id, task]));
        // A task that is on the board is not archived any more, whatever the memory says: it was restored while the feed was away.
        snapshot.tasks.forEach(task => this.archivedKnown.delete(task.id));
        this.archiveRevision++;
        // The feed may have missed what makes a key a task now, and a daemon that failed may be back: every key is asked again when something shows it.
        this.#unresolvedKeys.clear();
        this.runs = new Map(snapshot.runs.map(run => [run.id, run]));
        this.chatTaskLinks = new Map(snapshot.chatTaskLinks.map(link => [chatLinkKey(link), link]));
        this.runTaskLinks = new Map(snapshot.runTaskLinks.map(link => [runLinkKey(link), link]));
        this.cursor = snapshot.cursor;
        this.status = 'ready';
        this.error = '';
        this.commentsReload++;

        const queued = this.#queue.splice(0);

        queued.sort((a, b) => a.cursor - b.cursor).forEach(event => this.applyEvent(event));
    }

    /**
     * Takes in one event of this project. An event at or before the cursor is already in the snapshot (or was
     * applied), so it is skipped; one that arrives while the first snapshot loads waits for it.
     */
    applyEvent(event: ClowdyEvent): void {
        if (this.status === 'loading') {
            this.#queue.push(event);

            return;
        }

        if (this.status === 'failed' || event.cursor <= this.cursor) return;

        this.#apply(event.data, event.cursor);
        this.cursor = event.cursor;
    }

    #apply(data: EventData, cursor: number): void {
        switch (data.type) {
            case 'project.upserted':
                this.project = data.project;
                this.statuses = data.statuses;
                break;
            case 'chat.upserted':
                this.chats.set(data.chat.id, data.chat);
                break;
            case 'chat.deleted': {
                const gone = new Set(data.runIds);

                this.chats.delete(data.chatId);
                gone.forEach(runId => this.runs.delete(runId));

                for (const [key, link] of this.chatTaskLinks) if (link.chatId === data.chatId) this.chatTaskLinks.delete(key);

                for (const [key, link] of this.runTaskLinks) if (gone.has(link.runId)) this.runTaskLinks.delete(key);

                break;
            }
            case 'task.upserted':
                // The snapshot has no archived tasks, so an archived one is off the board here too; restoring it sends the task again without `archivedAt`.
                // Its chat and run links stay (a restore sends no link events); the derived lists ignore the links of a task the map does not hold.
                if (data.task.archivedAt === undefined) {
                    // Back on the board, or new: either way the archive may have lost it.
                    if (this.archivedKnown.delete(data.task.id) || !this.tasks.has(data.task.id)) this.archiveRevision++;

                    this.tasks.set(data.task.id, data.task);
                }
                else {
                    this.tasks.delete(data.task.id);
                    this.rememberArchived([data.task]);
                    this.archiveRevision++;
                }

                break;
            case 'task.deleted':
                // A task that is not on the board is in the archive, or nowhere.
                if (!this.tasks.has(data.taskId)) this.archiveRevision++;

                this.archivedKnown.delete(data.taskId);
                this.tasks.delete(data.taskId);
                this.#dropLinks(link => link.taskId === data.taskId);
                this.#bumpComments(data.taskId);
                break;
            case 'task.comment.upserted':
                this.#bumpComments(data.comment.taskId);
                break;
            case 'task.comment.deleted':
                this.#bumpComments(data.taskId);
                break;
            case 'run.upserted':
                this.runs.set(data.run.id, data.run);
                break;
            case 'stream.truncated': {
                // The stream itself belongs to `StreamStore`; the sub-agent runs the dropped part started are gone from the daemon.
                const gone = new Set(data.removedRunIds);

                gone.forEach(runId => this.runs.delete(runId));

                for (const [key, link] of this.runTaskLinks) if (gone.has(link.runId)) this.runTaskLinks.delete(key);

                break;
            }
            case 'link.chatTask':
                if (data.present) this.chatTaskLinks.set(chatLinkKey(data.link), data.link);
                else this.chatTaskLinks.delete(chatLinkKey(data.link));

                break;
            case 'link.runTask':
                if (data.present) this.runTaskLinks.set(runLinkKey(data.link), data.link);
                else this.runTaskLinks.delete(runLinkKey(data.link));

                break;
            case 'artifact.added':
                this.artifactsRevision++;
                break;
            // Stream items belong to `StreamStore`; notices and a deleted project are handled by the root store. A document is a file now: the file manager's watch reports it.
            case 'docs.changed':
            case 'project.deleted':
            case 'stream.item':
            case 'notice':
                break;
        }
    }

    #bumpComments(taskId: TaskId): void {
        this.commentsRevisions.set(taskId, (this.commentsRevisions.get(taskId) ?? 0) + 1);
    }

    #dropLinks(matches: (link: { taskId: TaskId }) => boolean): void {
        for (const [key, link] of this.chatTaskLinks) if (matches(link)) this.chatTaskLinks.delete(key);

        for (const [key, link] of this.runTaskLinks) if (matches(link)) this.runTaskLinks.delete(key);
    }

    /* --------------------------------- Derived --------------------------------- */

    /** Chats, most recently active first. */
    get chatList(): Chat[] {
        return [...this.chats.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    /** The threads of each chat (`Chat.parentChatId`), archived ones too, in the order they were made. A chat with none has no entry. */
    get threadsByParent(): Map<ChatId, Chat[]> {
        const threads = [...this.chats.values()].filter(chat => chat.parentChatId !== undefined).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

        return group(threads, chat => chat.parentChatId!);
    }

    /** The threads a chat started directly, archived ones too, oldest first. */
    threadsOf(chatId: ChatId): Chat[] {
        return this.threadsByParent.get(chatId) ?? [];
    }

    /** Every thread below a chat, at any depth and archived ones too: what goes with it when it is deleted. */
    threadsBelow(chatId: ChatId): Chat[] {
        const found: Chat[] = [];
        const seen = new Set<ChatId>([chatId]);

        for (let index = -1; index < found.length; index++) {
            for (const thread of this.threadsOf(index < 0 ? chatId : found[index].id)) {
                // Chats form a tree by contract; the guard keeps a corrupt parent cycle from looping.
                if (seen.has(thread.id)) continue;

                seen.add(thread.id);
                found.push(thread);
            }
        }

        return found;
    }

    get taskList(): Task[] {
        return [...this.tasks.values()].sort(byNumber);
    }

    /**
     * Remembers archived tasks the window has read (`archivedKnown`), the latest read last, and lets the ones read longest ago go past `ARCHIVED_MEMORY_LIMIT`.
     * A task without `archivedAt`, or one the board holds, is not archived and is left out.
     */
    rememberArchived(tasks: readonly Task[]): void {
        for (const task of tasks) {
            if (task.archivedAt === undefined || this.tasks.has(task.id)) continue;

            // Deleted first, so a task read again moves to the end of the order the oldest are dropped in.
            this.archivedKnown.delete(task.id);
            this.archivedKnown.set(task.id, task);
        }

        const excess = this.archivedKnown.size - ARCHIVED_MEMORY_LIMIT;

        if (excess > 0) [...this.archivedKnown.keys()].slice(0, excess).forEach(id => this.archivedKnown.delete(id));
    }

    /** The task on the board, else the archived one the window knows. Not the daemon's: `readTask` is. */
    taskById(taskId: TaskId): Task | undefined {
        return this.tasks.get(taskId) ?? this.archivedKnown.get(taskId);
    }

    /**
     * The task a key like `CAR-24` names, on the board or among the archived tasks the window knows: what a mention or a chip resolves a key with. It answers at once, and
     * for a key it does not know that has the shape of this project's keys it also starts one read of the task from the daemon (`getTaskDetailByKey`), which is how a key
     * of an archived task the window never saw becomes a chip: the task is remembered when it is archived, and whatever read the answer through here draws again. Text
     * that is not a key of this project asks nothing, so any code span may be passed.
     */
    taskOfKey(key: string): Task | undefined {
        for (const task of this.tasks.values()) if (task.key === key) return task;

        for (const task of this.archivedKnown.values()) if (task.key === key) return task;

        if (this.#mayBeKey(key) && !this.#readingKeys.has(key) && !this.#unresolvedKeys.has(key)) {
            this.#readingKeys.add(key);
            void this.#readKey(key);
        }

        return undefined;
    }

    /** Whether the project is loaded, so the board is known and a key it lacks may be an archived task, and `key` is `<this project's prefix>-<number>`, the prefix in any case. */
    #mayBeKey(key: string): boolean {
        if (this.status !== 'ready') return false;

        const dash = key.lastIndexOf('-');

        // Task numbers start at 1 and have no leading zero.
        return dash > 0 && /^[1-9]\d*$/.test(key.slice(dash + 1)) && key.slice(0, dash).toUpperCase() === this.project.taskPrefix.toUpperCase();
    }

    /**
     * Reads the task of `key` and remembers it when it is archived and not on the board (a task that is not archived is the board's, and its event may come after the
     * reply). It never rejects. A key that still names no task the window knows afterwards (a 404, a failed read, a task of the board, a key in another case than the
     * task's) is not asked again until a snapshot is taken in.
     */
    async #readKey(key: string): Promise<void> {
        try {
            const { task } = await this.transport.getTaskDetailByKey(this.id, key);

            if (task.projectId === this.id) this.rememberArchived([task]);
        }
        catch {
            // No such task, or a daemon out of reach: both are settled below, and a key that is not a task stays text.
        }

        this.#readingKeys.delete(key);

        if ([...this.archivedKnown.values()].some(task => task.key === key)) return;

        this.#unresolvedKeys.delete(key);
        this.#unresolvedKeys.add(key);

        if (this.#unresolvedKeys.size > UNRESOLVED_KEYS_LIMIT) this.#unresolvedKeys.delete(this.#unresolvedKeys.values().next().value as string);
    }

    /**
     * The task for an id the board does not hold: an archived one, read from the daemon (`getTaskDetail`) and remembered, or the one the window knows. Resolves to
     * `undefined` when the daemon has no such task, or it belongs to another project, and rejects for any other failure. A task the daemon has that is not archived
     * is returned and not remembered: the board has it, or is about to (the event can come after the reply that made it).
     */
    readTask(taskId: TaskId): Promise<Task | undefined> {
        const held = this.taskById(taskId);

        if (held) return Promise.resolve(held);

        let reading = this.#reading.get(taskId);

        if (!reading) {
            reading = this.#fetchTask(taskId).finally(() => this.#reading.delete(taskId));
            this.#reading.set(taskId, reading);
        }

        return reading;
    }

    async #fetchTask(taskId: TaskId): Promise<Task | undefined> {
        try {
            const { task } = await this.transport.getTaskDetail(taskId);

            if (task.projectId !== this.id) return undefined;

            this.rememberArchived([task]);

            return task;
        }
        catch (error) {
            if (error instanceof TransportError && error.status === 404) return undefined;

            throw error;
        }
    }

    /**
     * Every status of the workflow has an entry, empty or not, in workflow order. A task whose status is not in
     * the workflow (one removed after the task was filed) is in no entry.
     */
    get tasksByStatus(): Map<string, Task[]> {
        const byStatus = group(this.taskList, task => task.statusId);

        return new Map(this.statuses.map(status => [status.id, byStatus.get(status.id) ?? []]));
    }

    /**
     * A number that differs whenever the comments of the task may have changed: put it in the dependencies of what loads them. It only grows; its value means
     * nothing else.
     */
    commentsRevision(taskId: TaskId): number {
        return this.commentsReload + (this.commentsRevisions.get(taskId) ?? 0);
    }

    // The links of a task the map does not hold (an archived one, whose links the daemon keeps) are ignored by the four lists below and by `linksOfRun`.

    get runsByTask(): Map<TaskId, Run[]> {
        return this.#join(this.runTaskLinks.values(), link => link.taskId, link => (this.tasks.has(link.taskId) ? this.runs.get(link.runId) : undefined), byCreatedAt);
    }

    get tasksByRun(): Map<RunId, Task[]> {
        return this.#join(this.runTaskLinks.values(), link => link.runId, link => this.tasks.get(link.taskId), byNumber);
    }

    get tasksByChat(): Map<ChatId, Task[]> {
        return this.#join(this.chatTaskLinks.values(), link => link.chatId, link => this.tasks.get(link.taskId), byNumber);
    }

    get chatsByTask(): Map<TaskId, Chat[]> {
        return this.#join(this.chatTaskLinks.values(), link => link.taskId, link => (this.tasks.has(link.taskId) ? this.chats.get(link.chatId) : undefined), (a, b) => b.updatedAt - a.updatedAt);
    }

    /** Runs linked to the task, whatever the relation (`assigned` or `created`), by when they were made. */
    runsOfTask(taskId: TaskId): Run[] {
        return this.runsByTask.get(taskId) ?? [];
    }

    tasksOfRun(runId: RunId): Task[] {
        return this.tasksByRun.get(runId) ?? [];
    }

    tasksOfChat(chatId: ChatId): Task[] {
        return this.tasksByChat.get(chatId) ?? [];
    }

    chatsOfTask(taskId: TaskId): Chat[] {
        return this.chatsByTask.get(taskId) ?? [];
    }

    /** The links of one run, for the relation (`assigned`, `created`) that a bare task list loses. */
    linksOfRun(runId: RunId): RunTaskLink[] {
        return [...this.runTaskLinks.values()].filter(link => link.runId === runId && this.tasks.has(link.taskId));
    }

    #join<L, T>(links: Iterable<L>, keyOf: (link: L) => string, target: (link: L) => T | undefined, order: (a: T, b: T) => number): Map<string, T[]> {
        const joined = new Map<string, T[]>();

        for (const link of links) {
            const entity = target(link);

            if (entity === undefined) continue;

            const key = keyOf(link);
            const list = joined.get(key) ?? [];

            // The same run may be linked to a task twice (`assigned` and `created`).
            if (!list.includes(entity)) list.push(entity);

            joined.set(key, list);
        }

        joined.forEach(list => list.sort(order));

        return joined;
    }
}
