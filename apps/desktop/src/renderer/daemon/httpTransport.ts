import { PROTOCOL_HEADER, PROTOCOL_VERSION, ROUTES, SSE_EVENT } from '@clowdy/protocol';

import { SseParser } from './sse';
import { TransportError, type CommandInput, type FeedStatus, type StreamTarget, type Transport } from './transport';

import type {
    ClowdyEvent,
    CommandResult,
    DocFile,
    DocsTree,
    ProjectId,
    ProjectSnapshot,
    RootSnapshot,
    SkillCatalog,
    StreamItem,
    TaskDetail,
    TaskId,
} from '@clowdy/protocol';

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

function isCommandResult(value: unknown): value is CommandResult {
    return typeof value === 'object' && value !== null && 'ok' in value && 'requestId' in value;
}

/** The daemon's HTTP + SSE API, as described by `@clowdy/protocol`. */
export class HttpTransport implements Transport {
    readonly #base: string;
    readonly #headers: Record<string, string>;
    readonly #fetch: typeof fetch;
    readonly #sleep: (ms: number) => Promise<void>;

    constructor({ url, token, fetch: fetchImpl = (...args) => fetch(...args), sleep = sleepFor }: HttpTransportOptions) {
        this.#base = url.replace(/\/+$/, '');
        this.#headers = { authorization: `Bearer ${ token }`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) };
        this.#fetch = fetchImpl;
        this.#sleep = sleep;
    }

    getRootSnapshot(): Promise<RootSnapshot> {
        return this.#get(ROUTES.snapshot);
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

    getDocsTree(projectId: ProjectId): Promise<DocsTree> {
        return this.#get(ROUTES.docsTree(projectId));
    }

    getDocFile(projectId: ProjectId, path: string): Promise<DocFile> {
        return this.#get(`${ ROUTES.docsFile(projectId) }?path=${ encodeURIComponent(path) }`);
    }

    getSkills(projectId?: ProjectId): Promise<SkillCatalog> {
        return this.#get(projectId === undefined ? ROUTES.skills : `${ ROUTES.skills }?projectId=${ encodeURIComponent(projectId) }`);
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
