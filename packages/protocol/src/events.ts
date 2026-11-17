import type { Artifact, Chat, ChatTaskLink, DocNode, Project, Run, RunTaskLink, StreamItem, Task, TaskId, TaskStatus } from './domain';

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
    | { type: 'chat.upserted'; chat: Chat }
    | { type: 'task.upserted'; task: Task }
    | { type: 'task.deleted'; taskId: TaskId }
    | { type: 'run.upserted'; run: Run }
    /** A stream item was appended or updated in place (streaming text, a tool changing state, an answered question). */
    | { type: 'stream.item'; item: StreamItem }
    | { type: 'link.chatTask'; link: ChatTaskLink; present: boolean }
    | { type: 'link.runTask'; link: RunTaskLink; present: boolean }
    | { type: 'artifact.added'; artifact: Artifact }
    /** A file under the project's docs folder changed on disk. Clients refetch the tree or the open file. */
    | { type: 'docs.changed'; path: string; change: 'created' | 'modified' | 'removed' }
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
}

export type DocsTree = DocNode[];
