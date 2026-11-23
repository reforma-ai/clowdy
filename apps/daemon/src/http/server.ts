import { FS_VERSION_HEADER, PROTOCOL_HEADER, PROTOCOL_VERSION } from '@clowdy/protocol';

import { CommandError, invalid, TooLargeError } from '../errors';
import { BodyTooLarge, declaredLength, JSON_BODY_LIMIT } from './body';
import { fsRoutes } from './fs-routes';
import { ALLOWED_HEADERS, isAllowedOrigin, isLoopbackHost, protocolMismatch, tokenMatches } from './guard';
import { bodyTooLarge, failure, forbidden, unauthorized } from './responses';
import { createRoutes } from './routes';
import { openTerminalStream, terminalRoutes, terminalSocket, terminalStreamId } from './terminals';

import type { Server } from 'bun';
import type { Services } from '../commands';
import type { TerminalSocketData } from './terminals';

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
    } catch {
        throw invalid('The path contains a malformed escape sequence');
    }
}

/** Binds 127.0.0.1 only; `port` 0 picks a free port. */
export function startServer({
    services,
    version,
    startedAt,
    heartbeatMs,
    shutdown,
}: ServerOptions): Server<TerminalSocketData> {
    const { config } = services;
    const context = {
        services,
        version,
        startedAt,
        heartbeatMs,
        shutdown,
        keepOpen: (request: Request) => server.timeout(request, 0),
    };
    const routes = [...createRoutes(context), ...fsRoutes(context), ...terminalRoutes(context)];

    async function route(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const candidates = routes.filter(candidate => candidate.pattern.test(url.pathname));

        // Bun's own limit is the largest of any route (an upload's), so the smaller ones are kept here: a body a route does not
        // read stays unread, and one it reads is cut off by the route (`readText`) when no length was declared.
        if (
            declaredLength(request) > Math.max(JSON_BODY_LIMIT, ...candidates.map(candidate => candidate.maxBody ?? 0))
        ) {
            return bodyTooLarge();
        }

        if (candidates.length === 0) {
            return failure('not_found', `No route ${url.pathname}`);
        }

        const match = candidates.find(candidate => candidate.method === request.method);

        if (!match) {
            return new Response(null, {
                status: 405,
                headers: { allow: candidates.map(candidate => candidate.method).join(', ') },
            });
        }

        if (!match.open && !tokenMatches(request.headers.get('authorization'), config.token)) {
            return unauthorized();
        }

        try {
            const params = (match.pattern.exec(url.pathname) ?? []).slice(1).map(decode);

            return await match.handle(request, url, params);
        } catch (error) {
            if (error instanceof TooLargeError) {
                return failure(error.code, error.message, error.details, undefined, 413);
            }

            if (error instanceof BodyTooLarge) {
                return bodyTooLarge();
            }

            if (error instanceof CommandError) {
                return failure(error.code, error.message, error.details);
            }

            console.error(`[clowdy] ${request.method} ${url.pathname} failed:`, error);

            return failure('internal', 'The daemon failed to handle the request');
        }
    }

    /** `undefined` when the request became a WebSocket: Bun answers it then. */
    async function handle(request: Request, socketServer: Server<TerminalSocketData>): Promise<Response | undefined> {
        const origin = request.headers.get('origin');

        if (!isLoopbackHost(request.headers.get('host'))) {
            return forbidden('The request was not addressed to a loopback host');
        }

        if (origin !== null && !isAllowedOrigin(origin, config.corsOrigins)) {
            return forbidden('This origin is not allowed');
        }

        // A terminal's stream is a WebSocket, which a page opens without CORS and without headers: the token comes as a subprotocol, and the origin was checked above.
        const streamId = terminalStreamId(request, new URL(request.url).pathname);

        if (streamId !== undefined) {
            return openTerminalStream(request, socketServer, services.terminals, config.token, streamId);
        }

        // The version of a file is a header a page may read only when it is exposed.
        const cors: Record<string, string> =
            origin === null
                ? {}
                : {
                      'access-control-allow-origin': origin,
                      'access-control-expose-headers': FS_VERSION_HEADER,
                      vary: 'Origin',
                  };

        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: {
                    ...cors,
                    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
                    'access-control-allow-headers': ALLOWED_HEADERS,
                    'access-control-max-age': '600',
                },
            });
        }

        const response = protocolMismatch(request.headers.get(PROTOCOL_HEADER))
            ? failure('invalid', `This daemon speaks protocol major ${PROTOCOL_VERSION}`, {
                  supported: PROTOCOL_VERSION,
              })
            : await route(request);

        for (const [name, value] of Object.entries(cors)) {
            response.headers.set(name, value);
        }

        return response;
    }

    const server: Server<TerminalSocketData> = Bun.serve<TerminalSocketData>({
        hostname: '127.0.0.1',
        port: config.port,
        // Bun applies one limit to every route; the biggest body any of them takes (an upload) is what it may let in.
        maxRequestBodySize: Math.max(JSON_BODY_LIMIT, ...routes.map(candidate => candidate.maxBody ?? 0)),
        fetch: (request, socketServer) => handle(request, socketServer),
        websocket: terminalSocket(services.terminals),
    });

    return server;
}
