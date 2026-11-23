import { describe, expect, it } from 'vitest';

import { type RevealTasks, revealTask } from './taskReveal';

/**
 * 1
 * ├─ 2
 * │  └─ 3
 * │     └─ 4
 * └─ 5
 * 6 (a root)
 * 7 (inside 99, which the project does not hold: it stands as a root)
 * 8 (archived)
 */
const TASKS: RevealTasks = new Map([
    ['t1', { id: 't1' }],
    ['t2', { id: 't2', parentId: 't1' }],
    ['t3', { id: 't3', parentId: 't2' }],
    ['t4', { id: 't4', parentId: 't3' }],
    ['t5', { id: 't5', parentId: 't1' }],
    ['t6', { id: 't6' }],
    ['t7', { id: 't7', parentId: 't99' }],
    ['t8', { id: 't8', archivedAt: 5 }],
]);

const reveal = (scope: string | null, taskId: string, oneLevel = false) =>
    revealTask(TASKS, scope, taskId, { oneLevel });

describe('revealTask', () => {
    describe('a task inside the scope', () => {
        it('keeps the scope', () => {
            expect(reveal('t1', 't2')).toEqual({ scope: 't1', unfold: [] });
            expect(reveal('t1', 't5')).toEqual({ scope: 't1', unfold: [] });
        });

        it('keeps the roots for any task, and asks for the folds above a task that is not at the top', () => {
            expect(reveal(null, 't6')).toEqual({ scope: null, unfold: [] });
            expect(reveal(null, 't1')).toEqual({ scope: null, unfold: [] });
            expect(reveal(null, 't4')).toEqual({ scope: null, unfold: ['t3', 't2', 't1'] });
        });

        it('asks for the folds between the scope and the task, the nearest first, and not the scope itself', () => {
            expect(reveal('t1', 't4')).toEqual({ scope: 't1', unfold: ['t3', 't2'] });
            expect(reveal('t2', 't4')).toEqual({ scope: 't2', unfold: ['t3'] });
        });

        it('keeps the scope for the scope task itself, whose own header is on the screen', () => {
            expect(reveal('t2', 't2')).toEqual({ scope: 't2', unfold: [] });
        });

        it('moves the scope to the parent for a task below the first level of a board of one level, which draws no card for it', () => {
            expect(reveal('t1', 't4', true)).toEqual({ scope: 't3', unfold: [] });
            expect(reveal(null, 't4', true)).toEqual({ scope: 't3', unfold: [] });
            // At the first level it is a card: nothing moves.
            expect(reveal('t1', 't2', true)).toEqual({ scope: 't1', unfold: [] });
            expect(reveal(null, 't6', true)).toEqual({ scope: null, unfold: [] });
        });
    });

    describe('a task outside the scope', () => {
        it('moves the scope to its parent, where it is a task of the first level in every view', () => {
            expect(reveal('t1', 't6')).toEqual({ scope: null, unfold: [] });
            expect(reveal('t5', 't3')).toEqual({ scope: 't2', unfold: [] });
            expect(reveal('t2', 't5')).toEqual({ scope: 't1', unfold: [] });
            expect(reveal('t3', 't1')).toEqual({ scope: null, unfold: [] });
        });

        it('moves to the roots for a task with no parent, and for one whose parent the project does not hold', () => {
            expect(reveal('t1', 't7')).toEqual({ scope: null, unfold: [] });
        });

        it('treats the scope that is a descendant of the task as outside: the task is above it', () => {
            expect(reveal('t4', 't2')).toEqual({ scope: 't1', unfold: [] });
        });
    });

    describe('a task that was just made, which the project may not hold yet', () => {
        const made = (scope: string | null, madeIn: string | null | undefined, oneLevel = false) =>
            revealTask(TASKS, scope, 'new', { oneLevel, madeIn });

        it('is revealed as the task it will be: inside the scope the scope stays, outside it the scope moves to the task it is inside', () => {
            expect(made('t1', 't1')).toEqual({ scope: 't1', unfold: [] });
            expect(made(null, null)).toEqual({ scope: null, unfold: [] });
            expect(made('t1', null)).toEqual({ scope: null, unfold: [] });
            expect(made('t5', 't2')).toEqual({ scope: 't2', unfold: [] });
        });

        it('asks for the folds above it in a view of every level, and moves the scope to its parent on a board of one level', () => {
            expect(made('t1', 't3')).toEqual({ scope: 't1', unfold: ['t3', 't2'] });
            expect(made('t1', 't3', true)).toEqual({ scope: 't3', unfold: [] });
        });

        it('stands as a root when the task it is made inside is not held', () => {
            expect(made('t1', 't99')).toEqual({ scope: null, unfold: [] });
        });

        it('changes nothing without `madeIn`, as for any task the project does not hold', () => {
            expect(made('t1', undefined)).toBeUndefined();
        });

        it('reads a task the project holds as it is, whatever `madeIn` says', () => {
            expect(revealTask(TASKS, 't1', 't2', { oneLevel: false, madeIn: 't6' })).toEqual({
                scope: 't1',
                unfold: [],
            });
        });
    });

    it('changes nothing for a task the project does not hold or that is archived', () => {
        expect(reveal('t1', 't8')).toBeUndefined();
        expect(reveal('t1', 'gone')).toBeUndefined();
    });

    it('ends a walk through a cycle in the data', () => {
        const loop: RevealTasks = new Map([
            ['a', { id: 'a', parentId: 'b' }],
            ['b', { id: 'b', parentId: 'a' }],
        ]);

        expect(revealTask(loop, null, 'a', { oneLevel: false })).toEqual({ scope: null, unfold: ['b'] });
    });
});
