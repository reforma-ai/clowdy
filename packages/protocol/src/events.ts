import type { Artifact, Chat, ChatTaskLink, DocsFolder, FolderId, Project, Run, RunId, RunTaskLink, StreamItem, Task, TaskComment, TaskId, TaskStatus } from './domain';

/**
 * The daemon's change feed. Every event has a strictly increasing `cursor`; a client that stores the cursor of
 * its snapshot and then consumes events after it sees every change exactly once, in order.
 * Events carry whole entities (upserts), so applying one twice is harmless.
 */
export interface EventBase {
    cursor: number;
    at: number;
    projectId: string;
}

export type ClowdyEvent = EventBase & { data: EventData };

export type EventData =
    | { type: 'project.upserted'; project: Project; statuses: TaskStatus[] }
    /** The project (the event's `projectId`) and everything in it is gone from the daemon; its folder is untouched. */
    | { type: 'project.deleted' }
    | { type: 'chat.upserted'; chat: Chat }
    /** The chat and `runIds` (its orchestrator and every run below it, with their streams and task links) are gone. */
    | { type: 'chat.deleted'; chatId: string; runIds: string[] }
    | { type: 'task.upserted'; task: Task }
    /** The task is gone, its comments with it (there is no `task.comment.deleted` for each): a client drops what it holds of them. */
    | { type: 'task.deleted'; taskId: TaskId }
    /** A comment was added or its body changed. A client that has loaded the task's comments puts it in; one that has not ignores it. */
    | { type: 'task.comment.upserted'; comment: TaskComment }
    /** A comment was deleted (the person's command). A task that goes takes its comments with `task.deleted` instead. */
    | { type: 'task.comment.deleted'; taskId: TaskId; commentId: string }
    | { type: 'run.upserted'; run: Run }
    /** A stream item was appended or updated in place (streaming text, a tool changing state, an answered question). */
    | { type: 'stream.item'; item: StreamItem }
    /**
     * The stream of `runId` lost every item from `fromSeq` on (an edit of a message rewrote the chat from there), and the sub-agent runs `removedRunIds` that
     * the dropped part had started are gone with their streams. Items before `fromSeq` stay as they are; the next item of the stream may take the number
     * `fromSeq` again, under a new id. A client drops the items of `runId` from `fromSeq` on and forgets the runs.
     */
    | { type: 'stream.truncated'; runId: RunId; fromSeq: number; removedRunIds: RunId[] }
    | { type: 'link.chatTask'; link: ChatTaskLink; present: boolean }
    | { type: 'link.runTask'; link: RunTaskLink; present: boolean }
    | { type: 'artifact.added'; artifact: Artifact }
    /**
     * A file under the docs folder of one of the project's folders changed on disk. Clients refetch the tree or the open file. A folder that
     * several projects have announces its change to each of them, with each project's own `folderId`.
     */
    | { type: 'docs.changed'; folderId: FolderId; path: string; change: 'created' | 'modified' | 'removed' }
    /**
     * The skills this project's runs see changed: a skill folder was edited, or a user skill was switched.
     * User-level changes are announced once per project. Clients refetch `GET /v1/skills`.
     */
    | { type: 'skills.changed' }
    /** The agents the daemon can run changed (one was added, removed, switched, or found again). Clients refetch `GET /v1/agents`. */
    | { type: 'agents.changed' }
    | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

export type EventType = EventData['type'];

/** `GET /v1/events` frame names. */
export const SSE_EVENT = 'clowdy';

/** Events for a project plus the docs tree: what `GET /v1/projects/:id/snapshot` returns, as of `cursor`. */
export interface ProjectSnapshot {
    cursor: number;
    project: Project;
    statuses: TaskStatus[];
    chats: Chat[];
    tasks: Task[];
    runs: Run[];
    chatTaskLinks: ChatTaskLink[];
    runTaskLinks: RunTaskLink[];
}

export interface RootSnapshot {
    cursor: number;
    projects: Project[];
    /** The home folder of the person the daemon runs as: where a path is shown as `~`. Absent from a daemon that does not tell it. */
    home?: string;
}

/**
 * The documents of a project: one entry per folder, in the project's order (the main folder first). A folder other than the main one whose
 * documents cannot be read (missing, or its docs folder leads out of it) is left out.
 */
export type DocsTree = DocsFolder[];
