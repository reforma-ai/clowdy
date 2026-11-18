// Adapted from Reforma's provider-error-message.ts and payer-failure.ts (apps/sandbox/src/chat/agent/helpers): readable
// text out of nested errors and wire bodies, and the limit / transient / access taxonomy, on the agents' own error texts.

import { readableMessage } from '../error-text';

/** Stable identifiers of why a turn failed. They go out as `EngineEvent.error.code`. */
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

export interface FailureContext {
    /** The agent's name, for messages. */
    agent: string;
    /** The command that signs the agent in, when it has one. */
    login?: string;
}

export interface FailureInput extends FailureContext {
    /** A structured kind the agent attached to the error (`rate_limit`, `authentication_failed`, ...). */
    kind?: string;
    /** The JSON-RPC error code, when the error came from the agent's reply. */
    rpcCode?: number;
    /** The error text: the agent's own message, an API error body, or a thrown error's message. */
    text?: string;
}

const STDERR_CHARS = 500;

/** ACP's "authentication required" and "resource not found" JSON-RPC codes. */
const AUTH_REQUIRED = -32000;
const RESOURCE_NOT_FOUND = -32002;

const NOT_LOGGED_IN = /not logged in|not signed in|please (?:run )?\/?login|auth(?:entication)? required|log ?in required|sign ?in required|oauth token (?:has )?(?:expired|been revoked)|invalid (?:api key|x-api-key)|invalid authentication credentials|unauthorized|no credentials|missing api key/i;
const USAGE_LIMIT = /\b(?:hit|reached|exceeded) your (?:[\w-]+ )?limit|usage limit (?:reached|exceeded)|(?:5-hour|five-hour|weekly|session|monthly) limit|out of (?:extra )?usage/i;
const RESET = /\bresets?\s+(?:at\s+|on\s+)?([^.\n·∙|]+)/i;
const BILLING = /credit balance (?:is )?too low|billing|payment required|insufficient (?:credits?|quota|funds)|spend limit/i;
const RATE_LIMIT = /rate.?limit|too many requests/i;
const OVERLOADED = /overloaded/i;
const CONTEXT = /prompt (?:is )?too long|context (?:length|window)|maximum context|exceeds? (?:the )?(?:context|maximum)|request_too_large|input is too long/i;
const SESSION_NOT_FOUND = /no conversation found|session .{0,60}not found|resource not found/i;
const MISSING_EXECUTABLE = /ENOENT|executable not found|command not found|not found on path/i;
const CRASH = /exited with code|terminated by signal|process exited|connection closed|stream closed/i;
const API_STATUS = /\b(?:API Error|status|HTTP)[: ]*(\d{3})\b/i;
const ACCOUNT_KINDS = ['oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'cloud_credential_error'];

function resetPhrase(text: string): string | undefined {
    return RESET.exec(text)?.[1].trim().replace(/[\s,;:]+$/, '') || undefined;
}

function failure(code: FailureCode, message: string, retryable = false): Failure {
    return { code, message, retryable };
}

function signedOut({ agent, login }: FailureContext): Failure {
    return failure('not_logged_in', `${ agent } is not signed in.${ login ? ` Run \`${ login }\` in a terminal, then start again.` : ' Sign in with its own command, then start again.' }`);
}

/** Sorts a failed turn into a stable code with a message people can act on. Pure: the same input gives the same answer. */
export function classifyFailure({ agent, login, kind, rpcCode, text = '' }: FailureInput): Failure {
    const detail = readableMessage(text);
    const status = Number(API_STATUS.exec(text)?.[1]) || undefined;

    if (rpcCode === AUTH_REQUIRED || kind === 'authentication_failed' || NOT_LOGGED_IN.test(text) || status === 401) {
        return signedOut({ agent, login });
    }

    if (kind !== undefined && ACCOUNT_KINDS.includes(kind)) {
        return failure('auth_failed', detail || `The ${ agent } account cannot be used right now.`);
    }

    if (USAGE_LIMIT.test(text)) {
        const resets = resetPhrase(text);

        return failure('usage_limit', `${ agent } usage limit reached${ resets ? `; it resets ${ resets }` : '' }.`, true);
    }

    if (kind === 'billing_error' || status === 402 || BILLING.test(text)) {
        return failure('billing', detail || `${ agent } billing needs attention: the account has no credit left.`);
    }

    if (kind === 'rate_limit' || status === 429 || RATE_LIMIT.test(text)) {
        return failure('rate_limited', `${ agent } is rate limiting requests. ${ detail }`.trim(), true);
    }

    if (kind === 'overloaded' || status === 529 || status === 503 || OVERLOADED.test(text)) {
        return failure('overloaded', `${ agent } is overloaded right now. Try again in a few minutes.`, true);
    }

    if (CONTEXT.test(text)) {
        return failure('context_too_long', 'The conversation no longer fits the model\'s context window. Start a new chat.');
    }

    if (rpcCode === RESOURCE_NOT_FOUND || SESSION_NOT_FOUND.test(text)) {
        return failure('session_not_found', `The earlier ${ agent } session cannot be found, so the run cannot continue it. Start a new chat.`);
    }

    if (kind === 'invalid_request' || kind === 'model_not_found' || status === 400 || status === 404) {
        return failure('invalid_request', detail || `${ agent } rejected the request.`);
    }

    if (kind === 'server_error' || (status !== undefined && status >= 500)) {
        return failure('server_error', detail || `${ agent } had a server error.`, true);
    }

    return failure('unknown', detail || `${ agent } stopped without an answer.`);
}

/** Classifies an error thrown while talking to the agent: a program that cannot start, a crash, or a failure whose text the classifier knows. */
export function classifyThrown(error: unknown, context: FailureContext, stderr = ''): Failure {
    const text = readableMessage(error);
    const rpc = error as { code?: unknown; data?: { errorKind?: unknown; kind?: unknown } } | null;
    const rpcCode = typeof rpc?.code === 'number' ? rpc.code : undefined;
    const kind = [rpc?.data?.errorKind, rpc?.data?.kind].find((value): value is string => typeof value === 'string');

    if (typeof rpc?.code === 'string' ? rpc.code === 'ENOENT' : MISSING_EXECUTABLE.test(text)) {
        return failure('engine_missing', `${ context.agent } could not be started (${ text }). Check that it is installed and that Clowdy can see it.`);
    }

    const classified = classifyFailure({ ...context, kind, rpcCode, text: [text, stderr].filter(Boolean).join('\n') });

    if (classified.code !== 'unknown' || !CRASH.test(text)) {
        return classified;
    }

    const tail = stderr.trim().slice(-STDERR_CHARS);

    return failure('process_crashed', `${ context.agent } stopped unexpectedly (${ text }).${ tail ? ` Last output: ${ tail }` : '' }`, true);
}

/** The agent's process ended while a turn was running. Its last words say why; a sign-in problem shows there too. */
export function processEnded(context: FailureContext, detail: string, stderr: string): Failure {
    const classified = classifyFailure({ ...context, text: stderr });

    if (classified.code !== 'unknown') {
        return classified;
    }

    const tail = stderr.trim().slice(-STDERR_CHARS);

    return failure('process_crashed', `${ context.agent } stopped unexpectedly (${ detail }).${ tail ? ` Last output: ${ tail }` : '' }`, true);
}
