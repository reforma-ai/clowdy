import { describe, expect, it } from 'vitest';

import { createFixtureData, DEFAULT_STATUSES, FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { scopeContent, taskNotes, tasksMode } from './scopeView';
import { keepAmong, TaskTree } from './taskTree';
import { filterTasks, NO_FILTER } from './taskView';

import type { Task } from '@clowdy/protocol';

/** The demo project's tasks on the board (CAR-38 to CAR-40 are archived, so the snapshot leaves them out): CAR-20 to CAR-30 and the tree of Payments. */
const tasks = createFixtureData().tasks.filter(task => task.projectId === FIXTURE_PROJECT_ID && task.archivedAt === undefined);
const tree = new TaskTree(tasks, DEFAULT_STATUSES);
const keys = (list: readonly Task[]) => list.map(task => task.key);

describe('tasksMode', () => {
    it('is the board of one level, the through board with the sub-tasks shown, and always the tree for the list', () => {
        expect(tasksMode('board', false)).toBe('board');
        expect(tasksMode('board', true)).toBe('through');
        expect(tasksMode('list', false)).toBe('tree');
        expect(tasksMode('list', true)).toBe('tree');
    });
});

describe('scopeContent', () => {
    describe('the board of one level', () => {
        it('draws the roots at the project\'s root, a card once, in a column by status, with no group for tasks that have no parent', () => {
            const content = scopeContent(tree, DEFAULT_STATUSES, null, 'board');

            expect(keys(content.tasks)).toEqual(['CAR-28', 'CAR-30', 'CAR-26', 'CAR-27', 'CAR-24', 'CAR-25', 'CAR-31', 'CAR-23', 'CAR-20', 'CAR-21', 'CAR-22', 'CAR-29']);
            expect(content.columns.map(column => [column.status.id, keys(column.tasks)])).toEqual([
                ['backlog', ['CAR-28', 'CAR-30']],
                ['todo', ['CAR-26', 'CAR-27']],
                ['active', ['CAR-24', 'CAR-25', 'CAR-31']],
                ['review', ['CAR-23']],
                ['done', ['CAR-20', 'CAR-21', 'CAR-22']],
                ['canceled', ['CAR-29']],
            ]);
            expect(content.rows).toEqual([]);
            expect(content.total).toBe(12);
        });

        it('draws the tasks directly inside a task, and not what is inside them', () => {
            const content = scopeContent(tree, DEFAULT_STATUSES, 't-31', 'board');

            expect(keys(content.tasks)).toEqual(['CAR-35', 'CAR-32', 'CAR-36', 'CAR-37']);
            expect(content.total).toBe(4);
        });

        it('walks the columns for the cursor: what is drawn, a column after another', () => {
            const content = scopeContent(tree, DEFAULT_STATUSES, 't-31', 'board');

            expect(content.grid).toEqual([[], ['t-35'], ['t-32'], ['t-36'], [], ['t-37']]);
        });
    });

    describe('the through board', () => {
        it('flattens every task below the scope onto it, whatever its depth, in a column by status', () => {
            const content = scopeContent(tree, DEFAULT_STATUSES, 't-31', 'through');

            expect(keys(content.tasks)).toEqual(['CAR-34', 'CAR-35', 'CAR-32', 'CAR-36', 'CAR-33', 'CAR-37']);
            expect(content.columns.map(column => [column.status.id, keys(column.tasks)])).toEqual([
                ['backlog', []],
                ['todo', ['CAR-34', 'CAR-35']],
                ['active', ['CAR-32']],
                ['review', ['CAR-36']],
                ['done', ['CAR-33']],
                ['canceled', ['CAR-37']],
            ]);
            expect(content.total).toBe(6);
        });

        it('draws every task of the project at the root', () => {
            const content = scopeContent(tree, DEFAULT_STATUSES, null, 'through');

            expect(content.tasks).toHaveLength(tasks.length);
            expect(content.total).toBe(tasks.length);
        });
    });

    describe('the tree', () => {
        it('draws the tasks below the scope under their parents, each level in workflow order, and the cursor walks them top to bottom as one column', () => {
            const content = scopeContent(tree, DEFAULT_STATUSES, 't-31', 'tree');

            expect(content.rows.map(row => [row.task.key, row.depth])).toEqual([['CAR-35', 0], ['CAR-32', 0], ['CAR-34', 1], ['CAR-33', 1], ['CAR-36', 0], ['CAR-37', 0]]);
            expect(keys(content.tasks)).toEqual(content.rows.map(row => row.task.key));
            expect(content.grid).toEqual([['t-35', 't-32', 't-34', 't-33', 't-36', 't-37']]);
            expect(content.columns).toEqual([]);
            expect(content.total).toBe(6);
        });

        it('skips what is inside a folded task, for the drawing and for the cursor', () => {
            const content = scopeContent(tree, DEFAULT_STATUSES, 't-31', 'tree', { collapsed: ['t-32'] });

            expect(content.rows.map(row => row.task.key)).toEqual(['CAR-35', 'CAR-32', 'CAR-36', 'CAR-37']);
            expect(content.rows.find(row => row.task.key === 'CAR-32')).toMatchObject({ hasChildren: true, collapsed: true });
            expect(content.grid).toEqual([['t-35', 't-32', 't-36', 't-37']]);
            // The tasks inside are still there for the empty state's sake.
            expect(content.total).toBe(6);
        });
    });

    describe('with a filter', () => {
        const keepMatching = (query: string) => keepAmong(filterTasks(tasks, { ...NO_FILTER, query }, new Map()));

        it('finds a match inside a task from the roots, in every mode, whatever the parents are', () => {
            const keep = keepMatching('tokenize');

            expect(keys(scopeContent(tree, DEFAULT_STATUSES, null, 'board', { keep }).tasks)).toEqual(['CAR-33']);
            expect(keys(scopeContent(tree, DEFAULT_STATUSES, null, 'through', { keep }).tasks)).toEqual(['CAR-33']);
            expect(scopeContent(tree, DEFAULT_STATUSES, null, 'tree', { keep }).rows.map(row => [row.task.key, row.depth])).toEqual([['CAR-33', 0]]);
        });

        it('keeps a match under its parent when the parent matches too', () => {
            const keep = keepMatching('card');

            // "Card checkout" matches and so does "Tokenize the card in the browser", "Handle a declined card" and "Split a payment between two cards".
            const rows = scopeContent(tree, DEFAULT_STATUSES, 't-31', 'tree', { keep }).rows;

            expect(rows.map(row => [row.task.key, row.depth])).toEqual([['CAR-32', 0], ['CAR-34', 1], ['CAR-33', 1], ['CAR-37', 0]]);
        });

        it('says how many tasks the mode could draw before the filter, so an empty view can tell a hidden one from an empty one', () => {
            const content = scopeContent(tree, DEFAULT_STATUSES, 't-31', 'board', { keep: keepMatching('no such task') });

            expect(content.tasks).toEqual([]);
            expect(content.total).toBe(4);
        });
    });

    it('has nothing for a task with nothing inside it, in any mode', () => {
        for (const mode of ['board', 'through', 'tree'] as const) {
            const content = scopeContent(tree, DEFAULT_STATUSES, 't-28', mode);

            expect([content.total, content.tasks, content.grid.flat()]).toEqual([0, [], []]);
        }
    });
});

describe('taskNotes', () => {
    const task = (id: string) => tasks.find(candidate => candidate.id === id)!;

    it('gives the work inside a task over every level, with the canceled left out, and the checklist of its description', () => {
        expect(taskNotes(tree, task('t-31'), { scope: null, withParent: true }).rollUp).toEqual({ done: 1, total: 5 });
        expect(taskNotes(tree, task('t-32'), { scope: null, withParent: true }).rollUp).toEqual({ done: 1, total: 2 });
        expect(taskNotes(tree, task('t-35'), { scope: null, withParent: true }).checklist).toEqual({ done: 2, total: 5 });
    });

    it('gives neither for a task that has no tasks inside it and no checklist', () => {
        expect(taskNotes(tree, task('t-28'), { scope: null, withParent: true })).toEqual({ rollUp: undefined, checklist: undefined, parentKey: undefined });
    });

    it('names the parent for a card on a board, unless the parent is the scope, which the screen\'s header shows', () => {
        expect(taskNotes(tree, task('t-33'), { scope: 't-31', withParent: true }).parentKey).toBe('CAR-32');
        expect(taskNotes(tree, task('t-32'), { scope: 't-31', withParent: true }).parentKey).toBeUndefined();
        expect(taskNotes(tree, task('t-32'), { scope: null, withParent: true }).parentKey).toBe('CAR-31');
        expect(taskNotes(tree, task('t-24'), { scope: null, withParent: true }).parentKey).toBeUndefined();
    });

    it('names no parent for a row of the tree, which sits under it', () => {
        expect(taskNotes(tree, task('t-33'), { scope: 't-31', withParent: false }).parentKey).toBeUndefined();
    });
});
