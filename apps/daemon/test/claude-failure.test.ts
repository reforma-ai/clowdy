import { describe, expect, test } from 'bun:test';

import { classifyFailure, classifyThrown } from '../src/engine/claude/failure';
import { readableMessage } from '../src/engine/error-text';

describe('readable messages', () => {
    test('an API error body becomes its message, keeping the status', () => {
        const body = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_1"}';

        expect(readableMessage(body)).toBe('API Error: 529 Overloaded');
    });

    test('bodies wrapped in bodies are unwrapped', () => {
        const inner = JSON.stringify({ error: { message: 'Credit balance is too low' } });
        const outer = `API Error: 400 ${ JSON.stringify({ error: { message: inner } }) }`;

        expect(readableMessage(outer)).toBe('API Error: 400 Credit balance is too low');
    });

    test('plain prose and broken JSON stay as they are', () => {
        expect(readableMessage('  Not logged in · Please run /login ')).toBe('Not logged in · Please run /login');
        expect(readableMessage('oops {not json')).toBe('oops {not json');
    });

    test('errors give their message, or their cause\'s when they have none', () => {
        expect(readableMessage(new Error('plain'))).toBe('plain');
        expect(readableMessage(new Error('', { cause: new Error('the cause') }))).toBe('the cause');
        expect(readableMessage({ error: { message: 'nested' } })).toBe('nested');
        expect(readableMessage(undefined)).toBe('');
    });
});

describe('failure classes', () => {
    const classify = (text: string, extra: Partial<Parameters<typeof classifyFailure>[0]> = {}) => classifyFailure({ auth: 'subscription', text, ...extra });

    test('not logged in says what to do, and is not retried', () => {
        const failure = classify('Not logged in · Please run /login', { kind: 'authentication_failed' });

        expect(failure).toEqual({ code: 'not_logged_in', retryable: false, message: 'Claude is not signed in. Run `claude auth login` in a terminal, then start again.' });
    });

    test('an expired login is the same failure', () => {
        expect(classify('OAuth token has expired. Please run /login.').code).toBe('not_logged_in');
    });

    test('a rejected API key or token names the setting that holds it, never its value', () => {
        const key = classifyFailure({ auth: 'api-key', text: 'Invalid API key · Fix external API key', kind: 'authentication_failed' });
        const token = classifyFailure({ auth: 'oauth-token', text: 'OAuth token has expired', kind: 'authentication_failed' });

        expect(key).toMatchObject({ code: 'auth_failed', retryable: false });
        expect(key.message).toContain('CLOWDY_CLAUDE_API_KEY');
        expect(token.message).toContain('CLOWDY_CLAUDE_OAUTH_TOKEN');
    });

    test('a 401 is an authentication failure even without a kind', () => {
        expect(classify('API Error: 401 {"error":{"message":"invalid x-api-key"}}').code).toBe('not_logged_in');
    });

    test('an account the organization or Anthropic has blocked keeps the CLI\'s explanation', () => {
        expect(classify('Your account is on hold', { kind: 'account_on_hold' })).toEqual({ code: 'auth_failed', retryable: false, message: 'Your account is on hold' });
    });

    test.each([
        ['You\'ve hit your limit · resets 3pm (Europe/Berlin)', 'it resets 3pm (Europe/Berlin)'],
        ['5-hour limit reached ∙ resets 11:30pm', 'it resets 11:30pm'],
        ['You\'ve hit your weekly limit · resets Nov 20, 9am', 'it resets Nov 20, 9am'],
        ['Claude usage limit reached.', undefined],
    ])('a usage limit (%s) is retryable after the reset', (text, resets) => {
        const failure = classify(text, { kind: 'rate_limit' });

        expect(failure.code).toBe('usage_limit');
        expect(failure.retryable).toBe(true);
        expect(failure.message).toBe(resets ? `Claude usage limit reached; ${ resets }.` : 'Claude usage limit reached.');
    });

    test('a plain 429 is a transient rate limit, not a usage limit', () => {
        expect(classify('API Error: 429 {"error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}')).toMatchObject({ code: 'rate_limited', retryable: true });
        expect(classify('', { kind: 'rate_limit' }).code).toBe('rate_limited');
    });

    test('overload (529) and unavailability (503) are transient', () => {
        expect(classify('API Error: 529 {"error":{"type":"overloaded_error","message":"Overloaded"}}')).toMatchObject({ code: 'overloaded', retryable: true });
        expect(classify('API Error: 503 Service Unavailable').code).toBe('overloaded');
        expect(classify('', { kind: 'overloaded' }).code).toBe('overloaded');
    });

    test('server errors are retried, bad requests are not', () => {
        expect(classify('API Error: 500 {"error":{"message":"Internal server error"}}')).toMatchObject({ code: 'server_error', retryable: true, message: 'API Error: 500 Internal server error' });
        expect(classify('API Error: 400 {"error":{"message":"messages: text content blocks must be non-empty"}}')).toMatchObject({ code: 'invalid_request', retryable: false });
        expect(classify('model: claude-nope not found', { kind: 'model_not_found' }).code).toBe('invalid_request');
    });

    test('a conversation that outgrew the model is not retried', () => {
        expect(classify('Prompt is too long')).toMatchObject({ code: 'context_too_long', retryable: false });
        expect(classify('', { terminalReason: 'prompt_too_long' }).code).toBe('context_too_long');
    });

    test('an empty account balance is a billing problem', () => {
        expect(classify('Credit balance is too low', { kind: 'billing_error' })).toMatchObject({ code: 'billing', retryable: false });
        expect(classify('API Error: 402 payment required').code).toBe('billing');
    });

    test('a session that cannot be resumed is its own failure', () => {
        expect(classify('No conversation found with session ID: 1234').code).toBe('session_not_found');
    });

    test('anything else keeps the CLI\'s words, or names the subtype when there are none', () => {
        expect(classify('Something odd happened')).toEqual({ code: 'unknown', retryable: false, message: 'Something odd happened' });
        expect(classify('', { subtype: 'error_max_turns' }).message).toBe('Claude stopped without an answer (error_max_turns).');
        expect(classify('').message).toBe('Claude stopped without an answer.');
    });
});

describe('errors thrown by the SDK', () => {
    test('a missing program points at the setting that fixes it', () => {
        const failure = classifyThrown(new Error('Native CLI binary for darwin-arm64 not found'), 'subscription');

        expect(failure).toMatchObject({ code: 'engine_missing', retryable: false });
        expect(failure.message).toContain('CLOWDY_CLAUDE_BIN');
        expect(classifyThrown(Object.assign(new Error('spawn /nope ENOENT'), { code: 'ENOENT' }), 'subscription').code).toBe('engine_missing');
    });

    test('a crash is retryable and shows the last words of the process', () => {
        const failure = classifyThrown(new Error('Claude Code process exited with code 1'), 'subscription', 'Segmentation fault\n');

        expect(failure).toMatchObject({ code: 'process_crashed', retryable: true });
        expect(failure.message).toContain('exited with code 1');
        expect(failure.message).toContain('Segmentation fault');
    });

    test('a crash whose stderr says the user is logged out is a login problem', () => {
        expect(classifyThrown(new Error('Claude Code process exited with code 1'), 'subscription', 'Error: Not logged in · Please run /login').code).toBe('not_logged_in');
    });

    test('the tail of a long stderr is kept, not the head', () => {
        const stderr = `${ 'noise '.repeat(500) }THE END`;
        const failure = classifyThrown(new Error('Claude Code process exited with code 2'), 'subscription', stderr);

        expect(failure.message).toContain('THE END');
        expect(failure.message.length).toBeLessThan(700);
    });

    test('other errors are classified by their text', () => {
        expect(classifyThrown(new Error('API Error: 529 {"error":{"message":"Overloaded"}}'), 'subscription').code).toBe('overloaded');
        expect(classifyThrown(new Error('something else'), 'subscription')).toEqual({ code: 'unknown', retryable: false, message: 'something else' });
    });
});
