import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { insertStatus } from '../src/db/projects';
import { getTask, upsertTask } from '../src/db/tasks';
import { projectSnapshot } from '../src/domain/snapshots';
import { archivedTasksPage } from '../src/domain/taskArchive';
import { resolveTask } from '../src/domain/tasks';
import { cleanTempDirs, startHarness, waitFor } from './helpers';

import type { Task, TaskArchivePage } from '@clowdy/protocol';
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

/** A project with `create`, the id of each status by category, and the task as the store holds it now. */
function setup(name?: string) {
    const project = h.openRepo(name);
    // A project starts with no parked status; a test that needs one adds it first.
    const addBacklog = () => insertStatus(h.store.db, project.id, { id: `sts_backlog_${ project.id }`, name: 'Backlog', category: 'backlog' }, 99);
    const status = (category: string) => h.statuses(project.id).find(candidate => candidate.category === category)!.id;
    const create = (title: string, extra: Record<string, unknown> = {}): Task => h.ok('task.create', { projectId: project.id, title, ...extra }).task;
    const get = (taskId: string): Task => getTask(h.store.db, taskId)!;
    const archive = (taskId: string, cancel?: boolean) => h.ok('task.archive', { taskId, ...(cancel !== undefined && { cancel }) });
    const unarchive = (taskId: string) => h.ok('task.unarchive', { taskId });
    const archivedIds = () => archivedTasksPage(h.store, project.id, { limit: 100 }).tasks.map(task => task.id);

    return { project, status, addBacklog, create, get, archive, unarchive, archivedIds };
}

/** A task that a run works on now: the run waits for an open dependency, which keeps it active with no engine to drive. Returns the run's id. */
function busy(create: ReturnType<typeof setup>['create'], title: string, extra: Record<string, unknown> = {}) {
    const dependency = create(`${ title } needs this`);
    const task = create(title, { dependsOn: [dependency.id], ...extra });
    const { runId } = h.ok('task.start', { taskId: task.id });

    expect(h.run(runId).status).toBe('blocked');

    return { task, dependency, runId };
}

describe('task.archive', () => {
    test('archives a closed task, answers it with the ids that went in, and announces it once; nothing else about the task changes', () => {
        const { status, create, get, archive } = setup();

        for (const category of ['done', 'canceled']) {
            const task = create(`Finished as ${ category }`, { statusId: status(category) });
            const before = get(task.id);
            const cursor = h.store.headCursor();
            const answer = archive(task.id);

            expect(answer).toEqual({ task: { ...before, archivedAt: expect.any(Number) }, archived: [task.id], canceled: [] });
            expect(answer.task.archivedAt).toBeGreaterThan(0);
            expect(h.events(cursor).map(event => event.data)).toEqual([{ type: 'task.upserted', task: answer.task }]);
            // A flag, not an edit: the place in the order of changes, the status and the closing time stay.
            expect(get(task.id)).toEqual(answer.task);
            expect(get(task.id).updatedAt).toBe(before.updatedAt);
            expect(get(task.id).closedAt).toBe(before.closedAt);
            expect(get(task.id).statusId).toBe(before.statusId);
        }
    });

    test('refuses a task that is not closed, whatever open category it is in, and changes nothing', () => {
        const { status, addBacklog, create, get } = setup();

        addBacklog();

        for (const [category, name] of [['backlog', 'Backlog'], ['todo', 'To do'], ['active', 'In progress'], ['review', 'Review']]) {
            const task = create(`In ${ category }`, { statusId: status(category) });
            const cursor = h.store.headCursor();

            expect(failure(h.send('task.archive', { taskId: task.id }))).toMatchObject({ code: 'invalid', message: `${ task.key } (${ name }) is not closed: close it first, or archive with cancel` });
            expect(h.store.headCursor()).toBe(cursor);
            expect(get(task.id)).not.toHaveProperty('archivedAt');
        }
    });

    test('a task with an open task inside it is refused too, the message names them, and a long list is counted', () => {
        const { status, create, get, archive } = setup();
        const epic = create('Epic', { statusId: status('done') });
        const open = create('Open stage', { parentId: epic.id });
        const review = create('In review', { parentId: epic.id, statusId: status('review') });

        create('Done stage', { parentId: epic.id, statusId: status('done') });
        expect(failure(h.send('task.archive', { taskId: epic.id }))).toMatchObject({ code: 'invalid', message: `${ open.key } (To do), ${ review.key } (Review) are not closed: close them first, or archive with cancel` });

        const crowd = Array.from({ length: 7 }, (_, index) => create(`Open ${ index }`, { parentId: epic.id }));

        expect(failure(h.send('task.archive', { taskId: epic.id })).message).toBe(`${ [open, review, ...crowd].slice(0, 5).map(task => `${ task.key } (${ task.id === review.id ? 'Review' : 'To do' })`).join(', ') } and 4 more are not closed: close them first, or archive with cancel`);
        // Nothing went in, not even the closed tasks the refusal did not name.
        expect(get(epic.id)).not.toHaveProperty('archivedAt');
        expect(archive(epic.id, true).archived).toHaveLength(1 + 1 + 1 + 1 + 7);
    });

    test('archives the whole subtree with one shared archivedAt, one event per task, the task first, in one transaction', () => {
        const { project, status, create, get, archive } = setup();
        const epic = create('Epic', { statusId: status('done') });
        const stage = create('Stage', { parentId: epic.id, statusId: status('done') });
        const step = create('Step', { parentId: stage.id, statusId: status('canceled') });
        const other = create('Other stage', { parentId: epic.id, statusId: status('done') });
        const outside = create('Outside', { statusId: status('done') });
        const cursor = h.store.headCursor();
        const answer = archive(epic.id);

        expect(answer.archived).toEqual([epic.id, stage.id, other.id, step.id]);

        const times = new Set([epic, stage, step, other].map(task => get(task.id).archivedAt));

        expect(times.size).toBe(1);
        expect(get(outside.id)).not.toHaveProperty('archivedAt');

        const events = h.events(cursor);

        expect(events.map(event => event.data)).toEqual([epic, stage, other, step].map(task => ({ type: 'task.upserted', task: get(task.id) })));
        // One transaction: the events follow each other with nothing between them, and the project saw no other change.
        expect(events.map(event => event.cursor)).toEqual([cursor + 1, cursor + 2, cursor + 3, cursor + 4]);
        expect(events.every(event => event.projectId === project.id)).toBe(true);
    });

    test('cancel moves the open tasks of the subtree to Canceled and archives them with the rest, one event for each task carrying both changes', () => {
        const { status, addBacklog, create, get, archive } = setup();

        addBacklog();

        const epic = create('Epic', { statusId: status('active') });
        const stage = create('Stage', { parentId: epic.id });
        const step = create('Step', { parentId: stage.id, statusId: status('review') });
        const parked = create('Parked idea', { parentId: epic.id, statusId: status('backlog') });
        const done = create('Done stage', { parentId: epic.id, statusId: status('done') });
        const doneBefore = get(done.id);
        const cursor = h.store.headCursor();
        const before = Date.now();
        const answer = archive(epic.id, true);

        expect(answer.archived).toEqual([epic.id, stage.id, parked.id, done.id, step.id]);
        expect(answer.canceled).toEqual([epic.id, stage.id, parked.id, step.id]);

        for (const task of [epic, stage, step, parked]) {
            expect(get(task.id)).toMatchObject({ statusId: status('canceled'), archivedAt: expect.any(Number), closedAt: expect.any(Number) });
            expect(get(task.id).closedAt).toBeGreaterThanOrEqual(before);
            expect(get(task.id).updatedAt).toBeGreaterThanOrEqual(before);
        }

        // The closed one only gets the flag.
        expect(get(done.id)).toEqual({ ...doneBefore, archivedAt: get(epic.id).archivedAt });
        expect(new Set([epic, stage, step, parked, done].map(task => get(task.id).archivedAt)).size).toBe(1);
        // One event per task, not one for the cancel and another for the archive.
        expect(h.events(cursor).map(event => event.data)).toEqual([epic, stage, parked, done, step].map(task => ({ type: 'task.upserted', task: get(task.id) })));
    });

    test('cancel on a task that is closed already, and cancel false, change nothing beyond the archive; cancel false refuses open work like no cancel', () => {
        const { status, create, get, archive } = setup();
        const closed = create('Closed', { statusId: status('done') });
        const open = create('Open');

        expect(archive(closed.id, true)).toMatchObject({ archived: [closed.id], canceled: [] });
        expect(get(closed.id).statusId).toBe(status('done'));
        expect(failure(h.send('task.archive', { taskId: open.id, cancel: false })).code).toBe('invalid');
        expect(get(open.id)).not.toHaveProperty('archivedAt');
    });

    test('a run working on the task refuses the archive, whatever cancel says, and so does a run on a task inside it; nothing changes', () => {
        const { status, create, get } = setup();
        const own = busy(create, 'Own');
        const epic = create('Epic', { statusId: status('done') });
        const inside = busy(create, 'Inside', { parentId: epic.id, statusId: status('done') });
        const cursor = h.store.headCursor();

        expect(failure(h.send('task.archive', { taskId: own.task.id }))).toMatchObject({ code: 'conflict', message: expect.stringContaining(`Task ${ own.task.key } has an active run (Orchestrator`) });
        expect(failure(h.send('task.archive', { taskId: own.task.id, cancel: true })).code).toBe('conflict');
        expect(failure(h.send('task.archive', { taskId: epic.id })).message).toMatch(new RegExp(`^Task ${ inside.task.key }, inside ${ epic.key }, has an active run \\(Orchestrator \\d+\\): stop it first$`));
        expect(failure(h.send('task.archive', { taskId: epic.id, cancel: true })).code).toBe('conflict');
        // Closed or open, the refusal leaves everything where it was: not the epic, not a task before the busy one in the order.
        expect([own.task, epic, inside.task].map(task => get(task.id).archivedAt)).toEqual([undefined, undefined, undefined]);
        expect(h.store.headCursor()).toBe(cursor);

        // Once the run has stopped the archive goes through.
        h.ok('run.cancel', { runId: inside.runId });
        expect(h.ok('task.archive', { taskId: epic.id }).archived).toEqual([epic.id, inside.task.id]);
        h.ok('run.cancel', { runId: own.runId });
    });

    test('a run on a task is refused even when the task is closed already', () => {
        const { status, create } = setup();
        const { task, runId } = busy(create, 'Finished while a run waits');

        h.ok('task.update', { taskId: task.id, statusId: status('done') });
        expect(failure(h.send('task.archive', { taskId: task.id })).code).toBe('conflict');
        h.ok('run.cancel', { runId });
        expect(h.ok('task.archive', { taskId: task.id }).archived).toEqual([task.id]);
    });

    test('archiving a task that is archived changes nothing: no event, the same archivedAt, nothing in the answer', () => {
        const { status, create, get, archive } = setup();
        const epic = create('Epic', { statusId: status('done') });
        const first = archive(epic.id).task as Task;
        const cursor = h.store.headCursor();

        expect(archive(epic.id, true)).toEqual({ task: first, archived: [], canceled: [] });
        expect(get(epic.id).archivedAt).toBe(first.archivedAt);
        expect(h.store.headCursor()).toBe(cursor);
    });

    test('a task inside the subtree that was archived on its own keeps its own archivedAt and is not in the answer, even when it is not closed', () => {
        const { status, create, get, archive } = setup();
        const epic = create('Epic', { statusId: status('done') });
        const early = create('Early stage', { parentId: epic.id, statusId: status('done') });
        const late = create('Late stage', { parentId: epic.id, statusId: status('done') });
        const alone = archive(early.id).task as Task;
        const answer = archive(epic.id);

        expect(answer.archived).toEqual([epic.id, late.id]);
        expect(get(early.id).archivedAt).toBe(alone.archivedAt);
        expect(get(epic.id).archivedAt).not.toBe(alone.archivedAt);
        expect(get(late.id).archivedAt).toBe(get(epic.id).archivedAt);
    });

    test('a batch never takes the archivedAt of an earlier one, whatever the clock says, so a restore cannot take the other batch along', () => {
        const { status, create, get, archive, unarchive } = setup();
        const [first, second, third] = [create('First', { statusId: status('done') }), create('Second', { statusId: status('done') }), create('Third', { statusId: status('done') })];
        const ahead = Date.now() + 3_600_000;

        // The first batch carries a time the clock has not reached yet, as after a clock set back: the next ones must still come after it.
        upsertTask(h.store.db, { ...get(first.id), archivedAt: ahead });
        archive(second.id);
        archive(third.id);

        expect([second, third].map(task => get(task.id).archivedAt)).toEqual([ahead + 1, ahead + 2]);
        expect(unarchive(second.id).restored).toEqual([second.id]);
        expect([first, third].map(task => get(task.id).archivedAt)).toEqual([ahead, ahead + 2]);
    });

    test('a task that does not exist is not found, and a refused archive does not stop the next one', () => {
        const { status, create, archive } = setup();
        const closed = create('Closed', { statusId: status('done') });

        expect(failure(h.send('task.archive', { taskId: 'tsk_nope' })).code).toBe('not_found');
        expect(failure(h.send('task.unarchive', { taskId: 'tsk_nope' })).code).toBe('not_found');
        expect(archive(closed.id).archived).toEqual([closed.id]);
    });

    test('dependencies stay as they are: a task that waited for an archived one is free already, and one waiting for an open task the cancel closed is released', async () => {
        const { status, create, get, archive } = setup();
        const closed = create('Finished first', { statusId: status('done') });
        const dependent = create('Next', { dependsOn: [closed.id] });
        const epic = create('Epic');
        const waitingOn = create('Waited on', { parentId: epic.id });
        const outsider = create('Outside', { dependsOn: [waitingOn.id] });
        const { runId } = h.ok('task.start', { taskId: outsider.id });

        expect(h.run(runId)).toMatchObject({ status: 'blocked', statusReason: `Waiting for ${ waitingOn.key }` });
        archive(closed.id);
        expect(get(dependent.id).dependsOn).toEqual([closed.id]);

        // The dependency is archived, and a run on its dependent is not held back by it.
        const started = h.ok('task.start', { taskId: dependent.id }).runId;

        expect(h.run(started).status).not.toBe('blocked');
        h.ok('run.cancel', { runId: started });
        // Canceling releases the dependents, as a cancel by hand does.
        archive(epic.id, true);
        expect(get(outsider.id).dependsOn).toEqual([waitingOn.id]);
        await waitFor(() => h.run(runId).status !== 'blocked', 'the canceled dependency to release the run');
        h.ok('run.cancel', { runId });
    });
});

describe('task.unarchive', () => {
    test('brings the task back with the tasks that went in with it, announces each once, and changes nothing else', () => {
        const { status, create, get, archive, unarchive } = setup();
        const epic = create('Epic', { statusId: status('active') });
        const stage = create('Stage', { parentId: epic.id });
        const step = create('Step', { parentId: stage.id, statusId: status('done') });

        archive(epic.id, true);

        const archived = [epic, stage, step].map(task => get(task.id));
        const cursor = h.store.headCursor();
        const answer = unarchive(epic.id);

        expect(answer.restored).toEqual([epic.id, stage.id, step.id]);
        expect(answer.task).toEqual(get(epic.id));

        for (const [index, task] of [epic, stage, step].entries()) {
            const { archivedAt: _, ...rest } = archived[index];

            expect(get(task.id)).toEqual(rest);
        }

        // A canceled task comes back canceled: restoring is not reopening.
        expect(get(epic.id).statusId).toBe(status('canceled'));
        expect(h.events(cursor).map(event => event.data)).toEqual([epic, stage, step].map(task => ({ type: 'task.upserted', task: get(task.id) })));
        expect(h.events(cursor).map(event => event.cursor)).toEqual([cursor + 1, cursor + 2, cursor + 3]);
    });

    test('restores only the batch: a task archived on its own earlier stays in the archive, and comes back alone afterwards', () => {
        const { status, create, get, archive, unarchive } = setup();
        const epic = create('Epic', { statusId: status('done') });
        const early = create('Early stage', { parentId: epic.id, statusId: status('done') });
        const late = create('Late stage', { parentId: epic.id, statusId: status('done') });

        archive(early.id);
        archive(epic.id);
        expect(unarchive(epic.id).restored).toEqual([epic.id, late.id]);
        expect(get(early.id).archivedAt).toBeDefined();
        expect(get(epic.id)).not.toHaveProperty('archivedAt');
        expect(unarchive(early.id).restored).toEqual([early.id]);
        expect(get(early.id)).not.toHaveProperty('archivedAt');
    });

    test('a task archived on its own later stays archived when its parent comes back with an earlier batch, and batches of separate trees do not mix', () => {
        const { status, create, get, archive, unarchive } = setup();
        const [first, second] = [create('First epic', { statusId: status('done') }), create('Second epic', { statusId: status('done') })];
        const child = create('Child', { parentId: first.id, statusId: status('done') });
        const other = create('Other child', { parentId: second.id, statusId: status('done') });

        archive(first.id);
        archive(second.id);
        expect(unarchive(first.id).restored).toEqual([first.id, child.id]);
        expect([second, other].map(task => get(task.id).archivedAt !== undefined)).toEqual([true, true]);
    });

    test('a task moved under another archived task since it was archived is no part of its old batch: it is not put on the board under a parent that stays archived', () => {
        const { status, create, get, archive, unarchive } = setup();
        const epic = create('Epic', { statusId: status('done') });
        const middle = create('Middle', { parentId: epic.id, statusId: status('done') });
        const stray = create('Stray', { parentId: epic.id, statusId: status('done') });

        archive(middle.id);
        archive(epic.id);
        expect(get(stray.id).archivedAt).toBe(get(epic.id).archivedAt);
        h.ok('task.update', { taskId: stray.id, parentId: middle.id });

        expect(unarchive(epic.id).restored).toEqual([epic.id]);
        expect([middle, stray].map(task => get(task.id).archivedAt !== undefined)).toEqual([true, true]);
        expect(failure(h.send('task.unarchive', { taskId: stray.id })).code).toBe('invalid');
        expect(unarchive(middle.id).restored).toEqual([middle.id]);
        expect(unarchive(stray.id).restored).toEqual([stray.id]);
    });

    test('is refused while the task\'s parent is archived, in the same batch or not, with nothing changed; the parent first brings it back', () => {
        const { status, create, get, archive, unarchive } = setup();
        const epic = create('Epic', { statusId: status('done') });
        const stage = create('Stage', { parentId: epic.id, statusId: status('done') });
        const step = create('Step', { parentId: stage.id, statusId: status('done') });

        archive(epic.id);

        const cursor = h.store.headCursor();

        expect(failure(h.send('task.unarchive', { taskId: stage.id }))).toMatchObject({ code: 'invalid', message: `Task ${ stage.key } is inside ${ epic.key }, which is archived: restore ${ epic.key } first` });
        expect(failure(h.send('task.unarchive', { taskId: step.id })).message).toBe(`Task ${ step.key } is inside ${ stage.key }, which is archived: restore ${ stage.key } first`);
        expect(h.store.headCursor()).toBe(cursor);
        expect(get(stage.id).archivedAt).toBeDefined();
        expect(unarchive(epic.id).restored).toEqual([epic.id, stage.id, step.id]);

        // A parent archived by its own call, after the child was: the child waits for it as well.
        const loneParent = create('Parent', { statusId: status('done') });
        const loneChild = create('Child', { parentId: loneParent.id, statusId: status('done') });

        archive(loneChild.id);
        archive(loneParent.id);
        expect(failure(h.send('task.unarchive', { taskId: loneChild.id })).code).toBe('invalid');
        expect(unarchive(loneParent.id).restored).toEqual([loneParent.id]);
        expect(unarchive(loneChild.id).restored).toEqual([loneChild.id]);
    });

    test('a task that is not archived changes nothing: no event, an empty answer', () => {
        const { create, unarchive } = setup();
        const task = create('Live');
        const cursor = h.store.headCursor();

        expect(unarchive(task.id)).toEqual({ task, restored: [] });
        expect(h.store.headCursor()).toBe(cursor);
    });

    test('a restored task is on the board again, can be started, and can be reopened', () => {
        const { project, status, create, get, archive, unarchive } = setup();
        const task = create('Work', { statusId: status('done') });

        archive(task.id);
        expect(projectSnapshot(h.store, project.id).tasks.map(entry => entry.id)).not.toContain(task.id);
        unarchive(task.id);
        expect(projectSnapshot(h.store, project.id).tasks.map(entry => entry.id)).toContain(task.id);
        h.ok('task.update', { taskId: task.id, statusId: status('todo') });
        expect(get(task.id)).not.toHaveProperty('closedAt');
        h.ok('run.cancel', { runId: h.ok('task.start', { taskId: task.id }).runId });
    });
});

describe('what an archived task leaves and what it keeps', () => {
    test('it leaves the project snapshot, over HTTP too, and the live tasks stay', async () => {
        const { project, status, create, archive } = setup();
        const live = create('Live');
        const closed = create('Closed', { statusId: status('done') });

        archive(closed.id);
        expect(projectSnapshot(h.store, project.id).tasks.map(task => task.id)).toEqual([live.id]);

        const snapshot = await (await h.fetch(`/v1/projects/${ project.id }/snapshot`)).json() as { tasks: Task[] };

        expect(snapshot.tasks.map(task => task.id)).toEqual([live.id]);
    });

    test('it is found by its key and its id, and a task can depend on it, on create and on update, and keeps it in its dependencies', () => {
        const { project, status, create, get, archive } = setup();
        const closed = create('Closed', { statusId: status('done') });

        archive(closed.id);
        expect(resolveTask(h.store, project.id, closed.key).id).toBe(closed.id);
        expect(resolveTask(h.store, project.id, closed.id).id).toBe(closed.id);

        // A dependency on an archived task is accepted, on create and on update, and counts as resolved.
        const waiting = create('Waiting', { dependsOn: [closed.id] });
        const later = create('Later');

        h.ok('task.update', { taskId: later.id, dependsOn: [closed.id] });
        expect(get(waiting.id).dependsOn).toEqual([closed.id]);
        expect(get(later.id).dependsOn).toEqual([closed.id]);
        expect(projectSnapshot(h.store, project.id).tasks.find(task => task.id === waiting.id)?.dependsOn).toEqual([closed.id]);
        h.ok('run.cancel', { runId: h.ok('task.start', { taskId: waiting.id }).runId });
    });

    test('task.start refuses an archived task, says to restore it first, and opens no chat and no run', () => {
        const { status, create, archive, unarchive } = setup();
        const task = create('Closed', { statusId: status('done') });

        archive(task.id);

        const chats = (h.store.db.query('SELECT COUNT(*) AS n FROM chats').get() as { n: number }).n;
        const runs = (h.store.db.query('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n;

        expect(failure(h.send('task.start', { taskId: task.id }))).toMatchObject({ code: 'invalid', message: `Task ${ task.key } is archived: restore it first` });
        expect(failure(h.send('task.start', { taskId: task.id, force: true })).code).toBe('invalid');
        expect((h.store.db.query('SELECT COUNT(*) AS n FROM chats').get() as { n: number }).n).toBe(chats);
        expect((h.store.db.query('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n).toBe(runs);
        unarchive(task.id);
        h.ok('run.cancel', { runId: h.ok('task.start', { taskId: task.id }).runId });
    });

    test('an archived task is closed until it is restored: reopening it is refused, an edit that keeps it closed is not', () => {
        const { status, create, get, archive } = setup();
        const task = create('Closed', { statusId: status('done') });

        archive(task.id);
        expect(failure(h.send('task.update', { taskId: task.id, statusId: status('todo') }))).toMatchObject({ code: 'invalid', message: `Task ${ task.key } is archived: restore it before reopening it` });
        expect(get(task.id).statusId).toBe(status('done'));

        const edited = h.ok('task.update', { taskId: task.id, title: 'Renamed', statusId: status('canceled') }).task as Task;

        expect(edited).toMatchObject({ title: 'Renamed', statusId: status('canceled') });
        expect(get(task.id).archivedAt).toBeDefined();
    });

    test('an archived task is no parent for a task on the board, on create or on a move; an archived task can move under a live or an archived one', () => {
        const { status, create, get, archive } = setup();
        const epic = create('Epic', { statusId: status('done') });
        const live = create('Live');
        const other = create('Other epic', { statusId: status('done') });
        const closed = create('Closed', { statusId: status('done') });

        archive(epic.id);
        archive(other.id);

        const message = `Task ${ epic.key } is archived: restore it before putting tasks inside it`;

        expect(failure(h.send('task.create', { projectId: epic.projectId, title: 'New', parentId: epic.id }))).toMatchObject({ code: 'invalid', message });
        expect(failure(h.send('task.update', { taskId: live.id, parentId: epic.id }))).toMatchObject({ code: 'invalid', message });
        expect(get(live.id)).not.toHaveProperty('parentId');

        // An archived task moves under a live parent (it stays archived) or under another archived one.
        archive(closed.id);
        expect(h.ok('task.update', { taskId: closed.id, parentId: other.id }).task.parentId).toBe(other.id);
        expect(h.ok('task.update', { taskId: closed.id, parentId: live.id }).task).toMatchObject({ parentId: live.id, archivedAt: expect.any(Number) });
    });

    test('the tree rules still see the archived tasks: depth and loops are checked through them', () => {
        const { status, create, archive } = setup();
        const tasks: Task[] = [];

        for (let level = 1; level <= 8; level++) {
            tasks.push(create(`Level ${ level }`, { statusId: status('done'), ...(level > 1 && { parentId: tasks[level - 2].id }) }));
        }

        archive(tasks[0].id);

        const spare = create('Spare', { statusId: status('done') });

        archive(spare.id);
        expect(failure(h.send('task.update', { taskId: spare.id, parentId: tasks[7].id })).message).toContain('Too deep');
        expect(failure(h.send('task.update', { taskId: tasks[0].id, parentId: tasks[3].id })).message).toBe(`Task ${ tasks[3].key } is inside ${ tasks[0].key }, so it cannot be its parent`);
    });

    test('deleting an archived task works: its archived children go up to its parent and keep their archivedAt, the dependents lose the dependency, and nothing else is touched', () => {
        const { status, create, get, archive } = setup();
        const grand = create('Grandparent', { statusId: status('done') });
        const epic = create('Epic', { parentId: grand.id, statusId: status('done') });
        const stage = create('Stage', { parentId: epic.id, statusId: status('done') });
        const dependent = create('Dependent', { dependsOn: [epic.id] });

        archive(epic.id);

        const archivedAt = get(stage.id).archivedAt;
        const cursor = h.store.headCursor();

        h.ok('task.delete', { taskId: epic.id });

        expect(get(stage.id)).toMatchObject({ parentId: grand.id, archivedAt });
        expect(get(grand.id)).not.toHaveProperty('archivedAt');
        expect(getTask(h.store.db, epic.id)).toBeUndefined();
        expect(get(dependent.id).dependsOn).toEqual([]);
        expect(h.events(cursor).map(event => event.data)).toEqual([
            { type: 'task.upserted', task: get(dependent.id) },
            { type: 'task.upserted', task: get(stage.id) },
            { type: 'task.deleted', taskId: epic.id },
        ]);
        // The archived child under a live parent can come back by itself, since its parent is on the board.
        expect(h.ok('task.unarchive', { taskId: stage.id }).restored).toEqual([stage.id]);
    });

    test('deleting a live task whose child is archived leaves that child archived under the task\'s parent; deleting a root makes it a root', () => {
        const { status, create, get, archive } = setup();
        const root = create('Root');
        const middle = create('Middle', { parentId: root.id });
        const child = create('Child', { parentId: middle.id, statusId: status('done') });

        archive(child.id);
        h.ok('task.delete', { taskId: middle.id });
        expect(get(child.id)).toMatchObject({ parentId: root.id, archivedAt: expect.any(Number) });
        h.ok('task.delete', { taskId: root.id });
        expect(get(child.id)).not.toHaveProperty('parentId');
        expect(get(child.id).archivedAt).toBeDefined();
    });
});

describe('the archive route', () => {
    const page = async (projectId: string, query = '') => (await h.fetch(`/v1/projects/${ projectId }/archived-tasks${ query }`)).json() as Promise<TaskArchivePage>;

    test('an empty archive is an empty page, and a project\'s archive holds its own tasks only', async () => {
        const { project, status, create, archive } = setup();
        const other = setup('other');

        expect(await page(project.id)).toEqual({ tasks: [], total: 0 });
        create('Live');

        const mine = create('Mine', { statusId: status('done') });
        const theirs = h.ok('task.create', { projectId: other.project.id, title: 'Theirs', statusId: other.status('done') }).task as Task;

        archive(mine.id);
        other.archive(theirs.id);
        expect((await page(project.id)).tasks.map(task => task.id)).toEqual([mine.id]);
        expect((await page(other.project.id)).tasks.map(task => task.id)).toEqual([theirs.id]);
    });

    test('pages the archived tasks, the latest batch first and a batch by number, with the total and a cursor that ends on the last page', async () => {
        const { project, status, create, archive } = setup();
        const first = create('First epic', { statusId: status('done') });
        const firstChild = create('First child', { parentId: first.id, statusId: status('done') });
        const second = create('Second epic', { statusId: status('done') });
        const secondChild = create('Second child', { parentId: second.id, statusId: status('done') });
        const third = create('Third', { statusId: status('done') });

        create('Live, never archived');
        archive(first.id);
        archive(second.id);
        archive(third.id);

        const everything = await page(project.id);

        expect(everything.tasks.map(task => task.id)).toEqual([third.id, second.id, secondChild.id, first.id, firstChild.id]);
        expect(everything).toMatchObject({ total: 5 });
        expect(everything).not.toHaveProperty('nextCursor');
        expect(everything.tasks.every(task => typeof task.archivedAt === 'number')).toBe(true);

        const ids: string[] = [];
        let cursor: string | undefined;

        do {
            const next: TaskArchivePage = await page(project.id, `?limit=2${ cursor ? `&cursor=${ cursor }` : '' }`);

            expect(next.total).toBe(5);
            expect(next.tasks.length).toBeLessThanOrEqual(2);
            ids.push(...next.tasks.map(task => task.id));
            cursor = next.nextCursor;
        } while (cursor);

        expect(ids).toEqual(everything.tasks.map(task => task.id));
    });

    test('a task archived between two pages neither repeats nor shifts the rest, and the limit is kept between 1 and 100', async () => {
        const { project, status, create, archive } = setup();
        const tasks = Array.from({ length: 4 }, (_, index) => create(`Task ${ index }`, { statusId: status('done') }));

        for (const task of tasks) {
            archive(task.id);
        }

        const first = await page(project.id, '?limit=2');

        expect(first.tasks.map(task => task.id)).toEqual([tasks[3].id, tasks[2].id]);

        const newer = create('Newer', { statusId: status('done') });

        archive(newer.id);

        const second = await page(project.id, `?limit=2&cursor=${ first.nextCursor }`);

        expect(second.tasks.map(task => task.id)).toEqual([tasks[1].id, tasks[0].id]);
        expect(second.total).toBe(5);
        expect(second).not.toHaveProperty('nextCursor');
        expect((await page(project.id, '?limit=0')).tasks).toHaveLength(1);
        expect((await page(project.id, '?limit=1000')).tasks).toHaveLength(5);
        expect((await page(project.id)).tasks).toHaveLength(5);
    });

    test('the cursor and limit are checked, an unknown project is not found, and the route needs the token', async () => {
        const { project } = setup();

        expect((await h.fetch(`/v1/projects/${ project.id }/archived-tasks?limit=ten`)).status).toBe(400);
        expect((await h.fetch(`/v1/projects/${ project.id }/archived-tasks?limit=-1`)).status).toBe(400);
        expect((await h.fetch(`/v1/projects/${ project.id }/archived-tasks?cursor=nope`)).status).toBe(400);
        expect((await h.fetch('/v1/projects/prj_nope/archived-tasks')).status).toBe(404);
        expect((await fetch(`${ h.url }/v1/projects/${ project.id }/archived-tasks`)).status).toBe(401);
        expect((await fetch(`${ h.url }/v1/projects/${ project.id }/archived-tasks`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    });

    test('a task of the page is the whole task: its dependencies, parent and times', async () => {
        const { project, status, create, archive } = setup();
        const dependency = create('Dependency', { statusId: status('done') });
        const epic = create('Epic', { statusId: status('done'), dependsOn: [dependency.id] });
        const stage = create('Stage', { statusId: status('done'), parentId: epic.id });

        archive(epic.id);

        const { tasks } = await page(project.id);

        expect(tasks.find(task => task.id === epic.id)).toMatchObject({ key: epic.key, dependsOn: [dependency.id], closedAt: epic.closedAt, updatedAt: epic.updatedAt, createdAt: epic.createdAt });
        expect(tasks.find(task => task.id === stage.id)?.parentId).toBe(epic.id);
    });
});
