import { describe, expect, it } from 'vitest';

import { foldFinishedWork, workedForLabel, type StreamBlock } from './turns';

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
        expect(blocks[2]).toEqual({ kind: 'item', item: items[2] });
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
