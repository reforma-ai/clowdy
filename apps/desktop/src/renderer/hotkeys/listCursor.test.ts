import { autorun } from 'mobx';
import { describe, expect, it } from 'vitest';

import { type Grid, ListCursor, rangeBetween, sameGrid, stepTo, survivingCursor } from './listCursor';

const list: Grid = [['a', 'b', 'c', 'd']];
const board: Grid = [['a1', 'a2', 'a3'], ['b1'], [], ['c1', 'c2']];

describe('stepTo', () => {
    it('moves up and down inside the column and stops at the ends', () => {
        expect(stepTo(list, 'b', 'down')).toBe('c');
        expect(stepTo(list, 'b', 'up')).toBe('a');
        expect(stepTo(list, 'd', 'down')).toBe('d');
        expect(stepTo(list, 'a', 'up')).toBe('a');
    });

    it('jumps to the ends of the column with first and last', () => {
        expect(stepTo(list, 'b', 'first')).toBe('a');
        expect(stepTo(list, 'b', 'last')).toBe('d');
        expect(stepTo(board, 'c2', 'first')).toBe('c1');
        expect(stepTo(board, 'a1', 'last')).toBe('a3');
    });

    it('keeps the row index across columns, clamped to the target column', () => {
        expect(stepTo(board, 'a2', 'right')).toBe('b1');
        expect(stepTo(board, 'a1', 'right')).toBe('b1');
        expect(stepTo(board, 'c2', 'left')).toBe('b1');
        expect(stepTo(board, 'c1', 'left')).toBe('b1');
    });

    it('skips empty columns and stays put when there is no column that way', () => {
        expect(stepTo(board, 'b1', 'right')).toBe('c1');
        expect(stepTo(board, 'c1', 'left')).toBe('b1');
        expect(stepTo(board, 'a1', 'left')).toBe('a1');
        expect(stepTo(board, 'c2', 'right')).toBe('c2');
    });

    it('does nothing sideways on a single column', () => {
        expect(stepTo(list, 'b', 'left')).toBe('b');
        expect(stepTo(list, 'b', 'right')).toBe('b');
    });

    it('lands on an end when there is no cursor yet, and on null in an empty grid', () => {
        expect(stepTo(list, null, 'down')).toBe('a');
        expect(stepTo(list, null, 'up')).toBe('d');
        expect(stepTo(list, 'gone', 'last')).toBe('d');
        expect(stepTo([[], []], 'a', 'down')).toBeNull();
        expect(stepTo([], null, 'down')).toBeNull();
    });
});

describe('rangeBetween', () => {
    it('runs in reading order whichever end comes first', () => {
        expect(rangeBetween(list, 'b', 'd')).toEqual(['b', 'c', 'd']);
        expect(rangeBetween(list, 'd', 'b')).toEqual(['b', 'c', 'd']);
        expect(rangeBetween(list, 'c', 'c')).toEqual(['c']);
    });

    it('goes column by column on a board', () => {
        expect(rangeBetween(board, 'a3', 'c1')).toEqual(['a3', 'b1', 'c1']);
    });

    it('is empty when an end is not in the grid', () => {
        expect(rangeBetween(list, 'a', 'zzz')).toEqual([]);
    });
});

describe('survivingCursor', () => {
    it('keeps a cursor that is still there, even in another column', () => {
        expect(survivingCursor(board, [['a1'], ['a2', 'b1']], 'a2')).toBe('a2');
    });

    it('moves to the neighbour below, else above, in the same column', () => {
        expect(survivingCursor(list, [['a', 'c', 'd']], 'b')).toBe('c');
        expect(survivingCursor(list, [['a', 'b']], 'c')).toBe('b');
        expect(survivingCursor(list, [['a', 'b', 'd']], 'c')).toBe('d');
    });

    it('takes the nearest one when the neighbours went too', () => {
        expect(survivingCursor(list, [['a', 'd']], 'b')).toBe('a');
        expect(survivingCursor(list, [['a', 'd']], 'c')).toBe('d');
    });

    it('leaves the column when none of it survives, and falls back to the first id', () => {
        expect(survivingCursor(board, [['b1', 'c1']], 'a2')).toBe('b1');
        expect(survivingCursor(board, [['x']], 'a2')).toBe('x');
        expect(survivingCursor(board, [[]], 'a2')).toBeNull();
        expect(survivingCursor(board, board, null)).toBeNull();
    });
});

describe('ListCursor', () => {
    const cursorOn = (columns: Grid, id: string) => {
        const cursor = new ListCursor();

        cursor.setGrid(columns);
        cursor.setCursor(id);

        return cursor;
    };

    describe('setGrid', () => {
        it('starts on the preferred id, else the first, and stays null in an empty grid', () => {
            const preferred = new ListCursor();
            const first = new ListCursor();
            const empty = new ListCursor();

            preferred.setGrid(list, 'c');
            first.setGrid(list, 'nope');
            empty.setGrid([[]]);

            expect(preferred.cursorId).toBe('c');
            expect(first.cursorId).toBe('a');
            expect(empty.cursorId).toBeNull();
        });

        it('does not move a cursor that exists, whatever is preferred', () => {
            const cursor = cursorOn(list, 'b');

            cursor.setGrid(list, 'd');

            expect(cursor.cursorId).toBe('b');
        });

        it('moves a vanished cursor to its nearest neighbour and prunes the selection', () => {
            const cursor = cursorOn(list, 'b');

            cursor.toggle('a');
            cursor.toggle('b');
            cursor.setGrid([['a', 'c', 'd']]);

            expect(cursor.cursorId).toBe('c');
            expect([...cursor.selected]).toEqual(['a']);
        });

        it('repairs an anchor that left by moving it to the cursor', () => {
            const cursor = cursorOn(list, 'b');

            cursor.toggle('b');
            cursor.setGrid([['a', 'c']]);

            expect(cursor.anchorId).toBe('c');
            expect(cursor.selected.size).toBe(0);
        });

        it('keeps the rest of a range selected when its anchor left and the range is extended', () => {
            const cursor = cursorOn(list, 'a');

            cursor.toggle();
            cursor.extend('down');
            cursor.extend('down');
            cursor.setGrid([['b', 'c', 'd']]);

            expect([...cursor.selected]).toEqual(['b', 'c']);

            cursor.extend('down');

            expect([...cursor.selected].sort()).toEqual(['b', 'c', 'd']);
        });

        it('starts again on the first id after the grid was empty', () => {
            const cursor = cursorOn(list, 'b');

            cursor.setGrid([[]]);

            expect(cursor.cursorId).toBeNull();

            cursor.setGrid(list);

            expect(cursor.cursorId).toBe('a');
        });

        it('keeps the observable state when the grid has not changed', () => {
            const cursor = cursorOn(list, 'b');
            const seen: Grid[] = [];
            const stop = autorun(() => seen.push(cursor.columns));

            cursor.setGrid([['a', 'b', 'c', 'd']]);
            stop();

            expect(seen).toHaveLength(1);
            expect(sameGrid(cursor.columns, list)).toBe(true);
        });
    });

    describe('move', () => {
        it('moves the cursor and leaves the selection alone', () => {
            const cursor = cursorOn(list, 'a');

            cursor.toggle();
            cursor.move('down');
            cursor.move('down');

            expect(cursor.cursorId).toBe('c');
            expect([...cursor.selected]).toEqual(['a']);
        });

        it('crosses columns on a board', () => {
            const cursor = cursorOn(board, 'a2');

            cursor.move('right');
            cursor.move('right');

            expect(cursor.cursorId).toBe('c1');
        });

        it('starts a new range after moving with nothing selected', () => {
            const cursor = cursorOn(list, 'a');

            cursor.toggle();
            cursor.toggle();
            cursor.move('down');
            cursor.move('down');
            cursor.extend('down');

            expect([...cursor.selected]).toEqual(['c', 'd']);
        });
    });

    describe('toggle', () => {
        it('adds and removes the cursor item and sets the anchor', () => {
            const cursor = cursorOn(list, 'b');

            cursor.toggle();

            expect([...cursor.selected]).toEqual(['b']);
            expect(cursor.anchorId).toBe('b');

            cursor.toggle();

            expect(cursor.selected.size).toBe(0);
        });

        it('takes an id for a pointer, moves the cursor there and ignores ids that are not in the grid', () => {
            const cursor = cursorOn(list, 'a');

            cursor.toggle('c');
            cursor.toggle('zzz');

            expect([...cursor.selected]).toEqual(['c']);
            expect(cursor.cursorId).toBe('c');
        });
    });

    describe('extend', () => {
        it('selects the range from the anchor, and shrinks it when the cursor comes back', () => {
            const cursor = cursorOn(list, 'a');

            cursor.toggle();
            cursor.extend('down');
            cursor.extend('down');

            expect([...cursor.selected]).toEqual(['a', 'b', 'c']);
            expect(cursor.cursorId).toBe('c');

            cursor.extend('up');

            expect([...cursor.selected]).toEqual(['a', 'b']);
        });

        it('starts the range at the cursor when nothing was toggled', () => {
            const cursor = cursorOn(list, 'b');

            cursor.extend('down');

            expect([...cursor.selected]).toEqual(['b', 'c']);
            expect(cursor.anchorId).toBe('b');
        });

        it('extends upwards from the anchor', () => {
            const cursor = cursorOn(list, 'c');

            cursor.toggle();
            cursor.extend('up');
            cursor.extend('up');

            expect([...cursor.selected].sort()).toEqual(['a', 'b', 'c']);
        });

        it('drops what the range no longer covers when the cursor crosses back over the anchor', () => {
            const cursor = cursorOn(list, 'b');

            cursor.toggle();
            cursor.extend('down');
            cursor.extend('down');

            expect([...cursor.selected].sort()).toEqual(['b', 'c', 'd']);

            cursor.extend('up');
            cursor.extend('up');
            cursor.extend('up');

            expect([...cursor.selected].sort()).toEqual(['a', 'b']);
            expect(cursor.cursorId).toBe('a');
        });

        it('keeps what was picked one by one outside the range', () => {
            const cursor = cursorOn(list, 'a');

            cursor.toggle();
            cursor.move('down');
            cursor.move('down');
            cursor.toggle();
            cursor.extend('down');

            expect([...cursor.selected].sort()).toEqual(['a', 'c', 'd']);

            cursor.extend('up');

            expect([...cursor.selected].sort()).toEqual(['a', 'c']);
        });

        it('stays put at the end of the list but still selects the item', () => {
            const cursor = cursorOn(list, 'd');

            cursor.extend('down');

            expect([...cursor.selected]).toEqual(['d']);
            expect(cursor.cursorId).toBe('d');
        });

        it('ranges from the item a click anchored, even though the pointer moved the cursor to the next click first', () => {
            const cursor = cursorOn(list, 'a');

            cursor.anchorAt('b');
            cursor.setCursor('d');
            cursor.extendTo('d');

            expect([...cursor.selected]).toEqual(['b', 'c', 'd']);
        });

        it('keeps the selection when a click anchors, and ranges on top of it', () => {
            const cursor = cursorOn(board, 'a1');

            cursor.toggle('c1');
            cursor.anchorAt('a2');
            cursor.extendTo('a3');

            expect([...cursor.selected].sort()).toEqual(['a2', 'a3', 'c1']);
            expect(cursor.cursorId).toBe('a3');
        });

        it('ignores an anchor id that is not in the grid', () => {
            const cursor = cursorOn(list, 'b');

            cursor.anchorAt('zzz');
            cursor.extendTo('c');

            expect([...cursor.selected]).toEqual(['b', 'c']);
        });

        it('extends to an id for Shift-click, from the cursor when there is no anchor', () => {
            const cursor = cursorOn(list, 'a');

            cursor.extendTo('c');

            expect([...cursor.selected]).toEqual(['a', 'b', 'c']);
            expect(cursor.cursorId).toBe('c');

            cursor.extendTo('zzz');

            expect(cursor.selected.size).toBe(3);
        });
    });

    describe('selectAll and clearSelection', () => {
        it('selects every id and clears again, with the range reset', () => {
            const cursor = cursorOn(board, 'a1');

            cursor.selectAll();

            expect(cursor.selected.size).toBe(6);

            cursor.clearSelection();

            expect(cursor.selected.size).toBe(0);
            expect(cursor.anchorId).toBeNull();
            expect(cursor.cursorId).toBe('a1');
        });
    });

    describe('selectAll under a filter', () => {
        it('takes only the visible ids, and a later wider grid does not add the rest', () => {
            const cursor = cursorOn(list, 'b');

            cursor.setGrid([['b', 'd']]);
            cursor.selectAll();

            expect(cursor.targets()).toEqual(['b', 'd']);

            cursor.setGrid(list);

            expect(cursor.targets()).toEqual(['b', 'd']);
        });
    });

    describe('targets', () => {
        it('is the selection in reading order, else the cursor item, else nothing', () => {
            const cursor = new ListCursor();

            expect(cursor.targets()).toEqual([]);

            cursor.setGrid(list);
            cursor.setCursor('b');

            expect(cursor.targets()).toEqual(['b']);

            cursor.toggle('d');
            cursor.toggle('a');

            expect(cursor.targets()).toEqual(['a', 'd']);
        });
    });

    it('ignores a cursor id that is not in the grid', () => {
        const cursor = cursorOn(list, 'b');

        cursor.setCursor('zzz');

        expect(cursor.cursorId).toBe('b');
    });

    it('is observable', () => {
        const cursor = cursorOn(list, 'a');
        const seen: (string | null)[] = [];
        const stop = autorun(() => seen.push(cursor.cursorId));

        cursor.move('down');
        stop();

        expect(seen).toEqual(['a', 'b']);
    });
});
