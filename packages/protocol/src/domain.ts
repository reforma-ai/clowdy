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
    /**
     * The branch the folder has checked out, or on a detached HEAD the short hash of the commit (with `detached`); absent when the folder is not a repository or is
     * missing.
     */
    branch?: string;
    /** `branch` is a short commit hash, since HEAD points at a commit and not at a branch. */
    detached?: true;
    /** How many chats work in this folder by choice (`Chat.folderId`): they go back to the main folder when the folder leaves the project. */
    chats: number;
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
     * menu and the project list show it in place of the folder icon. `NO_PROJECT_ICON` keeps the folder icon. Left out, they show the icon
     * the daemon finds in the main folder (`GET /v1/projects/:id/icon`), or the folder icon. The personal space has none.
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

/** `ProjectSettings.icon` of a project the person took the icon from: it shows the folder icon, even with a favicon in its main folder. */
export const NO_PROJECT_ICON = 'none';

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
    /**
     * Set on a thread: a chat that an agent of this chat started (`clowdy thread spawn`). The thread is a chat like any other, with its own agent, queue
     * and composer, which the person may open and write to; the link only places it below this chat in the list and decides who is told when it stops.
     * Absent on a chat the person made.
     */
    parentChatId?: ChatId;
    /**
     * The folder of the project the chat works in, set when the chat was made from a folder other than the main one and never changed after. Absent
     * for a chat that follows the main folder, whichever it is. A folder that leaves the project hands its chats back to the main folder: the daemon
     * clears the field, and the chat's next turn starts a new conversation. A thread has its parent's.
     */
    folderId?: FolderId;
    /**
     * Set on a chat made by `chat.fork`: where its conversation was taken from. `atSeq` is the `seq` of the last item the new chat's stream has from the
     * source (the answer the fork was made at), so what comes after it is the fork's own; the copied items keep the `seq` they had in the source. A fork is no
     * thread (`parentChatId` stays empty) and no child: it lives on when the source is archived or deleted, which leaves `chatId` naming a chat that is gone.
     * Set when the chat is made; it changes only when `chat.edit` cuts into the history the fork inherited (an edited message at or before `atSeq`), which
     * moves `atSeq` back to the item before the edited message (`0` when nothing inherited is left). Absent on every other chat.
     */
    forkedFrom?: { chatId: ChatId; atSeq: number };
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

/** How a thread ended its turn, as its parent is told. */
export type ThreadOutcome = 'finished' | 'failed' | 'interrupted';

/** What a parent is told of one thread that stopped. Notices of the same thread that the parent has not read yet are merged: the latest wins. */
export interface ThreadNotice {
    chatId: ChatId;
    /** The thread's title when it stopped. */
    title: string;
    outcome: ThreadOutcome;
    /** The thread's last words (clipped), or why it failed; absent when it said nothing. */
    text?: string;
    /** Titles of what the thread still has open in the background: its text is then not its final result. */
    background?: string[];
}

/**
 * Where a message came from when the person did not write it. `thread` is a message another thread of the same tree sent (`clowdy thread tell`, or the
 * first message a parent gave when it started the thread); `threadNotice` is what a parent is told when threads below it stop, one entry per thread.
 */
export type MessageSource =
    | { kind: 'thread'; chatId: ChatId; title: string }
    | { kind: 'threadNotice'; threads: ThreadNotice[] };

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
     * has finished. Its turn is the command alone, with no `user` item; `text` is what the queue shows, `content` the command.
     */
    command?: QueuedCommand;
    /** What the person wrote, as the stream's `user` item will show it; may be empty when files are attached. */
    text: string;
    /** The files of the message. The daemon keeps them for it from the moment it was queued. */
    attachments?: Attachment[];
    /** What the agent is told: the text and, after a blank line, where the files are (as `chat.send` tells it). */
    content: string;
    /** Set when another thread wrote it, or it reports threads that stopped (`text` is then a one-line summary): the stream's `user` item carries it. */
    from?: MessageSource;
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

/** A task in one of these categories is finished: it releases the tasks that wait for it and no longer counts as work in flight. */
export const CLOSED_TASK_CATEGORIES: readonly TaskStatusCategory[] = ['done', 'canceled'];

export function isClosedCategory(category: TaskStatusCategory): boolean {
    return CLOSED_TASK_CATEGORIES.includes(category);
}

/**
 * How many levels a tree of tasks may have through the daemon's commands and tools: a root is level 1. It is GitHub's limit, so a tracker imported later
 * fits. The store itself has no limit; moving a task checks the deepest task of its subtree too.
 */
export const MAX_TASK_DEPTH = 8;

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
    /** Tasks that must be closed (done or canceled) before this one can start. */
    dependsOn: TaskId[];
    /** The task this one is part of; absent for a root. A task may hold tasks down to `MAX_TASK_DEPTH` levels. */
    parentId?: TaskId;
    createdBy: Actor;
    external?: TaskExternalRef;
    createdAt: number;
    updatedAt: number;
    /** When the task entered a closed status (`isClosedCategory`); absent while it is open. Unlike `updatedAt` it does not move with every edit. */
    closedAt?: number;
    /**
     * When the task was archived; absent for a task that is not. An archived task is closed, is not in the project snapshot or in the roll-ups of the board,
     * and is still found by its key or id (a dependency or a mention on it resolves). The tasks archived together, a task and what is inside it, share one
     * `archivedAt`, and restoring the task restores exactly those. A client treats a task with `archivedAt` as off the board.
     */
    archivedAt?: number;
}

export type Actor = { kind: 'user' } | { kind: 'run'; runId: RunId } | { kind: 'provider'; provider: string };

/**
 * A Markdown note on a task, from the person or from a run. Comments are not in the project snapshot (a task may collect any number): a client reads
 * them from `GET /v1/tasks/:id/comments` when it shows a task, and follows `task.comment.upserted` and `task.comment.deleted` after that.
 */
export interface TaskComment {
    id: string;
    taskId: TaskId;
    /** Who wrote it: the person for a command of the app, the run for a comment an agent left. */
    author: Actor;
    /** Markdown, never empty. */
    body: string;
    createdAt: number;
    /** When the body was last changed; absent until it is. */
    editedAt?: number;
}

/** A chat discusses a task, many-to-many. */
export interface ChatTaskLink {
    chatId: ChatId;
    taskId: TaskId;
}

/* ---------------------------------- Runs ---------------------------------- */

/** `executor` is the role of a native sub-agent's child run; every other run is a chat's orchestrator. */
export type RunRole = 'orchestrator' | 'executor';

/** A run's origin: `native` is a sub-agent that lives inside its parent's engine session. Absent for a chat's orchestrator. */
export type RunOrigin = 'native';

/** What a run is doing, or why it is not. `waiting_*` and `blocked` always carry a reason on the run. */
export type RunStatus =
    | 'queued'
    | 'running'
    | 'waiting_background'
    | 'waiting_user'
    | 'blocked'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'interrupted';

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running', 'waiting_background', 'waiting_user', 'blocked'];
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled', 'interrupted'];

export function isTerminalRunStatus(status: RunStatus): boolean {
    return TERMINAL_RUN_STATUSES.includes(status);
}

/**
 * Whether a chat's orchestrator in this status takes a message only later, so the message waits in the chat's queue (`Chat.queue`): it works, or waits
 * for an answer, a slot or a reset. One that has finished, or only waits for background work its session keeps open, is at rest and takes a message at once.
 */
export function isBusyRunStatus(status: RunStatus): boolean {
    return !isTerminalRunStatus(status) && status !== 'waiting_background';
}

/**
 * The status a person reads a run by. It is the run's own, except that a run with a question or a request for permission open to the person
 * (`Run.awaitingUser`) reads `waiting_user` while it works or rests for its background work: its session goes on, so the status stays what it was
 * (`waiting_background` leads to no `waiting_user`), and the card is all that says it needs the person. Every place that tells a run that waits for
 * the person from one that does not (a chat's dot, a thread's row, a thread as its parent reads it) goes by this, and logic (what takes a message, what
 * can be stopped) by `status`.
 */
export function shownRunStatus(run: Pick<Run, 'status' | 'awaitingUser'>): RunStatus {
    return run.awaitingUser === true && (run.status === 'running' || run.status === 'waiting_background') ? 'waiting_user' : run.status;
}

/** Why the run waits, as it reads beside `shownRunStatus`: its own reason, except where the card open to the person overrides a status that says otherwise. */
export function shownRunReason(run: Pick<Run, 'status' | 'awaitingUser' | 'statusReason'>): string | undefined {
    return shownRunStatus(run) === run.status ? run.statusReason : 'Waiting for you';
}

export interface Run {
    id: RunId;
    projectId: ProjectId;
    /** The run whose engine session this native sub-agent lives in; absent for roots (a chat's orchestrator, a task started by the user). */
    parentRunId?: RunId;
    rootRunId: RunId;
    /** The chat this run answers, for orchestrators started from a chat. */
    chatId?: ChatId;
    role: RunRole;
    /**
     * `native` marks a sub-agent that lives inside its parent's engine session (Claude's `Agent` tool and the like): it
     * has no process, no slot and no tasks of its own. Absent for roots (a chat's orchestrator).
     */
    origin?: RunOrigin;
    /**
     * For a `native` run, the id of the tool call in its parent's stream that started it (the agent's own `Agent` or `Task` call), so the card
     * drawn for that call finds its child. Absent when the engine did not say, and for every other run.
     */
    parentToolCallId?: string;
    /**
     * For a `native` run whose engine session can end it alone: `run.cancel` of this run ends this sub-agent and nothing else, while the parent's
     * session and its other sub-agents go on. Absent when the session cannot (the engine has no such request, or the agent did not offer it for this
     * sub-agent): `run.cancel` of such a run is refused, and only its parent's cancel ends it. Set when the run is made and never changed.
     */
    canStopAlone?: boolean;
    /** Short label: the orchestrator's (`Orchestrator 01`), or a sub-agent's type as its engine names it (`Explore`). */
    name: string;
    /** One line on the current work. */
    summary: string;
    status: RunStatus;
    /** Why it waits: a question, a dependency, a limit, background work. */
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
    /**
     * What the agent has open in the background while its session outlives a turn (a command, a sub-agent, a workflow): the engine's latest complete
     * list. Absent when nothing is open, which is how most runs stay.
     */
    background?: BackgroundItem[];
    /**
     * Set while a question or a request for permission of the run is open to the person, whatever the run's status: a run that works is parked in
     * `waiting_user` for it, but one whose agent asks while the session rests for its background work (a turn the agent started by itself, a sub-agent
     * that goes on) keeps `waiting_background`, and its card is the only sign. Absent when nothing is open, and once the run is over. Read it through
     * `shownRunStatus`.
     */
    awaitingUser?: boolean;
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
}

/** How full the agent's context window was at its latest report, in tokens. Only agents that report it have one (Claude and Codex do, Cursor does not). */
export interface RunContext {
    used: number;
    size: number;
}

/** One thing an agent started in the background, for the person to see that the run is not over. */
export interface BackgroundItem {
    /** The engine's own id of it, stable while it is open: what tells one item from another across snapshots. */
    id: string;
    kind: 'command' | 'subagent' | 'task';
    /** What it is, in a few words: the command, the sub-agent's name, the task's. */
    title: string;
    /**
     * The agent lets the client end this item alone (`run.stopBackground`), leaving the session and everything else it has open running. Set by the engine
     * from what the agent said of the item (an ACP terminal that advertises `terminal/cancel`); absent when it cannot be stopped alone, and for a
     * sub-agent that has a child run (its row stops it through the child run, `Run.canStopAlone`). An item without it is ended only with the run.
     */
    canStopAlone?: boolean;
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
    /** `assigned` runs execute the task; `created` runs created it. */
    relation: 'assigned' | 'created';
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
    /**
     * Set (`true`) only on the final answer of a finished turn that the chat's agent can fork the conversation at: the daemon holds the agent's own id of
     * the message as a rewind point, and the agent can cut its session there. Never written as `false`; absent everywhere else, so a client draws Fork
     * where it is set and nowhere it is not.
     */
    canFork?: boolean;
    /**
     * Set (`true`) only on a message of the person's own (a `user` item without `from`) that starts a turn (the first item of the chat, or the first one
     * after a turn that ended at a rewind point) in a chat whose agent can cut its session there: the message may be edited and sent again. A steer
     * inside a running turn, a message another chat wrote and a message that follows a turn from before rewind points were kept are not. Never written as `false`.
     */
    canEdit?: boolean;
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
    | { kind: 'user'; text: string; attachments?: Attachment[]; from?: MessageSource }
    | { kind: 'assistant'; text: string; done: boolean }
    /**
     * What the agent thought between its other steps, in its own words as it streams (`done` once it moved on to something else), and how long it took
     * (`durationMs`, set with `done`). Not part of the story the agent is told again, and not an answer: it is shown folded, as the work of a turn.
     */
    | { kind: 'reasoning'; text: string; done: boolean; durationMs?: number }
    | { kind: 'tool'; toolCallId: string; name: string; input: unknown; state: ToolState; output?: unknown; error?: string }
    /** A system line such as "Background command finished: bun test". */
    | { kind: 'note'; text: string }
    /** A question the run is waiting on (semi-manual mode); `answer` is set once the user replied. */
    | { kind: 'question'; questionId: string; text: string; options: QuestionOption[]; recommended?: string; answer?: string }
    /**
     * A request of the agent for permission to do something, put to the person (an agent on a preset that asks). The run waits in `waiting_user` while any
     * is `open`. `decisions` are the answers the agent's options allow, by kind; `decision` is set once the person answered (`run.decide`) or Clowdy
     * answered from a grant. `cancelled`: the agent withdrew it or the run was stopped; `expired`: the daemon restarted and the agent is gone.
     */
    | { kind: 'approval'; approvalId: string; toolCallId?: string; title: string; subject: ApprovalSubject; decisions: ApprovalDecision[]; state: ApprovalState; decision?: ApprovalDecision }
    | { kind: 'error'; text: string };

/** What an agent asks to do: a command, a change to files, or any other tool. The daemon classifies the request, so a client draws it with no knowledge of the agent. */
export type ApprovalSubject =
    | { kind: 'command'; command: string; cwd?: string }
    | { kind: 'file_change'; paths: string[] }
    | { kind: 'tool_use'; tool: string; detail?: string };

/** The three answers: once (`allow_once`), for the rest of the run (`allow_always`: Clowdy remembers the request and answers the agent with its one-time allow, so no lasting rule of the agent's is written), no (`reject`, for the agent's `reject_once` and `reject_always`). */
export type ApprovalDecision = 'allow_once' | 'allow_always' | 'reject';

export type ApprovalState = 'open' | 'decided' | 'cancelled' | 'expired';

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
 * The documents of one folder of a project: Markdown files under its `.clowdy/docs`. A folder whose docs folder does not exist has no nodes.
 */
export interface DocsFolder {
    folderId: FolderId;
    nodes: DocNode[];
}
