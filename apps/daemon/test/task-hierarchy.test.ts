import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { takeTaskNumber } from '../src/db/projects';
import { upsertTask } from '../src/db/tasks';
import { projectSnapshot } from '../src/domain/snapshots';
import { moveTask } from '../src/domain/tasks';
import { cleanTempDirs, startHarness, waitFor } from './helpers';

import type { Task } from '@clowdy/protocol';
import type { Harness } from './helpers';

afterAll(cleanTempDirs);

let h: Harness;

beforeEach(async () => {
    h = await startHarness();
});

afterEach(async () => {
    await h.stop();
});

const failure = (result: ReturnType<Harness['send']>) => {
    if (result.ok) {
        throw new Error('expected a failure');
    }

    return result.error;
};

/** A project with a `create` that returns the task, and the id of each status by category. */
function setup() {
    const project = h.openRepo();
    const statuses = h.statuses(project.id);
    const status = (category: string) => statuses.find(candidate => candidate.category === category)!.id;
    const create = (title: string, extra: Record<string, unknown> = {}): Task =>
        h.ok('task.create', { projectId: project.id, title, ...extra }).task;
    const get = (taskId: string): Task => projectSnapshot(h.store, project.id).tasks.find(task => task.id === taskId)!;
    /** A chain of `length` tasks, each the child of the one before; the first is a root. */
    const chain = (length: number, prefix = 'Level') => {
        const tasks: Task[] = [];

        for (let level = 1; level <= length; level++) {
            tasks.push(create(`${prefix} ${level}`, level === 1 ? {} : { parentId: tasks[level - 2].id }));
        }

        return tasks;
    };

    return { project, status, create, get, chain };
}

describe('a task inside a task', () => {
    test('a task made with a parent carries it everywhere the task goes: the answer, the event and the snapshot; a root carries nothing', () => {
        const { project, create, get } = setup();
        const epic = create('Epic');
        const cursor = h.store.headCursor();
        const stage = create('Stage', { parentId: epic.id });

        expect(stage.parentId).toBe(epic.id);
        expect(epic).not.toHaveProperty('parentId');
        expect(h.events(cursor).map(event => event.data)).toEqual([
            { type: 'task.upserted', task: expect.objectContaining({ id: stage.id, parentId: epic.id }) },
        ]);
        expect(get(stage.id).parentId).toBe(epic.id);
        expect(get(epic.id)).not.toHaveProperty('parentId');
        expect(projectSnapshot(h.store, project.id).tasks.filter(task => task.parentId === epic.id)).toHaveLength(1);
    });

    test('a task moves under another with its subtree, and becomes a root again with null', () => {
        const { create, get } = setup();
        const [epic, other] = [create('Epic'), create('Other epic')];
        const stage = create('Stage', { parentId: epic.id });
        const step = create('Step', { parentId: stage.id });

        expect(h.ok('task.update', { taskId: stage.id, parentId: other.id }).task.parentId).toBe(other.id);
        expect(get(step.id).parentId).toBe(stage.id);
        expect(h.ok('task.update', { taskId: stage.id, parentId: null }).task).not.toHaveProperty('parentId');
        expect(get(stage.id)).not.toHaveProperty('parentId');
        expect(get(step.id).parentId).toBe(stage.id);
    });

    test('a parent that does not change, and a root made a root, publish nothing', () => {
        const { create } = setup();
        const epic = create('Epic');
        const stage = create('Stage', { parentId: epic.id });
        const cursor = h.store.headCursor();

        h.ok('task.update', { taskId: stage.id, parentId: epic.id });
        h.ok('task.update', { taskId: epic.id, parentId: null });
        expect(h.store.headCursor()).toBe(cursor);
        h.ok('task.update', { taskId: stage.id, parentId: null });
        expect(h.store.headCursor()).toBe(cursor + 1);
    });

    test('a change to the parent alone moves updatedAt and keeps everything else', async () => {
        const { create } = setup();
        const epic = create('Epic');
        const stage = create('Stage', { description: 'Text' });

        await Bun.sleep(5);

        const moved = h.ok('task.update', { taskId: stage.id, parentId: epic.id }).task as Task;

        expect(moved).toMatchObject({
            title: 'Stage',
            description: 'Text',
            statusId: stage.statusId,
            parentId: epic.id,
        });
        expect(moved.updatedAt).toBeGreaterThan(stage.updatedAt);
        expect(moved.createdAt).toBe(stage.createdAt);
    });

    test('a parent that does not exist, or is in another project, is refused with the reason', () => {
        const { project, create } = setup();
        const other = h.openRepo('other');
        const foreign = h.ok('task.create', { projectId: other.id, title: 'Foreign' }).task as Task;
        const task = create('Task');

        expect(failure(h.send('task.create', { projectId: project.id, title: 'x', parentId: 'tsk_nope' })).code).toBe(
            'not_found'
        );
        expect(failure(h.send('task.update', { taskId: task.id, parentId: 'tsk_nope' })).code).toBe('not_found');
        expect(
            failure(h.send('task.create', { projectId: project.id, title: 'x', parentId: foreign.id }))
        ).toMatchObject({ code: 'invalid', message: 'Task OTH-1 belongs to another space' });
        expect(failure(h.send('task.update', { taskId: task.id, parentId: foreign.id }))).toMatchObject({
            code: 'invalid',
            message: 'Task OTH-1 belongs to another space',
        });
        // A refused create leaves no task behind.
        expect(
            (h.store.db.query('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?').get(project.id) as { n: number })
                .n
        ).toBe(1);
    });

    test('a task is not its own parent, nor the parent of the task above it, however far above', () => {
        const { create, chain } = setup();
        const [a, b, c] = chain(3);
        const loner = create('Loner');

        expect(failure(h.send('task.update', { taskId: loner.id, parentId: loner.id }))).toMatchObject({
            code: 'invalid',
            message: 'Task REP-4 cannot be its own parent',
        });
        expect(failure(h.send('task.update', { taskId: a.id, parentId: b.id }))).toMatchObject({
            code: 'invalid',
            message: 'Task REP-2 is inside REP-1, so it cannot be its parent',
        });
        expect(failure(h.send('task.update', { taskId: a.id, parentId: c.id })).message).toBe(
            'Task REP-3 is inside REP-1, so it cannot be its parent'
        );
        expect(failure(h.send('task.update', { taskId: b.id, parentId: c.id })).code).toBe('invalid');
        // A task of another tree is fine.
        expect(h.ok('task.update', { taskId: loner.id, parentId: c.id }).task.parentId).toBe(c.id);
    });

    test('a tree has at most 8 levels: the ninth is refused on create and on a move', () => {
        const { project, create, chain } = setup();
        const tasks = chain(8);
        const spare = create('Spare');

        expect(
            failure(h.send('task.create', { projectId: project.id, title: 'Too deep', parentId: tasks[7].id }))
        ).toMatchObject({
            code: 'invalid',
            message: 'Too deep: REP-10 under REP-8 would reach level 9, and a tree has at most 8 levels',
        });
        expect(failure(h.send('task.update', { taskId: spare.id, parentId: tasks[7].id })).message).toBe(
            'Too deep: REP-9 under REP-8 would reach level 9, and a tree has at most 8 levels'
        );
        expect(h.ok('task.update', { taskId: spare.id, parentId: tasks[6].id }).task.parentId).toBe(tasks[6].id);
    });

    test('a tree that is already too deep is not refused again for an edit that leaves the parent alone', () => {
        const { project, create, chain, status } = setup();
        const tasks = chain(8);
        const number = takeTaskNumber(h.store.db, project.id);
        // The store has no depth limit, so a ninth level can exist, written by something other than the commands.
        const deep: Task = {
            id: 'tsk_deep',
            projectId: project.id,
            number,
            key: `REP-${number}`,
            title: 'Level 9',
            description: '',
            statusId: tasks[0].statusId,
            dependsOn: [],
            parentId: tasks[7].id,
            createdBy: { kind: 'user' },
            createdAt: 1,
            updatedAt: 1,
        };

        upsertTask(h.store.db, deep);
        expect(h.ok('task.update', { taskId: deep.id, title: 'Renamed', parentId: tasks[7].id }).task.title).toBe(
            'Renamed'
        );
        expect(h.ok('task.update', { taskId: deep.id, statusId: status('done') }).task.closedAt).toBeGreaterThan(0);
        // A move is still checked: nothing goes under the ninth level.
        expect(failure(h.send('task.update', { taskId: create('Spare').id, parentId: deep.id })).message).toContain(
            'would reach level 10'
        );
    });

    test('moving a task with a subtree counts the deepest task inside it', () => {
        const { create, chain } = setup();
        const target = chain(6, 'Target');
        const epic = create('Epic');
        const stage = create('Stage', { parentId: epic.id });
        const step = create('Step', { parentId: stage.id });
        const detail = create('Detail', { parentId: step.id });

        // The epic has three levels below it: under level 4 it reaches level 8, under level 5 it would reach 9.
        expect(failure(h.send('task.update', { taskId: epic.id, parentId: target[5].id })).message).toContain(
            'would reach level 10, counting the 3 levels of tasks inside it'
        );
        expect(failure(h.send('task.update', { taskId: epic.id, parentId: target[4].id })).message).toContain(
            'would reach level 9'
        );
        expect(h.ok('task.update', { taskId: epic.id, parentId: target[3].id }).task.parentId).toBe(target[3].id);
        // The stage has two levels below it: it fits under level 5 (reach 8) but not under level 6 (reach 9).
        expect(failure(h.send('task.update', { taskId: stage.id, parentId: target[5].id })).message).toContain(
            'would reach level 9, counting the 2 levels'
        );
        expect(h.ok('task.update', { taskId: stage.id, parentId: target[4].id }).task.parentId).toBe(target[4].id);
        // A leaf only needs room for itself: the detail goes under level 6 and sits at level 7.
        expect(h.ok('task.update', { taskId: detail.id, parentId: target[5].id }).task.parentId).toBe(target[5].id);
        // One level inside is spelled in the singular.
        const small = create('Small');

        create('Inside', { parentId: small.id });
        expect(
            failure(h.send('task.update', { taskId: small.id, parentId: chain(7, 'Deep')[6].id })).message
        ).toContain('counting the 1 level of tasks inside it');
    });

    test('a refused move changes nothing', () => {
        const { create, get } = setup();
        const epic = create('Epic');
        const stage = create('Stage', { parentId: epic.id });
        const cursor = h.store.headCursor();

        expect(failure(h.send('task.update', { taskId: epic.id, parentId: stage.id, title: 'Renamed' })).code).toBe(
            'invalid'
        );
        expect(h.store.headCursor()).toBe(cursor);
        expect(get(epic.id).title).toBe('Epic');
    });

    test('deleting a task moves the tasks inside it up to its own parent, and publishes each of them', () => {
        const { create, get } = setup();
        const epic = create('Epic');
        const stage = create('Stage', { parentId: epic.id });
        const [stepA, stepB] = [create('Step A', { parentId: stage.id }), create('Step B', { parentId: stage.id })];
        const detail = create('Detail', { parentId: stepA.id });
        const cursor = h.store.headCursor();

        h.ok('task.delete', { taskId: stage.id });

        expect(h.events(cursor).map(event => event.data)).toEqual([
            { type: 'task.upserted', task: expect.objectContaining({ id: stepA.id, parentId: epic.id }) },
            { type: 'task.upserted', task: expect.objectContaining({ id: stepB.id, parentId: epic.id }) },
            { type: 'task.deleted', taskId: stage.id },
        ]);
        expect(get(stepA.id).parentId).toBe(epic.id);
        expect(get(stepB.id).parentId).toBe(epic.id);
        expect(get(detail.id).parentId).toBe(stepA.id);
    });

    test('the tasks inside a deleted root become roots, and a task that is both a child and a dependent is published once, with both changes', () => {
        const { create, get } = setup();
        const epic = create('Epic');
        const stage = create('Stage', { parentId: epic.id, dependsOn: [epic.id] });
        const other = create('Other', { parentId: epic.id });
        const cursor = h.store.headCursor();

        h.ok('task.delete', { taskId: epic.id });

        expect(h.events(cursor).map(event => event.data)).toEqual([
            { type: 'task.upserted', task: expect.objectContaining({ id: stage.id, dependsOn: [] }) },
            { type: 'task.upserted', task: expect.objectContaining({ id: other.id }) },
            { type: 'task.deleted', taskId: epic.id },
        ]);
        expect(get(stage.id)).not.toHaveProperty('parentId');
        expect(get(other.id)).not.toHaveProperty('parentId');
        expect(get(stage.id).dependsOn).toEqual([]);
        expect(
            h
                .events(cursor)
                .flatMap(event => (event.data.type === 'task.upserted' ? [event.data.task] : []))
                .every(task => !('parentId' in task))
        ).toBe(true);
    });

    test('no task keeps a parent that is gone, and no tree gets deeper when a task goes', () => {
        const { create, chain } = setup();
        const tasks = chain(8);

        h.ok('task.delete', { taskId: tasks[3].id });
        expect(
            h.store.db
                .query('SELECT id FROM tasks WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM tasks)')
                .all()
        ).toEqual([]);
        // Level 5 is now level 4, so a task fits under what was level 7 and is now level 6, with room for one more.
        expect(create('Fits', { parentId: tasks[6].id }).parentId).toBe(tasks[6].id);
        expect(create('Fits too', { parentId: tasks[7].id }).parentId).toBe(tasks[7].id);
    });
});

describe('closedAt', () => {
    test('a task made in a closed status is closed from the start; one made open has no closing time', () => {
        const { create, status } = setup();
        const done = create('Done', { statusId: status('done') });
        const canceled = create('Canceled', { statusId: status('canceled') });

        expect(done.closedAt).toBe(done.createdAt);
        expect(canceled.closedAt).toBe(canceled.createdAt);
        expect(create('Open')).not.toHaveProperty('closedAt');
        expect(create('Active', { statusId: status('active') })).not.toHaveProperty('closedAt');
    });

    test('entering Done or Canceled sets it, leaving clears it, and moving between the two keeps the first time', async () => {
        const { create, status } = setup();
        const task = create('Work');
        const update = (statusId: string) => h.ok('task.update', { taskId: task.id, statusId }).task as Task;
        const before = Date.now();
        const done = update(status('done'));

        expect(done.closedAt).toBeGreaterThanOrEqual(before);
        expect(done.closedAt).toBeLessThanOrEqual(Date.now());

        await Bun.sleep(5);
        expect(update(status('canceled')).closedAt).toBe(done.closedAt);
        expect(update(status('done')).closedAt).toBe(done.closedAt);
        expect(update(status('review'))).not.toHaveProperty('closedAt');

        await Bun.sleep(5);

        const again = update(status('canceled'));

        expect(again.closedAt).toBeGreaterThan(done.closedAt!);
        expect(update(status('todo'))).not.toHaveProperty('closedAt');
    });

    test('an edit of something else keeps the closing time while updatedAt moves', async () => {
        const { create, status, get } = setup();
        const task = create('Work', { statusId: status('done') });

        await Bun.sleep(5);

        const edited = h.ok('task.update', { taskId: task.id, title: 'Renamed', description: 'Notes' }).task as Task;

        expect(edited.closedAt).toBe(task.closedAt);
        expect(edited.updatedAt).toBeGreaterThan(task.updatedAt);
        expect(get(task.id).closedAt).toBe(task.closedAt);
    });

    test('the time reaches the clients in the event and the snapshot, and a task that is not closed has none there either', () => {
        const { create, status, get } = setup();
        const task = create('Work');
        const cursor = h.store.headCursor();
        const closed = h.ok('task.update', { taskId: task.id, statusId: status('done') }).task as Task;

        expect(h.events(cursor).map(event => event.data)).toEqual([
            { type: 'task.upserted', task: expect.objectContaining({ id: task.id, closedAt: closed.closedAt }) },
        ]);
        expect(get(task.id).closedAt).toBe(closed.closedAt);
        h.ok('task.update', { taskId: task.id, statusId: status('todo') });
        expect(get(task.id)).not.toHaveProperty('closedAt');
    });

    test('a move the runtime makes, not a person, sets it too', () => {
        const { create, get } = setup();
        const task = create('Work');

        moveTask(h.store, task.id, 'review');
        expect(get(task.id)).not.toHaveProperty('closedAt');
        moveTask(h.store, task.id, 'done');
        expect(get(task.id).closedAt).toBeGreaterThan(0);
        moveTask(h.store, task.id, 'todo');
        expect(get(task.id)).not.toHaveProperty('closedAt');
    });
});

describe('a canceled dependency', () => {
    test('releases a run that waits for it, as a done one does, and a dependency still open keeps it waiting', async () => {
        const { create, status } = setup();
        const [first, second, third] = [create('First'), create('Second'), create('Third')];
        const waiting = create('Waiting', { dependsOn: [first.id, second.id, third.id] });
        const { runId } = h.ok('task.start', { taskId: waiting.id });

        expect(h.run(runId)).toMatchObject({ status: 'blocked', statusReason: 'Waiting for REP-1, REP-2, REP-3' });
        h.ok('task.update', { taskId: first.id, statusId: status('canceled') });
        await waitFor(
            () => h.run(runId).statusReason === 'Waiting for REP-2, REP-3',
            'the canceled task to stop blocking'
        );
        h.ok('task.update', { taskId: second.id, statusId: status('done') });
        await waitFor(() => h.run(runId).statusReason === 'Waiting for REP-3', 'the done task to stop blocking');
        expect(h.run(runId).status).toBe('blocked');
        h.ok('task.update', { taskId: third.id, statusId: status('canceled') });
        await waitFor(() => h.run(runId).status !== 'blocked', 'the last dependency to release the run');
        h.ok('run.cancel', { runId });
    });

    test('a run on a task whose only dependency is canceled starts at once', () => {
        const { create, status } = setup();
        const first = create('First', { statusId: status('canceled') });
        const second = create('Second', { dependsOn: [first.id] });
        const { runId } = h.ok('task.start', { taskId: second.id });

        expect(h.run(runId).status).not.toBe('blocked');
        h.ok('run.cancel', { runId });
    });
});
