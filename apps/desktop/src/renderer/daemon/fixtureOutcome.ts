import type { ErrorCode } from '@clowdy/protocol';

/** What the fixture daemon answers a command with, before the transport gives it a request id. */
export type Outcome =
    | { ok: true; data: unknown }
    | { ok: false; error: { code: ErrorCode; message: string; details?: unknown } };

export const ok = (data: unknown = {}): Outcome => ({ ok: true, data });
export const fail = (code: ErrorCode, message: string, details?: unknown): Outcome => ({
    ok: false,
    error: { code, message, details },
});
