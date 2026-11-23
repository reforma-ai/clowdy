import { MAX_TASK_DEPTH } from '@clowdy/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_PERSONAL_PROJECT_ID, FIXTURE_PROJECT_ID } from './fixtureData';
import { FixtureTransport } from './fixtureTransport';

import type { ClowdyEvent, CommandResult, Task, TaskComment } from '@clowdy/protocol';
import type { CommandInput } from './transport';

/*
 * The fixture daemon must behave as the real one for the task rules, because the app's tests and the demo run on it. These tests state the daemon's rules
 * (`apps/daemon/test` has the originals) against the fixture: the checks, the messages, and the events in their order.
 */

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

async function connected() {
    const transport = new FixtureTransport();
    const { cursor } = await transport.getRootSnapshot();
    const events: ClowdyEvent[] = [];

    transport.subscribe(
        cursor,
        event => events.push(event),
        () => undefined
    );
    await vi.advanceTimersByTimeAsync(0);

    const send = async <T = Record<string, unknown>>(command: CommandInput) => {
        const result = await transport.command(command);

        await vi.advanceTimersByTimeAsync(0);

        return result as CommandResult<T>;
    };
    const snapshot = async () => transport.getProjectSnapshot(FIXTURE_PROJECT_ID);
    const task = async (id: string) => (await transport.getTaskDetail(id)).task;
    /** The events since the last call, as `type` or `type:id`, so a test reads the order. */
    const seen = () => {
        const names = events.map(event => {
            const { data } = event;

            if (data.type === 'task.upserted') return `task.upserted:${data.task.key}`;

            if (data.type === 'task.deleted') return `task.deleted:${data.taskId}`;

            if (data.type === 'task.comment.upserted') return `task.comment.upserted:${data.comment.id}`;

            if (data.type === 'task.comment.deleted') return `task.comment.deleted:${data.commentId}`;

            if (data.type === 'link.chatTask' || data.type === 'link.runTask')
                return `${data.type}:${data.link.taskId}:${data.present}`;

            return data.type;
        });

        events.length = 0;

        return names;
    };

    return { transport, events, send, snapshot, task, seen };
}

type Connected = Awaited<ReturnType<typeof connected>>;

const refusal = (result: CommandResult) =>
    result.ok ? undefined : { code: result.error.code, message: result.error.message };

const create = (title: string, rest: Partial<Extract<CommandInput, { type: 'task.create' }>> = {}): CommandInput => ({
    type: 'task.create',
    projectId: FIXTURE_PROJECT_ID,
    title,
    ...rest,
});

/** Makes a chain of tasks, each inside the one before, from `parentId` (or a root) down, and answers them in order. */
async function chain({ send }: Connected, length: number, parentId?: string): Promise<Task[]> {
    const made: Task[] = [];

    for (let level = 0; level < length; level++) {
        const result = await send<{ task: Task }>(
            create(`Level ${level + 1}`, { parentId: made.at(-1)?.id ?? parentId })
        );

        if (!result.ok) throw new Error(result.error.message);

        made.push(result.data.task);
    }

    return made;
}

describe('the demo data', () => {
    it('has a tree, a checklist, comments and an archived piece, and keeps the numbers of the board', async () => {
        const { snapshot, transport } = await connected();
        const { tasks } = await snapshot();
        const byNumber = new Map(tasks.map(task => [task.number, task]));

        expect(tasks.filter(task => task.number >= 20 && task.number <= 30)).toHaveLength(11);
        // Payments, the tasks inside it, and one of those with two inside it.
        expect(byNumber.get(31)?.parentId).toBeUndefined();
        expect([32, 35, 36, 37].map(number => byNumber.get(number)?.parentId)).toEqual([
            't-31',
            't-31',
            't-31',
            't-31',
        ]);
        expect([33, 34].map(number => byNumber.get(number)?.parentId)).toEqual(['t-32', 't-32']);
        expect(new Set(tasks.filter(task => task.number >= 31).map(task => task.statusId))).toEqual(
            new Set(['active', 'done', 'todo', 'review', 'canceled'])
        );
        expect(byNumber.get(35)?.description).toMatch(/^- \[x\] /m);
        expect(byNumber.get(35)?.description).toMatch(/^- \[ \] /m);
        // The archive is not on the board.
        expect(tasks.some(task => task.archivedAt !== undefined)).toBe(false);
        expect([38, 39, 40].map(number => byNumber.has(number))).toEqual([false, false, false]);
        expect((await transport.getArchivedTasks(FIXTURE_PROJECT_ID)).tasks.map(task => task.parentId)).toEqual([
            undefined,
            't-38',
            't-38',
        ]);
    });

    it("gives a closed task the time it closed, as the daemon's migration does", async () => {
        const { snapshot } = await connected();
        const { tasks } = await snapshot();
        const closed = tasks.filter(task => ['done', 'canceled'].includes(task.statusId));

        expect(closed.length).toBeGreaterThan(0);
        expect(closed.every(task => task.closedAt !== undefined)).toBe(true);
        expect(tasks.filter(task => !closed.includes(task)).every(task => task.closedAt === undefined)).toBe(true);
    });
});

describe('task.create', () => {
    it('answers { task }, puts the task under a parent of the same project, and announces it once', async () => {
        const { send, seen } = await connected();
        const result = await send<{ task: Task }>(create('Add the receipt', { parentId: 't-35' }));

        expect(result).toMatchObject({
            ok: true,
            data: { task: { key: 'CAR-41', parentId: 't-35', statusId: 'todo' } },
        });
        expect(seen()).toEqual(['task.upserted:CAR-41']);
    });

    it('numbers tasks with a counter: a refused task takes no number, and the number of a deleted task is not given out again', async () => {
        const { send } = await connected();

        expect(refusal(await send(create('Refused', { parentId: 't-nope' })))?.code).toBe('not_found');

        const first = await send<{ task: Task }>(create('First'));

        expect(first.ok && first.data.task.key).toBe('CAR-41');
        await send({ type: 'task.delete', taskId: first.ok ? first.data.task.id : '' });

        const second = await send<{ task: Task }>(create('Second'));

        expect(second.ok && second.data.task.key).toBe('CAR-42');
    });

    it("starts a task in the project's first Todo status, and in a given status of the project only", async () => {
        const { send } = await connected();

        expect(await send(create('One', { statusId: 'review' }))).toMatchObject({
            ok: true,
            data: { task: { statusId: 'review' } },
        });
        expect(refusal(await send(create('Two', { statusId: 'nope' })))).toEqual({
            code: 'invalid',
            message: 'Status nope does not belong to project p-car',
        });
    });

    it('sets closedAt when the task starts in a closed status, and not otherwise', async () => {
        const { send } = await connected();
        const now = Date.now();
        const done = await send<{ task: Task }>(create('Finished', { statusId: 'done' }));
        const canceled = await send<{ task: Task }>(create('Dropped', { statusId: 'canceled' }));
        const open = await send<{ task: Task }>(create('Waiting', { statusId: 'review' }));

        expect(done.ok && done.data.task.closedAt).toBe(now);
        expect(canceled.ok && canceled.data.task.closedAt).toBe(now);
        expect(open.ok && open.data.task.closedAt).toBeUndefined();
    });

    it('drops the whitespace around the title, and refuses a title with nothing in it', async () => {
        const { send } = await connected();

        expect(await send(create('  Pad the title \n'))).toMatchObject({
            ok: true,
            data: { task: { title: 'Pad the title' } },
        });
        expect(refusal(await send(create('   ')))).toEqual({
            code: 'invalid',
            message: 'The task title cannot be empty',
        });
    });

    it('refuses a parent that is no task, in another project, or archived', async () => {
        const { send, seen } = await connected();

        expect(refusal(await send(create('A', { parentId: 't-nope' })))).toEqual({
            code: 'not_found',
            message: 'Task t-nope does not exist',
        });
        expect(
            refusal(
                await send({
                    type: 'task.create',
                    projectId: FIXTURE_PERSONAL_PROJECT_ID,
                    title: 'B',
                    parentId: 't-24',
                })
            )
        ).toEqual({ code: 'invalid', message: 'Task CAR-24 belongs to another project' });
        expect(refusal(await send(create('C', { parentId: 't-38' })))).toEqual({
            code: 'invalid',
            message: 'Task CAR-38 is archived: restore it before putting tasks inside it',
        });
        expect(seen()).toEqual([]);
    });

    it('refuses a task that would make the tree deeper than MAX_TASK_DEPTH, naming the level it would reach', async () => {
        const connection = await connected();
        // Payments is level 1, Card checkout 2 and its two tasks 3: five more levels fill the tree.
        const made = await chain(connection, MAX_TASK_DEPTH - 3, 't-33');

        expect(made).toHaveLength(MAX_TASK_DEPTH - 3);

        const tooDeep = await connection.send(create('One too many', { parentId: made.at(-1)!.id }));

        expect(refusal(tooDeep)).toEqual({
            code: 'invalid',
            message: `Too deep: CAR-${40 + MAX_TASK_DEPTH - 2} under CAR-${40 + MAX_TASK_DEPTH - 3} would reach level ${MAX_TASK_DEPTH + 1}, and a tree has at most ${MAX_TASK_DEPTH} levels`,
        });
    });

    it('checks the dependencies like the daemon: the same project, and tasks that exist', async () => {
        const { send } = await connected();

        expect(await send(create('Needs two', { dependsOn: ['t-22', 't-22', 't-23'] }))).toMatchObject({
            ok: true,
            data: { task: { dependsOn: ['t-22', 't-23'] } },
        });
        expect(refusal(await send(create('Needs nothing real', { dependsOn: ['t-nope'] })))).toEqual({
            code: 'not_found',
            message: 'Task t-nope does not exist',
        });
        expect(
            refusal(
                await send({
                    type: 'task.create',
                    projectId: FIXTURE_PERSONAL_PROJECT_ID,
                    title: 'Other',
                    dependsOn: ['t-24'],
                })
            )
        ).toEqual({ code: 'invalid', message: 'Task CAR-24 belongs to another project' });
    });

    it('links the new task to the chat it is made in, after the task, and refuses a chat of another project', async () => {
        const { send, seen } = await connected();

        expect(await send(create('From chat', { chatId: 'c-1' }))).toMatchObject({ ok: true });
        expect(seen()).toEqual(['task.upserted:CAR-41', 'link.chatTask:t-101:true']);
        expect(
            refusal(
                await send({
                    type: 'task.create',
                    projectId: FIXTURE_PERSONAL_PROJECT_ID,
                    title: 'Elsewhere',
                    chatId: 'c-1',
                })
            )
        ).toEqual({ code: 'invalid', message: 'The chat belongs to another project' });
        expect(refusal(await send(create('Nowhere', { chatId: 'c-nope' })))).toEqual({
            code: 'not_found',
            message: 'Chat c-nope does not exist',
        });
    });
});

describe('task.update', () => {
    it('moves a task under another, with everything inside it, and detaches it with null', async () => {
        const { send, task, seen } = await connected();

        expect(await send({ type: 'task.update', taskId: 't-26', parentId: 't-35' })).toMatchObject({
            ok: true,
            data: { task: { id: 't-26', parentId: 't-35' } },
        });
        expect((await task('t-26')).parentId).toBe('t-35');
        expect(seen()).toEqual(['task.upserted:CAR-26']);

        // Moving the whole of Card checkout with its two tasks.
        expect(await send({ type: 'task.update', taskId: 't-32', parentId: 't-26' })).toMatchObject({ ok: true });
        expect((await task('t-33')).parentId).toBe('t-32');

        const detached = await send<{ task: Task }>({ type: 'task.update', taskId: 't-26', parentId: null });

        expect(detached.ok && 'parentId' in detached.data.task).toBe(false);
        expect((await task('t-26')).parentId).toBeUndefined();
    });

    it('leaves the parent as it is when the command does not name one, and does not announce a command that changes nothing', async () => {
        const { send, task, seen } = await connected();
        const before = await task('t-35');

        expect(await send({ type: 'task.update', taskId: 't-35', description: before.description })).toMatchObject({
            ok: true,
            data: { task: { parentId: 't-31' } },
        });
        expect(await send({ type: 'task.update', taskId: 't-35', parentId: 't-31' })).toMatchObject({ ok: true });
        expect(await send({ type: 'task.update', taskId: 't-35', title: before.title })).toMatchObject({ ok: true });
        expect(seen()).toEqual([]);
        expect(await task('t-35')).toEqual(before);
    });

    it('refuses a task as its own parent, one of its own descendants, a parent of another project and an archived one', async () => {
        const { send, task, seen } = await connected();

        expect(refusal(await send({ type: 'task.update', taskId: 't-32', parentId: 't-32' }))).toEqual({
            code: 'invalid',
            message: 'Task CAR-32 cannot be its own parent',
        });
        expect(refusal(await send({ type: 'task.update', taskId: 't-31', parentId: 't-33' }))).toEqual({
            code: 'invalid',
            message: 'Task CAR-33 is inside CAR-31, so it cannot be its parent',
        });
        expect(refusal(await send({ type: 'task.update', taskId: 't-24', parentId: 't-38' }))).toEqual({
            code: 'invalid',
            message: 'Task CAR-38 is archived: restore it before putting tasks inside it',
        });
        expect(refusal(await send({ type: 'task.update', taskId: 't-24', parentId: 't-nope' }))).toEqual({
            code: 'not_found',
            message: 'Task t-nope does not exist',
        });
        expect(seen()).toEqual([]);
        expect((await task('t-31')).parentId).toBeUndefined();
    });

    it('counts the levels inside the task being moved, so an epic cannot go under a deep task in one move', async () => {
        const connection = await connected();
        const { send, task } = connection;
        // A chain of seven levels: Payments (3 levels with its tasks) moved under the seventh would reach level 10.
        const made = await chain(connection, MAX_TASK_DEPTH - 1);
        const deepest = made.at(-1)!;

        expect(refusal(await send({ type: 'task.update', taskId: 't-31', parentId: deepest.id }))).toEqual({
            code: 'invalid',
            message: `Too deep: CAR-31 under CAR-${40 + MAX_TASK_DEPTH - 1} would reach level ${MAX_TASK_DEPTH + 2}, counting the 2 levels of tasks inside it, and a tree has at most ${MAX_TASK_DEPTH} levels`,
        });
        // A task with nothing inside it still fits as the last level.
        expect(await send({ type: 'task.update', taskId: 't-26', parentId: deepest.id })).toMatchObject({ ok: true });
        expect((await task('t-26')).parentId).toBe(deepest.id);
    });

    it('sets closedAt when a task enters a closed status, keeps it between two closed ones, and clears it when the task leaves', async () => {
        const { send, task } = await connected();

        vi.setSystemTime(new Date('2026-11-21T10:00:00Z'));
        expect((await task('t-26')).closedAt).toBeUndefined();

        await send({ type: 'task.update', taskId: 't-26', statusId: 'done' });
        expect((await task('t-26')).closedAt).toBe(Date.parse('2026-11-21T10:00:00Z'));

        vi.setSystemTime(new Date('2026-11-21T11:00:00Z'));
        await send({ type: 'task.update', taskId: 't-26', statusId: 'canceled' });
        expect((await task('t-26')).closedAt).toBe(Date.parse('2026-11-21T10:00:00Z'));

        await send({ type: 'task.update', taskId: 't-26', statusId: 'active' });
        expect('closedAt' in (await task('t-26'))).toBe(false);

        // An edit of something else leaves it alone, and so does a move between open statuses.
        await send({ type: 'task.update', taskId: 't-26', statusId: 'review' });
        expect((await task('t-26')).closedAt).toBeUndefined();
    });

    it('keeps the closing time through an edit of a closed task', async () => {
        const { send, task } = await connected();
        const { closedAt } = await task('t-22');

        await send({ type: 'task.update', taskId: 't-22', title: 'Renamed' });

        expect((await task('t-22')).closedAt).toBe(closedAt);
    });

    it('refuses to reopen an archived task, and lets it move from Done to Canceled', async () => {
        const { send } = await connected();

        expect(refusal(await send({ type: 'task.update', taskId: 't-39', statusId: 'todo' }))).toEqual({
            code: 'invalid',
            message: 'Task CAR-39 is archived: restore it before reopening it',
        });
        expect(await send({ type: 'task.update', taskId: 't-39', statusId: 'canceled' })).toMatchObject({
            ok: true,
            data: { task: { statusId: 'canceled' } },
        });
    });

    it('checks the title, the status and the dependencies', async () => {
        const { send } = await connected();

        expect(refusal(await send({ type: 'task.update', taskId: 't-26', title: '  ' }))).toEqual({
            code: 'invalid',
            message: 'The task title cannot be empty',
        });
        expect(refusal(await send({ type: 'task.update', taskId: 't-26', statusId: 'nope' }))).toEqual({
            code: 'invalid',
            message: 'Status nope does not belong to project p-car',
        });
        // CAR-22 already depends on CAR-21, so CAR-21 cannot depend on it.
        expect(refusal(await send({ type: 'task.update', taskId: 't-21', dependsOn: ['t-22'] }))).toEqual({
            code: 'invalid',
            message: 'Circular dependency: the task would depend on CAR-22, which already depends on it',
        });
        expect(refusal(await send({ type: 'task.update', taskId: 't-nope', title: 'x' }))).toEqual({
            code: 'not_found',
            message: 'Task t-nope does not exist',
        });
    });
});

describe('task.start', () => {
    /** The statuses the task is announced in, in order, since the call. */
    const statusesOf = (events: ClowdyEvent[], taskId: string) =>
        events.flatMap(event =>
            event.data.type === 'task.upserted' && event.data.task.id === taskId ? [event.data.task.statusId] : []
        );

    it('moves a task that waits to In progress when its run starts, and to Review when the run finishes: To do, and Backlog too', async () => {
        const { send, task, events } = await connected();

        await send({ type: 'task.start', taskId: 't-27' });
        await send({ type: 'task.start', taskId: 't-28' });

        expect([(await task('t-27')).statusId, (await task('t-28')).statusId]).toEqual(['active', 'active']);

        await vi.advanceTimersByTimeAsync(3000);

        expect([(await task('t-27')).statusId, (await task('t-28')).statusId]).toEqual(['review', 'review']);
        expect(statusesOf(events, 't-27')).toEqual(['active', 'review']);
    });

    it('leaves a task that is not waiting where it is when the run starts: in review, done or canceled', async () => {
        const { send, task, events } = await connected();
        const before = await Promise.all(['t-23', 't-22', 't-29'].map(async id => (await task(id)).statusId));

        for (const taskId of ['t-23', 't-22', 't-29']) await send({ type: 'task.start', taskId });

        await vi.advanceTimersByTimeAsync(3000);

        expect(before).toEqual(['review', 'done', 'canceled']);
        expect(await Promise.all(['t-23', 't-22', 't-29'].map(async id => (await task(id)).statusId))).toEqual(before);
        expect(['t-23', 't-22', 't-29'].flatMap(id => statusesOf(events, id))).toEqual([]);
    });

    it('keeps the closing time of a closed task that a run was started on', async () => {
        const { send, task } = await connected();
        const { closedAt } = await task('t-22');

        expect(closedAt).toBeDefined();

        await send({ type: 'task.start', taskId: 't-22' });
        await vi.advanceTimersByTimeAsync(3000);

        expect(await task('t-22')).toMatchObject({ statusId: 'done', closedAt });
    });

    it('leaves a task that is in progress there when the run starts, and moves it to Review when the run finishes', async () => {
        const { send, task, events } = await connected();

        expect((await task('t-25')).statusId).toBe('active');

        // An agent works on it already, so the second run is forced.
        await send({ type: 'task.start', taskId: 't-25', force: true });

        expect(statusesOf(events, 't-25')).toEqual([]);

        await vi.advanceTimersByTimeAsync(3000);

        expect(statusesOf(events, 't-25')).toEqual(['review']);
    });

    it('does not move a task to Review that someone took out of In progress while the run worked', async () => {
        const { send, task } = await connected();

        await send({ type: 'task.start', taskId: 't-27' });
        await send({ type: 'task.update', taskId: 't-27', statusId: 'done' });
        await vi.advanceTimersByTimeAsync(3000);

        expect((await task('t-27')).statusId).toBe('done');
        expect((await task('t-27')).closedAt).toBeDefined();
    });
});

describe('task.delete', () => {
    it('answers { taskId } and moves the tasks inside it up to its own parent, announcing them before the task', async () => {
        const { send, task, seen } = await connected();

        expect(await send({ type: 'task.delete', taskId: 't-32' })).toMatchObject({
            ok: true,
            data: { taskId: 't-32' },
        });
        expect([(await task('t-33')).parentId, (await task('t-34')).parentId]).toEqual(['t-31', 't-31']);
        expect(seen()).toEqual(['task.upserted:CAR-33', 'task.upserted:CAR-34', 'task.deleted:t-32']);
    });

    it('makes the tasks inside a root roots', async () => {
        const { send, task } = await connected();

        await send({ type: 'task.delete', taskId: 't-31' });

        for (const id of ['t-32', 't-35', 't-36', 't-37']) expect('parentId' in (await task(id))).toBe(false);

        expect((await task('t-33')).parentId).toBe('t-32');
    });

    it('moves an archived task inside it up too, and keeps it archived', async () => {
        const { send, task, snapshot } = await connected();

        await send({ type: 'task.delete', taskId: 't-38' });

        expect([(await task('t-39')).parentId, (await task('t-39')).archivedAt === undefined]).toEqual([
            undefined,
            false,
        ]);
        expect((await snapshot()).tasks.some(candidate => candidate.id === 't-39')).toBe(false);
    });

    it("announces the links that go and the tasks that lost a dependency, in the daemon's order", async () => {
        const { send, task, seen } = await connected();

        await send({ type: 'task.delete', taskId: 't-24' });

        // The chat link, the three run links (one that created it, two that work on it), then the tasks that depended on it (CAR-26 and CAR-27), then the task.
        expect(seen()).toEqual([
            'link.chatTask:t-24:false',
            'link.runTask:t-24:false',
            'link.runTask:t-24:false',
            'link.runTask:t-24:false',
            'task.upserted:CAR-26',
            'task.upserted:CAR-27',
            'task.deleted:t-24',
        ]);
        expect((await task('t-26')).dependsOn).toEqual(['t-25']);
        expect((await task('t-27')).dependsOn).toEqual([]);
    });

    it('takes the comments of the task with it, announced by task.deleted alone', async () => {
        const { send, seen, transport } = await connected();

        await send({ type: 'task.delete', taskId: 't-32' });

        expect(seen()).not.toContain('task.comment.deleted:cmt_A001');
        await expect(transport.getTaskComments('t-32')).rejects.toMatchObject({ status: 404 });
    });

    it('refuses a task that is not there', async () => {
        const { send } = await connected();

        expect(refusal(await send({ type: 'task.delete', taskId: 't-nope' }))).toEqual({
            code: 'not_found',
            message: 'Task t-nope does not exist',
        });
    });
});

describe('task.archive', () => {
    it('refuses a task with open work inside it, naming the open tasks, unless cancel closes them', async () => {
        const { send, seen } = await connected();
        const refused = refusal(await send({ type: 'task.archive', taskId: 't-31' }));

        expect(refused).toEqual({
            code: 'invalid',
            message:
                'CAR-31 (In progress), CAR-32 (In progress), CAR-35 (To do), CAR-36 (Review), CAR-34 (To do) are not closed: close them first, or archive with cancel',
        });
        expect(refusal(await send({ type: 'task.archive', taskId: 't-26' }))).toEqual({
            code: 'invalid',
            message: 'CAR-26 (To do) is not closed: close it first, or archive with cancel',
        });
        expect(seen()).toEqual([]);
    });

    it('names five open tasks and counts the rest', async () => {
        const { send } = await connected();

        await send(create('Another stage', { parentId: 't-31' }));

        expect(refusal(await send({ type: 'task.archive', taskId: 't-31' }))?.message).toMatch(
            /\(To do\) and 1 more are not closed: close them first, or archive with cancel$/
        );
    });

    it('archives a closed task with the tasks inside it, with one archivedAt, one event each, and answers who went', async () => {
        const { send, snapshot, task, seen } = await connected();

        await send({ type: 'task.update', taskId: 't-32', statusId: 'done' });
        await send({ type: 'task.update', taskId: 't-34', statusId: 'done' });
        seen();

        const result = await send<{ task: Task; archived: string[]; canceled: string[] }>({
            type: 'task.archive',
            taskId: 't-32',
        });

        expect(result).toMatchObject({
            ok: true,
            data: { task: { id: 't-32' }, archived: ['t-32', 't-33', 't-34'], canceled: [] },
        });
        expect(seen()).toEqual(['task.upserted:CAR-32', 'task.upserted:CAR-33', 'task.upserted:CAR-34']);

        const stamps = await Promise.all(['t-32', 't-33', 't-34'].map(async id => (await task(id)).archivedAt));

        expect(stamps[0]).toBeDefined();
        expect(new Set(stamps).size).toBe(1);
        expect((await snapshot()).tasks.some(candidate => ['t-32', 't-33', 't-34'].includes(candidate.id))).toBe(false);
        // Nothing but the archive changed, and a closed task keeps its place in the tree.
        expect((await task('t-33')).parentId).toBe('t-32');
    });

    it('moves the open tasks to the first Canceled status with cancel, one event each with its final state', async () => {
        const { send, snapshot, task, seen } = await connected();
        const result = await send<{ archived: string[]; canceled: string[] }>({
            type: 'task.archive',
            taskId: 't-31',
            cancel: true,
        });

        expect(result).toMatchObject({
            ok: true,
            data: {
                archived: ['t-31', 't-32', 't-35', 't-36', 't-37', 't-33', 't-34'],
                canceled: ['t-31', 't-32', 't-35', 't-36', 't-34'],
            },
        });
        expect(seen()).toEqual([
            'task.upserted:CAR-31',
            'task.upserted:CAR-32',
            'task.upserted:CAR-35',
            'task.upserted:CAR-36',
            'task.upserted:CAR-37',
            'task.upserted:CAR-33',
            'task.upserted:CAR-34',
        ]);

        const states = await Promise.all(['t-31', 't-33', 't-34', 't-37'].map(task));

        // The open ones are Canceled now and closed; the done one stays done; the canceled one keeps its time.
        expect(states.map(state => state.statusId)).toEqual(['canceled', 'done', 'canceled', 'canceled']);
        expect(states.every(state => state.closedAt !== undefined && state.archivedAt !== undefined)).toBe(true);
        expect((await snapshot()).tasks.filter(candidate => candidate.number >= 31)).toEqual([]);
    });

    it('is idempotent: a task in the archive is answered with nothing archived, and nothing is announced', async () => {
        const { send, seen } = await connected();

        expect(await send({ type: 'task.archive', taskId: 't-38' })).toMatchObject({
            ok: true,
            data: { task: { id: 't-38' }, archived: [], canceled: [] },
        });
        expect(seen()).toEqual([]);
    });

    it('refuses while a run works on the task, whatever cancel says, and changes nothing', async () => {
        const { send, task, seen } = await connected();

        expect(refusal(await send({ type: 'task.archive', taskId: 't-24', cancel: true }))).toEqual({
            code: 'conflict',
            message: 'Task CAR-24 has an active run (Orchestrator 01): stop it first',
        });
        expect(seen()).toEqual([]);
        expect((await task('t-24')).archivedAt).toBeUndefined();
    });

    it('refuses while a run works on a task inside it, and says which', async () => {
        const { send, task, seen } = await connected();

        await send({ type: 'task.update', taskId: 't-24', parentId: 't-31' });
        seen();

        expect(refusal(await send({ type: 'task.archive', taskId: 't-31', cancel: true }))).toEqual({
            code: 'conflict',
            message: 'Task CAR-24, inside CAR-31, has an active run (Orchestrator 01): stop it first',
        });
        expect(seen()).toEqual([]);
        expect((await task('t-31')).archivedAt).toBeUndefined();
    });

    it('does not count a run that only created the task, or one that has finished', async () => {
        const { send } = await connected();

        // r-orch-1 created CAR-21 and works on others: only an assigned, unfinished run counts.
        expect(await send({ type: 'task.archive', taskId: 't-21' })).toMatchObject({ ok: true });
        // r-orch-2 is assigned to CAR-20 and has finished.
        expect(await send({ type: 'task.archive', taskId: 't-20' })).toMatchObject({ ok: true });
    });

    it('gives two batches different times even in the same millisecond, so a restore cannot pick up a neighbour', async () => {
        const { send, task } = await connected();

        await send({ type: 'task.archive', taskId: 't-21' });
        await send({ type: 'task.archive', taskId: 't-22' });

        const [first, second] = [(await task('t-21')).archivedAt!, (await task('t-22')).archivedAt!];

        expect(second).toBeGreaterThan(first);
    });

    it('leaves a task inside it that was archived on its own with its own time', async () => {
        const { send, task } = await connected();

        await send({ type: 'task.archive', taskId: 't-33' });

        const own = (await task('t-33')).archivedAt;
        const result = await send<{ archived: string[] }>({ type: 'task.archive', taskId: 't-32', cancel: true });

        expect(result).toMatchObject({ ok: true, data: { archived: ['t-32', 't-34'] } });
        expect((await task('t-33')).archivedAt).toBe(own);
        expect((await task('t-32')).archivedAt).toBeGreaterThan(own!);
    });

    it('keeps updatedAt of a task that was closed already, and moves it for one that cancel closed', async () => {
        const { send, task } = await connected();
        const before = [(await task('t-33')).updatedAt, (await task('t-34')).updatedAt];

        vi.setSystemTime(Date.now() + 60_000);
        await send({ type: 'task.archive', taskId: 't-32', cancel: true });

        expect((await task('t-33')).updatedAt).toBe(before[0]);
        expect((await task('t-34')).updatedAt).toBeGreaterThan(before[1]);
    });

    it('refuses a task that is not there', async () => {
        const { send } = await connected();

        expect(refusal(await send({ type: 'task.archive', taskId: 't-nope' }))).toEqual({
            code: 'not_found',
            message: 'Task t-nope does not exist',
        });
    });

    it('keeps archived tasks in the detail, in the count of what a project holds, and out of the snapshot', async () => {
        const { send, snapshot, transport } = await connected();

        await send({ type: 'task.archive', taskId: 't-21' });

        expect((await transport.getTaskDetail('t-21')).task).toMatchObject({
            id: 't-21',
            archivedAt: expect.any(Number),
        });
        expect((await snapshot()).tasks.some(task => task.id === 't-21')).toBe(false);
        // Deleting the project takes the archive too, so it counts.
        expect((await transport.getProjectsInfo()).find(info => info.projectId === FIXTURE_PROJECT_ID)?.tasks).toBe(21);
        // And the links of the archived task stay in the snapshot, whose store ignores them.
        expect((await snapshot()).chatTaskLinks).toContainEqual({ chatId: 'c-1', taskId: 't-21' });
    });

    it('refuses a run on an archived task until it is restored', async () => {
        const { send } = await connected();

        expect(refusal(await send({ type: 'task.start', taskId: 't-38' }))).toEqual({
            code: 'invalid',
            message: 'Task CAR-38 is archived: restore it first',
        });

        await send({ type: 'task.unarchive', taskId: 't-38' });

        expect(await send({ type: 'task.start', taskId: 't-38' })).toMatchObject({ ok: true });
    });
});

describe('task.unarchive', () => {
    it('brings back the task with the tasks that were archived with it, announcing each without archivedAt', async () => {
        const { send, snapshot, seen } = await connected();
        const result = await send<{ task: Task; restored: string[] }>({ type: 'task.unarchive', taskId: 't-38' });

        expect(result).toMatchObject({ ok: true, data: { restored: ['t-38', 't-39', 't-40'] } });
        expect(result.ok && 'archivedAt' in result.data.task).toBe(false);
        expect(seen()).toEqual(['task.upserted:CAR-38', 'task.upserted:CAR-39', 'task.upserted:CAR-40']);
        expect((await snapshot()).tasks.filter(task => task.number >= 38).map(task => task.parentId)).toEqual([
            undefined,
            't-38',
            't-38',
        ]);
    });

    it('is refused while the parent is archived, naming it', async () => {
        const { send, seen } = await connected();

        expect(refusal(await send({ type: 'task.unarchive', taskId: 't-39' }))).toEqual({
            code: 'invalid',
            message: 'Task CAR-39 is inside CAR-38, which is archived: restore CAR-38 first',
        });
        expect(seen()).toEqual([]);
    });

    it('is idempotent for a task that is not archived', async () => {
        const { send, seen } = await connected();

        expect(await send({ type: 'task.unarchive', taskId: 't-24' })).toMatchObject({
            ok: true,
            data: { task: { id: 't-24' }, restored: [] },
        });
        expect(seen()).toEqual([]);
    });

    it('restores only its own batch: a task archived on its own earlier stays in the archive', async () => {
        const { send, task } = await connected();

        await send({ type: 'task.archive', taskId: 't-33' });
        await send({ type: 'task.archive', taskId: 't-32', cancel: true });

        const result = await send<{ restored: string[] }>({ type: 'task.unarchive', taskId: 't-32' });

        expect(result).toMatchObject({ ok: true, data: { restored: ['t-32', 't-34'] } });
        expect((await task('t-33')).archivedAt).toBeDefined();
        expect((await task('t-34')).archivedAt).toBeUndefined();
    });

    it('does not follow a task with the same time that was moved under another archived task since', async () => {
        const { send, task } = await connected();

        // Archive Payments' CAR-35 and CAR-36 together, then move CAR-36 under the archived CAR-39: it is archived under another batch's task now.
        await send({ type: 'task.update', taskId: 't-35', statusId: 'done' });
        await send({ type: 'task.update', taskId: 't-36', statusId: 'done', parentId: 't-35' });
        await send({ type: 'task.archive', taskId: 't-35' });
        await send({ type: 'task.update', taskId: 't-36', parentId: 't-39' });

        const result = await send<{ restored: string[] }>({ type: 'task.unarchive', taskId: 't-35' });

        expect(result).toMatchObject({ ok: true, data: { restored: ['t-35'] } });
        expect((await task('t-36')).archivedAt).toBeDefined();
    });
});

describe('task comments', () => {
    it('adds a comment of the person, answers { comment } and announces it', async () => {
        const { send, seen } = await connected();
        const result = await send<{ comment: TaskComment }>({
            type: 'task.comment.add',
            taskId: 't-24',
            body: 'Looks **good**\n\n',
        });

        expect(result).toMatchObject({
            ok: true,
            data: { comment: { taskId: 't-24', author: { kind: 'user' }, body: 'Looks **good**' } },
        });
        expect(result.ok && result.data.comment).not.toHaveProperty('editedAt');
        expect(result.ok && result.data.comment.id).toMatch(/^cmt_[0-9A-Z]+$/);
        expect(seen()).toEqual([`task.comment.upserted:${result.ok ? result.data.comment.id : ''}`]);
    });

    it('refuses an empty comment, and a task that is not there', async () => {
        const { send, seen } = await connected();

        expect(refusal(await send({ type: 'task.comment.add', taskId: 't-24', body: ' \n ' }))).toEqual({
            code: 'invalid',
            message: 'A comment cannot be empty',
        });
        expect(refusal(await send({ type: 'task.comment.add', taskId: 't-nope', body: 'x' }))).toEqual({
            code: 'not_found',
            message: 'Task t-nope does not exist',
        });
        expect(seen()).toEqual([]);
    });

    it('edits the body and stamps editedAt, once; the same body is no edit', async () => {
        const { send, seen } = await connected();

        vi.setSystemTime(new Date('2026-11-21T12:00:00Z'));

        const edited = await send<{ comment: TaskComment }>({
            type: 'task.comment.edit',
            taskId: 't-32',
            commentId: 'cmt_A001',
            body: 'Use the live keys now.  ',
        });

        expect(edited).toMatchObject({
            ok: true,
            data: {
                comment: {
                    id: 'cmt_A001',
                    body: 'Use the live keys now.',
                    editedAt: Date.parse('2026-11-21T12:00:00Z'),
                },
            },
        });
        expect(seen()).toEqual(['task.comment.upserted:cmt_A001']);

        vi.setSystemTime(new Date('2026-11-21T13:00:00Z'));

        const same = await send<{ comment: TaskComment }>({
            type: 'task.comment.edit',
            taskId: 't-32',
            commentId: 'cmt_A001',
            body: 'Use the live keys now.',
        });

        expect(same.ok && same.data.comment.editedAt).toBe(Date.parse('2026-11-21T12:00:00Z'));
        expect(seen()).toEqual([]);
    });

    it("lets the person edit any comment, an agent's too, and keeps its author", async () => {
        const { send } = await connected();

        expect(
            await send({ type: 'task.comment.edit', taskId: 't-32', commentId: 'cmt_A002', body: 'Fixed' })
        ).toMatchObject({ ok: true, data: { comment: { author: { kind: 'run', runId: 'r-orch-1' } } } });
    });

    it('refuses to edit with an empty body, a comment the task does not have, or one of another task', async () => {
        const { send } = await connected();

        expect(
            refusal(await send({ type: 'task.comment.edit', taskId: 't-32', commentId: 'cmt_A001', body: '' }))
        ).toEqual({ code: 'invalid', message: 'A comment cannot be empty' });
        expect(
            refusal(await send({ type: 'task.comment.edit', taskId: 't-32', commentId: 'cmt_nope', body: 'x' }))
        ).toEqual({ code: 'not_found', message: 'Comment cmt_nope does not exist' });
        expect(
            refusal(await send({ type: 'task.comment.edit', taskId: 't-24', commentId: 'cmt_A001', body: 'x' }))
        ).toEqual({ code: 'not_found', message: 'Comment cmt_A001 does not exist' });
    });

    it('deletes a comment, answers { taskId, commentId } and announces it', async () => {
        const { send, seen, transport } = await connected();

        expect(await send({ type: 'task.comment.delete', taskId: 't-32', commentId: 'cmt_A002' })).toMatchObject({
            ok: true,
            data: { taskId: 't-32', commentId: 'cmt_A002' },
        });
        expect(seen()).toEqual(['task.comment.deleted:cmt_A002']);
        expect((await transport.getTaskComments('t-32')).comments.map(comment => comment.id)).toEqual([
            'cmt_A001',
            'cmt_A003',
        ]);
        expect(refusal(await send({ type: 'task.comment.delete', taskId: 't-32', commentId: 'cmt_A002' }))).toEqual({
            code: 'not_found',
            message: 'Comment cmt_A002 does not exist',
        });
        expect(refusal(await send({ type: 'task.comment.delete', taskId: 't-24', commentId: 'cmt_A001' }))).toEqual({
            code: 'not_found',
            message: 'Comment cmt_A001 does not exist',
        });
    });

    it('lists comments oldest first even when several come in the same millisecond, and pages them from 25 at a time', async () => {
        const { send, transport } = await connected();

        for (let index = 1; index <= 30; index++)
            await send({ type: 'task.comment.add', taskId: 't-24', body: `Note ${index}` });

        const first = await transport.getTaskComments('t-24');

        expect(first.comments.map(comment => comment.body)).toEqual(
            Array.from({ length: 25 }, (_, index) => `Note ${index + 1}`)
        );
        expect(first.total).toBe(30);
        expect(first.nextCursor).toBeDefined();

        const second = await transport.getTaskComments('t-24', { cursor: first.nextCursor });

        expect(second.comments.map(comment => comment.body)).toEqual(
            Array.from({ length: 5 }, (_, index) => `Note ${index + 26}`)
        );
        expect(second.nextCursor).toBeUndefined();
    });

    it('sees a comment added between two pages on the page it belongs to, without repeating or skipping one', async () => {
        const { send, transport } = await connected();
        const first = await transport.getTaskComments('t-32', { limit: 1 });

        vi.setSystemTime(Date.now() + 1000);
        await send({ type: 'task.comment.add', taskId: 't-32', body: 'Later' });

        const rest = await transport.getTaskComments('t-32', { cursor: first.nextCursor });

        expect(rest.comments.map(comment => comment.id).slice(0, 2)).toEqual(['cmt_A002', 'cmt_A003']);
        expect(rest.comments.at(-1)?.body).toBe('Later');
    });
});
