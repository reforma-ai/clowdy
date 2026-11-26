import { describe, expect, it } from 'vitest';

import {
    type AgentRowsInput,
    agentGroups,
    agentRows,
    ancestorChats,
    archivedChats,
    archiveGroups,
    chatDotTone,
    chatFolder,
    chatOfRun,
    draftTarget,
    folderById,
    groupFolderOf,
    isActiveThread,
    isFinishedThread,
    nativeAgentsByRoot,
    resolveSelection,
    visibleChats,
} from './agentTree';

import type { Chat, ProjectFolder, Run, RunStatus } from '@clowdy/protocol';

let clock = 0;

function run(id: string, status: RunStatus = 'running', rest: Partial<Run> = {}): Run {
    return {
        id,
        projectId: 'p',
        rootRunId: id,
        role: 'executor',
        name: `Name ${id}`,
        summary: `Summary ${id}`,
        status,
        engine: 'fake',
        createdAt: ++clock,
        ...rest,
    };
}

function chat(id: string, orchestratorRunId?: string): Chat {
    return { id, projectId: 'p', title: `Chat ${id}`, orchestratorRunId, createdAt: 1, updatedAt: 1 } as Chat;
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

    it('puts the newest chat first until the person changes the order', () => {
        const made = [
            { ...chats[0], createdAt: 10 },
            { ...chats[1], createdAt: 30, archivedAt: 5 },
            { ...chats[2], createdAt: 20 },
        ];

        expect(visibleChats(made).map(candidate => candidate.id)).toEqual(['chat-3', 'chat-1']);
        expect(visibleChats(made, ['chat-1', 'chat-3']).map(candidate => candidate.id)).toEqual(['chat-1', 'chat-3']);
    });
});

describe('the groups of the list by folder', () => {
    const folders: ProjectFolder[] = [
        { id: 'f-web', path: '/dev/web' },
        { id: 'f-api', path: '/dev/api' },
        { id: 'f-notes', path: '/dev/notes' },
    ];
    const inFolder = (id: string, folderId?: string, rest: Partial<Chat> = {}): Chat => ({
        ...chat(id),
        ...(folderId && { folderId }),
        ...rest,
    });

    it("makes a group for each folder in the project's order, an empty one too, with the folder's name and the main one marked", () => {
        const groups = agentGroups([], folders);

        expect(groups.map(group => [group.folder.id, group.name, group.isMain, group.roots.length])).toEqual([
            ['f-web', 'web', true, 0],
            ['f-api', 'api', false, 0],
            ['f-notes', 'notes', false, 0],
        ]);
    });

    it('puts each chat in the group of its folder, keeping the order it was given, and a chat with no folder in the main one', () => {
        const roots = [
            inFolder('a', 'f-api'),
            inFolder('b'),
            inFolder('c', 'f-notes'),
            inFolder('d', 'f-api'),
            inFolder('e'),
        ];
        const groups = agentGroups(roots, folders);

        expect(groups.map(group => group.roots.map(candidate => candidate.id))).toEqual([
            ['b', 'e'],
            ['a', 'd'],
            ['c'],
        ]);
    });

    it('leaves a chat of a folder the project no longer has in the main group', () => {
        expect(agentGroups([inFolder('a', 'f-gone')], folders)[0]?.roots.map(candidate => candidate.id)).toEqual(['a']);
        expect(folderById(folders, 'f-gone').id).toBe('f-web');
        expect(folderById(folders, null).id).toBe('f-web');
        expect(folderById(folders, 'f-api').id).toBe('f-api');
    });

    it('tells which folder a new chat is for, by its name, with the main one when none is named or the folder is gone', () => {
        const target = (id: string | null) => {
            const { folder, name, isMain } = draftTarget(folders, id);

            return [folder.id, name, isMain];
        };

        expect(target('f-api')).toEqual(['f-api', 'api', false]);
        expect(target('f-web')).toEqual(['f-web', 'web', true]);
        expect(target(null)).toEqual(['f-web', 'web', true]);
        expect(target('f-gone')).toEqual(['f-web', 'web', true]);
    });

    it("names a chat's group by the chat the person made that it sits below, which a thread shares", () => {
        const family = new Map(
            [
                inFolder('root', 'f-api'),
                inFolder('thread', 'f-api', { parentChatId: 'root' }),
                inFolder('deep', undefined, { parentChatId: 'thread' }),
                inFolder('plain'),
            ].map(candidate => [candidate.id, candidate])
        );

        expect(groupFolderOf(family, folders, 'root')).toBe('f-api');
        expect(groupFolderOf(family, folders, 'thread')).toBe('f-api');
        // The root decides, whatever a thread below it says.
        expect(groupFolderOf(family, folders, 'deep')).toBe('f-api');
        expect(groupFolderOf(family, folders, 'plain')).toBe('f-web');
        expect(groupFolderOf(family, folders, 'ghost')).toBeUndefined();
    });

    it("tells the folder a chat works in, by its name: the group's folder, the main one for a chat with none", () => {
        const family = new Map(
            [
                inFolder('root', 'f-api'),
                inFolder('thread', undefined, { parentChatId: 'root' }),
                inFolder('plain'),
                inFolder('gone', 'f-gone'),
            ].map(candidate => [candidate.id, candidate])
        );
        const where = (id: string) => {
            const found = chatFolder(family, folders, id);

            return found && [found.folder.id, found.name];
        };

        expect(where('root')).toEqual(['f-api', 'api']);
        expect(where('thread')).toEqual(['f-api', 'api']);
        expect(where('plain')).toEqual(['f-web', 'web']);
        // A folder the project no longer has handed its chats back to the main one.
        expect(where('gone')).toEqual(['f-web', 'web']);
        expect(where('ghost')).toBeUndefined();
    });
});

describe('archivedChats', () => {
    it('lists only the archived chats, the one put away last first', () => {
        const list = [{ ...chats[0], archivedAt: 5 }, chats[1], { ...chats[2], archivedAt: 9 }];

        expect(archivedChats(list).map(candidate => candidate.id)).toEqual(['chat-3', 'chat-1']);
        expect(archivedChats([chats[1]])).toEqual([]);
    });
});

describe('archiveGroups', () => {
    // 2026-11-22, early in the afternoon: yesterday begins 13 hours before, so a chat put away at 09:00 is today's and one at 23:00 the day before is yesterday's.
    const now = new Date(2026, 10, 22, 13, 0).getTime();
    const away = (id: string, days: number, hour = 12): Chat & { archivedAt: number } => ({
        ...chat(id),
        archivedAt: new Date(2026, 10, 22 - days, hour).getTime(),
    });
    const shape = (list: readonly (Chat & { archivedAt: number })[]) =>
        archiveGroups(list, now).map(group => [group.id, group.title, group.chats.map(candidate => candidate.id)]);

    it('has today, yesterday, the 7 days before and older, by the calendar day, with the chats in the order they came in', () => {
        const list = [
            away('a', 0, 9),
            away('b', 0, 2),
            away('c', 1, 23),
            away('d', 2),
            away('e', 7),
            away('f', 8),
            away('g', 90),
        ];

        expect(shape(list)).toEqual([
            ['today', 'Today', ['a', 'b']],
            ['yesterday', 'Yesterday', ['c']],
            ['week', 'Last 7 days', ['d', 'e']],
            ['older', 'Older', ['f', 'g']],
        ]);
    });

    it('leaves out a group with no chat', () => {
        expect(shape([away('a', 0), away('b', 30)])).toEqual([
            ['today', 'Today', ['a']],
            ['older', 'Older', ['b']],
        ]);
        expect(shape([])).toEqual([]);
    });

    it('takes a moment ahead of the clock for today', () => {
        expect(shape([{ ...chat('a'), archivedAt: now + 5 * 60_000 }])).toEqual([['today', 'Today', ['a']]]);
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
    const resolve = (chatId: string | null, runId: string | null, draft = false) =>
        resolveSelection(byChat, chats, byRun, chatId, runId, draft);

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

        expect(resolveSelection(byChat, chats, orphan, 'chat-2', 'x')).toEqual({
            chat: byChat.get('chat-2'),
            run: undefined,
            draft: false,
        });
    });

    it('opens no chat that is in the archive, nor a run of one: the first listed chat stands in', () => {
        const archived = new Map([...byChat, ['chat-1', { ...chats[0], archivedAt: 5 }]]);
        const shown = chats.filter(candidate => candidate.id !== 'chat-1');

        expect(resolveSelection(archived, shown, byRun, 'chat-1', null)).toEqual({
            chat: shown[0],
            run: undefined,
            draft: false,
        });
        expect(resolveSelection(archived, shown, byRun, null, 'a1')).toEqual({
            chat: shown[0],
            run: undefined,
            draft: false,
        });
        expect(resolveSelection(archived, shown, byRun, null, null)).toEqual({
            chat: shown[0],
            run: undefined,
            draft: false,
        });
    });

    it('shows the new-chat row when it was asked for, whatever else is remembered', () => {
        expect(resolve('chat-2', 'a1', true)).toEqual({ chat: undefined, run: undefined, draft: true });
    });

    it('shows the new-chat row when there is no chat to show', () => {
        expect(resolveSelection(new Map(), [], byRun, null, 'a')).toEqual({
            chat: undefined,
            run: undefined,
            draft: true,
        });
    });
});

describe('chatDotTone', () => {
    it('is green while the orchestrator works or waits for its background work', () => {
        expect(chatDotTone(run('r', 'running'))).toBe('success');
        expect(chatDotTone(run('r', 'waiting_background'))).toBe('success');
    });

    it('uses the accent when waiting for the person and red when it failed', () => {
        expect(chatDotTone(run('r', 'waiting_user'))).toBe('accent');
        expect(chatDotTone(run('r', 'failed'))).toBe('danger');
    });

    it('uses the accent for an open card and green again once it is decided', () => {
        expect(chatDotTone(run('r', 'waiting_background', { awaitingUser: true }))).toBe('accent');
        expect(chatDotTone(run('r', 'running', { awaitingUser: true }))).toBe('accent');
        expect(chatDotTone(run('r', 'waiting_background'))).toBe('success');
        // A run that is over has no mark worth showing, whatever a stale snapshot says.
        expect(chatDotTone(run('r', 'cancelled', { awaitingUser: true }))).toBeUndefined();
    });

    it('keeps the usual tone of a run that is blocked or queued', () => {
        expect(chatDotTone(run('r', 'blocked'))).toBe('warning');
        expect(chatDotTone(run('r', 'queued'))).toBe('neutral');
    });

    it('is yellow only for an unread success and absent for an unstarted or stopped chat', () => {
        expect(chatDotTone(undefined)).toBeUndefined();
        expect(chatDotTone(run('r', 'succeeded'))).toBeUndefined();
        expect(chatDotTone(run('r', 'succeeded'), undefined, false, true)).toBe('warning');

        for (const status of ['cancelled', 'interrupted'] as const)
            expect(chatDotTone(run('r', status))).toBeUndefined();
    });

    it('is green for a chat at rest whose threads work, and keeps the tone of a run that has one of its own', () => {
        for (const status of ['succeeded', 'cancelled', 'interrupted'] as const)
            expect(chatDotTone(run('r', status), 'working')).toBe('success');

        expect(chatDotTone(run('r', 'failed'), 'working')).toBe('danger');
        expect(chatDotTone(run('r', 'waiting_user'), 'working')).toBe('accent');
        expect(chatDotTone(run('r', 'succeeded'), 'working', false, true)).toBe('success');
    });

    it('uses the accent for a chat whose thread waits for the person, and keeps a failure or a block', () => {
        for (const status of ['succeeded', 'cancelled', 'interrupted', 'running', 'waiting_background'] as const)
            expect(chatDotTone(run('r', status), 'asking')).toBe('accent');

        expect(chatDotTone(undefined, 'asking')).toBe('accent');
        expect(chatDotTone(run('r', 'failed'), 'asking')).toBe('danger');
        expect(chatDotTone(run('r', 'blocked'), 'asking')).toBe('warning');
    });

    it('shows drafts in gray unless work or an attention state takes priority', () => {
        expect(chatDotTone(undefined, undefined, true)).toBe('neutral');
        expect(chatDotTone(run('r', 'succeeded'), undefined, true, true)).toBe('neutral');
        expect(chatDotTone(run('r', 'running'), undefined, true)).toBe('success');
        expect(chatDotTone(run('r', 'waiting_user'), undefined, true)).toBe('accent');
        expect(chatDotTone(run('r', 'succeeded'), 'working', true)).toBe('success');
        expect(chatDotTone(run('r', 'succeeded'), 'asking', true)).toBe('accent');
    });
});

/*
 * A tree of threads: root (done) has t1 (working) and t2 (done); t1 has t11 (done) and t12 (failed); t2 has t21 (working); root2 has none.
 * Threads are listed in the order they were made, whatever order they are given in.
 */
describe('agentRows', () => {
    const thread = (id: string, parentChatId: string, createdAt: number, status?: RunStatus): Chat => ({
        ...chat(id, status ? `run-${id}` : undefined),
        parentChatId,
        createdAt,
    });
    const tree = [
        { ...chat('root', 'run-root'), createdAt: 1 },
        { ...chat('root2'), createdAt: 2 },
        thread('t2', 'root', 4, 'succeeded'),
        thread('t1', 'root', 3, 'running'),
        thread('t11', 't1', 5, 'succeeded'),
        thread('t12', 't1', 6, 'failed'),
        thread('t21', 't2', 7, 'running'),
    ];
    const treeRuns = new Map<string, Run>([
        ['run-root', run('run-root', 'succeeded')],
        ...tree
            .filter(candidate => candidate.parentChatId)
            .map(candidate => {
                const status = { t1: 'running', t2: 'succeeded', t11: 'succeeded', t12: 'failed', t21: 'running' }[
                    candidate.id
                ] as RunStatus;

                return [`run-${candidate.id}`, run(`run-${candidate.id}`, status)] as const;
            }),
    ]);
    const threadsOf = (list: readonly Chat[]) => (chatId: string) =>
        list.filter(candidate => candidate.parentChatId === chatId).sort((a, b) => a.createdAt - b.createdAt);
    const rows = (input: Partial<AgentRowsInput> = {}, list: readonly Chat[] = tree) =>
        agentRows({
            roots: list.filter(candidate => !candidate.parentChatId),
            threadsOf: threadsOf(list),
            runs: treeRuns,
            expanded: new Set(),
            showFinished: true,
            ...input,
        });
    const shape = (input: Partial<AgentRowsInput> = {}, list?: readonly Chat[]) =>
        rows(input, list).map(
            row => `${'  '.repeat(row.depth)}${row.id}${row.childCount > 0 ? (row.isExpanded ? ' -' : ' +') : ''}`
        );

    it('folds every chat with threads until it is expanded: only the roots are rows, the ones with threads have a fold', () => {
        expect(shape()).toEqual(['root +', 'root2']);
        expect(rows()[0]).toMatchObject({ depth: 0, childCount: 2, isExpanded: false });
    });

    it('lists the threads of an expanded chat below it, one level in, in the order they were made', () => {
        expect(shape({ expanded: new Set(['root']) })).toEqual(['root -', '  t1 +', '  t2 +', 'root2']);
        expect(shape({ expanded: new Set(['root', 't1', 't2']) })).toEqual([
            'root -',
            '  t1 -',
            '    t11',
            '    t12',
            '  t2 -',
            '    t21',
            'root2',
        ]);
    });

    describe('a thread that waits for the person', () => {
        const asking = (...ids: string[]): ReadonlyMap<string, Run> =>
            new Map(
                [...treeRuns].map(([id, candidate]) => [
                    id,
                    ids.includes(id.replace('run-', ''))
                        ? { ...candidate, status: 'waiting_user' as const, statusReason: 'Waiting for your approval' }
                        : candidate,
                ])
            );

        it('is listed under a folded chat, with the chats between, while the threads that do not ask stay folded away', () => {
            expect(shape({ runs: asking('t1') })).toEqual(['root +', '  t1 +', 'root2']);
            expect(shape({ runs: asking('t11') })).toEqual(['root +', '  t1 +', '    t11', 'root2']);
            expect(shape({ runs: asking('t11', 't21') })).toEqual([
                'root +',
                '  t1 +',
                '    t11',
                '  t2 +',
                '    t21',
                'root2',
            ]);
        });

        it('reads a thread that rests for its background work with a card open as asking, as the daemon does', () => {
            const resting = new Map(treeRuns).set('run-t2', {
                ...run('run-t2', 'waiting_background'),
                awaitingUser: true,
            });

            expect(shape({ runs: resting })).toEqual(['root +', '  t2 +', 'root2']);
        });

        it('leaves the fold as it was: the chat still counts every thread and reads folded, and expanding it lists them all', () => {
            expect(rows({ runs: asking('t1') })[0]).toMatchObject({ id: 'root', childCount: 2, isExpanded: false });
            expect(shape({ runs: asking('t1'), expanded: new Set(['root']) })).toEqual([
                'root -',
                '  t1 +',
                '  t2 +',
                'root2',
            ]);
        });

        it('is not listed when archived, or when the chat above it is gone from the list by the filter', () => {
            const archived = tree.map(candidate =>
                candidate.id === 't1' ? { ...candidate, archivedAt: 9 } : candidate
            );

            expect(shape({ runs: asking('t1') }, archived)).toEqual(['root +', 'root2']);
        });
    });

    it('hides what is below a folded thread even when a chat further down is expanded', () => {
        expect(shape({ expanded: new Set(['t1']) })).toEqual(['root +', 'root2']);
    });

    it('leaves archived threads out, and a chat whose threads are all archived has no fold', () => {
        const archived = tree.map(candidate =>
            candidate.parentChatId === 'root' ? { ...candidate, archivedAt: 9 } : candidate
        );

        expect(shape({ expanded: new Set(['root']) }, archived)).toEqual(['root', 'root2']);
    });

    it('hides finished threads when asked, unless a thread below still works or it is the open chat', () => {
        const all = new Set(['root', 't1', 't2']);

        // t2 is done but t21 works; t11 and t12 are over and have nothing below.
        expect(shape({ expanded: all, showFinished: false })).toEqual(['root -', '  t1', '  t2 -', '    t21', 'root2']);
        expect(shape({ expanded: all, showFinished: false, openChatId: 't12' })).toEqual([
            'root -',
            '  t1 -',
            '    t12',
            '  t2 -',
            '    t21',
            'root2',
        ]);
    });

    it('keeps a finished thread whose own finished thread is the open chat, so the open chat has its path', () => {
        const done = tree.map(candidate =>
            candidate.id === 't21' ? { ...candidate, orchestratorRunId: 'run-t11' } : candidate
        );

        expect(shape({ expanded: new Set(['root', 't2']), showFinished: false }, done)).toEqual([
            'root -',
            '  t1',
            'root2',
        ]);
        expect(shape({ expanded: new Set(['root', 't2']), showFinished: false, openChatId: 't21' }, done)).toEqual([
            'root -',
            '  t1',
            '  t2 -',
            '    t21',
            'root2',
        ]);
    });

    it('never hides a root, whatever its run did', () => {
        expect(shape({ showFinished: false }).map(line => line.split(' ')[0])).toEqual(['root', 'root2']);
    });

    it('lists a thread that never started, which is not finished', () => {
        expect(
            shape({ expanded: new Set(['root2']), showFinished: false }, [...tree, thread('fresh', 'root2', 8)])
        ).toEqual(['root +', 'root2 -', '  fresh']);
    });

    it('survives a parent cycle in corrupt data', () => {
        const cycle = [
            { ...chat('a'), createdAt: 1 },
            thread('b', 'c', 2, 'running'),
            thread('c', 'b', 3, 'running'),
            thread('d', 'a', 4, 'running'),
        ];

        expect(shape({ expanded: new Set(['a', 'b', 'c', 'd']) }, cycle)).toEqual(['a -', '  d']);
    });
});

describe('agentRows, with sub-agents', () => {
    const thread = (id: string, parentChatId: string, createdAt: number): Chat => ({
        ...chat(id, `run-${id}`),
        parentChatId,
        createdAt,
    });
    const native = (id: string, parent: string, status: RunStatus, rootRunId: string, createdAt: number) =>
        run(id, status, { parentRunId: parent, rootRunId, origin: 'native', createdAt });
    // root: its threads t1 (running, with its own sub-agent s1 running) and t2 (done), and its own sub-agents a (running, with a1 running below it), b (done, with d
    // running below it), c (waiting for the person) and e (failed). Made in the order t1, t2, a, a1, b, c, d, e (and s1 last). root2 rests.
    const list = [
        { ...chat('root', 'run-root'), createdAt: 1 },
        { ...chat('root2', 'run-root2'), createdAt: 2 },
        thread('t1', 'root', 3),
        thread('t2', 'root', 4),
    ];
    const baseRuns = [
        run('run-root', 'running', { createdAt: 1 }),
        run('run-root2', 'succeeded', { createdAt: 2 }),
        run('run-t1', 'running', { createdAt: 3 }),
        run('run-t2', 'succeeded', { createdAt: 4 }),
        native('a', 'run-root', 'running', 'run-root', 5),
        native('a1', 'a', 'running', 'run-root', 6),
        native('b', 'run-root', 'succeeded', 'run-root', 7),
        native('c', 'run-root', 'waiting_user', 'run-root', 8),
        native('d', 'b', 'running', 'run-root', 9),
        native('e', 'run-root', 'failed', 'run-root', 10),
        native('s1', 'run-t1', 'running', 'run-t1', 11),
    ];
    const rowsWith = (input: Partial<AgentRowsInput> = {}, runList: readonly Run[] = baseRuns, chats = list) => {
        const byRoot = nativeAgentsByRoot(runList);

        return agentRows({
            roots: chats.filter(candidate => !candidate.parentChatId),
            threadsOf: chatId =>
                chats.filter(candidate => candidate.parentChatId === chatId).sort((a, b) => a.createdAt - b.createdAt),
            runs: new Map(runList.map(candidate => [candidate.id, candidate])),
            agentsOf: candidate => (candidate.orchestratorRunId && byRoot.get(candidate.orchestratorRunId)) || [],
            expanded: new Set(),
            showFinished: true,
            expandRunning: true,
            ...input,
        });
    };
    const shape = (input: Partial<AgentRowsInput> = {}, runList?: readonly Run[], chats?: readonly Chat[]) =>
        rowsWith(input, runList, chats as Chat[]).map(
            row => `${'  '.repeat(row.depth)}${row.id}${row.childCount > 0 ? (row.isExpanded ? ' -' : ' +') : ''}`
        );
    const asking = (id: string, runList: readonly Run[] = baseRuns) =>
        runList.map(candidate => (candidate.id === id ? { ...candidate, status: 'waiting_user' as const } : candidate));
    const finish = (ids: readonly string[], runList: readonly Run[] = baseRuns) =>
        runList.map(candidate =>
            ids.includes(candidate.id) ? { ...candidate, status: 'succeeded' as const } : candidate
        );
    const open = { expanded: new Set(['root']) };

    describe('nativeAgentsByRoot', () => {
        it('groups the native sub-agents by the orchestrator they live in, oldest first, and leaves every other run out', () => {
            const byRoot = nativeAgentsByRoot([...baseRuns].reverse());

            expect([...byRoot.keys()].sort()).toEqual(['run-root', 'run-t1']);
            expect(byRoot.get('run-root')?.map(candidate => candidate.id)).toEqual(['a', 'a1', 'b', 'c', 'd', 'e']);
        });
    });

    describe('an expanded chat', () => {
        it('lists its threads and its sub-agents in one list, the oldest first, a sub-agent below the one that started it, finished or not', () => {
            expect(shape(open)).toEqual([
                'root -',
                '  t1 +',
                '    s1',
                '  t2',
                '  a',
                '    a1',
                '  b',
                '    d',
                '  c',
                '  e',
                'root2',
            ]);
        });

        it('mixes a thread in among the sub-agents by the time it was made', () => {
            const between = [...list, thread('t3', 'root', 6.5)];

            expect(shape(open, [...baseRuns, run('run-t3', 'succeeded', { createdAt: 6.5 })], between)).toEqual([
                'root -',
                '  t1 +',
                '    s1',
                '  t2',
                '  a',
                '    a1',
                '  t3',
                '  b',
                '    d',
                '  c',
                '  e',
                'root2',
            ]);
        });

        it('lists the sub-agents of a thread below that thread, in its own order, once the thread is open', () => {
            expect(shape({ expanded: new Set(['root', 't1']) }).slice(0, 4)).toEqual([
                'root -',
                '  t1 -',
                '    s1',
                '  t2',
            ]);
        });

        it('counts what is listed below a chat: its threads and its sub-agents, the nested ones too', () => {
            // t1, t2, a, a1, b, d, c and e.
            expect(rowsWith(open)[0]).toMatchObject({ kind: 'chat', id: 'root', childCount: 8, isExpanded: true });
            expect(rowsWith(open).find(row => row.id === 'a')).toMatchObject({
                kind: 'subagent',
                depth: 1,
                childCount: 0,
                isExpanded: false,
            });
            expect(rowsWith(open).find(row => row.id === 'a1')).toMatchObject({ depth: 2 });
        });

        it('has the same rows when the setting is off: the person opened the chat', () => {
            expect(shape({ ...open, expandRunning: false }).slice(0, 4)).toEqual(['root -', '  t1 +', '  t2', '  a']);
        });
    });

    describe('a finished sub-agent', () => {
        it('is listed with the finished threads, and left out of the list without them, unless something listed is below it', () => {
            const lines = shape({ ...open, showFinished: false });

            // e is over and has nothing below it; b is over, but d works below it.
            expect(lines).toEqual(['root -', '  t1 +', '    s1', '  a', '    a1', '  b', '    d', '  c', 'root2']);
        });

        it('is left out with all it started when they are over too', () => {
            const over = finish(['d']);

            expect(shape({ ...open, showFinished: false }, over)).toEqual([
                'root -',
                '  t1 +',
                '    s1',
                '  a',
                '    a1',
                '  c',
                'root2',
            ]);
            expect(shape(open, over)).toContain('    d');
        });

        it('keeps a finished sub-agent below which a working one nests, and the nesting, as a finished thread is kept for what works below it', () => {
            const nested = [...baseRuns, native('d1', 'd', 'running', 'run-root', 12)];

            expect(
                shape({ ...open, showFinished: false }, finish(['d'], nested)).filter(line => /^ +(b|d|d1)$/.test(line))
            ).toEqual(['  b', '    d', '      d1']);
        });

        it('stays listed when it is the open page, whatever the filter says', () => {
            expect(shape({ ...open, showFinished: false, openRunId: 'e', openChatId: 'root' })).toContain('  e');
            expect(shape({ ...open, showFinished: false })).not.toContain('  e');
        });

        it('keeps the sub-agents above the open one, so it keeps its nesting', () => {
            const over = finish(['d']);

            expect(shape({ ...open, showFinished: false, openRunId: 'd' }, over)).toContain('    d');
            expect(shape({ ...open, showFinished: false, openRunId: 'd' }, over)).toContain('  b');
        });

        it('reads as the run says: a failed one is a failed sub-agent row', () => {
            expect(rowsWith(open).find(row => row.id === 'e')).toMatchObject({
                kind: 'subagent',
                run: { status: 'failed' },
            });
        });
    });

    describe('a folded chat', () => {
        it('lists what works and what asks, with the threads and sub-agents between, in the order they were made', () => {
            expect(shape()).toEqual(['root +', '  t1 +', '    s1', '  a', '    a1', '  b', '    d', '  c', 'root2']);
        });

        it('keeps a finished sub-agent that has one that works below it, and leaves out one that is over with nothing below it', () => {
            const lines = shape();

            expect(lines).toContain('  b');
            expect(lines).not.toContain('  e');
            expect(lines.some(line => line.trim() === 't2')).toBe(false);
        });

        it('lists only what waits for the person with the setting off, which is how the list was', () => {
            expect(shape({ expandRunning: false })).toEqual(['root +', '  c', 'root2']);
            expect(shape({ expandRunning: false }, asking('run-t1'))).toEqual(['root +', '  t1 +', '  c', 'root2']);
        });

        it('lists a sub-agent that waits with the sub-agents it sits below, and not its siblings, with the setting off', () => {
            expect(shape({ expandRunning: false }, asking('a1'))).toEqual(['root +', '  a', '    a1', '  c', 'root2']);
            expect(shape({ expandRunning: false }, asking('d'))).toEqual(['root +', '  b', '    d', '  c', 'root2']);
        });

        it('lists a thread whose sub-agent waits for the person, with the setting off', () => {
            expect(shape({ expandRunning: false }, asking('s1'))).toEqual([
                'root +',
                '  t1 +',
                '    s1',
                '  c',
                'root2',
            ]);
        });

        it('keeps the row of the open sub-agent, whatever its state, and the sub-agents above it', () => {
            expect(shape({ expandRunning: false, openRunId: 'e', openChatId: 'root' })).toEqual([
                'root +',
                '  c',
                '  e',
                'root2',
            ]);
            expect(shape({ expandRunning: false, openRunId: 'd', openChatId: 'root' })).toEqual([
                'root +',
                '  b',
                '    d',
                '  c',
                'root2',
            ]);
        });

        it('lists what works in a chat that rests, and a chat with nothing at work has none', () => {
            const resting = baseRuns.map(candidate =>
                candidate.rootRunId === 'run-root' || candidate.id === 'run-root'
                    ? { ...candidate, status: 'succeeded' as const }
                    : candidate
            );

            expect(shape({}, resting)).toEqual(['root +', '  t1 +', '    s1', 'root2']);
            expect(shape({}, finish(['s1', 'run-t1'], resting))).toEqual(['root +', 'root2']);
        });

        it('counts what it holds below, shown or not, and reads folded', () => {
            expect(rowsWith()[0]).toMatchObject({ kind: 'chat', id: 'root', childCount: 8, isExpanded: false });
        });
    });

    describe('a chat with a great many finished sub-agents', () => {
        const crowd = [
            ...baseRuns,
            ...Array.from({ length: 300 }, (_, index) =>
                native(`f${index}`, 'run-root', 'succeeded', 'run-root', 20 + index)
            ),
        ];

        it('has a row for each of them while the chat is open and the finished are listed, and none while the chat is folded', () => {
            expect(rowsWith(open, crowd)).toHaveLength(rowsWith(open).length + 300);
            expect(rowsWith({}, crowd)).toHaveLength(rowsWith().length);
            expect(rowsWith({ ...open, showFinished: false }, crowd)).toHaveLength(
                rowsWith({ ...open, showFinished: false }).length
            );
            expect(rowsWith({}, crowd)[0]).toMatchObject({ id: 'root', childCount: 308 });
        });

        it('lists them oldest first below the others, one level in', () => {
            const rows = rowsWith(open, crowd);
            const first = rows.findIndex(row => row.id === 'f0');

            expect(rows.slice(first, first + 3).map(row => [row.id, row.depth])).toEqual([
                ['f0', 1],
                ['f1', 1],
                ['f2', 1],
            ]);
            expect(rows.at(-2)).toMatchObject({ id: 'f299' });
        });

        it('is built in one pass: each chat asks for its threads and its sub-agents once, and 300 take a moment', () => {
            const byRoot = nativeAgentsByRoot(crowd);
            const asked = { threads: 0, agents: 0 };
            const started = performance.now();
            const rows = agentRows({
                roots: list.filter(candidate => !candidate.parentChatId),
                threadsOf: chatId => {
                    asked.threads++;

                    return list.filter(candidate => candidate.parentChatId === chatId);
                },
                runs: new Map(crowd.map(candidate => [candidate.id, candidate])),
                agentsOf: candidate => {
                    asked.agents++;

                    return (candidate.orchestratorRunId && byRoot.get(candidate.orchestratorRunId)) || [];
                },
                expanded: new Set(['root', 't1']),
                showFinished: true,
                expandRunning: true,
            });
            const elapsed = performance.now() - started;

            expect(rows).toHaveLength(rowsWith({ expanded: new Set(['root', 't1']) }).length + 300);
            // The four chats (root, root2, t1, t2) each once, however many sub-agents they have.
            expect(asked).toEqual({ threads: 4, agents: 4 });
            expect(elapsed).toBeLessThan(500);
        });
    });

    describe('a chat without an orchestrator, and corrupt data', () => {
        it('has no sub-agents for a chat whose first message was never sent', () => {
            const fresh = [...list, { ...chat('fresh'), createdAt: 9 }];

            expect(shape({ expanded: new Set(['fresh']) }, undefined, fresh).slice(-2)).toEqual(['root2', 'fresh']);
            expect(rowsWith({}, undefined, fresh).at(-1)).toMatchObject({ id: 'fresh', childCount: 0 });
        });

        it('survives sub-agents that name each other as their parent, and lists them', () => {
            const loop = [
                ...baseRuns.filter(candidate => candidate.origin !== 'native'),
                native('x', 'y', 'running', 'run-root', 30),
                native('y', 'x', 'running', 'run-root', 31),
                native('z', 'run-root', 'running', 'run-root', 32),
            ];

            expect(shape({ expanded: new Set(['root']) }, loop)).toEqual([
                'root -',
                '  t1',
                '  t2',
                '  z',
                '  x',
                '    y',
                'root2',
            ]);
        });

        it('is today’s list for a caller that knows no sub-agents', () => {
            const rows = agentRows({
                roots: [list[0], list[1]],
                threadsOf: chatId => list.filter(candidate => candidate.parentChatId === chatId),
                runs: new Map(baseRuns.map(candidate => [candidate.id, candidate])),
                expanded: new Set(['root']),
                showFinished: true,
            });

            expect(rows.map(row => row.id)).toEqual(['root', 't1', 't2', 'root2']);
            expect(rows.every(row => row.kind === 'chat')).toBe(true);
        });
    });
});

describe('isFinishedThread and isActiveThread', () => {
    const runs = new Map(
        [
            'queued',
            'running',
            'blocked',
            'waiting_user',
            'waiting_background',
            'succeeded',
            'failed',
            'cancelled',
            'interrupted',
        ].map(status => [status, run(status, status as RunStatus)])
    );

    it('takes a thread for working while its orchestrator is queued, running, blocked, or waits for the person or its background work', () => {
        const active = [...runs.keys()].filter(status => isActiveThread(chat('t', status), runs));

        expect(active).toEqual(['queued', 'running', 'blocked', 'waiting_user', 'waiting_background']);
        expect(isActiveThread(chat('t'), runs)).toBe(false);
    });

    it("takes a thread for finished once its orchestrator's run is over, and one that never started for not finished", () => {
        const finished = [...runs.keys()].filter(status => isFinishedThread(chat('t', status), runs));

        expect(finished).toEqual(['succeeded', 'failed', 'cancelled', 'interrupted']);
        expect(isFinishedThread(chat('t'), runs)).toBe(false);
    });
});

describe('visibleChats and archivedChats, with threads', () => {
    const thread = (id: string, parentChatId: string, rest: Partial<Chat> = {}): Chat => ({
        ...chat(id),
        parentChatId,
        ...rest,
    });

    it('lists only the chats the person made at the top: a thread is a row below its parent', () => {
        expect(visibleChats([chats[0], thread('t', 'chat-1'), chats[1]]).map(candidate => candidate.id)).toEqual([
            'chat-1',
            'chat-2',
        ]);
    });

    it('puts a thread at the top when its parent is not in use, so it is not lost', () => {
        const list = [{ ...chats[0], archivedAt: 3 }, thread('t', 'chat-1'), thread('orphan', 'gone')];

        expect(visibleChats(list).map(candidate => candidate.id)).toEqual(['t', 'orphan']);
    });

    it('lists a thread put away with its parent nowhere on its own, and one put away alone by its title', () => {
        const list = [
            { ...chats[0], archivedAt: 5 },
            thread('with-parent', 'chat-1', { archivedAt: 5 }),
            thread('deeper', 'with-parent', { archivedAt: 5 }),
            chats[1],
            thread('alone', 'chat-2', { archivedAt: 7 }),
        ];

        expect(archivedChats(list).map(candidate => candidate.id)).toEqual(['alone', 'chat-1']);
    });
});

describe('ancestorChats', () => {
    const map = (...list: Chat[]) => new Map(list.map(candidate => [candidate.id, candidate]));

    it('lists the chats above a thread, nearest first, and none for a chat the person made', () => {
        const chatsById = map(
            chat('root'),
            { ...chat('mid'), parentChatId: 'root' },
            { ...chat('leaf'), parentChatId: 'mid' }
        );

        expect(ancestorChats(chatsById, 'leaf').map(candidate => candidate.id)).toEqual(['mid', 'root']);
        expect(ancestorChats(chatsById, 'root')).toEqual([]);
        expect(ancestorChats(chatsById, 'gone')).toEqual([]);
    });

    it('stops at a parent that is gone, and at a cycle', () => {
        expect(ancestorChats(map({ ...chat('leaf'), parentChatId: 'gone' }), 'leaf')).toEqual([]);
        expect(
            ancestorChats(map({ ...chat('a'), parentChatId: 'b' }, { ...chat('b'), parentChatId: 'a' }), 'a').map(
                candidate => candidate.id
            )
        ).toEqual(['b']);
    });
});
