import { describe, expect, test } from 'bun:test';

import { DEFAULT_LIMIT, MAX_LIMIT, parseSince, queryTasks } from '../src/domain/taskQuery';

import type { Task, TaskStatus, TaskStatusCategory } from '@clowdy/protocol';
import type { TaskQuery } from '../src/domain/taskQuery';

const statuses: TaskStatus[] = [
    { id: 'sts_backlog', name: 'Backlog', category: 'backlog' },
    { id: 'sts_todo', name: 'To do', category: 'todo' },
    { id: 'sts_active', name: 'In progress', category: 'active' },
    { id: 'sts_review', name: 'Review', category: 'review' },
    { id: 'sts_done', name: 'Done', category: 'done' },
    { id: 'sts_canceled', name: 'Canceled', category: 'canceled' },
];

const NOW = Date.parse('2026-11-21T12:00:00Z');
const HOUR = 3_600_000;

/** A task numbered `number` in `category`, last changed `hoursAgo` hours before `NOW`. */
function task(number: number, category: TaskStatusCategory, extra: Partial<Task> & { hoursAgo?: number } = {}): Task {
    const { hoursAgo = number, ...rest } = extra;
    const status = statuses.find(candidate => candidate.category === category) as TaskStatus;

    return {
        id: `tsk_${ number }`,
        projectId: 'prj_1',
        number,
        key: `CLW-${ number }`,
        title: `Task ${ number }`,
        description: '',
        statusId: status.id,
        dependsOn: [],
        createdBy: { kind: 'user' },
        createdAt: NOW - 1000 * HOUR + number,
        updatedAt: NOW - hoursAgo * HOUR,
        ...rest,
    };
}

const list = (tasks: Task[], query: TaskQuery = {}, running: string[] = [], linked: string[] = []) => queryTasks({
    tasks,
    statuses,
    isRunning: id => running.includes(id),
    linkedToChat: id => linked.includes(id),
}, query);

const keys = (page: ReturnType<typeof list>) => page.tasks.map(row => row.key);

const isoOf = (milliseconds: number) => new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** 100 backlog, 500 done, and a handful in flight: the project a bare listing must not drown in. */
function crowded(): Task[] {
    return [
        ...Array.from({ length: 100 }, (_, index) => task(index + 1, 'backlog', { hoursAgo: 5000 + index })),
        ...Array.from({ length: 500 }, (_, index) => task(index + 101, 'done', { hoursAgo: 2000 + index })),
        task(601, 'todo', { hoursAgo: 3 }),
        task(602, 'active', { hoursAgo: 1 }),
        task(603, 'review', { hoursAgo: 2 }),
    ];
}

describe('what a listing shows by default', () => {
    test('only the work in flight, with the count of everything else', () => {
        const page = list(crowded());

        expect(keys(page)).toEqual(['CLW-602', 'CLW-603', 'CLW-601']);
        expect(page.total).toBe(3);
        expect(page.shown).toBe(3);
        expect(page.nextCursor).toBeUndefined();
        expect(page.counts).toEqual({ backlog: 100, todo: 1, active: 1, review: 1, done: 500, canceled: 0 });
    });

    test('a row has no description and names what blocks it and whether a run works on it', () => {
        const tasks = [task(1, 'todo', { description: 'long text'.repeat(100) }), task(2, 'todo', { dependsOn: ['tsk_1'] }), task(3, 'done'), task(4, 'todo', { dependsOn: ['tsk_3'] })];
        const page = list(tasks, { sort: 'number' }, ['tsk_2']);

        expect(page.tasks[0]).toEqual({ key: 'CLW-1', title: 'Task 1', status: 'To do', category: 'todo', dependsOn: [], updatedAt: '2026-11-21T11:00:00Z' });
        expect(page.tasks[1]).toMatchObject({ key: 'CLW-2', dependsOn: ['CLW-1'], blockedBy: ['CLW-1'], running: true });
        expect(page.tasks[2]).toMatchObject({ key: 'CLW-4', dependsOn: ['CLW-3'] });
        expect(page.tasks[2]).not.toHaveProperty('blockedBy');
        expect(page.tasks[2]).not.toHaveProperty('running');
    });

    test('all shows everything, a status filter shows those statuses, and a text query reaches closed tasks', () => {
        const tasks = crowded();

        expect(list(tasks, { all: true }).total).toBe(603);
        expect(list(tasks, { statusIds: new Set(['sts_backlog']) }).total).toBe(100);
        expect(list(tasks, { statusIds: new Set(['sts_done', 'sts_todo']) }).total).toBe(501);
        expect(list(tasks, { all: true, statusIds: new Set(['sts_backlog']) }).total).toBe(100);
        expect(keys(list(tasks, { query: 'task 350' }))).toEqual(['CLW-350']);
        expect(keys(list(tasks, { query: 'task 350', statusIds: new Set(['sts_todo']) }))).toEqual([]);
    });

    test('a text query matches the key, the title and the description in any case', () => {
        const tasks = [task(1, 'todo', { title: 'CSV export' }), task(2, 'todo', { description: 'Needs the csv parser' }), task(3, 'done', { title: 'Other' })];

        expect(list(tasks, { query: 'CSV', sort: 'number' }).tasks.map(row => row.key)).toEqual(['CLW-1', 'CLW-2']);
        expect(keys(list(tasks, { query: 'clw-3' }))).toEqual(['CLW-3']);
    });
});

describe('filters', () => {
    const tasks = [
        task(1, 'done'),
        task(2, 'todo', { dependsOn: ['tsk_1'] }),
        task(3, 'todo', { dependsOn: ['tsk_4'] }),
        task(4, 'active'),
        task(5, 'canceled', { dependsOn: ['tsk_4'] }),
        task(6, 'todo', { dependsOn: ['tsk_5'] }),
    ];

    test('ready is open work whose dependencies are all closed, done or canceled; blocked is open work with one that is not', () => {
        // CLW-2 waits for a done task and CLW-6 for a canceled one: both are released. CLW-3 waits for CLW-4, which is still in progress.
        expect(keys(list(tasks, { ready: true, sort: 'number' }))).toEqual(['CLW-2', 'CLW-4', 'CLW-6']);
        expect(keys(list(tasks, { blocked: true, sort: 'number' }))).toEqual(['CLW-3']);
        expect(keys(list(tasks, { all: true, ready: true, sort: 'number' }))).toEqual(['CLW-2', 'CLW-4', 'CLW-6']);
        expect(() => list(tasks, { ready: true, blocked: true })).toThrow(/exclude each other/);
    });

    test('a canceled dependency is not in blockedBy, and a closed task is neither ready nor blocked', () => {
        const rows = list(tasks, { all: true, sort: 'number' }).tasks;

        expect(rows.find(row => row.key === 'CLW-6')).not.toHaveProperty('blockedBy');
        expect(rows.find(row => row.key === 'CLW-3')).toMatchObject({ blockedBy: ['CLW-4'] });
        // CLW-5 is canceled and CLW-1 is done: closed tasks are neither ready nor blocked, whatever they depend on.
        expect(keys(list(tasks, { all: true, ready: true }))).not.toContain('CLW-5');
        expect(keys(list(tasks, { all: true, blocked: true }))).not.toContain('CLW-5');
        expect(keys(list(tasks, { all: true, ready: true }))).not.toContain('CLW-1');
    });

    test('running and mine narrow to the tasks a run works on and the ones linked to the chat', () => {
        expect(keys(list(tasks, { running: true }, ['tsk_3']))).toEqual(['CLW-3']);
        expect(keys(list(tasks, { mine: true, sort: 'number' }, [], ['tsk_2', 'tsk_4', 'tsk_1']))).toEqual(['CLW-2', 'CLW-4']);
    });

    test('updatedSince keeps what changed at or after the time', () => {
        const aged = [task(1, 'todo', { hoursAgo: 30 }), task(2, 'todo', { hoursAgo: 5 }), task(3, 'todo', { hoursAgo: 1 })];

        expect(keys(list(aged, { updatedSince: NOW - 6 * HOUR }))).toEqual(['CLW-3', 'CLW-2']);
        expect(keys(list(aged, { updatedSince: NOW - 5 * HOUR }))).toEqual(['CLW-3', 'CLW-2']);
    });

    test('a time is a duration back from now or an ISO date, and anything else says what to write', () => {
        expect(parseSince('90m', NOW)).toBe(NOW - 90 * 60_000);
        expect(parseSince('12h', NOW)).toBe(NOW - 12 * HOUR);
        expect(parseSince('7d', NOW)).toBe(NOW - 7 * 24 * HOUR);
        expect(parseSince('2w', NOW)).toBe(NOW - 14 * 24 * HOUR);
        expect(parseSince('2026-11-01')).toBe(Date.parse('2026-11-01'));
        expect(parseSince('2026-11-01T09:30:00Z')).toBe(Date.parse('2026-11-01T09:30:00Z'));
        expect(() => parseSince('yesterday')).toThrow(/is not a time/);
        expect(() => parseSince('7')).toThrow(/is not a time/);
    });
});

describe('order and pages', () => {
    const tasks = [task(1, 'todo', { hoursAgo: 9 }), task(2, 'todo', { hoursAgo: 1 }), task(3, 'todo', { hoursAgo: 5 }), task(4, 'todo', { hoursAgo: 1 })];

    test('updated puts the newest change first and a tie goes to the lower number; number goes up; reverse turns it round', () => {
        expect(keys(list(tasks))).toEqual(['CLW-2', 'CLW-4', 'CLW-3', 'CLW-1']);
        expect(keys(list(tasks, { sort: 'number' }))).toEqual(['CLW-1', 'CLW-2', 'CLW-3', 'CLW-4']);
        expect(keys(list(tasks, { sort: 'number', reverse: true }))).toEqual(['CLW-4', 'CLW-3', 'CLW-2', 'CLW-1']);
        expect(keys(list(tasks, { sort: 'created' }))).toEqual(['CLW-4', 'CLW-3', 'CLW-2', 'CLW-1']);
    });

    test('a page holds the default number of rows, at most the maximum, and nextCursor leads to the rest without a gap or a repeat', () => {
        const many = Array.from({ length: 60 }, (_, index) => task(index + 1, 'todo', { hoursAgo: index + 1 }));
        const first = list(many);

        expect(first.shown).toBe(DEFAULT_LIMIT);
        expect(first.total).toBe(60);
        expect(first.nextCursor).toBeDefined();

        const second = list(many, { cursor: first.nextCursor });
        const third = list(many, { cursor: second.nextCursor });

        expect(second.shown).toBe(DEFAULT_LIMIT);
        expect(third.shown).toBe(10);
        expect(third.nextCursor).toBeUndefined();
        expect([...keys(first), ...keys(second), ...keys(third)]).toEqual(many.map(item => item.key));
        expect(list(many, { limit: MAX_LIMIT + 50 }).shown).toBe(60);
        expect(list(many, { limit: 5, sort: 'number', reverse: true }).tasks.map(row => row.key)).toEqual(['CLW-60', 'CLW-59', 'CLW-58', 'CLW-57', 'CLW-56']);
    });

    test('a task that changes between two pages does not repeat or push another one out', () => {
        const many = Array.from({ length: 6 }, (_, index) => task(index + 1, 'todo', { hoursAgo: index + 1 }));
        const first = list(many, { limit: 3 });
        // CLW-1 was on the first page; it changes now and would go to the top, but a cursor is a place in the order, so the next page does not repeat it.
        const changed = many.map(item => (item.number === 1 ? { ...item, updatedAt: NOW } : item));
        const second = list(changed, { limit: 3, cursor: first.nextCursor });

        expect(keys(first)).toEqual(['CLW-1', 'CLW-2', 'CLW-3']);
        expect(keys(second)).toEqual(['CLW-4', 'CLW-5', 'CLW-6']);
    });

    test('a page that ends inside a run of tasks with the same time continues with the next one, in either direction', () => {
        // Three tasks changed in the same instant, split over two pages by the limit.
        const tied = [task(1, 'todo', { hoursAgo: 4 }), task(2, 'todo', { hoursAgo: 2 }), task(3, 'todo', { hoursAgo: 2 }), task(4, 'todo', { hoursAgo: 2 }), task(5, 'todo', { hoursAgo: 1 })];
        const pages = (query: TaskQuery) => {
            const first = list(tied, { ...query, limit: 2 });
            const second = list(tied, { ...query, limit: 2, cursor: first.nextCursor });
            const third = list(tied, { ...query, limit: 2, cursor: second.nextCursor });

            return [...keys(first), ...keys(second), ...keys(third)];
        };

        expect(pages({})).toEqual(keys(list(tied)));
        expect(pages({})).toEqual(['CLW-5', 'CLW-2', 'CLW-3', 'CLW-4', 'CLW-1']);
        expect(pages({ reverse: true })).toEqual(['CLW-1', 'CLW-4', 'CLW-3', 'CLW-2', 'CLW-5']);
        expect(pages({ sort: 'number', reverse: true })).toEqual(['CLW-5', 'CLW-4', 'CLW-3', 'CLW-2', 'CLW-1']);
    });

    test('a cursor that is not one says what to pass', () => {
        expect(() => list(tasks, { cursor: 'abc' })).toThrow(/is not a cursor/);
    });

    test('an empty project answers an empty page', () => {
        expect(list([])).toEqual({ tasks: [], total: 0, shown: 0, counts: { backlog: 0, todo: 0, active: 0, review: 0, done: 0, canceled: 0 }, archived: 0 });
    });
});

describe('the tree', () => {
    // CLW-1 (epic, in progress)
    //   CLW-2 done, CLW-3 todo (a checklist), CLW-4 todo
    //     CLW-5 canceled, CLW-6 review
    // CLW-7 (another root), CLW-8 (a root, done)
    const tree = [
        task(1, 'active', { description: 'Epic\n- [x] plan\n- [ ] build\n- [ ] ship' }),
        task(2, 'done', { parentId: 'tsk_1' }),
        task(3, 'todo', { parentId: 'tsk_1', description: '- [x] one\n- [x] two' }),
        task(4, 'todo', { parentId: 'tsk_1' }),
        task(5, 'canceled', { parentId: 'tsk_4' }),
        task(6, 'review', { parentId: 'tsk_4' }),
        task(7, 'todo'),
        task(8, 'done'),
    ];

    test('a row names its parent by key and counts its children by category, leaving out the categories with none; a leaf and a root say nothing', () => {
        const rows = list(tree, { all: true, sort: 'number' }).tasks;
        const row = (key: string) => rows.find(candidate => candidate.key === key);

        expect(row('CLW-1')).toMatchObject({ children: { todo: 2, done: 1 } });
        expect(row('CLW-1')).not.toHaveProperty('parent');
        expect(row('CLW-4')).toMatchObject({ parent: 'CLW-1', children: { review: 1, canceled: 1 } });
        expect(row('CLW-6')).toMatchObject({ parent: 'CLW-4' });
        expect(row('CLW-6')).not.toHaveProperty('children');
        expect(row('CLW-7')).not.toHaveProperty('parent');
        expect(row('CLW-7')).not.toHaveProperty('children');
        // The roll-up counts every direct child, whichever the listing shows.
        expect(list(tree).tasks.find(candidate => candidate.key === 'CLW-1')?.children).toEqual({ todo: 2, done: 1 });
    });

    test('a row has a checklist when its description has an item, and not otherwise', () => {
        const rows = list(tree, { all: true, sort: 'number' }).tasks;

        expect(rows[0].checklist).toEqual({ done: 1, total: 3 });
        expect(rows[2].checklist).toEqual({ done: 2, total: 2 });
        expect(rows[1]).not.toHaveProperty('checklist');
    });

    test('parent lists the direct children, under every task below, and roots the tasks with no parent', () => {
        expect(keys(list(tree, { parentId: 'tsk_1', all: true, sort: 'number' }))).toEqual(['CLW-2', 'CLW-3', 'CLW-4']);
        expect(keys(list(tree, { underId: 'tsk_1', all: true, sort: 'number' }))).toEqual(['CLW-2', 'CLW-3', 'CLW-4', 'CLW-5', 'CLW-6']);
        expect(keys(list(tree, { underId: 'tsk_4', all: true, sort: 'number' }))).toEqual(['CLW-5', 'CLW-6']);
        expect(keys(list(tree, { roots: true, all: true, sort: 'number' }))).toEqual(['CLW-1', 'CLW-7', 'CLW-8']);
        expect(keys(list(tree, { parentId: 'tsk_6', all: true }))).toEqual([]);
    });

    test('the default status scope and the other filters apply on top of the structural scope', () => {
        // The open children of the epic: the done one stays out unless all, or a status, asks for it.
        expect(keys(list(tree, { parentId: 'tsk_1', sort: 'number' }))).toEqual(['CLW-3', 'CLW-4']);
        expect(keys(list(tree, { underId: 'tsk_1', sort: 'number' }))).toEqual(['CLW-3', 'CLW-4', 'CLW-6']);
        expect(keys(list(tree, { roots: true, sort: 'number' }))).toEqual(['CLW-1', 'CLW-7']);
        expect(keys(list(tree, { underId: 'tsk_1', statusIds: new Set(['sts_canceled']) }))).toEqual(['CLW-5']);
        expect(keys(list(tree, { parentId: 'tsk_1', query: 'zzz' }))).toEqual([]);
        expect(keys(list(tree, { underId: 'tsk_1', ready: true, sort: 'number' }))).toEqual(['CLW-3', 'CLW-4', 'CLW-6']);
        expect(list(tree, { parentId: 'tsk_1' }).total).toBe(2);
    });

    test('counts describe the structural scope, before the status scope hides anything; with no scope they are the project\'s', () => {
        expect(list(tree).counts).toEqual({ backlog: 0, todo: 3, active: 1, review: 1, done: 2, canceled: 1 });
        expect(list(tree, { parentId: 'tsk_1' }).counts).toEqual({ backlog: 0, todo: 2, active: 0, review: 0, done: 1, canceled: 0 });
        expect(list(tree, { underId: 'tsk_1' }).counts).toEqual({ backlog: 0, todo: 2, active: 0, review: 1, done: 1, canceled: 1 });
        expect(list(tree, { roots: true }).counts).toEqual({ backlog: 0, todo: 1, active: 1, review: 0, done: 1, canceled: 0 });
        expect(list(tree, { parentId: 'tsk_6' }).counts).toEqual({ backlog: 0, todo: 0, active: 0, review: 0, done: 0, canceled: 0 });
    });

    test('pages and their cursor stay inside the structural scope, with the same total and counts on every page', () => {
        const query = { underId: 'tsk_1', all: true, sort: 'number', limit: 2 } as const;
        const first = list(tree, query);
        const second = list(tree, { ...query, cursor: first.nextCursor });
        const last = list(tree, { ...query, cursor: second.nextCursor });

        expect([keys(first), keys(second), keys(last)]).toEqual([['CLW-2', 'CLW-3'], ['CLW-4', 'CLW-5'], ['CLW-6']]);
        expect(last.nextCursor).toBeUndefined();
        expect([first.total, second.total, last.total]).toEqual([5, 5, 5]);
        expect([second.counts, last.counts]).toEqual([first.counts, first.counts]);
    });

    test('parent, under and roots pick different parts of the tree and are not given together', () => {
        expect(() => list(tree, { parentId: 'tsk_1', underId: 'tsk_1' })).toThrow(/give one of them/);
        expect(() => list(tree, { roots: true, underId: 'tsk_1' })).toThrow(/give one of them/);
        expect(() => list(tree, { roots: true, parentId: 'tsk_1' })).toThrow(/give one of them/);
        expect(() => list(tree, { roots: false, parentId: 'tsk_1' })).not.toThrow();
    });

    test('a cycle in the data does not loop a listing', () => {
        const loop = [task(1, 'todo', { parentId: 'tsk_2' }), task(2, 'todo', { parentId: 'tsk_1' })];

        expect(keys(list(loop, { underId: 'tsk_1', sort: 'number' }))).toEqual(['CLW-2']);
        expect(list(loop, { sort: 'number' }).tasks.map(row => row.parent)).toEqual(['CLW-2', 'CLW-1']);
    });
});

describe('the archive', () => {
    const AT = NOW - 10 * HOUR;
    const EARLIER = NOW - 20 * HOUR;
    // CLW-1 (epic, done, archived with CLW-2 and CLW-3 at AT)
    //   CLW-2 done, CLW-3 canceled
    // CLW-4 (epic, in progress)
    //   CLW-5 done, CLW-6 done (archived on its own, earlier)
    // CLW-7 (todo, depends on the archived CLW-2), CLW-8 (backlog)
    const archive = [
        task(1, 'done', { archivedAt: AT, hoursAgo: 30 }),
        task(2, 'done', { parentId: 'tsk_1', archivedAt: AT, hoursAgo: 31 }),
        task(3, 'canceled', { parentId: 'tsk_1', archivedAt: AT, hoursAgo: 32 }),
        task(4, 'active'),
        task(5, 'done', { parentId: 'tsk_4' }),
        task(6, 'done', { parentId: 'tsk_4', archivedAt: EARLIER, hoursAgo: 40 }),
        task(7, 'todo', { dependsOn: ['tsk_2'] }),
        task(8, 'backlog'),
    ];

    test('an archived task is in no listing of the board: not the default, not all, not a status, not a text query', () => {
        expect(keys(list(archive, { sort: 'number' }))).toEqual(['CLW-4', 'CLW-7']);
        expect(keys(list(archive, { all: true, sort: 'number' }))).toEqual(['CLW-4', 'CLW-5', 'CLW-7', 'CLW-8']);
        expect(keys(list(archive, { statusIds: new Set(['sts_done']), sort: 'number' }))).toEqual(['CLW-5']);
        expect(keys(list(archive, { query: 'task', sort: 'number' }))).toEqual(['CLW-4', 'CLW-5', 'CLW-7', 'CLW-8']);
        expect(keys(list(archive, { query: 'Task 1' }))).toEqual([]);
        expect(list(archive, { all: true }).total).toBe(4);
    });

    test('the archived filter lists only archived tasks, whatever their status, and the other filters narrow that listing', () => {
        expect(keys(list(archive, { archived: true, sort: 'number' }))).toEqual(['CLW-1', 'CLW-2', 'CLW-3', 'CLW-6']);
        expect(keys(list(archive, { archived: true, all: true, sort: 'number' }))).toEqual(['CLW-1', 'CLW-2', 'CLW-3', 'CLW-6']);
        expect(keys(list(archive, { archived: true, statusIds: new Set(['sts_canceled']) }))).toEqual(['CLW-3']);
        expect(keys(list(archive, { archived: true, query: 'task 6' }))).toEqual(['CLW-6']);
        expect(keys(list(archive, { archived: true, query: 'zzz' }))).toEqual([]);
        expect(keys(list(archive, { archived: true, updatedSince: NOW - 31.5 * HOUR, sort: 'number' }))).toEqual(['CLW-1', 'CLW-2']);
        // An archived task is closed, so nothing of it is ready, blocked or running.
        expect(keys(list(archive, { archived: true, ready: true }))).toEqual([]);
        expect(keys(list(archive, { archived: true, blocked: true }))).toEqual([]);
        expect(keys(list(archive, { archived: true, running: true }, ['tsk_7']))).toEqual([]);
    });

    test('parent, under and roots pick that part of the tree among the archived tasks, and among the tasks of the board without the filter', () => {
        expect(keys(list(archive, { archived: true, parentId: 'tsk_1', sort: 'number' }))).toEqual(['CLW-2', 'CLW-3']);
        expect(keys(list(archive, { archived: true, underId: 'tsk_1', sort: 'number' }))).toEqual(['CLW-2', 'CLW-3']);
        // The top of an archived piece: CLW-1 has no parent, CLW-6 was archived alone below the live CLW-4.
        expect(keys(list(archive, { archived: true, roots: true, sort: 'number' }))).toEqual(['CLW-1', 'CLW-6']);
        // The parent itself may be on the board, with only some of its children archived.
        expect(keys(list(archive, { archived: true, parentId: 'tsk_4' }))).toEqual(['CLW-6']);
        expect(keys(list(archive, { archived: true, underId: 'tsk_4' }))).toEqual(['CLW-6']);
        expect(keys(list(archive, { parentId: 'tsk_4', all: true }))).toEqual(['CLW-5']);
        expect(keys(list(archive, { underId: 'tsk_4', all: true }))).toEqual(['CLW-5']);
        // The children of an archived task are archived: the board has none of them.
        expect(keys(list(archive, { parentId: 'tsk_1', all: true }))).toEqual([]);
        expect(keys(list(archive, { roots: true, all: true, sort: 'number' }))).toEqual(['CLW-4', 'CLW-7', 'CLW-8']);
        expect(() => list(archive, { archived: true, parentId: 'tsk_1', roots: true })).toThrow(/give one of them/);
    });

    test('counts describe the structural scope on the side that was asked for, and archived is the project\'s number whatever the query', () => {
        expect(list(archive).counts).toEqual({ backlog: 1, todo: 1, active: 1, review: 0, done: 1, canceled: 0 });
        expect(list(archive, { archived: true }).counts).toEqual({ backlog: 0, todo: 0, active: 0, review: 0, done: 3, canceled: 1 });
        expect(list(archive, { archived: true, parentId: 'tsk_1' }).counts).toEqual({ backlog: 0, todo: 0, active: 0, review: 0, done: 1, canceled: 1 });
        expect(list(archive, { archived: true, parentId: 'tsk_4' }).counts).toEqual({ backlog: 0, todo: 0, active: 0, review: 0, done: 1, canceled: 0 });
        expect(list(archive, { parentId: 'tsk_4' }).counts).toEqual({ backlog: 0, todo: 0, active: 0, review: 0, done: 1, canceled: 0 });
        expect(list(archive, { roots: true }).counts).toEqual({ backlog: 1, todo: 1, active: 1, review: 0, done: 0, canceled: 0 });

        for (const query of [{}, { all: true }, { archived: true }, { parentId: 'tsk_4' }, { query: 'zzz' }, { archived: true, query: 'zzz' }]) {
            expect({ query, archived: list(archive, query).archived }).toEqual({ query, archived: 4 });
        }

        expect(list(archive.filter(entry => entry.archivedAt === undefined)).archived).toBe(0);
    });

    test('a roll-up counts the tasks on its own side: the board leaves the archived children out, an archived task holds its archived ones', () => {
        const board = list(archive, { all: true, sort: 'number' }).tasks;
        const archived = list(archive, { archived: true, sort: 'number' }).tasks;

        expect(board.find(row => row.key === 'CLW-4')?.children).toEqual({ done: 1 });
        expect(archived.find(row => row.key === 'CLW-1')?.children).toEqual({ done: 1, canceled: 1 });
        expect(archived.find(row => row.key === 'CLW-2')).not.toHaveProperty('children');
        expect(archived.find(row => row.key === 'CLW-6')).not.toHaveProperty('children');

        // Every child archived: the parent on the board has none to count.
        const emptied = list([task(1, 'done'), task(2, 'done', { parentId: 'tsk_1', archivedAt: AT })], { all: true }).tasks;

        expect(emptied).toHaveLength(1);
        expect(emptied[0]).not.toHaveProperty('children');
    });

    test('a dependency on an archived task is resolved and still named by its key, and a row names its parent whichever side it is on', () => {
        const board = list(archive, { all: true, sort: 'number' }).tasks;
        const archived = list(archive, { archived: true, sort: 'number' }).tasks;

        expect(board.find(row => row.key === 'CLW-7')).toMatchObject({ dependsOn: ['CLW-2'] });
        expect(board.find(row => row.key === 'CLW-7')).not.toHaveProperty('blockedBy');
        expect(keys(list(archive, { ready: true, sort: 'number' }))).toEqual(['CLW-4', 'CLW-7']);
        expect(keys(list(archive, { blocked: true }))).toEqual([]);
        expect(archived.find(row => row.key === 'CLW-2')?.parent).toBe('CLW-1');
        expect(archived.find(row => row.key === 'CLW-6')?.parent).toBe('CLW-4');
        expect(board.find(row => row.key === 'CLW-5')?.parent).toBe('CLW-4');
    });

    test('only an archived task\'s row has archivedAt, as the time to the second', () => {
        const board = list(archive, { all: true }).tasks;
        const archived = list(archive, { archived: true, sort: 'number' }).tasks;

        expect(board.every(row => !('archivedAt' in row))).toBe(true);
        expect(archived.map(row => row.archivedAt)).toEqual([isoOf(AT), isoOf(AT), isoOf(AT), isoOf(EARLIER)]);
        expect(archived[0].archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    test('the archive pages like any listing, with the same total and counts on every page, and a cursor that stays inside it', () => {
        const query = { archived: true, sort: 'number', limit: 3 } as const;
        const first = list(archive, query);
        const second = list(archive, { ...query, cursor: first.nextCursor });

        expect([keys(first), keys(second)]).toEqual([['CLW-1', 'CLW-2', 'CLW-3'], ['CLW-6']]);
        expect(second.nextCursor).toBeUndefined();
        expect([first.total, second.total]).toEqual([4, 4]);
        expect(second.counts).toEqual(first.counts);
    });
});
