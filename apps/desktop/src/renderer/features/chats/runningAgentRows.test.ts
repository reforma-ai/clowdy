import { describe, expect, it } from 'vitest';

import {
    agentRowLabel,
    backgroundItemText,
    backgroundRows,
    backgroundRowText,
    canStopAlone,
    drawnRows,
    MAX_AGENT_ROWS,
    openBackground,
    runningAgents,
    stripRows,
    threadsAtWork,
    unlistedBackground,
} from './runningAgentRows';

import type { BackgroundItem, Chat, Run, RunStatus } from '@clowdy/protocol';

const run = (id: string, status: RunStatus, rest: Partial<Run> = {}): Run => ({
    id,
    projectId: 'p',
    rootRunId: 'orch',
    parentRunId: 'orch',
    role: 'executor',
    origin: 'native',
    name: id,
    summary: '',
    status,
    engine: 'claude',
    createdAt: 1,
    ...rest,
});

describe('runningAgents', () => {
    it("lists the chat's sub-agents that work or wait for the person, oldest first, those of a sub-agent too", () => {
        const runs = [
            run('orch', 'running', { parentRunId: undefined, origin: undefined, role: 'orchestrator' }),
            run('late', 'running', { createdAt: 9 }),
            run('early', 'running', { createdAt: 5 }),
            run('asking', 'waiting_user', { createdAt: 3 }),
            run('grandchild', 'running', { parentRunId: 'late', createdAt: 10 }),
            run('queued', 'queued'),
            run('blocked', 'blocked'),
            run('done', 'succeeded'),
            run('elsewhere', 'running', { rootRunId: 'other', parentRunId: 'other' }),
        ];

        expect(runningAgents(runs, 'orch').map(agent => agent.id)).toEqual(['asking', 'early', 'late', 'grandchild']);
        expect(runningAgents(runs, undefined)).toEqual([]);
    });
});

describe("a row's words", () => {
    it('names a sub-agent by what it was asked to do', () => {
        expect(agentRowLabel({ name: 'general-purpose', summary: 'Review clone route diff' })).toBe(
            'Review clone route diff'
        );
        expect(agentRowLabel({ name: 'Explore', summary: ' Find where\n the price is computed ' })).toBe(
            'Find where the price is computed'
        );
    });

    it('names a sub-agent that was given no purpose by its type', () => {
        expect(agentRowLabel({ name: 'Explore', summary: '' })).toBe('Explore agent');
        expect(agentRowLabel({ name: 'general-purpose', summary: '  ' })).toBe('General agent');
        expect(agentRowLabel({ name: 'Sub-agent', summary: '' })).toBe('Sub-agent');
    });
});

describe('the background row', () => {
    const open = [
        { id: 'bg-1', kind: 'command' as const, title: 'bun run test' },
        { id: 'bg-2', kind: 'subagent' as const, title: 'Explore' },
    ];

    it('lists what a live orchestrator has open, whatever the kind of the item', () => {
        for (const status of ['queued', 'running', 'waiting_background', 'waiting_user', 'blocked'] as const) {
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
        const child = run('child', 'running', { parentToolCallId: 'call-1' });

        expect(unlistedBackground([command, explore, workflow], [child])).toEqual([command, workflow]);
    });

    it('counts a sub-agent that has no child run at work, whatever other children there are', () => {
        const other = run('other', 'running', { parentToolCallId: 'call-9' });
        const unnamed = run('unnamed', 'running');

        expect(unlistedBackground([explore], [])).toEqual([explore]);
        expect(unlistedBackground([explore], [other])).toEqual([explore]);
        // A child that names no call stands for nothing in the list.
        expect(unlistedBackground([explore], [unnamed])).toEqual([explore]);
    });

    it('leaves a command or a task alone even when a child run names the same id', () => {
        const child = run('child', 'running', { parentToolCallId: 'bg-1' });

        expect(unlistedBackground([command], [child])).toEqual([command]);
    });
});

describe('the rows of background items', () => {
    const stoppable = (n: number, over: Partial<BackgroundItem> = {}): BackgroundItem => ({
        id: `bg-${n}`,
        kind: 'command',
        title: `command ${n}`,
        canStopAlone: true,
        ...over,
    });
    const plain = { id: 'plain', kind: 'command' as const, title: 'plain' };

    it('gives a row of its own to each item the agent lets be stopped alone, and counts the rest', () => {
        const workflow = { id: 'wf-1', kind: 'task' as const, title: 'Workflow', canStopAlone: true };

        expect(backgroundRows([stoppable(1), plain, workflow, stoppable(2)], [])).toEqual({
            own: [stoppable(1), plain, workflow, stoppable(2)],
            counted: [plain],
        });
        expect(backgroundRows([plain], [])).toEqual({ own: [plain], counted: [plain] });
        expect(backgroundRows([], [])).toEqual({ own: [], counted: [] });
    });

    it('keeps every stoppable item in order', () => {
        const items = Array.from({ length: MAX_AGENT_ROWS + 2 }, (_, index) => stoppable(index + 1));
        const { own, counted } = backgroundRows([plain, ...items], []);

        expect(own).toEqual([plain, ...items]);
        expect(counted).toEqual([plain]);
    });

    it('never gives a sub-agent one: its row is its child run, and one with none is counted', () => {
        const explore = { id: 'call-1', kind: 'subagent' as const, title: 'Explore', canStopAlone: true };
        const child = run('child', 'running', { origin: 'native', parentToolCallId: 'call-1' });

        expect(backgroundRows([explore], [child])).toEqual({ own: [], counted: [] });
        expect(backgroundRows([explore], [])).toEqual({ own: [], counted: [explore] });
    });

    it('names a row by what the item is and what it runs', () => {
        expect(backgroundItemText({ kind: 'command', title: 'bun run test' })).toBe('Command: bun run test');
        expect(backgroundItemText({ kind: 'task', title: 'Workflow: verify' })).toBe('Task: Workflow: verify');
        expect(backgroundItemText({ kind: 'task', title: 'Monitor · Build' })).toBe('Monitor: Build');
        expect(backgroundItemText({ kind: 'task', title: 'Wakeup: Check deployment' })).toBe(
            'Wakeup: Check deployment'
        );
    });
});

describe('Stop on a row', () => {
    it('stops a sub-agent only when its session can end it alone', () => {
        expect(canStopAlone({ canStopAlone: true })).toBe(true);
        expect(canStopAlone({ canStopAlone: false })).toBe(false);
        expect(canStopAlone({})).toBe(false);
    });
});

describe('threads in the strip', () => {
    const thread = (id: string, createdAt: number, rest: Partial<Chat> = {}): Chat => ({
        id,
        projectId: 'p',
        title: `Thread ${id}`,
        mode: 'autopilot',
        parentChatId: 'parent',
        orchestratorRunId: `run-${id}`,
        createdAt,
        updatedAt: createdAt,
        ...rest,
    });
    const orchestrator = (id: string, status: RunStatus) =>
        run(`run-${id}`, status, {
            rootRunId: `run-${id}`,
            parentRunId: undefined,
            origin: undefined,
            role: 'orchestrator',
        });

    it('lists the threads that work, oldest first: queued, running, blocked, or waiting for the person or for background work', () => {
        const statuses: Record<string, RunStatus> = {
            q: 'queued',
            r: 'running',
            b: 'blocked',
            u: 'waiting_user',
            w: 'waiting_background',
            s: 'succeeded',
            f: 'failed',
            c: 'cancelled',
            i: 'interrupted',
        };
        const threads = Object.keys(statuses).map((id, index) => thread(id, 20 - index));
        const runs = new Map(Object.entries(statuses).map(([id, status]) => [`run-${id}`, orchestrator(id, status)]));

        expect(threadsAtWork(threads, runs).map(({ chat }) => chat.id)).toEqual(['w', 'u', 'b', 'r', 'q']);
    });

    it('leaves out a thread that never started and one in the archive', () => {
        const runs = new Map([['run-a', orchestrator('a', 'running')]]);

        expect(
            threadsAtWork(
                [thread('a', 1, { archivedAt: 2 }), thread('fresh', 2, { orchestratorRunId: undefined })],
                runs
            )
        ).toEqual([]);
    });

    it('puts what waits for the person first, then the rest oldest first, so questions appear first', () => {
        const runs = new Map([
            ['run-old', orchestrator('old', 'running')],
            ['run-new', orchestrator('new', 'waiting_background')],
            ['run-later', orchestrator('later', 'waiting_user')],
        ]);
        // A thread that rests for its background work while its agent asks reads as asking too.
        runs.set('run-new', { ...runs.get('run-new')!, awaitingUser: true });

        const rows = stripRows(
            [run('agent', 'running', { createdAt: 5 })],
            threadsAtWork([thread('old', 1), thread('new', 2), thread('later', 3)], runs)
        );

        expect(rows.map(row => row.id)).toEqual(['new', 'later', 'old', 'agent']);
    });

    it('draws every row, or while folded only those that wait for the person', () => {
        const runs = new Map([
            ['run-a', orchestrator('a', 'running')],
            ['run-b', { ...orchestrator('b', 'waiting_background'), awaitingUser: true }],
        ]);
        const rows = stripRows([], threadsAtWork([thread('a', 1), thread('b', 2)], runs));

        expect(drawnRows(rows, false).map(row => row.id)).toEqual(['b', 'a']);
        expect(drawnRows(rows, true).map(row => row.id)).toEqual(['b']);
        expect(
            drawnRows(
                stripRows([], threadsAtWork([thread('a', 1)], new Map([['run-a', orchestrator('a', 'running')]]))),
                true
            )
        ).toEqual([]);
    });

    it('puts sub-agents and threads in one list, by when each was made', () => {
        const agents = [
            run('agent-late', 'running', { createdAt: 30 }),
            run('agent-early', 'running', { createdAt: 10 }),
        ];
        const threads = [{ chat: thread('t', 20), run: orchestrator('t', 'running') }];

        expect(stripRows(agents, threads).map(row => `${row.kind}:${row.id}`)).toEqual([
            'agent:agent-early',
            'thread:t',
            'agent:agent-late',
        ]);
    });
});
