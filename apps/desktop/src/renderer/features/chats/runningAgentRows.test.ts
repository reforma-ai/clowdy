import { describe, expect, it } from 'vitest';

import { agentRowLabel, agentRowText, runningAgents } from './runningAgentRows';

import type { Run, RunStatus } from '@clowdy/protocol';

const run = (id: string, status: RunStatus, rest: Partial<Run> = {}): Run => ({ id, projectId: 'p', rootRunId: 'orch', parentRunId: 'orch', role: 'executor', name: id, summary: '', status, engine: 'claude', createdAt: 1, ...rest });

describe('runningAgents', () => {
    it('lists the chat\'s runs that work or wait for the person, spawned or native, oldest first', () => {
        const runs = [
            run('orch', 'running', { parentRunId: undefined }),
            run('late', 'running', { createdAt: 9 }),
            run('native', 'running', { origin: 'native', createdAt: 5 }),
            run('asking', 'waiting_user', { createdAt: 3 }),
            run('grandchild', 'running', { parentRunId: 'late', createdAt: 10 }),
            run('queued', 'queued'),
            run('blocked', 'blocked'),
            run('done', 'succeeded'),
            run('elsewhere', 'running', { rootRunId: 'other', parentRunId: 'other' }),
        ];

        expect(runningAgents(runs, 'orch').map(agent => agent.id)).toEqual(['asking', 'native', 'late', 'grandchild']);
        expect(runningAgents(runs, undefined)).toEqual([]);
    });
});

describe('a row\'s words', () => {
    it('names a spawned run by its name and a native one by its type', () => {
        expect(agentRowLabel({ name: 'Executor 07', origin: 'spawned' })).toBe('Executor 07');
        expect(agentRowLabel({ name: 'Explore', origin: 'native' })).toBe('Explore agent');
        expect(agentRowLabel({ name: 'general-purpose', origin: 'native' })).toBe('General agent');
        expect(agentRowLabel({ name: 'Sub-agent', origin: 'native' })).toBe('Sub-agent');
    });

    it('says what the agent does and how many tools it called, that it works before its first step, and that it waits for the person', () => {
        const explore = { name: 'Explore', origin: 'native' as const, status: 'running' as const };

        expect(agentRowText(explore, 'Reading form.tsx', 4)).toBe('Explore agent · Reading form.tsx · 4 calls');
        expect(agentRowText(explore, 'Reading form.tsx', 1)).toBe('Explore agent · Reading form.tsx · 1 call');
        expect(agentRowText(explore, undefined, 0)).toBe('Explore agent working');
        expect(agentRowText({ name: 'Executor 08', origin: 'spawned', status: 'waiting_user' }, 'Reading a.ts', 7)).toBe('Executor 08 · Waiting for you');
    });
});
