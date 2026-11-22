import { MAX_TASK_DEPTH } from '@clowdy/protocol';
import { describe, expect, it } from 'vitest';

import { createFixtureData, DEFAULT_STATUSES, FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { checklistOf, keepAmong, parentCandidates, TaskTree } from './taskTree';
import { filterTasks, NO_FILTER } from './taskView';

import type { Task } from '@clowdy/protocol';

/** A task with a number, a status and a parent; the key and id follow the number. */
function task(number: number, statusId: string, parentId?: number, rest: Partial<Task> = {}): Task {
    return {
        id: `t-${ number }`,
        projectId: 'p',
        number,
        key: `X-${ number }`,
        title: `Task ${ number }`,
        description: '',
        statusId,
        dependsOn: [],
        createdBy: { kind: 'user' },
        createdAt: 0,
        updatedAt: 0,
        ...(parentId !== undefined && { parentId: `t-${ parentId }` }),
        ...rest,
    };
}

const numbers = (tasks: readonly Task[]) => tasks.map(candidate => candidate.number);

/**
 * 1 (active)
 * ├─ 2 (done)
 * │  ├─ 3 (done)
 * │  └─ 4 (todo)
 * ├─ 5 (todo)
 * ├─ 6 (review)
 * └─ 7 (canceled)
 * 8 (todo)  a root with nothing inside it
 * 9 (backlog)
 */
const TASKS = [
    task(1, 'active'),
    task(2, 'done', 1),
    task(3, 'done', 2),
    task(4, 'todo', 2),
    task(5, 'todo', 1),
    task(6, 'review', 1),
    task(7, 'canceled', 1),
    task(8, 'todo'),
    task(9, 'backlog'),
];

const tree = (tasks: readonly Task[] = TASKS) => new TaskTree(tasks, DEFAULT_STATUSES);

describe('childrenOf', () => {
    it('lists the direct children of a task, in workflow status order and then number', () => {
        // The workflow's order is backlog, todo, active, review, done, canceled.
        expect(numbers(tree().childrenOf('t-1'))).toEqual([5, 6, 2, 7]);
        expect(numbers(tree().childrenOf('t-2'))).toEqual([4, 3]);
    });

    it('lists the roots for no scope, in the same order, and nothing for a task with nothing inside it or one that is not there', () => {
        expect(numbers(tree().childrenOf(null))).toEqual([9, 8, 1]);
        expect(tree().childrenOf('t-8')).toEqual([]);
        expect(tree().childrenOf('t-missing')).toEqual([]);
    });

    it('breaks a tie of status by number, and puts a status the workflow no longer has last', () => {
        const tasks = [task(1, 'todo'), task(3, 'todo'), task(2, 'gone'), task(4, 'todo')];

        expect(numbers(tree(tasks).childrenOf(null))).toEqual([1, 3, 4, 2]);
    });

    it('keeps only what the filter keeps, and does not look below a child that is dropped', () => {
        const keep = (candidate: Task) => candidate.statusId !== 'todo';

        expect(numbers(tree().childrenOf('t-1', keep))).toEqual([6, 2, 7]);
        expect(numbers(tree().childrenOf(null, keep))).toEqual([9, 1]);
    });

    it('stands a task whose parent is not in the set as a root, so it does not vanish', () => {
        const tasks = [task(1, 'todo'), task(2, 'todo', 99)];

        expect(numbers(tree(tasks).childrenOf(null))).toEqual([1, 2]);
        expect(tree(tasks).parentOf(tasks[1])).toBeUndefined();
    });

    it('hands out a list of its own', () => {
        const children = tree().childrenOf(null);

        children.length = 0;

        expect(tree().childrenOf(null)).toHaveLength(3);
    });
});

describe('descendantsOf', () => {
    it('lists every task below a task at any depth, and nothing of the task itself or its siblings', () => {
        expect(numbers(tree().descendantsOf('t-1'))).toEqual([4, 5, 6, 2, 3, 7]);
        expect(numbers(tree().descendantsOf('t-2'))).toEqual([4, 3]);
        expect(tree().descendantsOf('t-8')).toEqual([]);
    });

    it('lists every task of the project for no scope', () => {
        expect(numbers(tree().descendantsOf(null)).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('applies the filter to what it lists, whatever the parent of a match is', () => {
        const keep = (candidate: Task) => candidate.statusId === 'done';

        expect(numbers(tree().descendantsOf('t-1', keep))).toEqual([2, 3]);
        expect(numbers(tree().descendantsOf('t-2', keep))).toEqual([3]);
    });

    it('ends on a cycle in the data instead of looping', () => {
        const tasks = [task(1, 'todo', 2), task(2, 'todo', 1), task(3, 'todo')];

        expect(numbers(tree(tasks).descendantsOf('t-1'))).toEqual([2]);
        expect(tree(tasks).rows('t-1').map(row => row.task.number)).toEqual([2]);
    });
});

describe('rows', () => {
    it('draws the roots with everything inside them, depth first, each level in workflow status order and then number', () => {
        const rows = tree().rows(null);

        expect(rows.map(row => [row.task.number, row.depth])).toEqual([[9, 0], [8, 0], [1, 0], [5, 1], [6, 1], [2, 1], [4, 2], [3, 2], [7, 1]]);
    });

    it('marks the rows that have tasks inside them, and none for a leaf', () => {
        const rows = tree().rows(null);

        expect(rows.filter(row => row.hasChildren).map(row => row.task.number)).toEqual([1, 2]);
        expect(rows.every(row => !row.collapsed)).toBe(true);
    });

    it('hides what is inside a collapsed task, and marks the row', () => {
        const rows = tree().rows(null, ['t-2']);

        expect(rows.map(row => row.task.number)).toEqual([9, 8, 1, 5, 6, 2, 7]);
        expect(rows.find(row => row.task.number === 2)).toMatchObject({ hasChildren: true, collapsed: true });

        expect(tree().rows(null, new Set(['t-1'])).map(row => row.task.number)).toEqual([9, 8, 1]);
    });

    it('does not mark a task with nothing inside it as collapsed, whatever the set says', () => {
        expect(tree().rows(null, ['t-8']).find(row => row.task.number === 8)).toMatchObject({ hasChildren: false, collapsed: false });
    });

    it('starts at the scope: its tasks are depth 0, and the scope is not a row', () => {
        const rows = tree().rows('t-1');

        expect(rows.map(row => [row.task.number, row.depth])).toEqual([[5, 0], [6, 0], [2, 0], [4, 1], [3, 1], [7, 0]]);
        expect(tree().rows('t-8')).toEqual([]);
        expect(tree().rows('t-missing')).toEqual([]);
    });

    it('lists a root once, without a "no parent" group, even when no task has children', () => {
        const flat = [task(1, 'todo'), task(2, 'todo')];

        expect(tree(flat).rows(null).map(row => [row.task.number, row.depth, row.hasChildren])).toEqual([[1, 0, false], [2, 0, false]]);
    });

    it('applies the filter: a kept task whose parent is dropped moves up to the nearest kept parent, or to the top', () => {
        const keep = (candidate: Task) => candidate.number !== 2;
        const rows = tree().rows(null, [], keep);

        // CAR-3 and CAR-4 were inside the dropped 2, so they stand directly under 1.
        expect(rows.map(row => [row.task.number, row.depth])).toEqual([[9, 0], [8, 0], [1, 0], [4, 1], [5, 1], [6, 1], [3, 1], [7, 1]]);

        const rootless = tree().rows(null, [], candidate => candidate.number === 4);

        expect(rootless.map(row => [row.task.number, row.depth, row.hasChildren])).toEqual([[4, 0, false]]);
    });

    it('does not offer to fold a task whose tasks the filter drops, and folds the ones it keeps', () => {
        const rows = tree().rows(null, ['t-1'], candidate => candidate.statusId !== 'todo');

        expect(rows.map(row => row.task.number)).toEqual([9, 1]);
        expect(rows.find(row => row.task.number === 1)).toMatchObject({ hasChildren: true, collapsed: true });
        expect(tree().rows(null, [], candidate => candidate.number === 1)[0]).toMatchObject({ hasChildren: false });
    });

    it('composes with the screen\'s filter through keepAmong', () => {
        const all = TASKS;
        const matching = filterTasks(all, { ...NO_FILTER, query: 'Task 3' }, new Map());
        const rows = tree().rows(null, [], keepAmong(matching));

        expect(rows.map(row => row.task.number)).toEqual([3]);
        expect(numbers(tree().childrenOf('t-2', keepAmong(matching)))).toEqual([3]);
        expect(numbers(tree().descendantsOf(null, keepAmong(matching)))).toEqual([3]);
    });
});

describe('ancestors, depth and height', () => {
    it('lists the ancestors of a task root first, for breadcrumbs, and none for a root', () => {
        expect(numbers(tree().ancestorsOf(TASKS[2]))).toEqual([1, 2]);
        expect(numbers(tree().ancestorsOf(TASKS[1]))).toEqual([1]);
        expect(tree().ancestorsOf(TASKS[0])).toEqual([]);
    });

    it('stops at an ancestor the set does not hold, and on a cycle', () => {
        const orphan = [task(1, 'todo', 99), task(2, 'todo', 1)];
        const loop = [task(1, 'todo', 2), task(2, 'todo', 1)];

        expect(numbers(tree(orphan).ancestorsOf(orphan[1]))).toEqual([1]);
        expect(numbers(tree(loop).ancestorsOf(loop[0]))).toEqual([2]);
    });

    it('counts levels from 1 for a root', () => {
        expect([1, 2, 3, 8].map(number => tree().depthOf(TASKS[number - 1]))).toEqual([1, 2, 3, 1]);
        expect([1, 2, 3, 8].map(number => tree().heightOf(`t-${ number }`))).toEqual([2, 1, 0, 0]);
        expect(tree().heightOf('t-missing')).toBe(0);
    });

    it('says whether a task can hold tasks: only below the depth the daemon allows', () => {
        const deep = Array.from({ length: MAX_TASK_DEPTH }, (_, index) => task(index + 1, 'todo', index === 0 ? undefined : index));

        expect(tree(deep).canHaveChildren(deep[MAX_TASK_DEPTH - 2])).toBe(true);
        expect(tree(deep).canHaveChildren(deep[MAX_TASK_DEPTH - 1])).toBe(false);
        expect(tree(deep).canHaveChildren(deep[0])).toBe(true);
    });
});

describe('rollUp', () => {
    it('counts the tasks done out of every task below, at any depth', () => {
        // Below 1: 2 (done), 3 (done), 4, 5, 6; 7 is canceled and left out.
        expect(tree().rollUp(TASKS[0])).toEqual({ done: 2, total: 5 });
        expect(tree().rollUp(TASKS[1])).toEqual({ done: 1, total: 2 });
    });

    it('has none for a task with nothing inside it', () => {
        expect(tree().rollUp(TASKS[2])).toBeUndefined();
        expect(tree().rollUp(TASKS[7])).toBeUndefined();
        expect(tree().rollUp({ id: 't-missing' })).toBeUndefined();
    });

    it('has none when everything inside it is canceled, and counts a task of a status the workflow lost as not done', () => {
        expect(tree([task(1, 'todo'), task(2, 'canceled', 1)]).rollUp({ id: 't-1' })).toBeUndefined();
        expect(tree([task(1, 'todo'), task(2, 'gone', 1)]).rollUp({ id: 't-1' })).toEqual({ done: 0, total: 1 });
    });

    it('counts a task in the Done category as done whatever the status is called', () => {
        const statuses = [{ id: 'a', name: 'Shipped', category: 'done' as const }, { id: 'b', name: 'Dropped', category: 'canceled' as const }, { id: 'c', name: 'Working', category: 'active' as const }];
        const tasks = [task(1, 'c'), task(2, 'a', 1), task(3, 'b', 1), task(4, 'c', 1)];

        expect(new TaskTree(tasks, statuses).rollUp({ id: 't-1' })).toEqual({ done: 1, total: 2 });
    });
});

describe('checklistOf', () => {
    it('reads the checklist of the description with the shared parser, and has none without items', () => {
        expect(checklistOf({ description: 'Steps:\n\n- [x] one\n- [ ] two\n* [ ] three' })).toEqual({ done: 1, total: 3 });
        expect(checklistOf({ description: 'Nothing to tick\n\n- plain bullet' })).toBeUndefined();
        expect(checklistOf({ description: '' })).toBeUndefined();
    });

    it('ignores items inside a code fence, as the daemon does', () => {
        expect(checklistOf({ description: '```\n- [x] code\n```\n- [ ] real' })).toEqual({ done: 0, total: 1 });
    });
});

describe('parentCandidates', () => {
    it('leaves out the task itself, everything inside it, and an archived task, and keeps the rest in task order', () => {
        const archived = task(10, 'done', undefined, { archivedAt: 5 });

        expect(numbers(parentCandidates([...TASKS, archived], TASKS[1]))).toEqual([1, 5, 6, 7, 8, 9]);
        expect(numbers(parentCandidates([...TASKS, archived], TASKS[7]))).toEqual([1, 2, 3, 4, 5, 6, 7, 9]);
    });

    it('lists the present parent, so a picker can show it', () => {
        expect(numbers(parentCandidates(TASKS, TASKS[4]))).toContain(1);
    });

    it('counts the levels inside the task: an epic does not fit under a deep task, a leaf does', () => {
        // A chain of MAX_TASK_DEPTH - 1 levels, and a separate task with two levels inside it.
        const chain = Array.from({ length: MAX_TASK_DEPTH - 1 }, (_, index) => task(index + 1, 'todo', index === 0 ? undefined : index));
        const epic = [task(100, 'todo'), task(101, 'todo', 100), task(102, 'todo', 101)];
        const all = [...chain, ...epic];
        const candidates = numbers(parentCandidates(all, epic[0]));

        // The epic has height 2, so it fits under a task of level 5 at the deepest: MAX_TASK_DEPTH - 3 of the chain.
        expect(candidates).toEqual(chain.slice(0, MAX_TASK_DEPTH - 3).map(link => link.number));

        // A task with nothing inside it fits under any of them, the last one making it level MAX_TASK_DEPTH.
        expect(numbers(parentCandidates([...chain, task(200, 'todo')], task(200, 'todo')))).toEqual(chain.map(link => link.number));
    });

    it('offers no task that is already at the deepest level, which is a full tree for anything below it', () => {
        const full = Array.from({ length: MAX_TASK_DEPTH }, (_, index) => task(index + 1, 'todo', index === 0 ? undefined : index));
        const extra = task(99, 'todo');

        expect(numbers(parentCandidates([...full, extra], extra))).toEqual(full.slice(0, MAX_TASK_DEPTH - 1).map(link => link.number));
    });

    it('offers every task of the project for one that is not made yet, within the depth', () => {
        expect(numbers(parentCandidates(TASKS))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });
});

describe('the demo tree', () => {
    it('rolls up Payments from the fixture: the tasks inside it and below, a canceled one left out', () => {
        const tasks = createFixtureData().tasks.filter(candidate => candidate.projectId === FIXTURE_PROJECT_ID && candidate.archivedAt === undefined);
        const demo = new TaskTree(tasks, DEFAULT_STATUSES);
        const payments = tasks.find(candidate => candidate.number === 31)!;

        // Below Payments: Card checkout (active), its two tasks (done, todo), Refund flow (todo), Receipts (review); Split payments is canceled.
        expect(demo.rollUp(payments)).toEqual({ done: 1, total: 5 });
        expect(demo.rollUp(tasks.find(candidate => candidate.number === 32)!)).toEqual({ done: 1, total: 2 });
        expect(checklistOf(tasks.find(candidate => candidate.number === 35)!)).toEqual({ done: 2, total: 5 });
        expect(demo.depthOf(tasks.find(candidate => candidate.number === 33)!)).toBe(3);
        expect(demo.childrenOf(null).map(root => root.number)).toContain(31);
        expect(demo.childrenOf(null).map(root => root.number)).not.toContain(32);
    });
});
