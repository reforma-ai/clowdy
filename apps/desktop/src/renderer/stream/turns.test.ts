import { describe, expect, it } from 'vitest';

import { foldFinishedWork, forkPointId, hasMessageActions, workedForLabel, type StreamBlock } from './turns';

import type { StreamItem, StreamItemBody } from '@clowdy/protocol';

let seq = 0;
const item = (body: StreamItemBody, at: number): StreamItem => ({ id: `i-${ ++seq }`, runId: 'r', seq, at, body });
const user = (at: number, text = 'Do it') => item({ kind: 'user', text }, at);
const said = (at: number, text = 'Done.') => item({ kind: 'assistant', text, done: true }, at);
const tool = (at: number) => item({ kind: 'tool', toolCallId: `t-${ at }`, name: 'Read', input: {}, state: 'done' }, at);
const note = (at: number) => item({ kind: 'note', text: 'started' }, at);
const failure = (at: number) => item({ kind: 'error', text: 'It failed' }, at);
const asking = (at: number) => item({ kind: 'question', questionId: `q-${ at }`, text: 'Which one?', options: [] }, at);

const shape = (blocks: StreamBlock[]) => blocks.map(block => (block.kind === 'worked' ? `worked(${ block.items.length }): ${ block.label }` : block.item.body.kind));

describe('foldFinishedWork', () => {
    it('folds the work between the person\'s message and the answer of a finished turn', () => {
        const items = [user(0), said(1000, 'Looking.'), tool(2000), tool(3000), note(4000), said(125_000, 'All done.')];

        expect(shape(foldFinishedWork(items, false))).toEqual(['user', 'worked(4): Worked for 2m 5s', 'assistant']);
    });

    it('keeps the answer and the message out of the fold', () => {
        const items = [user(0), tool(1000), said(5000, 'All done.')];
        const blocks = foldFinishedWork(items, false);

        expect(blocks[0]).toEqual({ kind: 'item', item: items[0] });
        expect(blocks[2]).toEqual({ kind: 'item', item: items[2], answer: true });
        expect(blocks[1]).toMatchObject({ kind: 'worked', items: [items[1]] });
    });

    it('leaves the latest turn open while the run is active', () => {
        const items = [user(0), tool(1000), said(5000, 'Half way.')];

        expect(shape(foldFinishedWork(items, true))).toEqual(['user', 'tool', 'assistant']);
    });

    it('folds an earlier turn even while the run is active', () => {
        const items = [user(0), tool(1000), said(5000), user(6000), tool(7000)];

        expect(shape(foldFinishedWork(items, true))).toEqual(['user', 'worked(1): Worked for 5s', 'assistant', 'user', 'tool']);
    });

    it('folds nothing when there is no work between the message and the answer', () => {
        expect(shape(foldFinishedWork([user(0), said(1000)], false))).toEqual(['user', 'assistant']);
    });

    it('leaves the latest turn open when it ended without an answer, and folds all of an earlier one that has none', () => {
        const stopped = [user(0), tool(1000), tool(2000)];

        expect(shape(foldFinishedWork(stopped, false))).toEqual(['user', 'tool', 'tool']);
        expect(shape(foldFinishedWork([...stopped, user(3000), said(4000)], false))).toEqual(['user', 'worked(2): Worked for 2s', 'user', 'assistant']);
    });

    it('does not fold an error away, and keeps what follows the answer', () => {
        const items = [user(0), tool(1000), failure(2000), tool(3000), said(4000, 'Could not.'), note(5000)];

        expect(shape(foldFinishedWork(items, false))).toEqual(['user', 'worked(2): Worked for 4s', 'error', 'assistant', 'note']);
    });

    it('does not fold a question away', () => {
        const items = [user(0), tool(1000), asking(2000), tool(3000), said(4000, 'Went with the first.')];

        expect(shape(foldFinishedWork(items, false))).toEqual(['user', 'worked(2): Worked for 4s', 'question', 'assistant']);
    });

    it('keeps an error that follows the message of the person\'s at once, whatever comes after', () => {
        expect(shape(foldFinishedWork([user(0), failure(1000), user(2000), tool(3000), said(4000)], false)))
            .toEqual(['user', 'error', 'user', 'worked(1): Worked for 2s', 'assistant']);
        expect(shape(foldFinishedWork([user(0), failure(1000)], false))).toEqual(['user', 'error']);
    });

    it('draws nothing for an empty stream, and keeps two messages of the person\'s in a row apart', () => {
        expect(foldFinishedWork([], false)).toEqual([]);
        expect(shape(foldFinishedWork([user(0), user(1000), tool(2000), said(3000)], false))).toEqual(['user', 'user', 'worked(1): Worked for 2s', 'assistant']);
    });

    it('treats a stream that starts without a message of the person\'s as one turn', () => {
        expect(shape(foldFinishedWork([tool(0), said(2000)], false))).toEqual(['worked(1): Worked for 2s', 'assistant']);
    });

    it('does not take a message still being written for the answer', () => {
        const writing = item({ kind: 'assistant', text: 'Half', done: false }, 3000);

        expect(shape(foldFinishedWork([user(0), tool(1000), writing], false))).toEqual(['user', 'tool', 'assistant']);
    });
});

/** The ids of the blocks marked as an answer. */
const answers = (blocks: StreamBlock[]) => blocks.flatMap(block => (block.kind === 'item' && block.answer ? [block.item.id] : []));

describe('foldFinishedWork answers', () => {
    it('marks the last written message of a finished turn, whether or not its work folds', () => {
        const folded = [user(0), tool(1000), said(2000, 'Looking.'), tool(3000), said(4000, 'All done.')];
        const bare = [user(5000), said(6000, 'Hello.')];

        expect(answers(foldFinishedWork([...folded, ...bare], false))).toEqual([folded[4].id, bare[1].id]);
    });

    it('marks the answer of every turn that is over, and none of the live one', () => {
        const items = [user(0), tool(1000), said(2000, 'First.'), user(3000), tool(4000), said(5000, 'Half way.')];

        expect(answers(foldFinishedWork(items, true))).toEqual([items[2].id]);
        expect(answers(foldFinishedWork(items, false))).toEqual([items[2].id, items[5].id]);
    });

    it('marks no answer for a turn that stopped without one, or while its message is still arriving', () => {
        const writing = item({ kind: 'assistant', text: 'Half', done: false }, 3000);

        expect(answers(foldFinishedWork([user(0), tool(1000), tool(2000)], false))).toEqual([]);
        expect(answers(foldFinishedWork([user(0), tool(1000), writing], false))).toEqual([]);
        expect(answers(foldFinishedWork([user(0), said(1000, '  ')], false))).toEqual([]);
    });

    it('marks the answer that precedes a trailing note, and never an item inside the fold', () => {
        const items = [user(0), said(1000, 'Looking.'), tool(2000), said(3000, 'Done.'), note(4000)];
        const blocks = foldFinishedWork(items, false);

        expect(answers(blocks)).toEqual([items[3].id]);
        expect(blocks.find(block => block.kind === 'worked')).toMatchObject({ items: [items[1], items[2]] });
    });
});

describe('hasMessageActions', () => {
    const block = (entry: StreamItem, answer?: true): StreamBlock => ({ kind: 'item', item: entry, ...(answer && { answer }) });

    it('is true for what the person wrote and for an answer', () => {
        expect(hasMessageActions(block(user(0)))).toBe(true);
        expect(hasMessageActions(block(said(1000), true))).toBe(true);
    });

    it('is false for what an agent or a thread wrote, and for the rest of a stream', () => {
        const fromThread = item({ kind: 'user', text: 'Done', from: { kind: 'thread', chatId: 'c-2', title: 'Fix login' } }, 0);
        const notice = item({ kind: 'user', text: 'Stopped', from: { kind: 'threadNotice', threads: [] } }, 0);

        expect(hasMessageActions(block(fromThread))).toBe(false);
        expect(hasMessageActions(block(notice))).toBe(false);
        expect(hasMessageActions(block(said(1000)))).toBe(false);
        expect(hasMessageActions(block(tool(1000)))).toBe(false);
        expect(hasMessageActions(block(note(1000)))).toBe(false);
        expect(hasMessageActions(block(failure(1000)))).toBe(false);
        expect(hasMessageActions({ kind: 'worked', key: 'w', label: 'Worked', items: [user(0)] })).toBe(false);
    });
});

describe('forkPointId', () => {
    /** Items with the numbers a fork keeps from its source: not one after the other. */
    const numbered = (...seqs: number[]): StreamItem[] => seqs.map(n => ({ id: `n-${ n }`, runId: 'r', seq: n, at: n, body: { kind: 'note', text: 'x' } }));

    it('is the item whose number is the fork point', () => {
        expect(forkPointId(numbered(1, 2, 3, 6, 7, 8), 6)).toBe('n-6');
        expect(forkPointId(numbered(1, 2, 3), 3)).toBe('n-3');
    });

    it('is the last item before the number when the stream skips it', () => {
        expect(forkPointId(numbered(1, 2, 3, 7, 8), 6)).toBe('n-3');
    });

    it('is nothing when the stream stops short of the number, or has nothing before it', () => {
        expect(forkPointId(numbered(1, 2, 3), 6)).toBeUndefined();
        expect(forkPointId(numbered(7, 8), 6)).toBeUndefined();
        expect(forkPointId([], 6)).toBeUndefined();
    });
});

describe('workedForLabel', () => {
    it('writes seconds, minutes and hours', () => {
        expect(workedForLabel(0, 400)).toBe('Worked for 1s');
        expect(workedForLabel(5, 5)).toBe('Worked for 1s');
        expect(workedForLabel(0, 59_000)).toBe('Worked for 59s');
        expect(workedForLabel(0, 120_000)).toBe('Worked for 2m');
        expect(workedForLabel(0, 3_725_000)).toBe('Worked for 1h 2m');
    });

    it('says only "Worked" when the times do not make a duration', () => {
        expect(workedForLabel(5, 1)).toBe('Worked');
        expect(workedForLabel(Number.NaN, 1)).toBe('Worked');
    });
});
