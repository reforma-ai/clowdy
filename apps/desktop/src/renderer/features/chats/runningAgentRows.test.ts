import { describe, expect, it } from 'vitest';

import { agentRowLabel, agentRowText, backgroundRowText, canStopAlone, offersStopAll, openBackground, runningAgents, unlistedBackground } from './runningAgentRows';

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

describe('the background row', () => {
    const open = [{ id: 'bg-1', kind: 'command' as const, title: 'bun run test' }, { id: 'bg-2', kind: 'subagent' as const, title: 'Explore' }];

    it('lists what a live orchestrator has open, whatever the kind of the item', () => {
        for (const status of ['queued', 'running', 'waiting_children', 'waiting_background', 'waiting_user', 'blocked'] as const) {
            expect(openBackground(run('orch', status, { background: open })), status).toEqual(open);
        }
    });

    it('lists nothing for no run, nothing open, or a run that ended with a stale list', () => {
        expect(openBackground(undefined)).toEqual([]);
        expect(openBackground(run('orch', 'waiting_background'))).toEqual([]);
        expect(openBackground(run('orch', 'waiting_background', { background: [] }))).toEqual([]);

        for (const status of ['succeeded', 'failed', 'cancelled', 'interrupted'] as const) {
            expect(openBackground(run('orch', status, { background: open })), status).toEqual([]);
        }
    });

    it('counts the items in the singular and the plural', () => {
        expect(backgroundRowText(1)).toBe('Background task running');
        expect(backgroundRowText(2)).toBe('2 background tasks running');
        expect(backgroundRowText(12)).toBe('12 background tasks running');
    });
});

describe('what the background row counts', () => {
    const command = { id: 'bg-1', kind: 'command' as const, title: 'bun run test' };
    const explore = { id: 'call-1', kind: 'subagent' as const, title: 'Explore' };
    const workflow = { id: 'wf-1', kind: 'task' as const, title: 'Workflow' };

    it('leaves out a sub-agent whose child run is a row, by the call that started it, and counts everything else', () => {
        const child = run('child', 'running', { origin: 'native', parentToolCallId: 'call-1' });

        expect(unlistedBackground([command, explore, workflow], [child])).toEqual([command, workflow]);
    });

    it('counts a sub-agent that has no child run at work, whatever other children there are', () => {
        const other = run('other', 'running', { origin: 'native', parentToolCallId: 'call-9' });
        const spawned = run('spawned', 'running', { parentToolCallId: 'call-1' });

        expect(unlistedBackground([explore], [])).toEqual([explore]);
        expect(unlistedBackground([explore], [other])).toEqual([explore]);
        // Only a native child stands for a sub-agent of the session; a spawned run is its own work.
        expect(unlistedBackground([explore], [spawned])).toEqual([explore]);
    });

    it('leaves a command or a task alone even when a child run names the same id', () => {
        const child = run('child', 'running', { origin: 'native', parentToolCallId: 'bg-1' });

        expect(unlistedBackground([command], [child])).toEqual([command]);
    });
});

describe('Stop on a row', () => {
    it('stops a spawned run, and a native sub-agent only when its session can end it alone', () => {
        expect(canStopAlone({ origin: 'spawned' })).toBe(true);
        expect(canStopAlone({ origin: undefined })).toBe(true);
        expect(canStopAlone({ origin: 'native', canStopAlone: true })).toBe(true);
        expect(canStopAlone({ origin: 'native', canStopAlone: false })).toBe(false);
        expect(canStopAlone({ origin: 'native' })).toBe(false);
    });
});

describe('Stop all', () => {
    const spawned = { origin: 'spawned' as const };
    const alone = { origin: 'native' as const, canStopAlone: true };
    const fixed = { origin: 'native' as const };

    it('is offered from two agents that can stop alone, whatever their kind', () => {
        expect(offersStopAll([])).toBe(false);
        expect(offersStopAll([spawned])).toBe(false);
        expect(offersStopAll([spawned, spawned])).toBe(true);
        expect(offersStopAll([alone, alone])).toBe(true);
        expect(offersStopAll([spawned, alone])).toBe(true);
    });

    it('does not count an agent that cannot stop alone, so it neither makes the button appear nor is stopped by it', () => {
        expect(offersStopAll([fixed, fixed, fixed])).toBe(false);
        expect(offersStopAll([spawned, fixed])).toBe(false);
        expect(offersStopAll([alone, fixed, spawned])).toBe(true);
    });
});
