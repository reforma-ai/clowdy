import { describe, expect, test } from 'bun:test';

import { classifyFailure, classifyThrown, processEnded } from '../src/engine/acp/failure';
import { readableMessage } from '../src/engine/error-text';

const agent = { agent: 'Codex', login: 'codex login' };

describe('classifyFailure', () => {
    test.each([
        [{ rpcCode: -32000, text: 'Authentication required' }, 'not_logged_in', false],
        [{ text: 'Please run /login' }, 'not_logged_in', false],
        [{ text: 'API Error: 401 invalid x-api-key' }, 'not_logged_in', false],
        [{ kind: 'oauth_org_not_allowed', text: 'Your organization cannot use this' }, 'auth_failed', false],
        [{ text: 'You have hit your limit. It resets 3pm (Europe/Berlin)' }, 'usage_limit', true],
        [{ text: 'Your credit balance is too low' }, 'billing', false],
        [{ text: 'API Error: 429 rate limit' }, 'rate_limited', true],
        [{ text: 'API Error: 529 {"error":{"message":"Overloaded"}}' }, 'overloaded', true],
        [{ text: 'prompt is too long' }, 'context_too_long', false],
        [{ rpcCode: -32002, text: 'Resource not found' }, 'session_not_found', false],
        [{ text: 'API Error: 400 bad' }, 'invalid_request', false],
        [{ text: 'API Error: 500 oops' }, 'server_error', true],
        [{ text: 'something nobody planned for' }, 'unknown', false],
    ])('%j is %s (retryable: %p)', (input, code, retryable) => {
        expect(classifyFailure({ ...agent, ...input })).toMatchObject({ code, retryable });
    });

    test('an adapter that bun x refuses for its age is a plain, final failure, not a crash to retry', () => {
        const stderr = 'Resolving dependencies\nerror: No version matching "2.8.0" found for specifier "@agentclientprotocol/codex-acp" (blocked by minimum-release-age: 259200 seconds)\nerror: @agentclientprotocol/codex-acp@2.8.0 failed to resolve';
        const failed = classifyThrown(new Error('ACP connection closed'), agent, stderr);

        expect(failed).toMatchObject({ code: 'adapter_unavailable', retryable: false });
        expect(failed.message).toBe('The Codex adapter (@agentclientprotocol/codex-acp@2.8.0) could not be installed, because Bun\'s minimum release age blocks a version that new. Try again once it is old enough, or lower the setting in ~/.bunfig.toml.');
        expect(processEnded(agent, 'exited with code 1', stderr)).toMatchObject({ code: 'adapter_unavailable', retryable: false });
    });

    test('a signed-out agent says which command signs it in', () => {
        expect(classifyFailure({ ...agent, rpcCode: -32000 }).message).toBe('Codex is not signed in. Run `codex login` in a terminal, then start again.');
        expect(classifyFailure({ agent: 'Mine', rpcCode: -32000 }).message).toBe('Mine is not signed in. Sign in with its own command, then start again.');
    });

    test('the reset time of a usage limit is passed on', () => {
        expect(classifyFailure({ ...agent, text: 'You have reached your weekly limit. Resets Monday 9am' }).message).toBe('Codex usage limit reached; it resets Monday 9am.');
    });
});

describe('classifyThrown', () => {
    test('a program that cannot be started is engine_missing', () => {
        expect(classifyThrown(Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }), agent)).toMatchObject({ code: 'engine_missing' });
    });

    test('the JSON-RPC code and the adapter\'s error kind are read from the error', () => {
        expect(classifyThrown(Object.assign(new Error('Internal error'), { code: -32603, data: { errorKind: 'rate_limit' } }), agent)).toMatchObject({ code: 'rate_limited', retryable: true });
        expect(classifyThrown(Object.assign(new Error('Authentication required'), { code: -32000 }), agent)).toMatchObject({ code: 'not_logged_in' });
    });

    test('stderr helps classify, and a crash with no known cause quotes it', () => {
        expect(classifyThrown(new Error('stream closed'), agent, 'Error: not logged in')).toMatchObject({ code: 'not_logged_in' });
        expect(classifyThrown(new Error('stream closed'), agent, 'segfault')).toMatchObject({ code: 'process_crashed', retryable: true, message: expect.stringContaining('segfault') });
    });
});

describe('processEnded', () => {
    test('the last words of the process decide', () => {
        expect(processEnded(agent, 'exit code 1', 'Error: Authentication required')).toMatchObject({ code: 'not_logged_in' });
        expect(processEnded(agent, 'exit code 3', 'boom')).toMatchObject({ code: 'process_crashed', message: 'Codex stopped unexpectedly (exit code 3). Last output: boom' });
    });
});

describe('readableMessage', () => {
    test('unwraps JSON bodies and nested causes, and adds an ACP error\'s details', () => {
        expect(readableMessage('API Error: 529 {"error":{"message":"Overloaded"}}')).toBe('API Error: 529 Overloaded');
        expect(readableMessage({ cause: { message: 'inner' } })).toBe('inner');
        expect(readableMessage({ message: 'Internal error', data: { details: 'Model not found' } })).toBe('Internal error: Model not found');
    });
});
