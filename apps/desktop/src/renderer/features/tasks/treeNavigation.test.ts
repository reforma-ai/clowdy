import { describe, expect, it } from 'vitest';

import { treeMove } from './treeNavigation';

import type { Task } from '@clowdy/protocol';
import type { TreeRow } from './taskTree';

/** A row of a task with only an id: the move reads the id, the depth, and whether the row has tasks inside it and is folded. */
const row = (id: string, depth: number, { hasChildren = false, collapsed = false } = {}): TreeRow => ({
    task: { id } as Task,
    depth,
    hasChildren,
    collapsed,
});

/**
 * a (open)
 *   b (open)
 *     c
 *   d
 * e (folded)
 * f
 */
const ROWS = [
    row('a', 0, { hasChildren: true }),
    row('b', 1, { hasChildren: true }),
    row('c', 2),
    row('d', 1),
    row('e', 0, { hasChildren: true, collapsed: true }),
    row('f', 0),
];

describe('treeMove', () => {
    describe('Right', () => {
        it('opens a folded row', () => {
            expect(treeMove(ROWS, 'e', 'right')).toEqual({ kind: 'unfold', taskId: 'e' });
        });

        it('goes to the first task inside an open row', () => {
            expect(treeMove(ROWS, 'a', 'right')).toEqual({ kind: 'move', taskId: 'b' });
            expect(treeMove(ROWS, 'b', 'right')).toEqual({ kind: 'move', taskId: 'c' });
        });

        it('has nothing to do on a row with nothing inside it', () => {
            expect(treeMove(ROWS, 'c', 'right')).toBeUndefined();
            expect(treeMove(ROWS, 'f', 'right')).toBeUndefined();
        });

        it('has nothing to do when the row after an open row is not inside it, which a stale row list can show', () => {
            expect(treeMove([row('a', 0, { hasChildren: true }), row('b', 0)], 'a', 'right')).toBeUndefined();
        });
    });

    describe('Left', () => {
        it('folds an open row', () => {
            expect(treeMove(ROWS, 'a', 'left')).toEqual({ kind: 'fold', taskId: 'a' });
            expect(treeMove(ROWS, 'b', 'left')).toEqual({ kind: 'fold', taskId: 'b' });
        });

        it('goes to the parent row from a row with nothing inside it', () => {
            expect(treeMove(ROWS, 'c', 'left')).toEqual({ kind: 'move', taskId: 'b' });
            expect(treeMove(ROWS, 'd', 'left')).toEqual({ kind: 'move', taskId: 'a' });
        });

        it('goes to the parent row from a folded row, since it has nothing to fold', () => {
            const rows = [
                row('a', 0, { hasChildren: true }),
                row('b', 1, { hasChildren: true, collapsed: true }),
                row('c', 1),
            ];

            expect(treeMove(rows, 'b', 'left')).toEqual({ kind: 'move', taskId: 'a' });
        });

        it('has nothing to do on a row at the top that cannot fold', () => {
            expect(treeMove(ROWS, 'f', 'left')).toBeUndefined();
            expect(treeMove(ROWS, 'e', 'left')).toBeUndefined();
        });
    });

    it('has nothing to do for a row that is not drawn, or without a cursor', () => {
        expect(treeMove(ROWS, 'gone', 'right')).toBeUndefined();
        expect(treeMove(ROWS, null, 'left')).toBeUndefined();
        expect(treeMove([], 'a', 'left')).toBeUndefined();
    });
});
