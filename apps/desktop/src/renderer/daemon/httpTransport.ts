import { PROTOCOL_HEADER, PROTOCOL_VERSION, ROUTES, SSE_EVENT } from '@clowdy/protocol';

import { HttpFileSystem } from './httpFileSystem';
import { SseParser } from './sse';
import { TerminalSocket } from './terminalStream';
import { TransportError, type CommandInput, type FeedStatus, type PageQuery, type ProjectFileSystem, type StreamTarget, type Transport } from './transport';

import type {
    AgentInfo,
    AgentModels,
    Attachment,
    ClowdyEvent,
    CommandResult,
    DocsTree,
    FolderGit,
    FolderId,
    ProjectFileMatch,
    ProjectId,
    ProjectInfo,
    ProjectSnapshot,
    RootSnapshot,
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

export interface HttpTransportOptions {
    /** Base URL of the daemon, e.g. `http://127.0.0.1:4310`. */
    url: string;
    token: string;
    /** For tests. */
    fetch?: typeof fetch;
    /** For tests: how long a retry waits. */
    sleep?: (ms: number) => Promise<void>;
}

export const RECONNECT_MIN_MS = 500;
export const RECONNECT_MAX_MS = 10_000;
const COMMAND_ATTEMPTS = 3;
const COMMAND_RETRY_MS = 500;

const sleepFor = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const headersFor = (token: string): Record<string, string> => ({ authorization: `Bearer ${ token }`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) });

function isCommandResult(value: unknown): value is CommandResult {
    return typeof value === 'object' && value !== null && 'ok' in value && 'requestId' in value;
}

/** The query string of a paged read, empty for the first page with the daemon's own size. */
function pageQuery({ limit, cursor }: PageQuery = {}): string {
    const params = new URLSearchParams();

    if (limit !== undefined) params.set('limit', String(limit));

    if (cursor !== undefined) params.set('cursor', cursor);

    return params.size > 0 ? `?${ params }` : '';
}

/** A refused request as an error: the daemon's own reason when it gave one, else its status. */
async function refusal(response: Response, route: string): Promise<TransportError> {
    const body = await response.json().catch(() => undefined) as { error?: { message?: unknown } } | undefined;
    const reason = typeof body?.error?.message === 'string' ? body.error.message : undefined;

    return new TransportError(reason ?? `The daemon answered ${ response.status } for ${ route }`, response.status);
}

/** The daemon's HTTP + SSE API, as described by `@clowdy/protocol`. */
export class HttpTransport implements Transport {
    #base: string;
    #token: string;
    #headers: Record<string, string>;
    readonly #fetch: typeof fetch;
    readonly #sleep: (ms: number) => Promise<void>;

    constructor({ url, token, fetch: fetchImpl = (...args) => fetch(...args), sleep = sleepFor }: HttpTransportOptions) {
        this.#base = url.replace(/\/+$/, '');
        this.#token = token;
        this.#headers = headersFor(token);
        this.#fetch = fetchImpl;
        this.#sleep = sleep;
    }

    /**
     * The daemon was replaced and listens elsewhere now. Requests made from here on go there, and the event feed,
     * which retries until it connects, picks the new address up on its next attempt and resumes from its cursor.
     */
    setAddress({ url, token }: { url: string; token: string }): void {
        this.#base = url.replace(/\/+$/, '');
        this.#token = token;
        this.#headers = headersFor(token);
    }

    getRootSnapshot(): Promise<RootSnapshot> {
        return this.#get(ROUTES.snapshot);
    }

    getProjectsInfo(projectId?: ProjectId): Promise<ProjectInfo[]> {
        return this.#get(projectId === undefined ? ROUTES.projectsInfo : `${ ROUTES.projectsInfo }?project=${ encodeURIComponent(projectId) }`);
    }

    getFolderGit(projectId: ProjectId, folderId: FolderId): Promise<FolderGit> {
        return this.#get(`${ ROUTES.projectGit(projectId) }?folderId=${ encodeURIComponent(folderId) }`);
    }

    getProjectSnapshot(projectId: ProjectId): Promise<ProjectSnapshot> {
        return this.#get(ROUTES.projectSnapshot(projectId));
    }

    getItems(target: StreamTarget, afterSeq = 0): Promise<StreamItem[]> {
        const route = 'runId' in target ? ROUTES.runItems(target.runId) : ROUTES.chatItems(target.chatId);

        return this.#get(`${ route }?after=${ afterSeq }`);
    }

    getTaskDetail(taskId: TaskId): Promise<TaskDetail> {
        return this.#get(ROUTES.taskDetail(taskId));
    }

    getTaskDetailByKey(projectId: ProjectId, key: string): Promise<TaskDetail> {
        return this.#get(ROUTES.projectTaskDetail(projectId, key));
    }

    getTaskComments(taskId: TaskId, page?: PageQuery): Promise<TaskCommentsPage> {
        return this.#get(`${ ROUTES.taskComments(taskId) }${ pageQuery(page) }`);
    }

    getArchivedTasks(projectId: ProjectId, page?: PageQuery): Promise<TaskArchivePage> {
        return this.#get(`${ ROUTES.projectArchivedTasks(projectId) }${ pageQuery(page) }`);
    }

    getDocsTree(projectId: ProjectId): Promise<DocsTree> {
        return this.#get(ROUTES.docsTree(projectId));
    }

    getProjectFiles(projectId: ProjectId, query: string, limit?: number): Promise<ProjectFileMatch[]> {
        const params = new URLSearchParams({ query });

        if (limit !== undefined) params.set('limit', String(limit));

        return this.#get(`${ ROUTES.projectFiles(projectId) }?${ params }`);
    }

    fileSystem(projectId: ProjectId, folderId: FolderId): ProjectFileSystem {
        return new HttpFileSystem({ target: () => ({ base: this.#base, headers: this.#headers }), fetch: this.#fetch, route: ROUTES.projectFs(projectId), folderId, sleep: this.#sleep });
    }

    async uploadAttachment(projectId: ProjectId, file: File): Promise<Attachment> {
        const route = `${ ROUTES.projectAttachments(projectId) }?name=${ encodeURIComponent(file.name) }`;
        const response = await this.#fetch(this.#base + route, { method: 'POST', headers: { ...this.#headers, 'content-type': file.type || 'application/octet-stream' }, body: file });

        if (!response.ok) throw await refusal(response, route);

        return await response.json() as Attachment;
    }

    async getAttachment(projectId: ProjectId, attachmentId: string): Promise<Blob> {
        const route = ROUTES.projectAttachment(projectId, attachmentId);
        const response = await this.#fetch(this.#base + route, { headers: this.#headers });

        if (!response.ok) throw await refusal(response, route);

        return await response.blob();
    }

    async getProjectIcon(projectId: ProjectId): Promise<Blob | undefined> {
        const route = ROUTES.projectIcon(projectId);
        const response = await this.#fetch(this.#base + route, { headers: this.#headers });

        // The daemon's answer for a folder without an icon, and for the personal space.
        if (response.status === 404) return undefined;

        if (!response.ok) throw await refusal(response, route);

        return await response.blob();
    }

    async deleteAttachment(projectId: ProjectId, attachmentId: string): Promise<void> {
        const route = ROUTES.projectAttachment(projectId, attachmentId);
        const response = await this.#fetch(this.#base + route, { method: 'DELETE', headers: this.#headers });

        if (!response.ok) throw await refusal(response, route);
    }

    getSkills(projectId?: ProjectId): Promise<SkillCatalog> {
        return this.#get(projectId === undefined ? ROUTES.skills : `${ ROUTES.skills }?projectId=${ encodeURIComponent(projectId) }`);
    }

    getAgents(): Promise<AgentInfo[]> {
        return this.#get(ROUTES.agents);
    }

    getAgentModels(agentId: string): Promise<AgentModels> {
        return this.#get(ROUTES.agentModels(agentId));
    }

    listTerminals(projectId?: ProjectId): Promise<TerminalInfo[]> {
        return this.#get(projectId === undefined ? ROUTES.terminals : `${ ROUTES.terminals }?projectId=${ encodeURIComponent(projectId) }`);
    }

    async createTerminal(request: TerminalCreate): Promise<TerminalInfo> {
        const response = await this.#fetch(this.#base + ROUTES.terminals, { method: 'POST', headers: { ...this.#headers, 'content-type': 'application/json' }, body: JSON.stringify(request) });

        if (!response.ok) throw await refusal(response, ROUTES.terminals);

        return await response.json() as TerminalInfo;
    }

    async closeTerminal(terminalId: TerminalId): Promise<void> {
        const route = ROUTES.terminal(terminalId);
        const response = await this.#fetch(this.#base + route, { method: 'DELETE', headers: this.#headers });

        // Closed from elsewhere already: the wish is met.
        if (!response.ok && response.status !== 404) throw await refusal(response, route);
    }

    openTerminal(terminalId: TerminalId, handlers: TerminalStreamHandlers): TerminalStream {
        return new TerminalSocket({
            handlers,
            address: () => ({ url: `${ this.#base.replace(/^http/, 'ws') }${ ROUTES.terminalStream(terminalId) }`, token: this.#token }),
            exists: async () => {
                try {
                    const response = await this.#fetch(this.#base + ROUTES.terminals, { headers: this.#headers });

                    return response.ok ? (await response.json() as TerminalInfo[]).some(terminal => terminal.id === terminalId) : undefined;
                }
                catch {
                    return undefined;
                }
            },
        });
    }

    async command(command: CommandInput): Promise<CommandResult> {
        // One id for the whole user action: a retry after a lost response must not act twice.
        const body = JSON.stringify({ ...command, requestId: crypto.randomUUID() });
        let failure: unknown;

        for (let attempt = 1; attempt <= COMMAND_ATTEMPTS; attempt++) {
            if (attempt > 1) await this.#sleep(COMMAND_RETRY_MS * (attempt - 1));

            try {
                const response = await this.#fetch(this.#base + ROUTES.commands, {
                    method: 'POST',
                    headers: { ...this.#headers, 'content-type': 'application/json' },
                    body,
                });
                const result: unknown = await response.json().catch(() => undefined);

                // The daemon refused the command (400, 404, 409 ...) with a result; that is an answer, not a failure.
                if (isCommandResult(result)) return result;

                failure = new TransportError(`The daemon answered ${ response.status }`, response.status);
            }
            catch (error) {
                failure = error;
            }
        }

        throw failure;
    }

    subscribe(cursor: number, onEvent: (event: ClowdyEvent) => void, onStatus: (status: FeedStatus) => void): () => void {
        const controller = new AbortController();

        void this.#follow(cursor, onEvent, onStatus, controller.signal);

        return () => controller.abort();
    }

    async #get<T>(route: string): Promise<T> {
        const response = await this.#fetch(this.#base + route, { headers: this.#headers });

        if (!response.ok) throw new TransportError(`The daemon answered ${ response.status } for ${ route }`, response.status);

        return await response.json() as T;
    }

    async #follow(cursor: number, onEvent: (event: ClowdyEvent) => void, onStatus: (status: FeedStatus) => void, signal: AbortSignal): Promise<void> {
        let backoff = RECONNECT_MIN_MS;

        while (!signal.aborted) {
            try {
                const response = await this.#fetch(`${ this.#base }${ ROUTES.events }?cursor=${ cursor }`, {
                    headers: { ...this.#headers, accept: 'text/event-stream' },
                    signal,
                });

                if (response.status === 410) return onStatus('resync');
                if (!response.ok || !response.body) throw new TransportError(`The daemon answered ${ response.status } for the event feed`, response.status);

                onStatus('connected');
                backoff = RECONNECT_MIN_MS;

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                const parser = new SseParser();

                for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
                    for (const frame of parser.push(decoder.decode(chunk.value, { stream: true }))) {
                        if (frame.event !== SSE_EVENT) continue;

                        const event = JSON.parse(frame.data) as ClowdyEvent;

                        cursor = event.cursor;
                        onEvent(event);
                    }
                }
            }
            catch {
                // Dropped or refused: fall through to the retry below.
            }

            if (signal.aborted) return;

            onStatus('reconnecting');
            await this.#sleep(backoff);
            backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
        }
    }
}
