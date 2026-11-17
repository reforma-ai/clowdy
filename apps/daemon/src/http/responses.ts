import { HTTP_STATUS } from '../errors';

import type { CommandResult, ErrorCode } from '@clowdy/protocol';

export function json(body: unknown, status = 200): Response {
    return Response.json(body, { status });
}

/** The error body every route uses; it has the shape of a failed `CommandResult`. */
export function failure(code: ErrorCode, message: string, details?: unknown, requestId?: string): Response {
    const body = { ok: false, ...(requestId !== undefined && { requestId }), error: { code, message, ...(details !== undefined && { details }) } };

    return json(body, HTTP_STATUS[code]);
}

export function commandResponse(result: CommandResult): Response {
    return json(result, result.ok ? 200 : HTTP_STATUS[result.error.code]);
}

/** Host and origin refusals: the caller is not who may talk to the daemon, whatever token it holds. */
export function forbidden(message: string): Response {
    return json({ ok: false, error: { code: 'unauthorized', message } }, 403);
}
