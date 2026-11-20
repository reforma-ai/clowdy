import { describe, expect, it } from 'vitest';

import { buildRunTree } from '../../stores/runTree';
import { agentRows, ancestorIds, archivedChats, chatDotTone, chatOfRun, countActiveChildren, describeRun, listedRunId, resolveSelection, visibleChats } from './agentTree';

import type { Chat, Run, RunStatus } from '@clowdy/protocol';

let clock = 0;

function run(id: string, status: RunStatus = 'running', rest: Partial<Run> = {}): Run {
    return { id, projectId: 'p', rootRunId: id, role: 'executor', name: `Name ${ id }`, summary: `Summary ${ id }`, status, engine: 'fake', createdAt: ++clock, ...rest };
}

function chat(id: string, orchestratorRunId?: string): Chat {
    return { id, projectId: 'p', title: `Chat ${ id }`, orchestratorRunId, createdAt: 1, updatedAt: 1 } as Chat;
}

/** orch, with a (running, with a1 below it), b (done) and c (waiting). */
const runs = [
    run('orch', 'running', { createdAt: 1 }),
    run('a', 'running', { parentRunId: 'orch', rootRunId: 'orch', createdAt: 2 }),
    run('a1', 'running', { parentRunId: 'a', rootRunId: 'orch', createdAt: 3 }),
    run('b', 'succeeded', { parentRunId: 'orch', rootRunId: 'orch', createdAt: 4 }),
    run('c', 'waiting_user', { parentRunId: 'orch', rootRunId: 'orch', createdAt: 5 }),
    run('other', 'running', { createdAt: 6 }),
];

const chats = [chat('chat-1', 'orch'), chat('chat-2', 'other'), chat('chat-3')];

describe('agentRows', () => {
    it('lists each chat followed by the runs below its orchestrator, which is the chat itself', () => {
        const rows = agentRows(chats, buildRunTree(runs), new Set());

        expect(rows.map(row => [row.kind, row.id, row.depth, row.childCount])).toEqual([
            ['chat', 'chat-1', 0, 3],
            ['run', 'a', 1, 1],
            ['run', 'a1', 2, 0],
            ['run', 'b', 1, 0],
            ['run', 'c', 1, 0],
            ['chat', 'chat-2', 0, 0],
            ['chat', 'chat-3', 0, 0],
        ]);
    });

    it('keeps the order of the chats it is given, whatever the order of the runs', () => {
        const rows = agentRows([chats[1], chats[0]], buildRunTree(runs), new Set());

        expect(rows.filter(row => row.kind === 'chat').map(row => row.id)).toEqual(['chat-2', 'chat-1']);
    });

    it('hides what is below a collapsed chat or run, and says so', () => {
        const tree = buildRunTree(runs);

        expect(agentRows(chats, tree, new Set(['a'])).map(row => row.id)).toEqual(['chat-1', 'a', 'b', 'c', 'chat-2', 'chat-3']);
        expect(agentRows(chats, tree, new Set(['chat-1'])).map(row => row.id)).toEqual(['chat-1', 'chat-2', 'chat-3']);
        expect(agentRows(chats, tree, new Set(['chat-1'])).find(row => row.id === 'chat-1')).toMatchObject({ childCount: 3, isExpanded: false });
    });

    it('shows a chat with no orchestrator run, or whose run is gone, without children', () => {
        const rows = agentRows([chat('lonely', 'missing')], buildRunTree(runs), new Set());

        expect(rows).toEqual([expect.objectContaining({ kind: 'chat', id: 'lonely', childCount: 0 })]);
    });
});

describe('visibleChats', () => {
    const list = [chats[0], { ...chats[1], archivedAt: 5 }, chats[2]];

    it('leaves the archived chats out, they are in the archive', () => {
        expect(visibleChats(list).map(candidate => candidate.id)).toEqual(['chat-1', 'chat-3']);
    });

    it('leaves the chats in the order they are given, which is by last activity', () => {
        expect(visibleChats([chats[2], chats[0], chats[1]]).map(candidate => candidate.id)).toEqual(['chat-3', 'chat-1', 'chat-2']);
    });

    it('puts the newest chat first when the list is sorted by creation', () => {
        const made = [{ ...chats[0], createdAt: 10 }, { ...chats[1], createdAt: 30, archivedAt: 5 }, { ...chats[2], createdAt: 20 }];

        expect(visibleChats(made, 'created').map(candidate => candidate.id)).toEqual(['chat-3', 'chat-1']);
        expect(visibleChats(made, 'activity').map(candidate => candidate.id)).toEqual(['chat-1', 'chat-3']);
    });
});

describe('archivedChats', () => {
    it('lists only the archived chats, the one put away last first', () => {
        const list = [{ ...chats[0], archivedAt: 5 }, chats[1], { ...chats[2], archivedAt: 9 }];

        expect(archivedChats(list).map(candidate => candidate.id)).toEqual(['chat-3', 'chat-1']);
        expect(archivedChats([chats[1]])).toEqual([]);
    });
});

describe('chatOfRun', () => {
    it('finds the chat whose orchestrator is the root of the run', () => {
        expect(chatOfRun(chats, run('a1', 'running', { rootRunId: 'orch' }))?.id).toBe('chat-1');
        expect(chatOfRun(chats, run('x', 'running', { rootRunId: 'ghost' }))).toBeUndefined();
    });
});

describe('resolveSelection', () => {
    const byChat = new Map(chats.map(candidate => [candidate.id, candidate]));
    const byRun = new Map(runs.map(candidate => [candidate.id, candidate]));
    const resolve = (chatId: string | null, runId: string | null, draft = false) => resolveSelection(byChat, chats, byRun, chatId, runId, draft);

    it('shows the chat that was opened', () => {
        expect(resolve('chat-2', null)).toEqual({ chat: byChat.get('chat-2'), run: undefined, draft: false });
    });

    it('shows a run below a chat, with its chat, wherever the chat remembered was', () => {
        expect(resolve('chat-2', 'a1')).toEqual({ chat: byChat.get('chat-1'), run: byRun.get('a1'), draft: false });
    });

    it('takes a root run for its chat', () => {
        expect(resolve(null, 'orch')).toEqual({ chat: byChat.get('chat-1'), run: undefined, draft: false });
    });

    it('falls back to the chat that was selected, then to the first one, when the run or the chat is gone', () => {
        expect(resolve('chat-2', 'gone')).toEqual({ chat: byChat.get('chat-2'), run: undefined, draft: false });
        expect(resolve('gone', null)).toEqual({ chat: chats[0], run: undefined, draft: false });
        expect(resolve(null, null)).toEqual({ chat: chats[0], run: undefined, draft: false });
    });

    it('falls back when the run belongs to no chat that is listed', () => {
        const orphan = new Map([...byRun, ['x', run('x', 'running', { parentRunId: 'ghost', rootRunId: 'ghost' })]]);

        expect(resolveSelection(byChat, chats, orphan, 'chat-2', 'x')).toEqual({ chat: byChat.get('chat-2'), run: undefined, draft: false });
    });

    it('opens no chat that is in the archive, nor a run of one: the first listed chat stands in', () => {
        const archived = new Map([...byChat, ['chat-1', { ...chats[0], archivedAt: 5 }]]);
        const shown = chats.filter(candidate => candidate.id !== 'chat-1');

        expect(resolveSelection(archived, shown, byRun, 'chat-1', null)).toEqual({ chat: shown[0], run: undefined, draft: false });
        expect(resolveSelection(archived, shown, byRun, null, 'a1')).toEqual({ chat: shown[0], run: undefined, draft: false });
        expect(resolveSelection(archived, shown, byRun, null, null)).toEqual({ chat: shown[0], run: undefined, draft: false });
    });

    it('shows the new-chat row when it was asked for, whatever else is remembered', () => {
        expect(resolve('chat-2', 'a1', true)).toEqual({ chat: undefined, run: undefined, draft: true });
    });

    it('shows the new-chat row when there is no chat to show', () => {
        expect(resolveSelection(new Map(), [], byRun, null, 'a')).toEqual({ chat: undefined, run: undefined, draft: true });
    });
});

describe('ancestorIds', () => {
    const byId = new Map(runs.map(candidate => [candidate.id, candidate]));

    it('lists the parents, nearest first', () => {
        expect(ancestorIds(byId, 'a1')).toEqual(['a', 'orch']);
        expect(ancestorIds(byId, 'orch')).toEqual([]);
        expect(ancestorIds(byId, 'unknown')).toEqual([]);
    });

    it('stops at a parent cycle', () => {
        const cyclic = new Map([run('x', 'running', { parentRunId: 'y' }), run('y', 'running', { parentRunId: 'x' })].map(candidate => [candidate.id, candidate]));

        expect(ancestorIds(cyclic, 'x')).toEqual(['y', 'x']);
    });
});

describe('countActiveChildren', () => {
    it('counts the children that are still going', () => {
        const counts = countActiveChildren(runs);

        expect(counts.get('orch')).toBe(2);
        expect(counts.get('a')).toBe(1);
        expect(counts.has('b')).toBe(false);
    });

    it('leaves native sub-agents out', () => {
        const counts = countActiveChildren([...runs, run('n1', 'running', { parentRunId: 'b', rootRunId: 'orch', origin: 'native' })]);

        expect(counts.has('b')).toBe(false);
    });
});

describe('listedRunId', () => {
    const native = run('n1', 'running', { parentRunId: 'a', rootRunId: 'orch', origin: 'native' });
    const nativeOfOrchestrator = run('n2', 'running', { parentRunId: 'orch', rootRunId: 'orch', origin: 'native' });
    const byId = new Map([...runs, native, nativeOfOrchestrator].map(candidate => [candidate.id, candidate]));

    it('is the run\'s own row, or for a native sub-agent the row of the run it lives in', () => {
        expect(listedRunId(byId, byId.get('a1')!)).toBe('a1');
        expect(listedRunId(byId, native)).toBe('a');
    });

    it('is nothing when that run is the orchestrator, whose row is the chat\'s', () => {
        expect(listedRunId(byId, nativeOfOrchestrator)).toBeUndefined();
        expect(listedRunId(byId, byId.get('orch')!)).toBeUndefined();
    });
});

describe('describeRun', () => {
    it('says a parent waits for its sub-agents, with how many are active', () => {
        const parent = run('p', 'waiting_children');

        expect(describeRun(parent, 3)).toEqual({ text: 'Waiting for sub-agents · 3 active', tone: 'warning' });
        expect(describeRun(parent, 0)).toEqual({ text: 'Waiting for sub-agents', tone: 'warning' });
    });

    it('says a run waits for its background work, with how many items are open, and calmly', () => {
        const background = [{ id: 'bg-1', kind: 'command' as const, title: 'bun run test' }, { id: 'bg-2', kind: 'task' as const, title: 'Workflow' }];

        expect(describeRun(run('r', 'waiting_background', { background }), 0)).toEqual({ text: 'Waiting for background work · 2 open', tone: 'neutral' });
        expect(describeRun(run('r', 'waiting_background'), 0)).toEqual({ text: 'Waiting for background work', tone: 'neutral' });
    });

    it('shows the reason of waiting, blocked, queued and interrupted runs', () => {
        expect(describeRun(run('r', 'waiting_user', { statusReason: 'Asked which mail provider' }), 0)).toEqual({ text: 'Asked which mail provider', tone: 'warning' });
        expect(describeRun(run('r', 'blocked', { statusReason: 'Blocked by CAR-24' }), 0)).toEqual({ text: 'Blocked by CAR-24', tone: 'warning' });
        expect(describeRun(run('r', 'queued', { statusReason: 'Waiting for a free slot' }), 0)).toEqual({ text: 'Waiting for a free slot', tone: 'neutral' });
        expect(describeRun(run('r', 'interrupted', { statusReason: 'The daemon restarted' }), 0)).toEqual({ text: 'The daemon restarted', tone: 'neutral' });
    });

    it('still says what a run waits for when the daemon sent no reason', () => {
        expect(describeRun(run('r', 'waiting_user'), 0)?.text).toBe('Waiting for your answer');
        expect(describeRun(run('r', 'blocked'), 0)).toBeUndefined();
    });

    it('shows the error of a failed run', () => {
        expect(describeRun(run('r', 'failed', { error: 'Typecheck failed' }), 0)).toEqual({ text: 'Typecheck failed', tone: 'danger' });
    });

    it('says nothing about a run that is working or done', () => {
        expect(describeRun(run('r', 'running'), 0)).toBeUndefined();
        expect(describeRun(run('r', 'succeeded', { result: 'Done.' }), 0)).toBeUndefined();
    });
});

describe('chatDotTone', () => {
    it('is green while the orchestrator works or waits for its executors or for its background work', () => {
        expect(chatDotTone(run('r', 'running'))).toBe('success');
        expect(chatDotTone(run('r', 'waiting_children'))).toBe('success');
        expect(chatDotTone(run('r', 'waiting_background'))).toBe('success');
    });

    it('is blue once it has asked the person something, and red when it failed', () => {
        expect(chatDotTone(run('r', 'waiting_user'))).toBe('accent');
        expect(chatDotTone(run('r', 'failed'))).toBe('danger');
    });

    it('keeps the usual tone of a run that is blocked or queued', () => {
        expect(chatDotTone(run('r', 'blocked'))).toBe('warning');
        expect(chatDotTone(run('r', 'queued'))).toBe('neutral');
    });

    it('is nothing for a chat that has not started or whose run is over', () => {
        expect(chatDotTone(undefined)).toBeUndefined();

        for (const status of ['succeeded', 'cancelled', 'interrupted'] as const) expect(chatDotTone(run('r', status))).toBeUndefined();
    });
});
