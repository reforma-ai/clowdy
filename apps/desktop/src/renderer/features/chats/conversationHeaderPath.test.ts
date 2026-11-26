import { describe, expect, it } from 'vitest';

import { conversationHeaderPath, foldedPath, type HeaderPart, MAX_PARTS } from './conversationHeaderPath';

import type { Chat, Run } from '@clowdy/protocol';

const chat = (id: string, title: string, extra: Partial<Chat> = {}): Chat =>
    ({ id, title, projectId: 'p', ...extra }) as Chat;
const run = (id: string, name: string, extra: Partial<Run> = {}): Run =>
    ({ id, name, rootRunId: 'o1', origin: 'native', ...extra }) as Run;

const chats = (...items: Chat[]) => new Map(items.map(item => [item.id, item]));
const runs = (...items: Run[]) => new Map(items.map(item => [item.id, item]));
const label = (item: Run) => `<${item.name}>`;

const labels = (parts: readonly HeaderPart[]) => parts.map(part => part.label);
const targets = (parts: readonly HeaderPart[]) => parts.map(part => part.target);

describe('conversationHeaderPath, a chat', () => {
    const tree = chats(
        chat('c1', 'Ship the checkout', { orchestratorRunId: 'o1' }),
        chat('c2', 'Fix the rounding', { parentChatId: 'c1' }),
        chat('c3', 'Check the table', { parentChatId: 'c2' })
    );

    it('is its title alone, which opens nothing since it is the page', () => {
        const parts = conversationHeaderPath({ chats: tree, runs: runs(), chat: tree.get('c1'), label });

        expect(labels(parts)).toEqual(['Ship the checkout']);
        expect(targets(parts)).toEqual([undefined]);
    });

    it('is the path of a thread: the chat, then the thread', () => {
        const parts = conversationHeaderPath({ chats: tree, runs: runs(), chat: tree.get('c2'), label });

        expect(labels(parts)).toEqual(['Ship the checkout', 'Fix the rounding']);
        expect(targets(parts)).toEqual([{ kind: 'chat', chatId: 'c1' }, undefined]);
    });

    it('is the path of a thread of a thread, the chat the person made first', () => {
        const parts = conversationHeaderPath({ chats: tree, runs: runs(), chat: tree.get('c3'), label });

        expect(labels(parts)).toEqual(['Ship the checkout', 'Fix the rounding', 'Check the table']);
        expect(targets(parts)).toEqual([{ kind: 'chat', chatId: 'c1' }, { kind: 'chat', chatId: 'c2' }, undefined]);
    });

    it('reads a chat with no title as New chat', () => {
        const parts = conversationHeaderPath({
            chats: chats(chat('c1', '  ')),
            runs: runs(),
            chat: chat('c1', '  '),
            label,
        });

        expect(labels(parts)).toEqual(['New chat']);
    });

    it('names a parent in the archive without a target, since opening it would bring it back', () => {
        const archived = chats(
            chat('c1', 'Ship the checkout', { archivedAt: 5 }),
            chat('c2', 'Fix the rounding', { parentChatId: 'c1' })
        );
        const parts = conversationHeaderPath({ chats: archived, runs: runs(), chat: archived.get('c2'), label });

        expect(labels(parts)).toEqual(['Ship the checkout', 'Fix the rounding']);
        expect(targets(parts)).toEqual([undefined, undefined]);
    });

    it('ends the path above a parent that is not there', () => {
        const orphan = chats(chat('c2', 'Fix the rounding', { parentChatId: 'gone' }));
        const parts = conversationHeaderPath({ chats: orphan, runs: runs(), chat: orphan.get('c2'), label });

        expect(labels(parts)).toEqual(['Fix the rounding']);
    });

    it('does not loop on parents that point at each other', () => {
        const loop = chats(chat('c1', 'One', { parentChatId: 'c2' }), chat('c2', 'Two', { parentChatId: 'c1' }));
        const parts = conversationHeaderPath({ chats: loop, runs: runs(), chat: loop.get('c1'), label });

        expect(labels(parts)).toEqual(['Two', 'One']);
    });
});

describe('conversationHeaderPath, a sub-agent', () => {
    const tree = chats(
        chat('c1', 'Ship the checkout', { orchestratorRunId: 'o1' }),
        chat('c2', 'Fix the rounding', { parentChatId: 'c1', orchestratorRunId: 'o2' })
    );
    const root = run('o1', 'Orchestrator 01', { origin: undefined, rootRunId: 'o1' });
    const general = run('a1', 'general-purpose', { parentRunId: 'o1' });
    const explore = run('a2', 'Explore', { parentRunId: 'a1' });
    const all = runs(root, general, explore);

    it('is the path of its chat and then its own name, the chat opening and the sub-agent being the page', () => {
        const parts = conversationHeaderPath({
            chats: tree,
            runs: all,
            chat: tree.get('c1'),
            subagent: general,
            label,
        });

        expect(labels(parts)).toEqual(['Ship the checkout', '<general-purpose>']);
        expect(targets(parts)).toEqual([{ kind: 'chat', chatId: 'c1' }, undefined]);
    });

    it('follows the path of a thread: every chat above it opens, then the sub-agent', () => {
        const parts = conversationHeaderPath({
            chats: tree,
            runs: all,
            chat: tree.get('c2'),
            subagent: run('a3', 'Explore', { parentRunId: 'o2', rootRunId: 'o2' }),
            label,
        });

        expect(labels(parts)).toEqual(['Ship the checkout', 'Fix the rounding', '<Explore>']);
        expect(targets(parts)).toEqual([{ kind: 'chat', chatId: 'c1' }, { kind: 'chat', chatId: 'c2' }, undefined]);
    });

    it('adds the sub-agents it runs inside, the one nearest the chat first, each opening its own page', () => {
        const parts = conversationHeaderPath({
            chats: tree,
            runs: all,
            chat: tree.get('c1'),
            subagent: explore,
            label,
        });

        expect(labels(parts)).toEqual(['Ship the checkout', '<general-purpose>', '<Explore>']);
        expect(targets(parts)).toEqual([{ kind: 'chat', chatId: 'c1' }, { kind: 'run', runId: 'a1' }, undefined]);
    });

    it('stops at a parent run that is not there, and at runs that point at each other', () => {
        const orphan = run('a2', 'Explore', { parentRunId: 'gone' });
        const loopA = run('l1', 'general-purpose', { parentRunId: 'l2' });
        const loopB = run('l2', 'Explore', { parentRunId: 'l1' });

        expect(
            labels(
                conversationHeaderPath({
                    chats: tree,
                    runs: runs(orphan),
                    chat: tree.get('c1'),
                    subagent: orphan,
                    label,
                })
            )
        ).toEqual(['Ship the checkout', '<Explore>']);
        expect(
            labels(
                conversationHeaderPath({
                    chats: tree,
                    runs: runs(loopA, loopB),
                    chat: tree.get('c1'),
                    subagent: loopA,
                    label,
                })
            )
        ).toEqual(['Ship the checkout', '<Explore>', '<general-purpose>']);
    });

    it('is the sub-agent alone when its chat is gone', () => {
        const parts = conversationHeaderPath({ chats: tree, runs: all, chat: undefined, subagent: general, label });

        expect(labels(parts)).toEqual(['<general-purpose>']);
    });
});

describe('foldedPath', () => {
    const part = (n: number): HeaderPart => ({ key: `k${n}`, label: `Part ${n}` });
    const parts = (count: number) => Array.from({ length: count }, (_, index) => part(index + 1));
    const shown = (items: ReturnType<typeof foldedPath>) => items.map(item => ('fold' in item ? '…' : item.label));

    it('keeps a path that fits, whole', () => {
        expect(shown(foldedPath(parts(MAX_PARTS), false))).toEqual(['Part 1', 'Part 2', 'Part 3', 'Part 4']);
        expect(shown(foldedPath(parts(1), false))).toEqual(['Part 1']);
    });

    it('folds the middle of a longer one into one …, keeping the first part and the last two', () => {
        expect(shown(foldedPath(parts(MAX_PARTS + 1), false))).toEqual(['Part 1', '…', 'Part 4', 'Part 5']);
        expect(shown(foldedPath(parts(7), false))).toEqual(['Part 1', '…', 'Part 6', 'Part 7']);
    });

    it('says how many parts the … stands for', () => {
        expect(foldedPath(parts(7), false)[1]).toEqual({ fold: true, hidden: 4 });
    });

    it('shows all of a long path once it is opened out', () => {
        expect(foldedPath(parts(7), true)).toHaveLength(7);
    });
});
