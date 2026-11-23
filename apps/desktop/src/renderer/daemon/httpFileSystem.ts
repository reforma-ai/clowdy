import { decodeUtf8 } from '@clowdy/file-manager/paths';
import { FileSystemError } from '@clowdy/file-manager/provider';
import { FS_VERSION_HEADER } from '@clowdy/protocol';

import { SseParser } from './sse';

import type {
    FileContent,
    FileEntry,
    FileSystemErrorCode,
    FileSystemProvider,
    MoveOperation,
    OverwriteOptions,
    SearchQuery,
    SearchResult,
    WatchEvent,
    WriteOptions,
} from '@clowdy/file-manager/provider';
import type { FolderId, WorkspaceId } from '@clowdy/protocol';

export interface HttpFileSystemOptions {
    /** The daemon's address and the headers that go with every request, asked for each request: the daemon may be replaced while the app runs. */
    target: () => { base: string; headers: Record<string, string> };
    fetch: typeof fetch;
    /** `/v1/projects/:id/fs`. */
    route: string;
    folderId: FolderId;
    /** The worktree of the folder to read and write, in place of the folder's own checkout: sent with every request beside the folder. */
    workspaceId?: WorkspaceId;
    /** For tests: how long a reconnect of the watch waits. */
    sleep?: (ms: number) => Promise<void>;
}

const WATCH_RECONNECT_MIN_MS = 500;
const WATCH_RECONNECT_MAX_MS = 10_000;

const sleepFor = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

interface ErrorBody {
    error?: { code?: unknown; message?: unknown; details?: { reason?: unknown; path?: unknown; currentVersion?: unknown } };
}

/** What a refused request is to the file manager: the code it acts on, with the daemon's own words. */
function refusal(status: number, body: ErrorBody | undefined, path: string): FileSystemError {
    const { code, message, details } = body?.error ?? {};
    const text = typeof message === 'string' ? message : `The daemon answered ${ status }`;
    const failed = (fileSystemCode: FileSystemErrorCode, options: { path?: string; currentVersion?: string | null } = { path }) => new FileSystemError(fileSystemCode, text, options);

    if (status === 404 || code === 'not_found') return failed('NotFound');

    if (details?.reason === 'exists') return failed('Exists', { path: typeof details.path === 'string' ? details.path : path });

    if (details?.reason === 'version') return failed('Conflict', { path, currentVersion: typeof details.currentVersion === 'string' ? details.currentVersion : null });

    if (details?.reason === 'outside' || details?.reason === 'permission' || status === 403) return failed('NoPermission');

    return failed('Unavailable');
}

/** The event a frame of the change stream carries, or nothing when the frame is not one: a frame that is not JSON, or has another shape, says nothing about the files. */
function watchEvent(data: string): WatchEvent | undefined {
    try {
        const event = JSON.parse(data) as { type?: unknown; changes?: unknown } | null;

        if (event?.type === 'resync') return { type: 'resync' };

        if (event?.type === 'changes' && Array.isArray(event.changes)) return event as WatchEvent;
    }
    catch {
        // Not JSON.
    }

    return undefined;
}

/** One folder of a project, through the daemon's `fs` routes (see `packages/protocol/src/fs.ts`). */
export class HttpFileSystem implements FileSystemProvider {
    readonly capabilities = {};

    readonly #options: HttpFileSystemOptions;

    constructor(options: HttpFileSystemOptions) {
        this.#options = options;
    }

    async list(path = '', depth = Number.POSITIVE_INFINITY): Promise<FileEntry[]> {
        const response = await this.#request('list', { path, ...(Number.isFinite(depth) ? { depth: String(depth) } : {}) }, path);

        return await response.json() as FileEntry[];
    }

    async findFiles(query: string): Promise<readonly string[]> {
        const response = await this.#request('find', { query }, '');

        return await response.json() as string[];
    }

    async read(path: string): Promise<FileContent> {
        const response = await this.#request('file', { path }, path);
        const version = response.headers.get(FS_VERSION_HEADER) ?? '';
        const bytes = new Uint8Array(await response.arrayBuffer());
        const text = decodeUtf8(bytes);

        return text === null ? { kind: 'binary', blob: new Blob([bytes]), version } : { kind: 'text', text, version };
    }

    async write(path: string, content: string | Blob, { expectedVersion }: WriteOptions = {}): Promise<string> {
        const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };

        if (expectedVersion === null) headers['if-none-match'] = '*';
        else if (expectedVersion !== undefined) headers['if-match'] = expectedVersion;

        const response = await this.#request('file', { path }, path, { method: 'PUT', headers, body: content });

        return (await response.json() as { version: string }).version;
    }

    async createDirectory(path: string): Promise<void> {
        await this.#post('folder', { path }, path);
    }

    async move(moves: readonly MoveOperation[], { overwrite }: OverwriteOptions = {}): Promise<void> {
        await this.#post('move', { moves, ...(overwrite ? { overwrite } : {}) }, moves[0]?.from ?? '');
    }

    async copy(copies: readonly MoveOperation[], { overwrite }: OverwriteOptions = {}): Promise<void> {
        await this.#post('copy', { copies, ...(overwrite ? { overwrite } : {}) }, copies[0]?.from ?? '');
    }

    async delete(paths: readonly string[]): Promise<void> {
        await this.#post('delete', { paths }, paths[0] ?? '');
    }

    /** Searches the contents of the folder's files on the daemon, which stops when `signal` aborts the request. A rejection's message is what the Search tab shows. */
    search = async ({ query, matchCase, wholeWord, exclude }: SearchQuery, signal: AbortSignal): Promise<SearchResult> => {
        const response = await this.#post('search', { query, matchCase, wholeWord, exclude }, '', signal);

        return await response.json() as SearchResult;
    };

    watch(listener: (event: WatchEvent) => void): () => void {
        const controller = new AbortController();

        void this.#follow(listener, controller.signal);

        return () => controller.abort();
    }

    #post(action: string, body: Record<string, unknown>, path: string, signal?: AbortSignal): Promise<Response> {
        return this.#request(action, undefined, path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...this.#place(), ...body }),
            signal,
        });
    }

    /** What names the folder, and the worktree of it when there is one: in the address of a read, a write, a list or the watch, in the body of the other writes. */
    #place(): Record<string, string> {
        const { folderId, workspaceId } = this.#options;

        return { folderId, ...(workspaceId !== undefined && { workspaceId }) };
    }

    /** A request to one route: `query` goes in the address with the place (a read, a write, the lists), without it the body names the place. */
    async #request(action: string, query: Record<string, string> | undefined, path: string, init: RequestInit = {}): Promise<Response> {
        const { base, headers } = this.#options.target();
        const search = query ? `?${ new URLSearchParams({ ...this.#place(), ...query }) }` : '';
        let response: Response;

        try {
            response = await this.#options.fetch(`${ base }${ this.#options.route }/${ action }${ search }`, { ...init, headers: { ...headers, ...init.headers } });
        }
        catch (error) {
            // A request the caller gave up is not a failure of the daemon.
            if (init.signal?.aborted) throw error;

            throw new FileSystemError('Unavailable', 'The daemon cannot be reached', { path, cause: error });
        }

        if (!response.ok) throw refusal(response.status, await response.json().catch(() => undefined) as ErrorBody | undefined, path);

        return response;
    }

    /**
     * Follows the change stream, and again after it drops. Every stream starts with a `resync`: the daemon reads the folder's state when a stream opens, so
     * what changed between the manager's listing (made as the stream was being opened) and that moment, or while an earlier stream was down, is told by no change.
     */
    async #follow(listener: (event: WatchEvent) => void, signal: AbortSignal): Promise<void> {
        const sleep = this.#options.sleep ?? sleepFor;
        let backoff = WATCH_RECONNECT_MIN_MS;

        while (!signal.aborted) {
            try {
                const { base, headers } = this.#options.target();
                const response = await this.#options.fetch(`${ base }${ this.#options.route }/watch?${ new URLSearchParams(this.#place()) }`, {
                    headers: { ...headers, accept: 'text/event-stream' },
                    signal,
                });

                // Whatever way a stream is left (an answer that refuses, a listener that threw, an abort), it is closed and not left open to the daemon while the next one is made.
                // A stream that has a reader is cancelled through it.
                let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
                const close = () => void (reader ?? response.body)?.cancel().catch(() => undefined);

                // The folder is not the project's any more, or the project is gone: nothing is left to follow, and asking again would go on for as long as the app runs.
                if (response.status === 404) return close();

                if (!response.ok || !response.body) {
                    close();

                    throw new Error(`The daemon answered ${ response.status } for the watch`);
                }

                try {
                    reader = response.body.getReader();

                    const decoder = new TextDecoder();
                    const parser = new SseParser();

                    listener({ type: 'resync' });

                    backoff = WATCH_RECONNECT_MIN_MS;

                    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
                        for (const frame of parser.push(decoder.decode(chunk.value, { stream: true }))) {
                            const event = watchEvent(frame.data);

                            if (event) listener(event);
                        }
                    }
                }
                finally {
                    close();
                }
            }
            catch {
                // Dropped or refused: the retry below.
            }

            if (signal.aborted) return;

            await sleep(backoff);
            backoff = Math.min(backoff * 2, WATCH_RECONNECT_MAX_MS);
        }
    }
}
