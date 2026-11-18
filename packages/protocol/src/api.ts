/** Version of this contract. The daemon refuses clients that send a different major in `x-clowdy-protocol`. */
export const PROTOCOL_VERSION = 1;

export const PROTOCOL_HEADER = 'x-clowdy-protocol';

/**
 * HTTP surface, loopback only, `Authorization: Bearer <token>` on everything but `/v1/health`.
 *
 * GET  /v1/health                         -> Health
 * GET  /v1/snapshot                       -> RootSnapshot
 * GET  /v1/projects/:id/snapshot          -> ProjectSnapshot
 * GET  /v1/events?cursor=N                -> text/event-stream of ClowdyEvent (frame name `clowdy`, id = cursor); without a
 *                                            cursor the stream is live only; `Last-Event-ID` also resumes; `&projectId=ID`
 *                                            limits it to one project. 410 when the cursor is ahead of the log (the log is not pruned
 *                                            yet, so a cursor is never too old): fetch a snapshot and resume from its cursor.
 * POST /v1/commands                       -> body Command, answers CommandResult
 * GET  /v1/runs/:id/items?after=SEQ       -> StreamItem[] (a run's stream, also an orchestrator's chat)
 * GET  /v1/chats/:id/items?after=SEQ      -> StreamItem[] (the chat's orchestrator stream)
 * GET  /v1/tasks/:id/detail               -> TaskDetail
 * GET  /v1/projects/:id/docs              -> DocsTree
 * GET  /v1/projects/:id/docs/file?path=   -> DocFile
 * GET  /v1/projects/:id/files?query=&limit= -> string[] (paths below the project folder that contain every word of `query`,
 *                                            best match first, at most `limit` (default 40, most 100); git's tracked and
 *                                            unignored files, or a walk outside a repository; never the project's `.clowdy` folder)
 * POST /v1/shutdown                       -> { ok: true }; stops the daemon gracefully (live engines are aborted, their runs
 *                                            come back `interrupted` at the next start, nothing is marked cancelled)
 * GET  /v1/skills?projectId=              -> SkillCatalog (system and user skills; with `projectId` also that project's skills)
 * GET  /v1/agents                         -> AgentInfo[] (every agent the daemon knows, with whether it can start one on this machine)
 */
export const ROUTES = {
    health: '/v1/health',
    snapshot: '/v1/snapshot',
    projectSnapshot: (projectId: string) => `/v1/projects/${ encodeURIComponent(projectId) }/snapshot`,
    events: '/v1/events',
    commands: '/v1/commands',
    runItems: (runId: string) => `/v1/runs/${ encodeURIComponent(runId) }/items`,
    chatItems: (chatId: string) => `/v1/chats/${ encodeURIComponent(chatId) }/items`,
    taskDetail: (taskId: string) => `/v1/tasks/${ encodeURIComponent(taskId) }/detail`,
    docsTree: (projectId: string) => `/v1/projects/${ encodeURIComponent(projectId) }/docs`,
    docsFile: (projectId: string) => `/v1/projects/${ encodeURIComponent(projectId) }/docs/file`,
    projectFiles: (projectId: string) => `/v1/projects/${ encodeURIComponent(projectId) }/files`,
    skills: '/v1/skills',
    agents: '/v1/agents',
    shutdown: '/v1/shutdown',
} as const;

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
