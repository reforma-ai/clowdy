import type { FolderId, TaskComment } from './domain';

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
 *                                            git remote and how many chats chose it, and how many chats, tasks and unfinished runs the project has;
 *                                            read when asked, never announced)
 * GET  /v1/events?cursor=N                -> text/event-stream of ClowdyEvent (frame name `clowdy`, id = cursor); without a
 *                                            cursor the stream is live only; `Last-Event-ID` also resumes; `&projectId=ID`
 *                                            limits it to one project. 410 when the cursor is ahead of the log (the log is not pruned
 *                                            yet, so a cursor is never too old): fetch a snapshot and resume from its cursor.
 * POST /v1/commands                       -> body Command, answers CommandResult
 * GET  /v1/runs/:id/items?after=SEQ       -> StreamItem[] (a run's stream, also an orchestrator's chat)
 * GET  /v1/chats/:id/items?after=SEQ      -> StreamItem[] (the chat's orchestrator stream)
 * GET  /v1/tasks/:id/detail               -> TaskDetail
 * GET  /v1/tasks/:id/comments?limit=&cursor= -> TaskCommentsPage (the task's comments, oldest first; `limit` 1 to 100, default 25; `cursor` is the
 *                                            `nextCursor` of the page before, which is absent on the last page. Comments are not in the snapshot)
 * GET  /v1/projects/:id/docs              -> DocsTree (one entry per folder in the project's order, its documents under `.clowdy/docs`; a folder
 *                                            without that docs folder has no nodes and is not given one. A missing main folder is
 *                                            `unavailable`, one whose docs folder leads out of it `invalid`; another folder whose
 *                                            documents cannot be read, missing or leading out, is left out)
 * GET  /v1/projects/:id/docs/file?folderId=&path= -> DocFile (`path` relative to that folder's docs folder; a folder the project does not
 *                                            have is `not_found`)
 * GET  /v1/projects/:id/files?query=&limit= -> ProjectFileMatch[] (files of the project's folders whose path contains every word of `query`,
 *                                            the folder's name counting as part of the path when there are several; best match first,
 *                                            at most `limit` (default 40, most 100); git's tracked and unignored files, or a walk outside
 *                                            a repository; never a `.clowdy` folder). A missing main folder is `unavailable`; another is skipped
 * POST /v1/projects/:id/attachments?name= -> Attachment (the raw request body is the file, `Content-Type` its media type; the daemon keeps
 *                                            it until the message it is sent with is deleted. Refused above `MAX_ATTACHMENT_BYTES`.
 *                                            A file that is never sent is removed after a day)
 * GET  /v1/projects/:id/attachments/:attachmentId -> the file's bytes, with its media type
 * GET  /v1/projects/:id/icon              -> the icon found in the project's main folder (a favicon, an app icon: SVG, PNG or ICO, at most
 *                                            512 KB), with its media type; `not_found` when there is none, and for the personal space. The
 *                                            icon the person uploaded is `ProjectSettings.icon`, which the app shows first
 * DELETE /v1/projects/:id/attachments/:attachmentId -> { ok: true }; only for a file that was not sent yet (`conflict` otherwise)
 * /v1/projects/:id/fs/*                  -> the files of one of the project's folders: list, find, read, write, make a folder, move, copy,
 *                                            delete, watch. The routes are described in `fs.ts`
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
    taskDetail: (taskId: string) => `/v1/tasks/${ encodeURIComponent(taskId) }/detail`,
    taskComments: (taskId: string) => `/v1/tasks/${ encodeURIComponent(taskId) }/comments`,
    docsTree: (projectId: string) => `/v1/projects/${ encodeURIComponent(projectId) }/docs`,
    docsFile: (projectId: string) => `/v1/projects/${ encodeURIComponent(projectId) }/docs/file`,
    projectFiles: (projectId: string) => `/v1/projects/${ encodeURIComponent(projectId) }/files`,
    projectAttachments: (projectId: string) => `/v1/projects/${ encodeURIComponent(projectId) }/attachments`,
    projectAttachment: (projectId: string, attachmentId: string) => `/v1/projects/${ encodeURIComponent(projectId) }/attachments/${ encodeURIComponent(attachmentId) }`,
    projectIcon: (projectId: string) => `/v1/projects/${ encodeURIComponent(projectId) }/icon`,
    projectFs: (projectId: string) => `/v1/projects/${ encodeURIComponent(projectId) }/fs`,
    skills: '/v1/skills',
    agents: '/v1/agents',
    agentModels: (agentId: string) => `/v1/agents/${ encodeURIComponent(agentId) }/models`,
    shutdown: '/v1/shutdown',
} as const;

/** How many folders one project may have. */
export const MAX_PROJECT_FOLDERS = 50;

/** The longest `ProjectSettings.icon`: a 64px PNG the app made is a few kilobytes as a data URL. */
export const MAX_PROJECT_ICON_LENGTH = 64 * 1024;

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
    chatIds: string[];
    runIds: string[];
    artifacts: import('./domain').Artifact[];
}

/** One page of a task's comments, oldest first. */
export interface TaskCommentsPage {
    comments: TaskComment[];
    /** How many comments the task has, whatever the page holds. */
    total: number;
    /** Passed as `cursor` it gives the next page; absent on the last one. */
    nextCursor?: string;
}
