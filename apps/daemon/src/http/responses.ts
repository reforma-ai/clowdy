import { HTTP_STATUS } from '../errors';

import type { CommandResult, ErrorCode } from '@clowdy/protocol';

export function json(body: unknown, status = 200): Response {
    return Response.json(body, { status });
}

/** The error body every route uses; it has the shape of a failed `CommandResult`. */
export function failure(code: ErrorCode, message: string, details?: unknown, requestId?: string, status: number = HTTP_STATUS[code]): Response {
    const body = { ok: false, ...(requestId !== undefined && { requestId }), error: { code, message, ...(details !== undefined && { details }) } };

    return json(body, status);
}

/** What Bun itself answered to a body over its limit before the daemon set its own: status and reason, no body. */
export function bodyTooLarge(): Response {
    return new Response(null, { status: 413, statusText: 'Request Entity Too Large', headers: { connection: 'close' } });
}

export function commandResponse(result: CommandResult): Response {
    return json(result, result.ok ? 200 : HTTP_STATUS[result.error.code]);
}

/** Host and origin refusals: the caller is not who may talk to the daemon, whatever token it holds. */
export function forbidden(message: string): Response {
    return json({ ok: false, error: { code: 'unauthorized', message } }, 403);
}
