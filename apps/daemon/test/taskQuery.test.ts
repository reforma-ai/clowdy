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

    test('ready is open work whose dependencies are all done; blocked is open work with one that is not', () => {
        expect(keys(list(tasks, { ready: true, sort: 'number' }))).toEqual(['CLW-2', 'CLW-4']);
        expect(keys(list(tasks, { blocked: true, sort: 'number' }))).toEqual(['CLW-3', 'CLW-6']);
        expect(keys(list(tasks, { all: true, ready: true, sort: 'number' }))).toEqual(['CLW-2', 'CLW-4']);
        expect(() => list(tasks, { ready: true, blocked: true })).toThrow(/exclude each other/);
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
        expect(list([])).toEqual({ tasks: [], total: 0, shown: 0, counts: { backlog: 0, todo: 0, active: 0, review: 0, done: 0, canceled: 0 } });
    });
});
