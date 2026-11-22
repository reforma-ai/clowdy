import type { FolderId, ProjectId } from './domain';

/**
 * Terminals: shells the daemon runs on a pseudo-terminal in one of a project's folders. The shell belongs to the daemon, not to the window: a reload, a second
 * window or a dropped connection comes back to the same shell, and the shell lives until it is closed, it exits or the daemon stops. Because the daemon is the
 * one that spawns it, the same routes work when the daemon runs on another machine.
 *
 * GET    /v1/terminals?projectId=      -> TerminalInfo[] (running ones and recently exited ones, oldest first; `projectId` limits them to one project)
 * POST   /v1/terminals                 -> TerminalInfo. Body `TerminalCreate`. The shell starts in the folder (or in `path` below it) with the given size.
 *                                         `not_found` for a project or folder that is not there, `unavailable` when the folder is missing on the disk or
 *                                         the machine has no shell to run, `conflict` (`details.reason: 'limit'`) past `MAX_TERMINALS` running ones.
 * DELETE /v1/terminals/:id             -> { ok: true }. Ends the shell (hang-up, then kill) and forgets the terminal; one that is not there is `not_found`.
 *                                         The streams still open on it are closed with code 1001: a client that connects again finds the terminal `not_found`.
 * GET    /v1/terminals/:id/stream      -> a WebSocket (see `TerminalServerMessage`), for as long as the client keeps it. Closing it leaves the shell running.
 *
 * The stream. A browser cannot set headers on a WebSocket, so the token travels as a subprotocol: the client offers `TERMINAL_SUBPROTOCOL` and
 * `terminalTokenProtocol(token)`, the daemon answers with the first. A client that can set headers may send `Authorization: Bearer` instead. The `Origin` and
 * `Host` rules of the rest of the API apply.
 *
 * - Binary frames are the shell's bytes: from the client its input (at most `MAX_TERMINAL_INPUT_BYTES` a frame), from the daemon its output, in order. Bytes
 *   rather than text, so a character split between two frames reaches the screen whole.
 * - Text frames are JSON: `TerminalClientMessage` from the client, `TerminalServerMessage` from the daemon.
 * - The first message after the upgrade is always `screen`: the whole screen as it is now (scrollback, both buffers, cursor and modes), serialized by the
 *   daemon's own copy of the terminal. Output follows from exactly there, none missed and none twice. A client that falls behind (the daemon sees its
 *   socket buffer fill) is sent a new `screen` in place of the output it cannot take, so a slow client never sees a torn screen.
 * - The shell has one size. The last `resize` wins, whichever client sent it.
 */

export type TerminalId = string;

export type TerminalState = 'running' | 'exited';

/** At most this many shells run at once on one daemon. */
export const MAX_TERMINALS = 16;

/** The size a PTY may have, in cells. */
export const MIN_TERMINAL_COLS = 2;
export const MAX_TERMINAL_COLS = 500;
export const MIN_TERMINAL_ROWS = 2;
export const MAX_TERMINAL_ROWS = 200;

/** The most input bytes one frame carries; a client splits a longer paste. */
export const MAX_TERMINAL_INPUT_BYTES = 64 * 1024;

/** Lines the daemon keeps above the screen, which a `screen` message replays; the client's scrollback should match. */
export const TERMINAL_SCROLLBACK = 5000;

export interface TerminalInfo {
    id: TerminalId;
    projectId: ProjectId;
    folderId: FolderId;
    /** Absolute path the shell started in. */
    cwd: string;
    /** The shell program's name, `zsh`, `bash`, `pwsh`: what a tab can be called. */
    shell: string;
    cols: number;
    rows: number;
    state: TerminalState;
    /** Set once `state` is `exited`. */
    exitCode?: number;
    createdAt: number;
}

export interface TerminalCreate {
    projectId: ProjectId;
    folderId: FolderId;
    /** A folder below the project folder, `/` separators, `''` or absent for the folder itself. */
    path?: string;
    cols: number;
    rows: number;
}

/** Whether a size is one a PTY can take: whole numbers within the limits. */
export function isTerminalSize(cols: unknown, rows: unknown): boolean {
    return typeof cols === 'number' && typeof rows === 'number' && Number.isInteger(cols) && Number.isInteger(rows)
        && cols >= MIN_TERMINAL_COLS && cols <= MAX_TERMINAL_COLS
        && rows >= MIN_TERMINAL_ROWS && rows <= MAX_TERMINAL_ROWS;
}

export type TerminalClientMessage =
    | { type: 'resize'; cols: number; rows: number };

/** The screen of a terminal as the daemon's own copy of it has it: what a client shows before the output that follows. */
export interface TerminalScreen {
    /** Escape sequences that draw the scrollback and the screen, its cursor and its modes, when written to a terminal of `cols` by `rows`. */
    screen: string;
    cols: number;
    rows: number;
    state: TerminalState;
    exitCode?: number;
}

export type TerminalServerMessage =
    /** The screen as it is now; whatever the client showed before is replaced by it. */
    | ({ type: 'screen' } & TerminalScreen)
    /** The shell ended; all its output was sent before this. */
    | { type: 'exit'; exitCode: number };

/** The subprotocol the daemon answers a terminal stream with. */
export const TERMINAL_SUBPROTOCOL = 'clowdy.terminal.v1';

const TOKEN_PROTOCOL_PREFIX = 'clowdy.token.';

/** The token as a subprotocol: base64url of its UTF-8 bytes, since a subprotocol is a narrow set of characters and a token any text. */
export function terminalTokenProtocol(token: string): string {
    let binary = '';

    for (const byte of new TextEncoder().encode(token)) {
        binary += String.fromCharCode(byte);
    }

    return `${ TOKEN_PROTOCOL_PREFIX }${ btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') }`;
}

/** The token a client offered in `Sec-WebSocket-Protocol`, or `undefined` when it offered none or a malformed one. */
export function tokenFromTerminalProtocols(header: string | null): string | undefined {
    const offered = (header ?? '').split(',').map(part => part.trim()).find(part => part.startsWith(TOKEN_PROTOCOL_PREFIX));

    if (offered === undefined) {
        return undefined;
    }

    try {
        const base64 = offered.slice(TOKEN_PROTOCOL_PREFIX.length).replaceAll('-', '+').replaceAll('_', '/');
        const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));

        return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
    }
    catch {
        return undefined;
    }
}
