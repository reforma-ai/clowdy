import { FS_VERSION_HEADER, MAX_FS_FILE_BYTES } from '@clowdy/protocol';
import { z } from 'zod';

import { requireProject } from '../domain/projects';
import { invalid } from '../errors';
import { MAX_BATCH } from '../fs/service';
import { declaredLength, readJson } from './body';
import { json } from './responses';

import type { RouteContext } from './routes';

/** The shape of a route of the file manager: the table of `routes.ts` has no PUT. */
export interface FsRoute {
    method: 'GET' | 'PUT' | 'POST';
    pattern: RegExp;
    /** Never set: every file route needs the token. It is here so the server can read a route of either table the same way. */
    open?: boolean;
    maxBody?: number;
    handle(request: Request, url: URL, params: string[]): Response | Promise<Response>;
}

/** A file may be a little over the limit on the wire before the daemon looks: past it Bun refuses with its own bare 413, up to it the route says what the limit is. */
const BODY_SLACK = 1024 * 1024;

const PREFIX = String.raw`^\/v1\/projects\/([^/]+)\/fs\/`;

const place = z.object({ folderId: z.string(), path: z.string() });
const moves = z.array(z.object({ from: z.string(), to: z.string() })).max(MAX_BATCH);
const moveBody = z.object({ folderId: z.string(), moves, overwrite: z.boolean().optional() });
const copyBody = z.object({ folderId: z.string(), copies: moves, overwrite: z.boolean().optional() });
const deleteBody = z.object({ folderId: z.string(), paths: z.array(z.string()).max(MAX_BATCH) });
const searchBody = z.object({ folderId: z.string(), query: z.string(), matchCase: z.boolean().optional(), wholeWord: z.boolean().optional(), exclude: z.array(z.string()).optional() });

/** A version as a client sends it in `If-Match`: bare, or quoted the way HTTP quotes an entity tag. */
const versionFrom = (header: string) => header.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');

/** The routes under `/v1/projects/:id/fs/`, described in `packages/protocol/src/fs.ts`. */
export function fsRoutes(context: RouteContext): FsRoute[] {
    const { store, fs } = context.services;
    const location = (url: URL) => ({ folderId: url.searchParams.get('folderId') ?? '', path: url.searchParams.get('path') ?? '' });

    return [
        {
            method: 'GET',
            pattern: new RegExp(`${ PREFIX }list$`),
            handle: async (_request, url, [id]) => {
                const { folderId, path } = location(url);
                const raw = url.searchParams.get('depth');

                // Digits only: `Number` would also take '', '1e3', '0x10' and ' 5'.
                if (raw !== null && !/^\d+$/.test(raw)) {
                    throw invalid('depth must be a non-negative integer');
                }

                return json(await fs.list(requireProject(store, id), folderId, path, raw === null ? undefined : Number(raw)));
            },
        },
        {
            method: 'GET',
            pattern: new RegExp(`${ PREFIX }find$`),
            handle: async (_request, url, [id]) => json(await fs.find(requireProject(store, id), url.searchParams.get('folderId') ?? '', url.searchParams.get('query') ?? '')),
        },
        {
            method: 'GET',
            pattern: new RegExp(`${ PREFIX }file$`),
            handle: async (_request, url, [id]) => {
                const { folderId, path } = location(url);
                const { bytes, version } = await fs.read(requireProject(store, id), folderId, path);

                // A stranger's file next to the daemon's API: nothing here may be taken for a page, whatever its name says.
                return new Response(bytes, {
                    headers: {
                        'content-type': 'application/octet-stream',
                        'x-content-type-options': 'nosniff',
                        'content-security-policy': 'sandbox',
                        'cache-control': 'no-store',
                        [FS_VERSION_HEADER]: version,
                    },
                });
            },
        },
        {
            method: 'PUT',
            pattern: new RegExp(`${ PREFIX }file$`),
            maxBody: MAX_FS_FILE_BYTES + BODY_SLACK,
            handle: async (request, url, [id]) => {
                const { folderId, path } = location(url);
                const ifMatch = request.headers.get('if-match');
                const ifNoneMatch = request.headers.get('if-none-match')?.trim() ?? null;

                if (ifNoneMatch !== null && ifNoneMatch !== '*') {
                    throw invalid('If-None-Match takes only *');
                }

                if (ifNoneMatch !== null && ifMatch !== null) {
                    throw invalid('If-Match and If-None-Match cannot be given together');
                }

                return json(await fs.write(requireProject(store, id), folderId, path, request.body, {
                    create: ifNoneMatch === '*',
                    version: ifMatch === null ? undefined : versionFrom(ifMatch),
                    declaredLength: declaredLength(request),
                }));
            },
        },
        {
            method: 'POST',
            pattern: new RegExp(`${ PREFIX }folder$`),
            handle: async (request, _url, [id]) => {
                const { folderId, path } = await readJson(request, place);

                await fs.makeFolder(requireProject(store, id), folderId, path);

                return json({ ok: true });
            },
        },
        {
            method: 'POST',
            pattern: new RegExp(`${ PREFIX }move$`),
            handle: async (request, _url, [id]) => {
                const { folderId, moves, overwrite } = await readJson(request, moveBody);

                await fs.move(requireProject(store, id), folderId, moves, overwrite);

                return json({ ok: true });
            },
        },
        {
            method: 'POST',
            pattern: new RegExp(`${ PREFIX }copy$`),
            handle: async (request, _url, [id]) => {
                const { folderId, copies, overwrite } = await readJson(request, copyBody);

                await fs.copy(requireProject(store, id), folderId, copies, overwrite);

                return json({ ok: true });
            },
        },
        {
            method: 'POST',
            pattern: new RegExp(`${ PREFIX }delete$`),
            handle: async (request, _url, [id]) => {
                const { folderId, paths } = await readJson(request, deleteBody);

                await fs.remove(requireProject(store, id), folderId, paths);

                return json({ ok: true });
            },
        },
        {
            method: 'POST',
            pattern: new RegExp(`${ PREFIX }search$`),
            handle: async (request, _url, [id]) => {
                const body = await readJson(request, searchBody);

                // A search may run for a minute with nothing to send; its own time limit ends it, and the client leaving ends it sooner.
                context.keepOpen(request);

                return json(await fs.search(requireProject(store, id), body, request.signal));
            },
        },
        {
            method: 'GET',
            pattern: new RegExp(`${ PREFIX }watch$`),
            handle: async (request, url, [id]) => {
                const stream = await fs.watch(requireProject(store, id), url.searchParams.get('folderId') ?? '', context.heartbeatMs);

                context.keepOpen(request);

                return new Response(stream, {
                    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' },
                });
            },
        },
    ];
}
