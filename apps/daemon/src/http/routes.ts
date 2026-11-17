import { commandSchema, PROTOCOL_VERSION } from '@clowdy/protocol';

import { executeCommand } from '../commands';
import { listItems } from '../db/items';
import { getRun } from '../db/runs';
import { requireChat } from '../domain/chats';
import { requireProject } from '../domain/projects';
import { projectSnapshot, rootSnapshot, taskDetail } from '../domain/snapshots';
import { invalid, notFound } from '../errors';
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
    method: 'GET' | 'POST';
    pattern: RegExp;
    /** Only the health check is open. */
    open?: boolean;
    handle(request: Request, url: URL, params: string[]): Response | Promise<Response>;
}

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
    const { store, docs, skills } = services;

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
                    body = await request.json();
                }
                catch {
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

                return json(listItems(store.db, id, integerParam(url.searchParams.get('after'), 'after', 0)));
            },
        },
        {
            method: 'GET',
            pattern: /^\/v1\/chats\/([^/]+)\/items$/,
            handle: (_request, url, [id]) => {
                const runId = requireChat(store, id).orchestratorRunId;

                return json(runId ? listItems(store.db, runId, integerParam(url.searchParams.get('after'), 'after', 0)) : []);
            },
        },
        { method: 'GET', pattern: /^\/v1\/tasks\/([^/]+)\/detail$/, handle: (_request, _url, [id]) => json(taskDetail(store, id)) },
        { method: 'GET', pattern: /^\/v1\/projects\/([^/]+)\/docs$/, handle: (_request, _url, [id]) => json(docs.tree(requireProject(store, id))) },
        {
            method: 'GET',
            pattern: /^\/v1\/projects\/([^/]+)\/docs\/file$/,
            handle: (_request, url, [id]) => json(docs.read(requireProject(store, id), url.searchParams.get('path') ?? '')),
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
