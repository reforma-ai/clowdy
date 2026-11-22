import type { FileSystemProvider, SearchService } from '@clowdy/file-manager/provider';
import type {
    AgentInfo,
    AgentModels,
    Attachment,
    ChatId,
    ClowdyEvent,
    Command,
    CommandResult,
    DocFile,
    DocsTree,
    FolderId,
    ProjectFileMatch,
    ProjectId,
    ProjectInfo,
    ProjectSnapshot,
    RootSnapshot,
    RunId,
    SkillCatalog,
    StreamItem,
    TaskArchivePage,
    TaskCommentsPage,
    TaskDetail,
    TaskId,
    TerminalCreate,
    TerminalId,
    TerminalInfo,
} from '@clowdy/protocol';
import type { TerminalStream, TerminalStreamHandlers } from './terminalStream';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A command as the UI builds it. The transport adds the `requestId`. */
export type CommandInput = DistributiveOmit<Command, 'requestId'>;

/**
 * Which page of a paged read: how many rows (a whole number; the daemon holds it to 1 to 100 and answers 25 without one) and where to go on, the `nextCursor`
 * of the page before. Both absent is the first page.
 */
export interface PageQuery {
    limit?: number;
    cursor?: string;
}

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

/** One folder of a project as the file manager uses it: a file system, and the search through its contents when the daemon has one (the file manager reads the files one by one without). */
export interface ProjectFileSystem extends FileSystemProvider {
    search?: SearchService;
}

/** The only way the UI talks to a daemon. */
export interface Transport {
    getRootSnapshot: () => Promise<RootSnapshot>;
    getProjectSnapshot: (projectId: ProjectId) => Promise<ProjectSnapshot>;
    /**
     * What the daemon reads about every project when asked: whether its folder is there, its git remote and branch, what it holds. In the order of the project list.
     * With a project id, that project alone.
     */
    getProjectsInfo: (projectId?: ProjectId) => Promise<ProjectInfo[]>;
    /** Follows the change feed after `cursor`. Returns what ends the subscription. */
    subscribe: (cursor: number, onEvent: (event: ClowdyEvent) => void, onStatus: (status: FeedStatus) => void) => () => void;
    /**
     * Sends a command. The request id is made once per call and kept across the transport's own retries, so the
     * daemon acts once. A command the daemon refused resolves with `ok: false`; a daemon out of reach rejects.
     */
    command: (command: CommandInput) => Promise<CommandResult>;
    getItems: (target: StreamTarget, afterSeq?: number) => Promise<StreamItem[]>;
    getTaskDetail: (taskId: TaskId) => Promise<TaskDetail>;
    /**
     * `getTaskDetail` for the task a key such as `CAR-12` names in the project, an archived one too: how a key met in a message is read when the window does not hold the task.
     * Rejects with a `TransportError` of status 404 for what is not a key of that project (another prefix, no number, a number nobody has, an unknown project).
     */
    getTaskDetailByKey: (projectId: ProjectId, key: string) => Promise<TaskDetail>;
    /** A page of the task's comments, oldest first. Comments are not in the snapshot: read them when a task shows them, and again when `ProjectState.commentsRevision` of the task changes. */
    getTaskComments: (taskId: TaskId, page?: PageQuery) => Promise<TaskCommentsPage>;
    /** A page of the project's archived tasks, the ones the snapshot leaves out, newest archived first. */
    getArchivedTasks: (projectId: ProjectId, page?: PageQuery) => Promise<TaskArchivePage>;
    /** The project's documents: one entry per folder, in the project's order, a folder that has none yet too. */
    getDocsTree: (projectId: ProjectId) => Promise<DocsTree>;
    /** A document of one of the project's folders, by its path under that folder's `.clowdy/docs`. */
    getDocFile: (projectId: ProjectId, folderId: FolderId, path: string) => Promise<DocFile>;
    /** Files of the project's folders whose path contains every word of `query`, best match first, each with its folder and its path relative to that folder. */
    getProjectFiles: (projectId: ProjectId, query: string, limit?: number) => Promise<ProjectFileMatch[]>;
    /** One folder of the project as a file system, for the file manager to browse and edit; the daemon checks every path against the folder. Nothing is asked until the file system is used. */
    fileSystem: (projectId: ProjectId, folderId: FolderId) => ProjectFileSystem;
    /** Stores a file in the project, to go with the next message of one of its chats. Rejects with a `TransportError` that carries the daemon's reason when it refuses. */
    uploadAttachment: (projectId: ProjectId, file: File) => Promise<Attachment>;
    /** The bytes of an attachment, to show it. */
    getAttachment: (projectId: ProjectId, attachmentId: string) => Promise<Blob>;
    /** Removes a file that was uploaded and not sent. */
    deleteAttachment: (projectId: ProjectId, attachmentId: string) => Promise<void>;
    /** The icon the daemon finds in the project's main folder (a favicon, an app icon), or `undefined` when there is none. */
    getProjectIcon: (projectId: ProjectId) => Promise<Blob | undefined>;
    /** The skills agents get: system and user ones, and with a project also that project's. */
    getSkills: (projectId?: ProjectId) => Promise<SkillCatalog>;
    /** Every agent the daemon knows, with who is signed in to it, its usage and its settings. */
    getAgents: () => Promise<AgentInfo[]>;
    /** The models an agent offers, with the reasoning levels of each. The daemon reads them from the agent's own program and keeps them for ten minutes. */
    getAgentModels: (agentId: string) => Promise<AgentModels>;
    /** The shells the daemon runs, those of one project when it is named: running ones and recently exited ones, oldest first. */
    listTerminals: (projectId?: ProjectId) => Promise<TerminalInfo[]>;
    /** Starts a shell in a folder of a project, at the given size. Rejects with a `TransportError` that carries the daemon's reason when it refuses. */
    createTerminal: (request: TerminalCreate) => Promise<TerminalInfo>;
    /** Ends the shell and forgets the terminal. */
    closeTerminal: (terminalId: TerminalId) => Promise<void>;
    /** Follows one terminal: its screen, its output and its end, and types into it. Reconnects by itself until the terminal is gone or the stream is closed. */
    openTerminal: (terminalId: TerminalId, handlers: TerminalStreamHandlers) => TerminalStream;
}

/** The daemon could not be reached, or answered something other than the contract. */
export class TransportError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
        this.name = 'TransportError';
    }
}
