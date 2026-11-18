import type {
    Attachment,
    ChatId,
    ClowdyEvent,
    Command,
    CommandResult,
    DocFile,
    DocsTree,
    ProjectId,
    ProjectSnapshot,
    RootSnapshot,
    RunId,
    SkillCatalog,
    StreamItem,
    TaskDetail,
    TaskId,
} from '@clowdy/protocol';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A command as the UI builds it. The transport adds the `requestId`. */
export type CommandInput = DistributiveOmit<Command, 'requestId'>;

/** A stream is read by its run, or by its chat (the chat's orchestrator run). */
export type StreamTarget = { runId: RunId } | { chatId: ChatId };

/**
 * State of the change feed.
 * - `connected`: events flow.
 * - `reconnecting`: the connection dropped; the transport keeps trying and resumes from the last cursor.
 * - `resync`: the daemon no longer holds the events after the cursor (HTTP 410). The subscription has ended;
 *   the caller reloads its snapshots and subscribes again.
 */
export type FeedStatus = 'connected' | 'reconnecting' | 'resync';

/** The only way the UI talks to a daemon. */
export interface Transport {
    getRootSnapshot: () => Promise<RootSnapshot>;
    getProjectSnapshot: (projectId: ProjectId) => Promise<ProjectSnapshot>;
    /** Follows the change feed after `cursor`. Returns what ends the subscription. */
    subscribe: (cursor: number, onEvent: (event: ClowdyEvent) => void, onStatus: (status: FeedStatus) => void) => () => void;
    /**
     * Sends a command. The request id is made once per call and kept across the transport's own retries, so the
     * daemon acts once. A command the daemon refused resolves with `ok: false`; a daemon out of reach rejects.
     */
    command: (command: CommandInput) => Promise<CommandResult>;
    getItems: (target: StreamTarget, afterSeq?: number) => Promise<StreamItem[]>;
    getTaskDetail: (taskId: TaskId) => Promise<TaskDetail>;
    getDocsTree: (projectId: ProjectId) => Promise<DocsTree>;
    getDocFile: (projectId: ProjectId, path: string) => Promise<DocFile>;
    /** Files of the project folder whose path contains every word of `query`, best match first, as paths relative to the folder. */
    getProjectFiles: (projectId: ProjectId, query: string, limit?: number) => Promise<string[]>;
    /** Stores a file in the project, to go with the next message of one of its chats. Rejects with a `TransportError` that carries the daemon's reason when it refuses. */
    uploadAttachment: (projectId: ProjectId, file: File) => Promise<Attachment>;
    /** The bytes of an attachment, to show it. */
    getAttachment: (projectId: ProjectId, attachmentId: string) => Promise<Blob>;
    /** Removes a file that was uploaded and not sent. */
    deleteAttachment: (projectId: ProjectId, attachmentId: string) => Promise<void>;
    /** The skills agents get: system and user ones, and with a project also that project's. */
    getSkills: (projectId?: ProjectId) => Promise<SkillCatalog>;
}

/** The daemon could not be reached, or answered something other than the contract. */
export class TransportError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
        this.name = 'TransportError';
    }
}
