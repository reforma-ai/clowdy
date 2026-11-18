import type { ErrorCode } from '@clowdy/protocol';

/** A failure the caller caused or can act on. It carries the protocol's error code; anything else is an internal error. */
export class CommandError extends Error {
    constructor(readonly code: ErrorCode, message: string, readonly details?: unknown) {
        super(message);
        this.name = 'CommandError';
    }
}

export const invalid = (message: string, details?: unknown) => new CommandError('invalid', message, details);
export const notFound = (what: string, id: string) => new CommandError('not_found', `${ what } ${ id } does not exist`);
export const conflict = (message: string, details?: unknown) => new CommandError('conflict', message, details);
export const unavailable = (message: string) => new CommandError('unavailable', message);

/** An upload over its size limit: `invalid` to a client, answered with HTTP 413 rather than 400. */
export class TooLargeError extends CommandError {
    constructor(message: string, details?: unknown) {
        super('invalid', message, details);
        this.name = 'TooLargeError';
    }
}

export const HTTP_STATUS: Record<ErrorCode, number> = {
    invalid: 400,
    unauthorized: 401,
    not_found: 404,
    conflict: 409,
    already_running: 409,
    unavailable: 503,
    internal: 500,
};

/** Thrown when the engine ends a run with an error event; the run fails with this message. */
export class EngineFailure extends Error {
    constructor(message: string, readonly retryable = false) {
        super(message);
        this.name = 'EngineFailure';
    }
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
