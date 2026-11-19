/**
 * The domain model, as clients see it. The daemon owns the truth; these are snapshots of it.
 * Ids are opaque strings. Times are epoch milliseconds.
 */

export type ProjectId = string;
export type FolderId = string;
export type ChatId = string;
export type TaskId = string;
export type RunId = string;
export type ArtifactId = string;

/** How a chat's orchestrator works: decides alone, or asks the user about significant forks. */
export type ChatMode = 'autopilot' | 'semi';

export interface Project {
    id: ProjectId;
    name: string;
    /**
     * The folders the project works in, at least one, in the person's order. The first is the main folder: agents work in it, and its own
     * `AGENTS.md` or `CLAUDE.md` is theirs; the others reach them as additional folders. A folder may be in other projects too.
     */
    folders: ProjectFolder[];
    /** Task prefix shown on cards, e.g. `CLW` gives `CLW-12`. */
    taskPrefix: string;
    settings: ProjectSettings;
    createdAt: number;
    /** Where the person put the project in their own order, lower first. The personal space is always listed first, whatever its number. */
    position: number;
    /**
     * The person's own space: a folder in the app's data for chats that belong to no repository. Exactly one project is, the daemon makes it
     * at its first start, it is listed first, and it cannot be renamed, moved or removed.
     */
    personal?: boolean;
}

/** One folder of a project: any folder on the machine, a git repository or not. */
export interface ProjectFolder {
    /** Stays while the folder belongs to the project, whatever its place in the list. */
    id: FolderId;
    /** Absolute, with symbolic links resolved. */
    path: string;
}

/** The main folder of a project: the first of its folders, where its agents work. */
export function mainFolder(project: Pick<Project, 'folders'>): ProjectFolder {
    return project.folders[0] as ProjectFolder;
}

/**
 * A short name for each folder, in the same order, to tell the folders of one project apart: the last part of the path, with `-2`, `-3`… after
 * a name an earlier folder already has. No two names are the same, even when a folder is itself called `app-2`.
 */
export function folderNames(folders: readonly Pick<ProjectFolder, 'path'>[]): string[] {
    const taken = new Set<string>();

    return folders.map(({ path }) => {
        const base = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
        let name = base;

        for (let count = 2; taken.has(name); count++) {
            name = `${ base }-${ count }`;
        }

        taken.add(name);

        return name;
    });
}

/**
 * What the daemon reads about a project when it is asked (`GET /v1/projects/info`): things that change outside the app or that no
 * snapshot carries, for the page that manages projects.
 */
export interface ProjectInfo {
    projectId: ProjectId;
    /** One entry per folder, in the project's order. */
    folders: ProjectFolderInfo[];
    chats: number;
    tasks: number;
    /** Runs that are not finished. Removing the project or choosing another main folder waits until there are none. */
    activeRuns: number;
}

export interface ProjectFolderInfo {
    folderId: FolderId;
    /**
     * False when the folder is gone (moved or deleted). Without its main folder the project cannot work until the folders change; another
     * missing folder is left out of what the agents get.
     */
    exists: boolean;
    /** The `origin` remote as git prints it (`git@github.com:acme/app.git`); absent without a remote, or when the folder is not a repository. */
    remoteUrl?: string;
}

export interface ProjectSettings {
    /** Concurrent runs for this project; the daemon also applies a global cap. */
    maxParallelRuns?: number;
    /**
     * The agent of a new chat in this project, or `LAST_USED`. Left out, the project follows the app's own choice (Settings > Chat). The daemon reads an
     * agent only (`projectEngine`), for a chat that names none.
     */
    engine?: EngineId | typeof LAST_USED;
    /**
     * The mode of a new chat in this project, or `LAST_USED`; left out, the app's own choice. The daemon reads a mode only (`projectChatMode`): for the
     * chats it opens itself (a started task) and for `chat.create` without one, which then default to autopilot.
     */
    chatMode?: ChatMode | typeof LAST_USED;
    model?: string;
    /**
     * The picture the person uploaded for the project, as the app made it: a small square PNG as a `data:image/png;base64,` URL. The project
     * menu and the project list show it in place of the folder icon. Left out, they show the icon the daemon finds in the main folder
     * (`GET /v1/projects/:id/icon`), or the folder icon. The personal space has none.
     */
    icon?: string;
    /** Not used by the daemon: agents decide about branches themselves. Kept so older settings stay valid. */
    targetBranch?: string;
}

/** The id of an agent the daemon can run: `claude`, `codex`, `cursor`, a custom agent's id, or `fake` (the scripted demo engine). */
export type EngineId = string;

/**
 * A project's choice for its new chats that keeps what the person picked last on their computer, in place of an agent or a mode. Only the app knows
 * what that was, so the daemon reads it as no choice. It cannot be an agent's id, which never starts with `~`.
 */
export const LAST_USED = '~last-used';

/** The agent a project names for its new chats, leaving out `LAST_USED`, which only the app can resolve. */
export function projectEngine(settings: ProjectSettings): EngineId | undefined {
    return settings.engine === LAST_USED ? undefined : settings.engine;
}

/** The mode a project names for its new chats, leaving out `LAST_USED`, which only the app can resolve. */
export function projectChatMode(settings: ProjectSettings): ChatMode | undefined {
    return settings.chatMode === LAST_USED ? undefined : settings.chatMode;
}

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
    /**
     * Messages the person wrote while the orchestrator worked, waiting for it: the steers first, then the next turns, each part in its own order.
     * Absent when nothing waits.
     */
    queue?: QueuedMessage[];
    /** Why the queue waits for the person (Send now on a message) instead of going out when the orchestrator rests. Absent while it flows, and whenever it is empty. */
    queuePaused?: QueuePause;
    createdAt: number;
    updatedAt: number;
}

/** How a message written while the orchestrator works reaches it: `steer` hands it to the turn in flight when the agent can take one, `queue` waits for the next turn. */
export type QueuedMessageMode = 'steer' | 'queue';

/** Why a chat's queue holds: the person pressed Stop, or the turn failed (or the daemon restarted under it). */
export type QueuePause = 'stopped' | 'failed';

/** A request the person made with a button instead of words: `compact` runs the agent's own compact command (`chat.compact`). */
export type QueuedCommand = 'compact';

/**
 * A message waiting for a busy orchestrator. It reaches the agent as the next turn when the orchestrator rests (one message per turn, steers first),
 * or earlier as a steer of the running turn. The stream shows the person's message only from the moment the agent got it.
 */
export interface QueuedMessage {
    id: string;
    mode: QueuedMessageMode;
    /**
     * Set on a compact item (`chat.compact` while the orchestrator worked): always a next turn (`queue`), never a steer, and it runs only once the orchestrator
     * has finished and read its children's results. Its turn is the command alone, with no `user` item; `text` is what the queue shows, `content` the command.
     */
    command?: QueuedCommand;
    /** What the person wrote, as the stream's `user` item will show it; may be empty when files are attached. */
    text: string;
    /** The files of the message. The daemon keeps them for it from the moment it was queued. */
    attachments?: Attachment[];
    /** What the agent is told: the text and, after a blank line, where the files are (as `chat.send` tells it). */
    content: string;
    createdAt: number;
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

/**
 * Whether a chat's orchestrator in this status takes a message only later, so the message waits in the chat's queue (`Chat.queue`): it works, or waits
 * for an answer, a slot or a reset. One that has finished, or only waits for its children, is at rest and takes a message at once.
 */
export function isBusyRunStatus(status: RunStatus): boolean {
    return !isTerminalRunStatus(status) && status !== 'waiting_children';
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
    /**
     * For a `native` run, the id of the tool call in its parent's stream that started it (the agent's own `Agent` or `Task` call), so the card
     * drawn for that call finds its child. Absent when the engine did not say, and for every other run.
     */
    parentToolCallId?: string;
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
    /**
     * Why the last turn of a `failed` run failed, when the agent said, as a stable identifier: `context_too_long` (the conversation no longer fits the
     * model's window, so the chat offers Compact), `not_logged_in`, `usage_limit` and the other codes of the daemon's failure classes. Gone once it works again.
     */
    failureCode?: string;
    /** Tokens and cost the engine reported, summed over the run's turns. */
    usage?: RunUsage;
    /** The context window of the engine's session, as of its latest report (written when it moves by a percent, and when a turn ends). */
    context?: RunContext;
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
}

/** How full the agent's context window was at its latest report, in tokens. Only agents that report it have one (Claude and Codex do, Cursor does not). */
export interface RunContext {
    used: number;
    size: number;
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

/** The `error` of a call that was still running when the person stopped the run, or the daemon stopped: the app reads it as stopped, not failed. */
export const STOPPED_TOOL = 'Stopped before it finished';

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

/**
 * The documents of one folder of a project: Markdown files under its `.clowdy/docs`. A folder whose docs folder does not exist yet has no nodes;
 * the first document written there makes it.
 */
export interface DocsFolder {
    folderId: FolderId;
    nodes: DocNode[];
}

export interface DocFile {
    path: string;
    content: string;
    /** SHA-256 of the content on disk; send it back as `baseHash` when saving. */
    hash: string;
}
