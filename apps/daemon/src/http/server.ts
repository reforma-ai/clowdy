import { PROTOCOL_HEADER, PROTOCOL_VERSION } from '@clowdy/protocol';

import { CommandError, invalid } from '../errors';
import { ALLOWED_HEADERS, isAllowedOrigin, isLoopbackHost, protocolMismatch, tokenMatches } from './guard';
import { failure, forbidden } from './responses';
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
    const routes = createRoutes({ services, version, startedAt, heartbeatMs, shutdown, keepOpen: request => server.timeout(request, 0) });

    async function route(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const candidates = routes.filter(candidate => candidate.pattern.test(url.pathname));

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

        if (origin !== null && !isAllowedOrigin(origin)) {
            return forbidden('This origin is not allowed');
        }

        const cors: Record<string, string> = origin === null ? {} : { 'access-control-allow-origin': origin, vary: 'Origin' };

        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: { ...cors, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': ALLOWED_HEADERS, 'access-control-max-age': '600' },
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
        maxRequestBodySize: 8 * 1024 * 1024,
        fetch: handle,
    });

    return server;
}
