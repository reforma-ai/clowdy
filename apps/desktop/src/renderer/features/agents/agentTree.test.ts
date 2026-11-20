import { describe, expect, it } from 'vitest';

import { archivedChats, chatDotTone, chatOfRun, resolveSelection, visibleChats } from './agentTree';

import type { Chat, Run, RunStatus } from '@clowdy/protocol';

let clock = 0;

function run(id: string, status: RunStatus = 'running', rest: Partial<Run> = {}): Run {
    return { id, projectId: 'p', rootRunId: id, role: 'executor', name: `Name ${ id }`, summary: `Summary ${ id }`, status, engine: 'fake', createdAt: ++clock, ...rest };
}

function chat(id: string, orchestratorRunId?: string): Chat {
    return { id, projectId: 'p', title: `Chat ${ id }`, orchestratorRunId, createdAt: 1, updatedAt: 1 } as Chat;
}

/** orch, with the native sub-agents a (running, with a1 below it), b (done) and c (waiting), and the orchestrator of another chat. */
const runs = [
    run('orch', 'running', { role: 'orchestrator', createdAt: 1 }),
    run('a', 'running', { parentRunId: 'orch', rootRunId: 'orch', origin: 'native', createdAt: 2 }),
    run('a1', 'running', { parentRunId: 'a', rootRunId: 'orch', origin: 'native', createdAt: 3 }),
    run('b', 'succeeded', { parentRunId: 'orch', rootRunId: 'orch', origin: 'native', createdAt: 4 }),
    run('c', 'waiting_user', { parentRunId: 'orch', rootRunId: 'orch', origin: 'native', createdAt: 5 }),
    run('other', 'running', { role: 'orchestrator', createdAt: 6 }),
];

const chats = [chat('chat-1', 'orch'), chat('chat-2', 'other'), chat('chat-3')];

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

    it('shows a sub-agent of a chat, with its chat, wherever the chat remembered was', () => {
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

describe('chatDotTone', () => {
    it('is green while the orchestrator works or waits for its background work', () => {
        expect(chatDotTone(run('r', 'running'))).toBe('success');
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
