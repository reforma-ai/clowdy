import { describe, expect, it } from 'vitest';

import { accountLine, formatEnv, isSignInRunning, parseEnv, providerAgents } from './providerView';

import type { AgentInfo } from '@clowdy/protocol';

const agent = (patch: Partial<AgentInfo> = {}): AgentInfo => ({ id: 'claude', name: 'Claude Code', custom: false, enabled: true, status: 'ready', launch: 'x', ...patch });

describe('providerAgents', () => {
    it('keeps Claude, Codex and Cursor in that order and leaves the others out', () => {
        const all = ['gemini', 'cursor', 'mine', 'claude', 'codex'].map(id => agent({ id }));

        expect(providerAgents(all).map(item => item.id)).toEqual(['claude', 'codex', 'cursor']);
        expect(providerAgents([agent({ id: 'codex' })]).map(item => item.id)).toEqual(['codex']);
    });
});

describe('accountLine', () => {
    it('shows the e-mail and the plan of who is signed in', () => {
        const line = accountLine(agent({ signIn: { status: 'signed-in', checkedAt: 1, account: { email: 'me@x.dev', plan: 'Max' } } }));

        expect(line).toMatchObject({ text: 'me@x.dev', plan: 'Max' });
    });

    it('falls back to the name, then to how it is signed in', () => {
        expect(accountLine(agent({ signIn: { status: 'signed-in', checkedAt: 1, account: { name: 'Dev' } } })).text).toBe('Dev');
        expect(accountLine(agent({ signIn: { status: 'signed-in', checkedAt: 1, account: { method: 'api-key' } } })).text).toBe('Signed in with an API key');
        expect(accountLine(agent({ signIn: { status: 'signed-in', checkedAt: 1 } })).text).toBe('Signed in');
    });

    it('says so when nobody is signed in, and when it has not asked yet', () => {
        expect(accountLine(agent({ signIn: { status: 'signed-out', checkedAt: 1 } }))).toMatchObject({ text: 'Not signed in', tone: 'warning' });
        expect(accountLine(agent())).toMatchObject({ text: 'Checking who is signed in…', tone: 'muted' });
        expect(accountLine(agent({ signIn: { status: 'unknown', checkedAt: 1, detail: 'The program did not answer' } }))).toMatchObject({ text: 'Could not tell who is signed in', detail: 'The program did not answer' });
    });

    it('puts a missing program or runtime before anything else, with the daemon\'s hint', () => {
        expect(accountLine(agent({ status: 'missing', detail: 'Install it' }))).toMatchObject({ text: 'Not installed', detail: 'Install it' });
        expect(accountLine(agent({ status: 'needs-runtime', detail: 'Install Bun' }))).toMatchObject({ text: 'Needs Bun to start', detail: 'Install Bun' });
    });

    it('keeps showing the account of an agent that is turned off, and says it is off when there is none', () => {
        expect(accountLine(agent({ enabled: false, status: 'disabled', signIn: { status: 'signed-in', checkedAt: 1, account: { email: 'me@x.dev' } } })).text).toBe('me@x.dev');
        expect(accountLine(agent({ enabled: false, status: 'disabled' })).text).toBe('Turned off in Clowdy');
    });
});

describe('isSignInRunning', () => {
    it('is true while the daemon waits for the person, and false before, after and without one', () => {
        expect(isSignInRunning({ step: 'starting', startedAt: 1 })).toBe(true);
        expect(isSignInRunning({ step: 'waiting', startedAt: 1 })).toBe(true);
        expect(isSignInRunning({ step: 'done', startedAt: 1 })).toBe(false);
        expect(isSignInRunning({ step: 'failed', startedAt: 1 })).toBe(false);
        expect(isSignInRunning(undefined)).toBe(false);
    });
});

describe('the environment editor', () => {
    it('reads KEY=VALUE lines, skipping blanks and comments, and keeps an equals sign in a value', () => {
        expect(parseEnv('A=1\n\n# note\r\nB = two words\nURL=https://x.dev/?a=b')).toEqual({ ok: true, env: { A: '1', B: 'two words', URL: 'https://x.dev/?a=b' } });
        expect(parseEnv('EMPTY=')).toEqual({ ok: true, env: { EMPTY: '' } });
        expect(parseEnv('')).toEqual({ ok: true, env: {} });
    });

    it('names the first line that is not a variable', () => {
        expect(parseEnv('A=1\nnonsense\nB=2')).toEqual({ ok: false, message: 'Line 2 is not KEY=VALUE' });
        expect(parseEnv('1BAD=x')).toEqual({ ok: false, message: 'Line 1 is not KEY=VALUE' });
        expect(parseEnv('=x')).toEqual({ ok: false, message: 'Line 1 is not KEY=VALUE' });
    });

    it('writes the variables back one per line in key order, so reading them gives the same set', () => {
        const env = { Z: '1', A: 'x y' };

        expect(formatEnv(env)).toBe('A=x y\nZ=1');
        expect(parseEnv(formatEnv(env))).toEqual({ ok: true, env });
    });
});
