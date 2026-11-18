/**
 * The domain model, as clients see it. The daemon owns the truth; these are snapshots of it.
 * Ids are opaque strings. Times are epoch milliseconds.
 */

export type ProjectId = string;
export type ChatId = string;
export type TaskId = string;
export type RunId = string;
export type ArtifactId = string;

/** How a chat's orchestrator works: decides alone, or asks the user about significant forks. */
export type ChatMode = 'autopilot' | 'semi';

export interface Project {
    id: ProjectId;
    name: string;
    /** Absolute path of the repository's working copy. */
    path: string;
    /** Task prefix shown on cards, e.g. `CLW` gives `CLW-12`. */
    taskPrefix: string;
    settings: ProjectSettings;
    createdAt: number;
}

export interface ProjectSettings {
    /** Concurrent runs for this project; the daemon also applies a global cap. */
    maxParallelRuns?: number;
    engine?: EngineId;
    /** The mode of chats the daemon opens itself (a started task) and of new chats that name none. Defaults to autopilot. */
    chatMode?: ChatMode;
    model?: string;
    /** Not used by the daemon: agents decide about branches themselves. Kept so older settings stay valid. */
    targetBranch?: string;
}

/** The id of an agent the daemon can run: `claude`, `codex`, `cursor`, a custom agent's id, or `fake` (the scripted demo engine). */
export type EngineId = string;

export interface Chat {
    id: ChatId;
    projectId: ProjectId;
    title: string;
    mode: ChatMode;
    /**
     * The agent that answers this chat, with the model and reasoning level it runs on, in the agent's own spelling.
     * Chosen with the chat, fixed once the first message started the orchestrator; `model` and `effort` may change at any time and
     * apply from the next turn. Absent on a chat that has not been given one: the first message then takes the project's or the daemon's.
     */
    engine?: EngineId;
    model?: string;
    effort?: string;
    /** The orchestrator run that answers this chat, once the first message started one. */
    orchestratorRunId?: RunId;
    /** When the person archived the chat; absent for a chat in use. An archived chat keeps its runs, tasks and stream, and a message to it brings it back. */
    archivedAt?: number;
    createdAt: number;
    updatedAt: number;
}

/* ---------------------------------- Tasks --------------------------------- */

/** A project's workflow column. Names are free text; `category` is what logic may rely on. */
export interface TaskStatus {
    id: string;
    name: string;
    category: TaskStatusCategory;
}

export type TaskStatusCategory = 'backlog' | 'todo' | 'active' | 'review' | 'done' | 'canceled';

/** Where a task came from or is mirrored to. The internal list is the source of truth; providers are optional. */
export interface TaskExternalRef {
    provider: string;
    externalId: string;
    url?: string;
}

export interface Task {
    id: TaskId;
    projectId: ProjectId;
    /** Per-project sequence number; `key` is `${taskPrefix}-${number}`. */
    number: number;
    key: string;
    title: string;
    description: string;
    statusId: string;
    /** Tasks that must be done before this one can start. */
    dependsOn: TaskId[];
    createdBy: Actor;
    external?: TaskExternalRef;
    createdAt: number;
    updatedAt: number;
}

export type Actor = { kind: 'user' } | { kind: 'run'; runId: RunId } | { kind: 'provider'; provider: string };

/** A chat discusses a task, many-to-many. */
export interface ChatTaskLink {
    chatId: ChatId;
    taskId: TaskId;
}

/* ---------------------------------- Runs ---------------------------------- */

export type RunRole = 'orchestrator' | 'executor' | 'verifier';

export type RunOrigin = 'spawned' | 'native';

/** What a run is doing, or why it is not. `waiting_*` and `blocked` always carry a reason on the run. */
export type RunStatus =
    | 'queued'
    | 'running'
    | 'waiting_children'
    | 'waiting_user'
    | 'blocked'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'interrupted';

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running', 'waiting_children', 'waiting_user', 'blocked'];
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled', 'interrupted'];

export function isTerminalRunStatus(status: RunStatus): boolean {
    return TERMINAL_RUN_STATUSES.includes(status);
}

export interface Run {
    id: RunId;
    projectId: ProjectId;
    /** The run that spawned this one; absent for roots (a chat's orchestrator, a task started by the user). */
    parentRunId?: RunId;
    rootRunId: RunId;
    /** The chat this run answers, for orchestrators started from a chat. */
    chatId?: ChatId;
    role: RunRole;
    /**
     * `native` marks a sub-agent that lives inside its parent's engine session (Claude's `Agent` tool and the like): it
     * has no process, no slot and no tasks of its own. `spawned` marks a run another run started with `run_spawn`.
     * Absent for roots (a chat's orchestrator).
     */
    origin?: RunOrigin;
    /** Short label: an agent name such as `Executor 07`, or the orchestrator's. */
    name: string;
    /** One line on the current work. */
    summary: string;
    status: RunStatus;
    /** Why it waits: a question, a dependency, a limit, a child run. */
    statusReason?: string;
    engine: EngineId;
    model?: string;
    /** The reasoning level, in the engine's own spelling; absent leaves the engine's own choice. */
    effort?: string;
    /** The engine's own session id, for resuming. */
    sessionId?: string;
    /** Not filled in: the daemon has no git machinery, agents manage their own worktrees. */
    worktree?: RunWorktree;
    /** Final report on success, error message on failure. */
    result?: string;
    error?: string;
    /** Tokens and cost the engine reported, summed over the run's turns. */
    usage?: RunUsage;
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
}

export interface RunUsage {
    inputTokens: number;
    outputTokens: number;
    costUsd?: number;
}

export interface RunWorktree {
    path: string;
    branch: string;
    baseCommit: string;
    /** The commit the run ended on, when it committed. */
    headCommit?: string;
}

/** A run works on tasks, many-to-many. */
export interface RunTaskLink {
    runId: RunId;
    taskId: TaskId;
    /** `assigned` runs execute the task; `created` runs created it; `verifies` runs check it. */
    relation: 'assigned' | 'created' | 'verifies';
}

/**
 * One entry of a run's or a chat's stream, in order. Streaming text updates one `assistant` item in place;
 * a reconnecting client sees the same items, never duplicated fragments.
 */
export interface StreamItem {
    id: string;
    /** The run this belongs to. Chat messages the user typed belong to the chat's orchestrator run. */
    runId: RunId;
    seq: number;
    at: number;
    body: StreamItemBody;
}

/** A file the person attached to a message. The daemon keeps the bytes; the agent is told where they are. */
export interface Attachment {
    id: string;
    /** The file name as the person's computer had it, cleaned of path parts. */
    name: string;
    /** IANA media type; `application/octet-stream` when nothing better is known. */
    mediaType: string;
    /** Bytes. */
    size: number;
}

export type StreamItemBody =
    /** `text` is what the person wrote, and may be empty when files are attached; the line that tells the agent where the files are is not part of it. */
    | { kind: 'user'; text: string; attachments?: Attachment[] }
    | { kind: 'assistant'; text: string; done: boolean }
    | { kind: 'tool'; toolCallId: string; name: string; input: unknown; state: ToolState; output?: unknown; error?: string }
    /** A system line such as "2 executors started". */
    | { kind: 'note'; text: string }
    /** A question the run is waiting on (semi-manual mode); `answer` is set once the user replied. */
    | { kind: 'question'; questionId: string; text: string; options: QuestionOption[]; recommended?: string; answer?: string }
    | { kind: 'error'; text: string };

export type ToolState = 'running' | 'done' | 'error';

export interface QuestionOption {
    id: string;
    label: string;
    consequence?: string;
}

/* -------------------------------- Artifacts ------------------------------- */

export type ArtifactKind = 'diff' | 'commit' | 'check' | 'doc' | 'build';

export interface Artifact {
    id: ArtifactId;
    projectId: ProjectId;
    runId?: RunId;
    taskId?: TaskId;
    kind: ArtifactKind;
    title: string;
    /** Kind-specific reference: commit sha and branch, check command and exit code, doc path, build path. */
    ref: Record<string, unknown>;
    createdAt: number;
}

/* -------------------------------- Documents ------------------------------- */

export interface DocNode {
    /** Path relative to the docs folder, `/`-separated. */
    path: string;
    name: string;
    kind: 'file' | 'dir';
    children?: DocNode[];
}

export interface DocFile {
    path: string;
    content: string;
    /** SHA-256 of the content on disk; send it back as `baseHash` when saving. */
    hash: string;
}
