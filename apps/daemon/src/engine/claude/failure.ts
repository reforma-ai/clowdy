// Adapted from Reforma's provider-error-message.ts and payer-failure.ts (apps/sandbox/src/chat/agent/helpers): readable
// text out of nested errors and wire bodies, and the limit / transient / access taxonomy, on Claude's own error texts.
import type { ClaudeAuth } from './config';

/** Stable identifiers of why a Claude turn failed. They go out as `EngineEvent.error.code`. */
export type FailureCode =
    | 'not_logged_in'
    | 'auth_failed'
    | 'usage_limit'
    | 'rate_limited'
    | 'overloaded'
    | 'server_error'
    | 'context_too_long'
    | 'billing'
    | 'invalid_request'
    | 'session_not_found'
    | 'engine_missing'
    | 'process_crashed'
    | 'unknown';

export interface Failure {
    code: FailureCode;
    /** What a person should read. */
    message: string;
    /** Whether trying the same work again later can succeed without anyone changing something. */
    retryable: boolean;
}

export interface FailureInput {
    auth: ClaudeAuth;
    /** The `error` field of the assistant message that carried the API error (`rate_limit`, `authentication_failed`, ...). */
    kind?: string;
    /** The error text: the CLI's own message, an API error body, or a thrown error's message. */
    text?: string;
    /** `result.terminal_reason` */
    terminalReason?: string;
    /** `result.subtype`, for the message when there is no text. */
    subtype?: string;
}

const MAX_DEPTH = 4;
const STDERR_CHARS = 500;

const NOT_LOGGED_IN = /not logged in|please run \/login|claude auth login|oauth token (?:has )?(?:expired|been revoked)|invalid (?:api key|x-api-key)|invalid authentication credentials/i;
const USAGE_LIMIT = /\b(?:hit|reached|exceeded) your (?:[\w-]+ )?limit|usage limit (?:reached|exceeded)|(?:5-hour|five-hour|weekly|session|monthly) limit|out of (?:extra )?usage/i;
const RESET = /\bresets?\s+(?:at\s+|on\s+)?([^.\n·∙|]+)/i;
const BILLING = /credit balance (?:is )?too low|billing|payment required|insufficient (?:credits?|quota|funds)|spend limit/i;
const RATE_LIMIT = /rate.?limit|too many requests/i;
const OVERLOADED = /overloaded/i;
const CONTEXT = /prompt (?:is )?too long|context (?:length|window)|maximum context|exceeds? (?:the )?(?:context|maximum)|request_too_large|input is too long/i;
const SESSION_NOT_FOUND = /no conversation found|session .{0,60}not found/i;
const MISSING_EXECUTABLE = /ENOENT|executable not found|native cli binary .* not found/i;
const CRASH = /exited with code|terminated by signal|process exited/i;
const API_STATUS = /\bAPI Error:?\s*(\d{3})\b/i;
const ACCOUNT_KINDS = ['oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'cloud_credential_error'];

/** Replaces a JSON error body inside `text` (`API Error: 529 {"error":{"message":"Overloaded"}}`) with its message. */
function unwrapBody(text: string, depth: number): string {
    const start = text.indexOf('{');

    if (start < 0 || depth > MAX_DEPTH) {
        return text.trim();
    }

    try {
        const body = JSON.parse(text.slice(start)) as { error?: { message?: unknown }; message?: unknown };
        const inner = body.error?.message ?? body.message;

        if (typeof inner === 'string' && inner.trim()) {
            return [text.slice(0, start).trim(), unwrapBody(inner, depth + 1)].filter(Boolean).join(' ');
        }
    }
    catch {
        // Not JSON after all: keep the prose.
    }

    return text.trim();
}

/** The text a person should read from a thrown error, an API error body or a nested `cause` chain. */
export function readableMessage(error: unknown, depth = 0): string {
    if (depth > MAX_DEPTH || error == null) {
        return '';
    }

    if (typeof error === 'string') {
        return unwrapBody(error, 0);
    }

    if (typeof error !== 'object') {
        return String(error);
    }

    const record = error as { message?: unknown; error?: unknown; cause?: unknown };

    if (typeof record.message === 'string' && record.message.trim()) {
        return unwrapBody(record.message, 0);
    }

    return readableMessage(record.error, depth + 1) || readableMessage(record.cause, depth + 1);
}

function resetPhrase(text: string): string | undefined {
    return RESET.exec(text)?.[1].trim().replace(/[\s,;:]+$/, '') || undefined;
}

function failure(code: FailureCode, message: string, retryable = false): Failure {
    return { code, message, retryable };
}

function authFailure(auth: ClaudeAuth, detail: string): Failure {
    if (auth === 'api-key') {
        return failure('auth_failed', 'Claude rejected the API key in CLOWDY_CLAUDE_API_KEY. Check that it is valid and belongs to an organization with credit.');
    }

    if (auth === 'oauth-token') {
        return failure('auth_failed', 'Claude rejected the token in CLOWDY_CLAUDE_OAUTH_TOKEN. Create a new one with `claude setup-token`.');
    }

    return NOT_LOGGED_IN.test(detail) || !detail
        ? failure('not_logged_in', 'Claude is not signed in. Run `claude auth login` in a terminal, then start again.')
        : failure('auth_failed', detail);
}

/** Sorts a failed turn into a stable code with a message people can act on. Pure: the same input gives the same answer. */
export function classifyFailure({ auth, kind, text = '', terminalReason, subtype }: FailureInput): Failure {
    const detail = readableMessage(text);
    const status = Number(API_STATUS.exec(text)?.[1]) || undefined;

    if (kind === 'authentication_failed' || NOT_LOGGED_IN.test(text) || status === 401) {
        return authFailure(auth, detail);
    }

    if (kind !== undefined && ACCOUNT_KINDS.includes(kind)) {
        return failure('auth_failed', detail || 'The Claude account cannot be used right now.');
    }

    if (USAGE_LIMIT.test(text)) {
        const resets = resetPhrase(text);

        return failure('usage_limit', `Claude usage limit reached${ resets ? `; it resets ${ resets }` : '' }.`, true);
    }

    if (kind === 'billing_error' || status === 402 || BILLING.test(text)) {
        return failure('billing', detail || 'Claude billing needs attention: the account has no credit left.');
    }

    if (kind === 'rate_limit' || status === 429 || RATE_LIMIT.test(text)) {
        return failure('rate_limited', `Claude is rate limiting requests. ${ detail }`.trim(), true);
    }

    if (kind === 'overloaded' || status === 529 || status === 503 || OVERLOADED.test(text)) {
        return failure('overloaded', 'Claude is overloaded right now. Try again in a few minutes.', true);
    }

    if (terminalReason === 'prompt_too_long' || CONTEXT.test(text)) {
        return failure('context_too_long', 'The conversation no longer fits the model\'s context window. Start a new chat.');
    }

    if (SESSION_NOT_FOUND.test(text)) {
        return failure('session_not_found', 'The earlier Claude session cannot be found, so the run cannot continue it. Start a new chat.');
    }

    if (kind === 'invalid_request' || kind === 'model_not_found' || status === 400 || status === 404) {
        return failure('invalid_request', detail || 'Claude rejected the request.');
    }

    if (kind === 'server_error' || (status !== undefined && status >= 500)) {
        return failure('server_error', detail || 'Claude had a server error.', true);
    }

    return failure('unknown', detail || `Claude stopped without an answer${ subtype ? ` (${ subtype })` : '' }.`);
}

/** Classifies an error thrown by the SDK: a missing binary, a crashed process, or a failure whose text the classifier knows. */
export function classifyThrown(error: unknown, auth: ClaudeAuth, stderr = ''): Failure {
    const text = readableMessage(error);

    if (MISSING_EXECUTABLE.test(text)) {
        return failure('engine_missing', `The Claude Code program could not be started (${ text }). Set CLOWDY_CLAUDE_BIN to the path of \`claude\` or reinstall the daemon's dependencies.`);
    }

    const classified = classifyFailure({ auth, text: [text, stderr].filter(Boolean).join('\n') });

    if (classified.code !== 'unknown' || !CRASH.test(text)) {
        return classified;
    }

    const tail = stderr.trim().slice(-STDERR_CHARS);

    return failure('process_crashed', `Claude Code stopped unexpectedly (${ text }).${ tail ? ` Last output: ${ tail }` : '' }`, true);
}
