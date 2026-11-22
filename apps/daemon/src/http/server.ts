import { FS_VERSION_HEADER, PROTOCOL_HEADER, PROTOCOL_VERSION } from '@clowdy/protocol';

import { CommandError, invalid, TooLargeError } from '../errors';
import { BodyTooLarge, declaredLength, JSON_BODY_LIMIT } from './body';
import { fsRoutes } from './fs-routes';
import { ALLOWED_HEADERS, isAllowedOrigin, isLoopbackHost, protocolMismatch, tokenMatches } from './guard';
import { bodyTooLarge, failure, forbidden } from './responses';
import { createRoutes } from './routes';

import type { Server } from 'bun';
import type { Services } from '../commands';

export interface ServerOptions {
    services: Services;
    version: string;
    startedAt: number;
    heartbeatMs?: number;
    /** Stops the daemon after the response to `POST /v1/shutdown` went out. */
    shutdown(): void;
}

function decode(segment: string): string {
    try {
        return decodeURIComponent(segment);
    }
    catch {
        throw invalid('The path contains a malformed escape sequence');
    }
}

/** Binds 127.0.0.1 only; `port` 0 picks a free port. */
export function startServer({ services, version, startedAt, heartbeatMs, shutdown }: ServerOptions): Server<undefined> {
    const { config } = services;
    const context = { services, version, startedAt, heartbeatMs, shutdown, keepOpen: (request: Request) => server.timeout(request, 0) };
    const routes = [...createRoutes(context), ...fsRoutes(context)];

    async function route(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const candidates = routes.filter(candidate => candidate.pattern.test(url.pathname));

        // Bun's own limit is the largest of any route (an upload's), so the smaller ones are kept here: a body a route does not
        // read stays unread, and one it reads is cut off by the route (`readText`) when no length was declared.
        if (declaredLength(request) > Math.max(JSON_BODY_LIMIT, ...candidates.map(candidate => candidate.maxBody ?? 0))) {
            return bodyTooLarge();
        }

        if (candidates.length === 0) {
            return failure('not_found', `No route ${ url.pathname }`);
        }

        const match = candidates.find(candidate => candidate.method === request.method);

        if (!match) {
            return new Response(null, { status: 405, headers: { allow: candidates.map(candidate => candidate.method).join(', ') } });
        }

        if (!match.open && !tokenMatches(request.headers.get('authorization'), config.token)) {
            return Response.json({ ok: false, requestId: '', error: { code: 'unauthorized', message: 'A valid bearer token is required' } }, { status: 401, headers: { 'www-authenticate': 'Bearer' } });
        }

        try {
            const params = (match.pattern.exec(url.pathname) ?? []).slice(1).map(decode);

            return await match.handle(request, url, params);
        }
        catch (error) {
            if (error instanceof TooLargeError) {
                return failure(error.code, error.message, error.details, undefined, 413);
            }

            if (error instanceof BodyTooLarge) {
                return bodyTooLarge();
            }

            if (error instanceof CommandError) {
                return failure(error.code, error.message, error.details);
            }

            console.error(`[clowdy] ${ request.method } ${ url.pathname } failed:`, error);

            return failure('internal', 'The daemon failed to handle the request');
        }
    }

    async function handle(request: Request): Promise<Response> {
        const origin = request.headers.get('origin');

        if (!isLoopbackHost(request.headers.get('host'))) {
            return forbidden('The request was not addressed to a loopback host');
        }

        if (origin !== null && !isAllowedOrigin(origin, config.corsOrigins)) {
            return forbidden('This origin is not allowed');
        }

        // The version of a file is a header a page may read only when it is exposed.
        const cors: Record<string, string> = origin === null ? {} : { 'access-control-allow-origin': origin, 'access-control-expose-headers': FS_VERSION_HEADER, vary: 'Origin' };

        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: { ...cors, 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': ALLOWED_HEADERS, 'access-control-max-age': '600' },
            });
        }

        const response = protocolMismatch(request.headers.get(PROTOCOL_HEADER))
            ? failure('invalid', `This daemon speaks protocol major ${ PROTOCOL_VERSION }`, { supported: PROTOCOL_VERSION })
            : await route(request);

        for (const [name, value] of Object.entries(cors)) {
            response.headers.set(name, value);
        }

        return response;
    }

    const server: Server<undefined> = Bun.serve({
        hostname: '127.0.0.1',
        port: config.port,
        // Bun applies one limit to every route; the biggest body any of them takes (an upload) is what it may let in.
        maxRequestBodySize: Math.max(JSON_BODY_LIMIT, ...routes.map(candidate => candidate.maxBody ?? 0)),
        fetch: handle,
    });

    return server;
}
