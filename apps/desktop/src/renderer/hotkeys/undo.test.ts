import { autorun } from 'mobx';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createUndoStack, UNDO_LIMIT, undoStack, type UndoEntry } from './undo';

/** An entry that records when it ran, and resolves to `outcome` once `release` is called (at once without a gate). */
function entry(label: string, ran: string[], outcome = true, gate?: Promise<void>): UndoEntry {
    return {
        label,
        undo: async () => {
            ran.push(`start ${ label }`);
            await gate;
            ran.push(`end ${ label }`);

            return outcome;
        },
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('UndoStack', () => {
    it('starts empty, and has nothing to undo', async () => {
        const stack = createUndoStack();

        expect(stack.canUndo).toBe(false);
        expect(await stack.undoLatest()).toBe(false);
    });

    it('undoes the latest entry first, one entry per call, and says whether it worked', async () => {
        const stack = createUndoStack();
        const ran: string[] = [];

        stack.push(entry('a', ran));
        stack.push(entry('b', ran, false));

        expect(await stack.undoLatest()).toBe(false);
        expect(await stack.undoLatest()).toBe(true);
        expect(await stack.undoLatest()).toBe(false);
        expect(ran).toEqual(['start b', 'end b', 'start a', 'end a']);
    });

    it('takes an entry off the stack as soon as it is asked for, a failed one too', async () => {
        const stack = createUndoStack();

        stack.push(entry('a', [], false));

        const pending = stack.undoLatest();

        expect(stack.canUndo).toBe(false);

        await pending;

        expect(stack.entries).toEqual([]);
    });

    it('never runs an entry twice, so a toast whose entry was undone by the key does nothing', async () => {
        const stack = createUndoStack();
        const ran: string[] = [];
        const a = entry('a', ran);

        stack.push(a);

        expect(await stack.undoLatest()).toBe(true);
        expect(await stack.undoEntry(a)).toBe(false);
        expect(ran).toEqual(['start a', 'end a']);
    });

    it('undoes a chosen entry and leaves the others in order', async () => {
        const stack = createUndoStack();
        const ran: string[] = [];
        const [a, b, c] = ['a', 'b', 'c'].map(label => entry(label, ran));

        [a, b, c].forEach(item => stack.push(item));

        expect(await stack.undoEntry(b)).toBe(true);
        expect(stack.entries).toEqual([a, c]);
        expect(await stack.undoLatest()).toBe(true);
        expect(ran).toEqual(['start b', 'end b', 'start c', 'end c']);
    });

    it('keeps the latest 50 entries and forgets the oldest', async () => {
        const stack = createUndoStack();

        expect(UNDO_LIMIT).toBe(50);

        for (let index = 0; index < UNDO_LIMIT + 5; index++) stack.push(entry(`e${ index }`, []));

        expect(stack.entries).toHaveLength(UNDO_LIMIT);
        expect(stack.entries[0].label).toBe('e5');
        expect(stack.entries.at(-1)?.label).toBe(`e${ UNDO_LIMIT + 4 }`);
    });

    it('takes its own limit, for a part of the app with a shorter history', () => {
        const stack = createUndoStack(2);

        ['a', 'b', 'c'].forEach(label => stack.push(entry(label, [])));

        expect(stack.entries.map(item => item.label)).toEqual(['b', 'c']);
    });

    it('forgets everything on clear', async () => {
        const stack = createUndoStack();

        stack.push(entry('a', []));
        stack.push(entry('b', []));
        stack.clear();

        expect(stack.canUndo).toBe(false);
        expect(await stack.undoLatest()).toBe(false);
    });

    it('lets one undo finish before the next starts, so two quick presses do not interleave', async () => {
        const stack = createUndoStack();
        const ran: string[] = [];
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        stack.push(entry('a', ran));
        stack.push(entry('b', ran, true, gate));

        const first = stack.undoLatest();
        const second = stack.undoLatest();

        await Promise.resolve();
        await Promise.resolve();

        expect(ran).toEqual(['start b']);

        release();

        expect(await Promise.all([first, second])).toEqual([true, true]);
        expect(ran).toEqual(['start b', 'end b', 'start a', 'end a']);
    });

    it('resolves to false for an entry that throws, and still runs the ones behind it', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const stack = createUndoStack();
        const ran: string[] = [];

        stack.push(entry('a', ran));
        stack.push({
            label: 'broken',
            undo: async () => {
                throw new Error('boom');
            },
        });

        const results = await Promise.all([stack.undoLatest(), stack.undoLatest()]);

        expect(results).toEqual([false, true]);
        expect(ran).toEqual(['start a', 'end a']);
        expect(error).toHaveBeenCalledTimes(1);
    });

    it('tells an observer when there starts to be something to undo and when there stops', async () => {
        const stack = createUndoStack();
        const seen: boolean[] = [];
        const stop = autorun(() => seen.push(stack.canUndo));

        stack.push(entry('a', []));
        stack.push(entry('b', []));
        await stack.undoLatest();
        await stack.undoLatest();
        stop();

        expect(seen).toEqual([false, true, false]);
    });
});

describe('undoStack', () => {
    it('is one stack for the window that an isolated stack does not touch', async () => {
        const isolated = createUndoStack();
        const ran: string[] = [];

        isolated.push(entry('isolated', ran));

        expect(undoStack.canUndo).toBe(false);

        undoStack.push(entry('window', ran));

        expect(isolated.entries.map(item => item.label)).toEqual(['isolated']);
        expect(await undoStack.undoLatest()).toBe(true);
        expect(ran).toEqual(['start window', 'end window']);
        expect(undoStack.canUndo).toBe(false);
    });
});
