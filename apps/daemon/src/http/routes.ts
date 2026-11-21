import { commandSchema, mainFolder, MAX_ATTACHMENT_BYTES, PROTOCOL_VERSION } from '@clowdy/protocol';

import { contentDisposition, servedMediaType } from '../attachments/names';
import { executeCommand } from '../commands';
import { getRun } from '../db/runs';
import { requireChat } from '../domain/chats';
import { streamItems } from '../domain/items';
import { findProjectIcon } from '../domain/projectIcon';
import { projectsInfo, requireProject } from '../domain/projects';
import { projectSnapshot, rootSnapshot, taskDetail } from '../domain/snapshots';
import { CommandError, invalid, notFound } from '../errors';
import { BodyTooLarge, declaredLength, JSON_BODY_LIMIT, readText } from './body';
import { commandResponse, failure, json } from './responses';
import { eventStream } from './sse';

import type { Health } from '@clowdy/protocol';
import type { Services } from '../commands';

export interface RouteContext {
    services: Services;
    startedAt: number;
    version: string;
    heartbeatMs?: number;
    shutdown(): void;
    /** Lets a long-lived response opt out of the server's idle timeout. */
    keepOpen(request: Request): void;
}

interface Route {
    method: 'GET' | 'POST' | 'DELETE';
    pattern: RegExp;
    /** Only the health check is open. */
    open?: boolean;
    /** The most bytes of request body the route takes; `JSON_BODY_LIMIT` when absent. Only an upload asks for more. */
    maxBody?: number;
    handle(request: Request, url: URL, params: string[]): Response | Promise<Response>;
}

/**
 * An upload may be a little over `MAX_ATTACHMENT_BYTES` on the wire before the daemon looks: past it Bun refuses the request with its
 * own bare 413, up to it the route answers with a JSON error that says what the limit is.
 */
const UPLOAD_BODY_SLACK = 1024 * 1024;

/** How many paths a file search answers with when it is not told, and the most it ever does. */
const DEFAULT_FILE_LIMIT = 40;
const MAX_FILE_LIMIT = 100;

function integerParam(raw: string | null, name: string, fallback: number): number {
    if (raw === null) {
        return fallback;
    }

    // Digits only: `Number` would also take '', '1e3', '0x10' and ' 5'.
    if (!/^\d+$/.test(raw)) {
        throw invalid(`${ name } must be a non-negative integer`);
    }

    return Number(raw);
}

export function createRoutes(context: RouteContext): Route[] {
    const { services } = context;
    const { store, docs, files, skills, attachments } = services;

    return [
        {
            method: 'GET',
            pattern: /^\/v1\/health$/,
            open: true,
            handle: () => json({ ok: true, protocol: PROTOCOL_VERSION, version: context.version, pid: process.pid, startedAt: context.startedAt, activeRuns: services.runs.activeCount() } satisfies Health),
        },
        {
            method: 'POST',
            pattern: /^\/v1\/shutdown$/,
            handle: () => {
                context.shutdown();

                return json({ ok: true });
            },
        },
        { method: 'GET', pattern: /^\/v1\/snapshot$/, handle: () => json(rootSnapshot(store)) },
        // `info` is not a project id (they all start with `prj_`), and the pattern is exact, so no route below can take it for one.
        { method: 'GET', pattern: /^\/v1\/projects\/info$/, handle: async () => json(await projectsInfo(store)) },
        { method: 'GET', pattern: /^\/v1\/projects\/([^/]+)\/snapshot$/, handle: (_request, _url, [id]) => json(projectSnapshot(store, id)) },
        {
            method: 'GET',
            pattern: /^\/v1\/events$/,
            handle: (request, url) => {
                const head = store.headCursor();
                const cursor = integerParam(url.searchParams.get('cursor') ?? request.headers.get('last-event-id'), 'cursor', head);

                if (cursor > head) {
                    return json({ ok: false, error: { code: 'invalid', message: 'The cursor is ahead of the event log; fetch a new snapshot and resume from its cursor', details: { cursor, head } } }, 410);
                }

                context.keepOpen(request);

                return new Response(eventStream(store, cursor, url.searchParams.get('projectId') ?? undefined, context.heartbeatMs), {
                    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' },
                });
            },
        },
        {
            method: 'POST',
            pattern: /^\/v1\/commands$/,
            handle: async (request) => {
                let body: unknown;

                try {
                    body = JSON.parse(await readText(request, JSON_BODY_LIMIT));
                }
                catch (error) {
                    if (error instanceof BodyTooLarge) {
                        throw error;
                    }

                    return failure('invalid', 'The body is not valid JSON', undefined, '');
                }

                const parsed = commandSchema.safeParse(body);
                const requestId = typeof (body as { requestId?: unknown } | null)?.requestId === 'string' ? (body as { requestId: string }).requestId : '';

                if (!parsed.success) {
                    return failure('invalid', 'The command is not valid', parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })), requestId);
                }

                return commandResponse(executeCommand(services, parsed.data));
            },
        },
        {
            method: 'GET',
            pattern: /^\/v1\/runs\/([^/]+)\/items$/,
            handle: (_request, url, [id]) => {
                if (!getRun(store.db, id)) {
                    throw notFound('Run', id);
                }

                return json(streamItems(store, id, integerParam(url.searchParams.get('after'), 'after', 0)));
            },
        },
        {
            method: 'GET',
            pattern: /^\/v1\/chats\/([^/]+)\/items$/,
            handle: (_request, url, [id]) => {
                const runId = requireChat(store, id).orchestratorRunId;

                return json(runId ? streamItems(store, runId, integerParam(url.searchParams.get('after'), 'after', 0)) : []);
            },
        },
        { method: 'GET', pattern: /^\/v1\/tasks\/([^/]+)\/detail$/, handle: (_request, _url, [id]) => json(taskDetail(store, id)) },
        { method: 'GET', pattern: /^\/v1\/projects\/([^/]+)\/docs$/, handle: (_request, _url, [id]) => json(docs.tree(requireProject(store, id))) },
        {
            method: 'GET',
            pattern: /^\/v1\/projects\/([^/]+)\/docs\/file$/,
            handle: (_request, url, [id]) => json(docs.read(requireProject(store, id), url.searchParams.get('folderId') ?? '', url.searchParams.get('path') ?? '')),
        },
        {
            method: 'GET',
            pattern: /^\/v1\/projects\/([^/]+)\/files$/,
            handle: async (_request, url, [id]) => {
                const limit = Math.min(Math.max(integerParam(url.searchParams.get('limit'), 'limit', DEFAULT_FILE_LIMIT), 1), MAX_FILE_LIMIT);

                return json(await files.search(requireProject(store, id), url.searchParams.get('query') ?? '', limit));
            },
        },
        {
            method: 'POST',
            pattern: /^\/v1\/projects\/([^/]+)\/attachments$/,
            maxBody: MAX_ATTACHMENT_BYTES + UPLOAD_BODY_SLACK,
            handle: async (request, url, [id]) => json(await attachments.upload(requireProject(store, id), {
                name: url.searchParams.get('name'),
                contentType: request.headers.get('content-type'),
                body: request.body,
                declaredLength: declaredLength(request),
            })),
        },
        {
            method: 'GET',
            pattern: /^\/v1\/projects\/([^/]+)\/attachments\/([^/]+)$/,
            handle: (_request, _url, [id, attachmentId]) => {
                const { record, path } = attachments.read(requireProject(store, id).id, attachmentId);

                // The bytes of a stranger's file next to the daemon's API: nothing here may be taken for a page, whatever its name says.
                return new Response(Bun.file(path), {
                    headers: {
                        'content-type': servedMediaType(record.mediaType),
                        'content-disposition': contentDisposition(record.name),
                        'x-content-type-options': 'nosniff',
                        'content-security-policy': 'sandbox',
                    },
                });
            },
        },
        {
            method: 'DELETE',
            pattern: /^\/v1\/projects\/([^/]+)\/attachments\/([^/]+)$/,
            handle: (_request, _url, [id, attachmentId]) => {
                attachments.remove(requireProject(store, id).id, attachmentId);

                return json({ ok: true });
            },
        },
        {
            method: 'GET',
            pattern: /^\/v1\/projects\/([^/]+)\/icon$/,
            handle: (_request, _url, [id]) => {
                const project = requireProject(store, id);
                const icon = project.personal ? undefined : findProjectIcon(mainFolder(project).path);

                if (!icon) {
                    throw new CommandError('not_found', `${ project.name } has no icon in its main folder`);
                }

                // A file of the project's own, read by the app as a picture; nothing here may be taken for a page.
                return new Response(Bun.file(icon.path), {
                    headers: {
                        'content-type': icon.mediaType,
                        'x-content-type-options': 'nosniff',
                        'content-security-policy': 'sandbox',
                        'cache-control': 'no-store',
                    },
                });
            },
        },
        { method: 'GET', pattern: /^\/v1\/agents$/, handle: async () => json(services.providers.decorate(await services.agents.list())) },
        {
            method: 'GET',
            pattern: /^\/v1\/agents\/([^/]+)\/models$/,
            handle: async (_request, _url, [id]) => {
                if (!services.agents.has(id!)) {
                    throw notFound('Agent', id!);
                }

                return json(await services.models.get(id!));
            },
        },
        {
            method: 'GET',
            pattern: /^\/v1\/skills$/,
            handle: (_request, url) => {
                const projectId = url.searchParams.get('projectId');

                return json(skills.catalog(projectId === null ? undefined : requireProject(store, projectId)));
            },
        },
    ];
}
