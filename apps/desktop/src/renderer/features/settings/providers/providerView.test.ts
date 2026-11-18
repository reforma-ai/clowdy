import { describe, expect, it } from 'vitest';

import { accountLine, formatEnv, headlineWindow, isSignInRunning, isUsableProvider, parseEnv, providerAgents, sortByHeadline, sortWindowsByUsage, usageTone, windowPercent } from './providerView';

import type { AgentInfo, AgentUsage, AgentUsageWindow } from '@clowdy/protocol';

const agent = (patch: Partial<AgentInfo> = {}): AgentInfo => ({ id: 'claude', name: 'Claude Code', custom: false, enabled: true, status: 'ready', launch: 'x', ...patch });

describe('providerAgents', () => {
    it('keeps Claude, Codex and Cursor in that order and leaves the others out', () => {
        const all = ['gemini', 'cursor', 'mine', 'claude', 'codex'].map(id => agent({ id }));

        expect(providerAgents(all).map(item => item.id)).toEqual(['claude', 'codex', 'cursor']);
        expect(providerAgents([agent({ id: 'codex' })]).map(item => item.id)).toEqual(['codex']);
    });
});

const meter = (id: string, usedPercent: number, resetsAt?: number): AgentUsageWindow => ({ id, label: id, usedPercent, resetsAt });
const usage = (windows: AgentUsageWindow[], state: AgentUsage['state'] = 'ok'): AgentUsage => ({ state, windows, fetchedAt: 1 });

describe('isUsableProvider', () => {
    it('is true for a provider that is switched on and installed, and false otherwise', () => {
        expect(isUsableProvider(agent())).toBe(true);
        expect(isUsableProvider(agent({ enabled: false, status: 'disabled' }))).toBe(false);
        expect(isUsableProvider(agent({ status: 'missing' }))).toBe(false);
        expect(isUsableProvider(agent({ status: 'needs-runtime' }))).toBe(false);
    });
});

describe('usageTone', () => {
    it('is normal below 80, warning from 80 and danger from 90', () => {
        expect(usageTone(0)).toBe('normal');
        expect(usageTone(79)).toBe('normal');
        expect(usageTone(80)).toBe('warning');
        expect(usageTone(89)).toBe('warning');
        expect(usageTone(90)).toBe('danger');
        expect(usageTone(100)).toBe('danger');
    });
});

describe('windowPercent', () => {
    it('rounds the percent and keeps it between 0 and 100', () => {
        expect(windowPercent(meter('a', 78.4))).toBe(78);
        expect(windowPercent(meter('a', 78.5))).toBe(79);
        expect(windowPercent(meter('a', 130))).toBe(100);
        expect(windowPercent(meter('a', -3))).toBe(0);
    });

    it('takes what is not a number for no usage, so a bar and a badge never show NaN', () => {
        expect(windowPercent(meter('a', Number.NaN))).toBe(0);
        expect(windowPercent(meter('a', Number.POSITIVE_INFINITY))).toBe(100);
        expect(windowPercent(meter('a', Number.NEGATIVE_INFINITY))).toBe(0);
    });
});

describe('headlineWindow', () => {
    it('is the most used of the primary windows', () => {
        const claude = agent({ usage: usage([meter('session', 8), meter('weekly', 78), meter('other', 20)]) });

        expect(headlineWindow(claude)?.id).toBe('weekly');
    });

    it('leaves out a scoped window, whatever its percent, and takes the first of equal ones', () => {
        expect(headlineWindow(agent({ usage: usage([meter('session', 8), meter('weekly', 20), meter('weekly:fable', 95)]) }))?.id).toBe('weekly');
        expect(headlineWindow(agent({ usage: usage([meter('session', 30), meter('weekly', 30)]) }))?.id).toBe('session');
        expect(headlineWindow(agent({ usage: usage([meter('weekly:fable', 95)]) }))).toBeUndefined();
    });

    it('takes the windows of Codex\'s main limit for primary ones, and leaves out the limit of a single model', () => {
        const codex = agent({ id: 'codex', usage: usage([meter('codex:primary', 3), meter('codex:secondary', 18), meter('spark:secondary', 40)]) });

        // The ids the daemon really gives Codex's windows all carry a `:`, so a rule on the colon alone would leave it without a headline.
        expect(headlineWindow(codex)?.id).toBe('codex:secondary');
        expect(headlineWindow(agent({ id: 'codex', usage: usage([meter('spark:secondary', 40)]) }))).toBeUndefined();
        expect(headlineWindow(agent({ id: 'claude', usage: usage([meter('codex:primary', 90), meter('session', 5)]) }))?.id).toBe('session');
    });

    it('skips a scoped window even when it is the only one that has a number, and is not fooled by a window that is not a number', () => {
        expect(headlineWindow(agent({ usage: usage([meter('weekly:fable', 99)]) }))).toBeUndefined();
        // A NaN first window would otherwise stay the headline, since nothing is greater than it.
        expect(headlineWindow(agent({ usage: usage([meter('session', Number.NaN), meter('weekly', 12)]) }))?.id).toBe('weekly');
    });

    it('compares the percents the badge shows, so 78.4 and 78.2 are equal and the first wins', () => {
        expect(headlineWindow(agent({ usage: usage([meter('session', 78.2), meter('weekly', 78.4)]) }))?.id).toBe('session');
    });

    it('is nothing without a trusted reading: no usage, not ok, no windows or signed out', () => {
        const windows = [meter('session', 50)];

        expect(headlineWindow(agent())).toBeUndefined();
        expect(headlineWindow(agent({ usage: usage(windows, 'unavailable') }))).toBeUndefined();
        // The last good windows of a failed read are not news.
        expect(headlineWindow(agent({ usage: usage(windows, 'error') }))).toBeUndefined();
        expect(headlineWindow(agent({ usage: usage([]) }))).toBeUndefined();
        expect(headlineWindow(agent({ usage: usage(windows), signIn: { status: 'signed-out', checkedAt: 1 } }))).toBeUndefined();
        expect(headlineWindow(agent({ usage: usage(windows), signIn: { status: 'signed-in', checkedAt: 1 } }))?.id).toBe('session');
    });
});

describe('sortByHeadline', () => {
    const withUsage = (id: string, percents: number[], patch: Partial<AgentInfo> = {}) => agent({ id, usage: usage(percents.map((percent, index) => meter(`w${ index }`, percent))), ...patch });

    it('puts the most used provider first, the ones without a reading last, and keeps the order of equal ones', () => {
        const all = [
            agent({ id: 'claude' }),
            withUsage('codex', [10, 40]),
            withUsage('cursor', [40]),
            withUsage('gemini', [90]),
            withUsage('mine', [10], { signIn: { status: 'signed-out', checkedAt: 1 } }),
        ];

        expect(sortByHeadline(all).map(item => item.id)).toEqual(['gemini', 'codex', 'cursor', 'claude', 'mine']);
    });

    it('does not change the list it is given', () => {
        const all = [agent({ id: 'claude' }), withUsage('codex', [10])];

        sortByHeadline(all);

        expect(all.map(item => item.id)).toEqual(['claude', 'codex']);
    });
});

describe('sortWindowsByUsage', () => {
    it('lists the most used window first and keeps the order of equal ones', () => {
        const sorted = sortWindowsByUsage([meter('a', 8), meter('b', 20), meter('c', 0), meter('d', 20)]);

        expect(sorted.map(item => item.id)).toEqual(['b', 'd', 'a', 'c']);
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
