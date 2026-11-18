import { reaction } from 'mobx';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createUndoStack, UNDO_LIMIT, undoStack, type UndoEntry } from './undo';

/** The scope the tests record in: a project. */
const SCOPE = 'p1';

/** An entry that records when it ran, and resolves to `outcome` once `release` is called (at once without a gate). */
function entry(label: string, ran: string[], outcome = true, gate?: Promise<void>, scope = SCOPE): UndoEntry {
    return {
        scope,
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

        expect(stack.canUndo(SCOPE)).toBe(false);
        expect(await stack.undoLatest(SCOPE)).toBe(false);
    });

    it('undoes the latest entry first, one entry per call, and says whether it worked', async () => {
        const stack = createUndoStack();
        const ran: string[] = [];

        stack.push(entry('a', ran));
        stack.push(entry('b', ran, false));

        expect(await stack.undoLatest(SCOPE)).toBe(false);
        expect(await stack.undoLatest(SCOPE)).toBe(true);
        expect(await stack.undoLatest(SCOPE)).toBe(false);
        expect(ran).toEqual(['start b', 'end b', 'start a', 'end a']);
    });

    it('takes an entry off the stack as soon as it is asked for, a failed one too', async () => {
        const stack = createUndoStack();

        stack.push(entry('a', [], false));

        const pending = stack.undoLatest(SCOPE);

        expect(stack.canUndo(SCOPE)).toBe(false);

        await pending;

        expect(stack.entries).toEqual([]);
    });

    it('never runs an entry twice, so a toast whose entry was undone by the key does nothing', async () => {
        const stack = createUndoStack();
        const ran: string[] = [];
        const a = entry('a', ran);

        stack.push(a);

        expect(await stack.undoLatest(SCOPE)).toBe(true);
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
        expect(await stack.undoLatest(SCOPE)).toBe(true);
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

        expect(stack.canUndo(SCOPE)).toBe(false);
        expect(await stack.undoLatest(SCOPE)).toBe(false);
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

        const first = stack.undoLatest(SCOPE);
        const second = stack.undoLatest(SCOPE);

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
            scope: SCOPE,
            label: 'broken',
            undo: async () => {
                throw new Error('boom');
            },
        });

        const results = await Promise.all([stack.undoLatest(SCOPE), stack.undoLatest(SCOPE)]);

        expect(results).toEqual([false, true]);
        expect(ran).toEqual(['start a', 'end a']);
        expect(error).toHaveBeenCalledTimes(1);
    });

    it('tells an observer when there starts to be something to undo and when there stops', async () => {
        const stack = createUndoStack();
        const seen: boolean[] = [];
        const stop = reaction(() => stack.canUndo(SCOPE), value => seen.push(value), { fireImmediately: true });

        stack.push(entry('a', []));
        stack.push(entry('b', []));
        await stack.undoLatest(SCOPE);
        await stack.undoLatest(SCOPE);
        stop();

        expect(seen).toEqual([false, true, false]);
    });

    it('keeps the history of each scope apart, so Cmd+Z never takes back another project\'s change', async () => {
        const stack = createUndoStack();
        const ran: string[] = [];

        stack.push(entry('in a', ran, true, undefined, 'a'));
        stack.push(entry('in b', ran, true, undefined, 'b'));
        stack.push(entry('later in a', ran, true, undefined, 'a'));

        expect(stack.canUndo('a')).toBe(true);
        expect(stack.canUndo('b')).toBe(true);
        expect(stack.canUndo('c')).toBe(false);
        expect(await stack.undoLatest('c')).toBe(false);
        expect(ran).toEqual([]);

        expect(await stack.undoLatest('b')).toBe(true);
        expect(ran).toEqual(['start in b', 'end in b']);
        expect(stack.canUndo('b')).toBe(false);
        expect(stack.canUndo('a')).toBe(true);

        expect(await stack.undoLatest('a')).toBe(true);
        expect(ran.slice(2)).toEqual(['start later in a', 'end later in a']);
    });

    it('caps each scope on its own, so a busy project does not push out another\'s history', () => {
        const stack = createUndoStack(2);
        const ran: string[] = [];

        stack.push(entry('b1', ran, true, undefined, 'b'));
        stack.push(entry('a1', ran, true, undefined, 'a'));
        stack.push(entry('a2', ran, true, undefined, 'a'));
        stack.push(entry('a3', ran, true, undefined, 'a'));

        expect(stack.entries.map(item => item.label)).toEqual(['b1', 'a2', 'a3']);
    });

    it('tells a reaction when the scope it asked about gains or loses an entry, and only then', async () => {
        const stack = createUndoStack();
        const seen: boolean[] = [];
        const stop = reaction(() => stack.canUndo('a'), value => seen.push(value), { fireImmediately: true });

        stack.push(entry('in b', [], true, undefined, 'b'));
        stack.push(entry('in a', [], true, undefined, 'a'));
        await stack.undoLatest('a');
        stop();

        expect(seen).toEqual([false, true, false]);
    });
});

describe('undoStack', () => {
    it('is one stack for the window that an isolated stack does not touch', async () => {
        const isolated = createUndoStack();
        const ran: string[] = [];

        isolated.push(entry('isolated', ran));

        expect(undoStack.canUndo(SCOPE)).toBe(false);

        undoStack.push(entry('window', ran));

        expect(isolated.entries.map(item => item.label)).toEqual(['isolated']);
        expect(await undoStack.undoLatest(SCOPE)).toBe(true);
        expect(ran).toEqual(['start window', 'end window']);
        expect(undoStack.canUndo(SCOPE)).toBe(false);
    });
});
