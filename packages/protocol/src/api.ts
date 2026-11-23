import type { ChatId, FolderId, Task, TaskComment, WorkspaceId } from './domain';

/** Version of this contract. The daemon refuses clients that send a different major in `x-clowdy-protocol`. */
export const PROTOCOL_VERSION = 1;

export const PROTOCOL_HEADER = 'x-clowdy-protocol';

/**
 * HTTP surface, loopback only, `Authorization: Bearer <token>` on everything but `/v1/health`.
 *
 * GET  /v1/health                         -> Health
 * GET  /v1/snapshot                       -> RootSnapshot
 * GET  /v1/projects/:id/snapshot          -> ProjectSnapshot
 * GET  /v1/projects/info                  -> ProjectInfo[] (one per project, in the order of the snapshot: whether each of its folders exists, its
 *                                            git remote and branch and how many chats chose it, and how many chats, tasks and unfinished runs the
 *                                            project has; read when asked, never announced); `?project=ID` answers that project alone (404 when
 *                                            there is none). `workspaces` has one entry for each worktree of the project's chats (`ChatWorkspace`): whether
 *                                            it is there (not made yet, or gone from the disk, is not) and the branch it has checked out now, or on a
 *                                            detached HEAD the short hash with `detached`, read as a folder's is; absent when the project has none)
 * GET  /v1/events?cursor=N                -> text/event-stream of ClowdyEvent (frame name `clowdy`, id = cursor); without a
 *                                            cursor the stream is live only; `Last-Event-ID` also resumes; `&projectId=ID`
 *                                            limits it to one project. 410 when the cursor is ahead of the log (the log is not pruned
 *                                            yet, so a cursor is never too old): fetch a snapshot and resume from its cursor.
 * POST /v1/commands                       -> body Command, answers CommandResult
 * GET  /v1/runs/:id/items?after=SEQ       -> StreamItem[] (a run's stream, also an orchestrator's chat)
 * GET  /v1/chats/:id/items?after=SEQ      -> StreamItem[] (the chat's orchestrator stream)
 * GET  /v1/chats/:id/workspace            -> ChatWorkspaceRemoval (whether the chat's worktree can be removed together with the chat, which is what `chat.delete`'s
 *                                            `removeWorkspace` asks for; `removable` is false for a chat with no worktree; `not_found` for no such chat)
 * GET  /v1/tasks/:id/detail               -> TaskDetail (the task itself, an archived one too, so a client can open a task its snapshot does not hold,
 *                                            with the ids of its chats and runs and its artifacts; `not_found` for no such task)
 * GET  /v1/projects/:id/tasks/:key/detail -> TaskDetail (the same answer as `GET /v1/tasks/:id/detail`, for the task a key such as `CAR-12` names in that
 *                                            project, an archived one too: a client that met a key in a message reads the task without knowing its id. The key
 *                                            is `<the project's taskPrefix>-<number>`, the prefix in any case. `not_found` for anything that is not a key of that
 *                                            project (another prefix, no number, a number nobody has) and for a project that does not exist, so a client reads
 *                                            404 as "no such task")
 * GET  /v1/tasks/:id/comments?limit=&cursor= -> TaskCommentsPage (the task's comments, oldest first; `limit` 1 to 100, default 25; `cursor` is the
 *                                            `nextCursor` of the page before, which is absent on the last page. Comments are not in the snapshot)
 * GET  /v1/projects/:id/archived-tasks?limit=&cursor= -> TaskArchivePage (the project's archived tasks, the ones the snapshot leaves out, newest archived
 *                                            first; `limit` 1 to 100, default 25; `cursor` is the `nextCursor` of the page before, which is absent on the
 *                                            last page)
 * GET  /v1/projects/:id/docs              -> DocsTree (one entry per folder in the project's order, with the document sources it has: the roots of
 *                                            `DOC_SOURCES` that are folders (`.briefback`, `.clowdy/docs`, Spec Kit's, OpenSpec's, Kiro's), each with its
 *                                            Markdown tree; a source with no Markdown file, or that is a link out of the folder, is left out, so a folder
 *                                            with none has an entry with `sources: []`. A missing main folder is `unavailable`; another folder that is
 *                                            missing is left out). `?workspaceId=` lists the documents of that worktree in place of those of its folder's
 *                                            own checkout (a plan an agent wrote there is not in the main checkout), under the folder's id; the other
 *                                            folders are listed as before. A workspace that is not the project's is `not_found`; one not made yet, or
 *                                            gone from the disk, is `unavailable`
 * GET  /v1/projects/:id/git?folderId=    -> FolderGit (what git says about one folder of the project: whether it is the root of a repository, the branch it has
 *                                            checked out, the folder's default branch (`origin/HEAD`, else `origin/main` or `origin/master`, else a local `main` or
 *                                            `master`, else the current HEAD; no network), its branches (local, then those of the remotes, at most `MAX_GIT_BRANCHES`)
 *                                            and its worktrees (`git worktree list`: the working trees only, the folder's own checkout flagged, each with whether it has
 *                                            changes). A folder that is not the root of a repository answers `isRepository: false` and nothing else; `folderId` of no
 *                                            folder of the project is `not_found`, none is `invalid`, and a folder gone from the disk, or a git that does not answer
 *                                            in time, is `unavailable`)
 * GET  /v1/projects/:id/git/status?folderId=&workspaceId= -> GitStatus (what git says of a place, a folder's checkout or a worktree of it: the branch, its upstream, the
 *                                            uncommitted paths and how far the branch is from its base)
 * GET  /v1/projects/:id/git/changes?folderId=&workspaceId=&scope= -> GitChanges (the files that changed in a scope, `all`, `branch`, `uncommitted` or `commit:<sha>`, with
 *                                            their line counts and revisions)
 * GET  /v1/projects/:id/git/file?folderId=&workspaceId=&scope=&path=&oldPath= -> GitFileSides (the text of one changed file before and after). The three are described
 *                                            in `git.ts`
 * GET  /v1/projects/:id/worktrees        -> FolderWorktrees[] (one entry per folder of the project, in the project's order: whether it is the root of a repository and, if
 *                                            it is, its own checkout first and then every worktree git lists for it (one Clowdy made, one an agent or a person made, a locked one,
 *                                            one whose folder is gone), each with the chats that work in it (archived ones too), the number of changed files, whether its work is
 *                                            in the base as last fetched, and why it cannot be removed. A folder that is not a repository, or is gone from the disk, has an entry
 *                                            with `isRepository: false` and no worktrees; `not_found` for no such project, `unavailable` for a git that does not answer)
 * GET  /v1/projects/:id/files?query=&limit=&workspaceId= -> ProjectFileMatch[] (files of the project's folders whose path contains every word of `query`,
 *                                            the folder's name counting as part of the path when there are several; best match first,
 *                                            at most `limit` (default 40, most 100); git's tracked and unignored files, or a walk outside
 *                                            a repository; never a `.clowdy` folder). A missing main folder is `unavailable`; another is skipped.
 *                                            `workspaceId` (optional) lists the files of that worktree in place of its folder's own checkout (a file only
 *                                            the worktree has is included, one only the checkout has is not), under the folder's id and name; the other
 *                                            folders are listed as before. The errors are those of `docs`
 * POST /v1/projects/:id/attachments?name= -> Attachment (the raw request body is the file, `Content-Type` its media type; the daemon keeps
 *                                            it until the message it is sent with is deleted. Refused above `MAX_ATTACHMENT_BYTES`.
 *                                            A file that is never sent is removed after a day)
 * GET  /v1/projects/:id/attachments/:attachmentId -> the file's bytes, with its media type
 * GET  /v1/projects/:id/icon              -> the icon found in the project's main folder (a favicon, an app icon: SVG, PNG or ICO, at most
 *                                            512 KB), with its media type; `not_found` when there is none, and for the personal space. The
 *                                            icon the person uploaded is `ProjectSettings.icon`, which the app shows first
 * DELETE /v1/projects/:id/attachments/:attachmentId -> { ok: true }; only for a file that was not sent yet (`conflict` otherwise)
 * /v1/projects/:id/fs/*                  -> the files of one of the project's folders, or of a worktree of it (`workspaceId` beside `folderId`): list, find,
 *                                            read, write, make a folder, move, copy, delete, watch, search. The routes are described in `fs.ts`
 * /v1/terminals/*                         -> the shells the daemon runs for the app's terminal: list, create, close, and a WebSocket stream of one. The
 *                                            routes are described in `terminals.ts`
 * POST /v1/shutdown                       -> { ok: true }; stops the daemon gracefully (live engines are aborted, their runs
 *                                            come back `interrupted` at the next start, nothing is marked cancelled)
 * GET  /v1/skills?projectId=              -> SkillCatalog (system and user skills; with `projectId` also that project's skills)
 * GET  /v1/agents/:id/models              -> AgentModels (the models the agent offers, read from its own program on first ask and kept for ten minutes; never starts a chat)
 * GET  /v1/agents                         -> AgentInfo[] (every agent the daemon knows, with whether it can start one on this machine, who is
 *                                            signed in, its subscription usage and its settings; answers at once with what is cached and
 *                                            refreshes stale accounts and usage in the background, announcing them with `agents.changed`)
 */
export const ROUTES = {
    health: '/v1/health',
    snapshot: '/v1/snapshot',
    projectsInfo: '/v1/projects/info',
    projectSnapshot: (projectId: string) => `/v1/projects/${ encodeURIComponent(projectId) }/snapshot`,
    events: '/v1/events',
    commands: '/v1/commands',
    runItems: (runId: string) => `/v1/runs/${ encodeURIComponent(runId) }/items`,
    chatItems: (chatId: string) => `/v1/chats/${ encodeURIComponent(chatId) }/items`,
    chatWorkspace: (chatId: string) => `/v1/chats/${ encodeURIComponent(chatId) }/workspace`,
    taskDetail: (taskId: string) => `/v1/tasks/${ encodeURIComponent(taskId) }/detail`,
    projectTaskDetail: (projectId: string, key: string) => `/v1/projects/${ encodeURIComponent(projectId) }/tasks/${ encodeURIComponent(key) }/detail`,
    taskComments: (taskId: string) => `/v1/tasks/${ encodeURIComponent(taskId) }/comments`,
    projectArchivedTasks: (projectId: string) => `/v1/projects/${ encodeURIComponent(projectId) }/archived-tasks`,
    docsTree: (projectId: string) => `/v1/projects/${ encodeURIComponent(projectId) }/docs`,
    projectGit: (projectId: string) => `/v1/projects/${ encodeURIComponent(projectId) }/git`,
    projectGitStatus: (projectId: string) => `/v1/projects/${ encodeURIComponent(projectId) }/git/status`,
    projectGitChanges: (projectId: string) => `/v1/projects/${ encodeURIComponent(projectId) }/git/changes`,
    projectGitFile: (projectId: string) => `/v1/projects/${ encodeURIComponent(projectId) }/git/file`,
    projectWorktrees: (projectId: string) => `/v1/projects/${ encodeURIComponent(projectId) }/worktrees`,
    projectFiles: (projectId: string) => `/v1/projects/${ encodeURIComponent(projectId) }/files`,
    projectAttachments: (projectId: string) => `/v1/projects/${ encodeURIComponent(projectId) }/attachments`,
    projectAttachment: (projectId: string, attachmentId: string) => `/v1/projects/${ encodeURIComponent(projectId) }/attachments/${ encodeURIComponent(attachmentId) }`,
    projectIcon: (projectId: string) => `/v1/projects/${ encodeURIComponent(projectId) }/icon`,
    projectFs: (projectId: string) => `/v1/projects/${ encodeURIComponent(projectId) }/fs`,
    terminals: '/v1/terminals',
    terminal: (terminalId: string) => `/v1/terminals/${ encodeURIComponent(terminalId) }`,
    terminalStream: (terminalId: string) => `/v1/terminals/${ encodeURIComponent(terminalId) }/stream`,
    skills: '/v1/skills',
    agents: '/v1/agents',
    agentModels: (agentId: string) => `/v1/agents/${ encodeURIComponent(agentId) }/models`,
    shutdown: '/v1/shutdown',
} as const;

/** How many folders one project may have. */
export const MAX_PROJECT_FOLDERS = 50;

/** The limits of a folder's workspace settings (`project.updateFolder`): the branch's name, the files a setup copies, and the setup's command in characters. */
export const MAX_BASE_BRANCH_LENGTH = 300;
export const MAX_SETUP_FILES = 50;
export const MAX_SETUP_COMMAND_LENGTH = 4000;

/** The longest `ProjectSettings.icon`: a 64px PNG the app made is a few kilobytes as a data URL. */
export const MAX_PROJECT_ICON_LENGTH = 64 * 1024;

/** What `GET /v1/chats/:id/workspace` says: the chat's worktree and whether deleting the chat may remove it (and its branch) too. */
export interface ChatWorkspaceRemoval {
    /**
     * True only for a worktree that Clowdy made, that is on the disk, that no chat outside this chat and the threads below it uses, in which nothing is uncommitted
     * (a new file counts) and whose branch is contained in the ref it was started from, as last fetched. False when there is no worktree, and for any other reason.
     */
    removable: boolean;
    /** The worktree's path and branch, when the chat has one. */
    path?: string;
    branch?: string;
}

/** The most branches `GET /v1/projects/:id/git` lists: a repository with more is cut, local branches first, and `FolderGit.truncated` says so. */
export const MAX_GIT_BRANCHES = 1000;

/**
 * One branch of a folder's repository: `main` for a local one, `origin/main` for one of a remote's (`remote`). The name is short, not always a ref git takes bare (a tag
 * may be called `main` too): the daemon resolves it as `refs/heads/<name>` for a local branch and `refs/remotes/<name>` for a remote one.
 */
export interface GitBranch {
    name: string;
    remote: boolean;
}

/** One worktree of a repository, as `git worktree list` gives it: the main checkout and the linked ones, whoever made them. */
export interface GitWorktree {
    /** Absolute, written as the machine writes paths (git prints `C:/work` on Windows). */
    path: string;
    /** The branch it has checked out; absent on a detached HEAD. */
    branch?: string;
    /** The first seven characters of the commit it is on; empty on a branch with no commit yet. */
    head: string;
    /** The worktree is the folder itself, which the project holds (when the folder is a linked worktree, that one). */
    main: boolean;
    /** Something in it is not committed, a new file included. Also set when git could not tell in time. */
    dirty: boolean;
}

/** What `GET /v1/projects/:id/git` says about a folder: a repository's branches and worktrees, or that the folder is no repository. */
export type FolderGit = { isRepository: false } | {
    isRepository: true;
    /** The branch the folder has checked out, or on a detached HEAD the short hash of its commit (with `detached`); in a repository with no commit yet, the name its first branch will have. */
    branch?: string;
    detached?: true;
    /** The ref a new worktree starts from unless the person picks another (a `GitBranch.name`, or a short hash on a detached HEAD); absent in a repository with no commit yet. */
    defaultBranch?: string;
    branches: GitBranch[];
    /** `branches` was cut at `MAX_GIT_BRANCHES`. */
    truncated?: true;
    worktrees: GitWorktree[];
};

/** Why a worktree has no Remove: it is the folder's own checkout (or the repository's primary working tree, which git never removes), git has it locked, or a chat works in it. The first that holds, in that order. */
export type WorktreeBlock = 'main' | 'locked' | 'chats';

/** A chat that works in a worktree, as the Manage dialog lists it. */
export interface WorktreeChat {
    id: ChatId;
    title: string;
    archived: boolean;
}

/**
 * One worktree of a folder's repository as `GET /v1/projects/:id/worktrees` describes it: what git lists, whoever made it, with who works in it and how far its work is from
 * the base. The folder's own checkout is the first row of its group.
 */
export interface WorktreeInfo {
    /** Absolute, written as the machine writes paths (git prints `C:/work` on Windows). */
    path: string;
    /** The branch it has checked out; absent on a detached HEAD. */
    branch?: string;
    /** The first seven characters of the commit it is on; empty when git did not say. */
    head: string;
    /** The worktree is the folder's own checkout. */
    main: boolean;
    /** Git lists it but its folder is gone from the disk (`prunable`, or nothing there): only its record can be removed. */
    missing: boolean;
    /** Git has it locked, with the reason (empty when none was given). */
    locked?: string;
    /** How many files have uncommitted changes, a new file counted; 0 when clean, and for a missing worktree. A status that fails or does not answer in time counts as 1, so a row never says clean on a guess. */
    changes: number;
    /** An initialised submodule is checked out in it: `git worktree remove` refuses such a tree without `--force`, whatever `changes` says. */
    submodules: boolean;
    /** The commit it is on and its branch are both in `base`, as last fetched; absent for the folder's own checkout and when no base resolves. A squash merge reads as not merged. */
    merged?: boolean;
    /** The ref `merged` was checked against (`origin/main`): the base the worktree was made from, else the folder's own. Absent with `merged`. */
    base?: string;
    /** The record Clowdy keeps of it (`Chat.workspace.id`), when a chat has worked in it or the new-chat page opened it. */
    workspaceId?: WorkspaceId;
    /** Clowdy made it, under its workspaces folder. */
    managed: boolean;
    /** The chats that work in it, archived ones too, oldest first. */
    chats: WorktreeChat[];
    /** Why it cannot be removed; absent when it can. */
    blocked?: WorktreeBlock;
}

/** What `GET /v1/projects/:id/worktrees` says about one folder of the project: no worktrees for a folder that is no repository, else its own checkout first and every worktree git lists. */
export interface FolderWorktrees {
    folderId: FolderId;
    /** The folder's name, as `folderNames` writes it. */
    name: string;
    /** The folder is the root of a working tree. False for any other folder, and for one gone from the disk. */
    isRepository: boolean;
    worktrees: WorktreeInfo[];
}

/** A file `GET /v1/projects/:id/files` found: the folder of the project it is in, and its path below that folder with `/` separators. */
export interface ProjectFileMatch {
    folderId: FolderId;
    path: string;
}

/** What one message may carry. The composer checks these before it uploads; the daemon refuses what is over. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_ATTACHMENTS_BYTES_PER_MESSAGE = 100 * 1024 * 1024;

export interface Health {
    ok: true;
    protocol: number;
    version: string;
    pid: number;
    startedAt: number;
    /** Runs that are queued, running, waiting or blocked, not counting sub-agents inside a session. A client asks before stopping a daemon where this is above 0. */
    activeRuns?: number;
}

/** What a client needs to find a running daemon; the daemon writes it to its data dir on start. */
export interface DaemonInfo {
    pid: number;
    port: number;
    token: string;
    protocol: number;
    startedAt: number;
}

export interface TaskDetail {
    taskId: string;
    /** The task as it is now, an archived one included: the project snapshot leaves archived tasks out, so this is how a client reads one it does not hold. */
    task: Task;
    chatIds: string[];
    runIds: string[];
    artifacts: import('./domain').Artifact[];
}

/**
 * One page of a project's archived tasks, newest archived first (the tasks of one archive batch share their `archivedAt` and follow each other in the order
 * of their numbers). Each is a `Task` with `archivedAt` set; the tree of a batch is rebuilt from `parentId`, whose parent may be on this page, on another,
 * or not archived at all.
 */
export interface TaskArchivePage {
    tasks: Task[];
    /** How many tasks the project has in the archive, whatever the page holds. */
    total: number;
    /** Passed as `cursor` it gives the next page; absent on the last one. */
    nextCursor?: string;
}

/** One page of a task's comments, oldest first. */
export interface TaskCommentsPage {
    comments: TaskComment[];
    /** How many comments the task has, whatever the page holds. */
    total: number;
    /** Passed as `cursor` it gives the next page; absent on the last one. */
    nextCursor?: string;
}
