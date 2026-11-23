import { isTerminalSize, MAX_TERMINAL_INPUT_BYTES, TERMINAL_SUBPROTOCOL, tokenFromTerminalProtocols } from '@clowdy/protocol';
import { z } from 'zod';

import { resolvePlace } from '../domain/places';
import { requireProject } from '../domain/projects';
import { readJson } from './body';
import { tokenMatches } from './guard';
import { failure, json, unauthorized } from './responses';

import type { TerminalClientMessage } from '@clowdy/protocol';
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import type { TerminalService } from '../terminals/service';
import type { ScreenMessage, TerminalListener } from '../terminals/session';
import type { Route, RouteContext } from './routes';

/** What the daemon keeps with the socket of a terminal stream. */
export interface TerminalSocketData {
    terminalId: string;
}

/** A client whose socket holds more than this is not sent more output: it gets a new screen once the socket has drained. */
const HIGH_WATER_BYTES = 1024 * 1024;
const LOW_WATER_BYTES = 64 * 1024;

const STREAM_ROUTE = /^\/v1\/terminals\/([^/]+)\/stream$/;

const createBody = z.object({
    projectId: z.string(),
    folderId: z.string(),
    workspaceId: z.string().optional(),
    path: z.string().optional(),
    cols: z.number(),
    rows: z.number(),
});

/** The routes under `/v1/terminals`, described in `packages/protocol/src/terminals.ts`; the stream is a WebSocket and is opened by `openTerminalStream`. */
export function terminalRoutes(context: RouteContext): Route[] {
    const { store, terminals } = context.services;

    return [
        { method: 'GET', pattern: /^\/v1\/terminals$/, handle: (_request, url) => json(terminals.list(url.searchParams.get('projectId') ?? undefined)) },
        {
            method: 'POST',
            pattern: /^\/v1\/terminals$/,
            handle: async (request) => {
                const body = await readJson(request, createBody);
                const project = requireProject(store, body.projectId);

                // A worktree that is not this folder's, or not this project's, is refused here, before a shell is started in it.
                return json(terminals.create(project, body, resolvePlace(store, project, body.folderId, body.workspaceId)));
            },
        },
        {
            method: 'DELETE',
            pattern: /^\/v1\/terminals\/([^/]+)$/,
            handle: (_request, _url, [id]) => {
                terminals.remove(id);

                return json({ ok: true });
            },
        },
    ];
}

/** Whether a request asks for a terminal's stream, and for which terminal. */
export function terminalStreamId(request: Request, pathname: string): string | undefined {
    const match = STREAM_ROUTE.exec(pathname);

    if (!match || request.method !== 'GET') {
        return undefined;
    }

    try {
        return decodeURIComponent(match[1]);
    }
    catch {
        // A malformed escape names no terminal; it is refused as `not_found`, after the token was checked, like any other id that is not there.
        return match[1];
    }
}

/**
 * Upgrades the request to the terminal's stream. Answers `undefined` when it did (Bun then owns the connection), and a refusal when not. The checks of `Host`
 * and `Origin` have run before this; the token is the one thing a WebSocket cannot send as a header from a page, so it also comes as a subprotocol.
 */
export function openTerminalStream(request: Request, server: Server<TerminalSocketData>, terminals: TerminalService, token: string, id: string): Response | undefined {
    const offered = request.headers.get('sec-websocket-protocol');
    const bearer = tokenFromTerminalProtocols(offered);

    if (!tokenMatches(bearer === undefined ? request.headers.get('authorization') : `Bearer ${ bearer }`, token)) {
        return unauthorized();
    }

    if (!terminals.find(id)) {
        return failure('not_found', `Terminal ${ id } does not exist`);
    }

    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return failure('invalid', 'This route is a WebSocket: upgrade the connection');
    }

    const answer = offered?.split(',').some(part => part.trim() === TERMINAL_SUBPROTOCOL) ? { 'sec-websocket-protocol': TERMINAL_SUBPROTOCOL } : undefined;

    return server.upgrade(request, { data: { terminalId: id }, headers: answer }) ? undefined : failure('internal', 'The connection could not be upgraded');
}

/** One connected window: what the shell prints goes out as binary frames, and when the socket cannot keep up it is sent a fresh screen instead. */
export class SocketClient implements TerminalListener {
    #behind = false;

    constructor(readonly socket: ServerWebSocket<TerminalSocketData>, readonly attach: (listener: TerminalListener) => Promise<void>) {}

    screen(message: ScreenMessage): void {
        this.#behind = false;
        this.socket.send(JSON.stringify(message));
    }

    output(data: Uint8Array): void {
        if (this.#behind) {
            return;
        }

        if (this.socket.getBufferedAmount() > HIGH_WATER_BYTES) {
            this.#behind = true;

            return;
        }

        this.socket.send(data);
    }

    exit(exitCode: number): void {
        this.socket.send(JSON.stringify({ type: 'exit', exitCode }));
    }

    /** The terminal was closed: the window is let go, and finds the terminal gone when it connects again. */
    gone(): void {
        this.socket.close(1001, 'The terminal was closed');
    }

    /** The socket can take more: a client that was passed over starts again from the screen as it is. */
    drained(): void {
        if (this.#behind && this.socket.getBufferedAmount() < LOW_WATER_BYTES) {
            this.#behind = false;
            void this.attach(this);
        }
    }
}

const clients = new WeakMap<ServerWebSocket<TerminalSocketData>, SocketClient>();

/** The socket side of the stream: the first thing a client is sent is its screen, and what it sends is the shell's input and its size. */
export function terminalSocket(terminals: TerminalService): WebSocketHandler<TerminalSocketData> {
    return {
        // The browser answers pings by itself; an idle shell must not drop its window.
        sendPings: true,
        idleTimeout: 120,
        maxPayloadLength: MAX_TERMINAL_INPUT_BYTES + 1024,
        open(socket) {
            const session = terminals.find(socket.data.terminalId);

            if (!session) {
                socket.close(1011, 'The terminal is gone');

                return;
            }

            const client = new SocketClient(socket, listener => session.attach(listener));

            clients.set(socket, client);
            void session.attach(client);
        },
        message(socket, message) {
            const session = terminals.find(socket.data.terminalId);

            if (!session) {
                return;
            }

            if (typeof message !== 'string') {
                session.write(new Uint8Array(message.buffer, message.byteOffset, message.byteLength));

                return;
            }

            let parsed: TerminalClientMessage | undefined;

            try {
                parsed = JSON.parse(message) as TerminalClientMessage;
            }
            catch {
                parsed = undefined;
            }

            if (parsed?.type === 'resize' && isTerminalSize(parsed.cols, parsed.rows)) {
                session.resize(parsed.cols, parsed.rows);
            }
            else {
                socket.close(1008, 'Not a message of the terminal protocol');
            }
        },
        drain(socket) {
            clients.get(socket)?.drained();
        },
        close(socket) {
            const client = clients.get(socket);

            if (client) {
                terminals.find(socket.data.terminalId)?.detach(client);
                clients.delete(socket);
            }
        },
    };
}
