import { makeAutoObservable, observableRef, observableShallow, runInAction } from 'mobx';

import { buildRunTree, type RunNode } from './runTree';

import type {
    Chat,
    ChatId,
    ChatTaskLink,
    ClowdyEvent,
    EventData,
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
    /** The newest change to the docs folder; screens that show it refetch what the change touches. */
    lastDocsChange: { path: string; change: 'created' | 'modified' | 'removed'; cursor: number } | null = null;
    /** Counts `artifact.added` events; a task detail that shows artifacts refetches when it changes. */
    artifactsRevision = 0;
    /** Events that arrived while the first snapshot was loading. */
    readonly #queue: ClowdyEvent[] = [];
    #loadId = 0;

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
            lastDocsChange: observableRef,
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
        this.runs = new Map(snapshot.runs.map(run => [run.id, run]));
        this.chatTaskLinks = new Map(snapshot.chatTaskLinks.map(link => [chatLinkKey(link), link]));
        this.runTaskLinks = new Map(snapshot.runTaskLinks.map(link => [runLinkKey(link), link]));
        this.cursor = snapshot.cursor;
        this.status = 'ready';
        this.error = '';

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
            case 'task.upserted':
                this.tasks.set(data.task.id, data.task);
                break;
            case 'task.deleted':
                this.tasks.delete(data.taskId);
                this.#dropLinks(link => link.taskId === data.taskId);
                break;
            case 'run.upserted':
                this.runs.set(data.run.id, data.run);
                break;
            case 'link.chatTask':
                if (data.present) this.chatTaskLinks.set(chatLinkKey(data.link), data.link);
                else this.chatTaskLinks.delete(chatLinkKey(data.link));

                break;
            case 'link.runTask':
                if (data.present) this.runTaskLinks.set(runLinkKey(data.link), data.link);
                else this.runTaskLinks.delete(runLinkKey(data.link));

                break;
            case 'docs.changed':
                this.lastDocsChange = { path: data.path, change: data.change, cursor };
                break;
            case 'artifact.added':
                this.artifactsRevision++;
                break;
            // Stream items belong to `StreamStore`; notices are shown by the root store.
            case 'stream.item':
            case 'notice':
                break;
        }
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

    get taskList(): Task[] {
        return [...this.tasks.values()].sort(byNumber);
    }

    /**
     * Every status of the workflow has an entry, empty or not, in workflow order. A task whose status is not in
     * the workflow (one removed after the task was filed) is in no entry.
     */
    get tasksByStatus(): Map<string, Task[]> {
        const byStatus = group(this.taskList, task => task.statusId);

        return new Map(this.statuses.map(status => [status.id, byStatus.get(status.id) ?? []]));
    }

    get runsByTask(): Map<TaskId, Run[]> {
        return this.#join(this.runTaskLinks.values(), link => link.taskId, link => this.runs.get(link.runId), byCreatedAt);
    }

    get tasksByRun(): Map<RunId, Task[]> {
        return this.#join(this.runTaskLinks.values(), link => link.runId, link => this.tasks.get(link.taskId), byNumber);
    }

    get tasksByChat(): Map<ChatId, Task[]> {
        return this.#join(this.chatTaskLinks.values(), link => link.chatId, link => this.tasks.get(link.taskId), byNumber);
    }

    get chatsByTask(): Map<TaskId, Chat[]> {
        return this.#join(this.chatTaskLinks.values(), link => link.taskId, link => this.chats.get(link.chatId), (a, b) => b.updatedAt - a.updatedAt);
    }

    /** Runs that work on the task, whatever the relation: executors first by when they started. */
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

    /** The links of one run, for the relation (`assigned`, `created`, `verifies`) that a bare task list loses. */
    linksOfRun(runId: RunId): RunTaskLink[] {
        return [...this.runTaskLinks.values()].filter(link => link.runId === runId);
    }

    /** The run tree for the Agents screen. */
    runTree(showFinished: boolean): RunNode[] {
        return buildRunTree(this.runs.values(), { showFinished });
    }

    #join<L, T>(links: Iterable<L>, keyOf: (link: L) => string, target: (link: L) => T | undefined, order: (a: T, b: T) => number): Map<string, T[]> {
        const joined = new Map<string, T[]>();

        for (const link of links) {
            const entity = target(link);

            if (entity === undefined) continue;

            const key = keyOf(link);
            const list = joined.get(key) ?? [];

            // The same run may be linked to a task twice (`assigned` and `verifies`).
            if (!list.includes(entity)) list.push(entity);

            joined.set(key, list);
        }

        joined.forEach(list => list.sort(order));

        return joined;
    }
}
