import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanTempDirs, git, Harness, makeRepo, startHarness, tempDir } from './helpers';

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

describe('idempotency', () => {
    test('a repeated requestId returns the first result without acting twice', () => {
        const { id } = h.openRepo();
        const first = h.send('chat.create', { requestId: 'req-idempotent-1', projectId: id, title: 'Once' });
        const second = h.send('chat.create', { requestId: 'req-idempotent-1', projectId: id, title: 'Twice' });

        expect(second).toEqual(first);
        expect((h.store.db.query('SELECT COUNT(*) AS n FROM chats').get() as { n: number }).n).toBe(1);
        expect(h.events().filter(event => event.data.type === 'chat.upserted')).toHaveLength(1);
    });

    test('a failed command is remembered too, and leaves no effects', () => {
        const { id } = h.openRepo();
        const bad = { requestId: 'req-failing-0001', projectId: id, title: 'T', dependsOn: ['tsk_missing'] };
        const cursor = h.store.headCursor();
        const first = h.send('task.create', bad);

        expect(failure(first).code).toBe('not_found');
        expect(h.send('task.create', bad)).toEqual(first);
        expect(h.store.headCursor()).toBe(cursor);
        expect((h.store.db.query('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n).toBe(0);
    });

    test('the result is stored in the commands table', () => {
        const { id } = h.openRepo();

        h.send('chat.create', { requestId: 'req-stored-0001', projectId: id });

        const row = h.store.db.query('SELECT result FROM commands WHERE request_id = ?').get('req-stored-0001') as { result: string };

        expect(JSON.parse(row.result)).toMatchObject({ ok: true, requestId: 'req-stored-0001' });
    });
});

describe('projects', () => {
    test('project.open derives the name and prefix, creates default statuses, and is idempotent per path', () => {
        const path = makeRepo(h.config.projectsDir, 'car-rental');
        const { project } = h.ok('project.open', { path });
        const again = h.ok('project.open', { path });

        expect(project).toMatchObject({ name: 'car-rental', taskPrefix: 'CAR', settings: {} });
        expect(again.project.id).toBe(project.id);

        const created = h.events().filter(event => event.data.type === 'project.upserted');

        expect(created).toHaveLength(1);
        expect((created[0].data as { statuses: { name: string; category: string }[] }).statuses.map(status => [status.name, status.category])).toEqual([
            ['To do', 'todo'], ['In progress', 'active'], ['Review', 'review'], ['Done', 'done'], ['Canceled', 'canceled'],
        ]);
    });

    test('project.open takes an explicit name and rejects folders that are not repository roots', () => {
        const path = makeRepo(h.config.projectsDir, 'named');

        expect(h.ok('project.open', { path, name: 'Fancy Name' }).project).toMatchObject({ name: 'Fancy Name', taskPrefix: 'FAN' });

        const plain = join(tempDir(), 'plain');

        mkdirSync(plain);
        expect(failure(h.send('project.open', { path: plain }))).toMatchObject({ code: 'invalid' });
        expect(failure(h.send('project.open', { path: join(path, 'missing') })).code).toBe('invalid');
        expect(failure(h.send('project.open', { path: 'relative/path' })).code).toBe('invalid');

        mkdirSync(join(path, 'src'));
        expect(failure(h.send('project.open', { path: join(path, 'src') })).message).toContain('repository root');
    });

    test('project.create makes a kebab-case folder, a main branch, and a first empty commit', () => {
        const { project } = h.ok('project.create', { name: 'My New App!' });

        expect(project.path).toEndWith(join('projects', 'my-new-app'));
        expect(project.name).toBe('My New App!');
        expect(git(project.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
        expect(git(project.path, 'rev-list', '--count', 'HEAD')).toBe('1');
        expect(git(project.path, 'log', '-1', '--format=%s')).toBe('Initial commit');
    });

    test('project.create reuses an empty folder, accepts a full path, and never touches a non-empty one', () => {
        const empty = join(tempDir(), 'empty');

        mkdirSync(empty);
        expect(h.ok('project.create', { name: 'x', path: empty }).project.path).toEndWith('empty');

        const occupied = join(tempDir(), 'occupied');

        mkdirSync(occupied);
        writeFileSync(join(occupied, 'keep.txt'), 'precious');
        expect(failure(h.send('project.create', { name: 'y', path: occupied })).code).toBe('conflict');
        expect(readFileSync(join(occupied, 'keep.txt'), 'utf8')).toBe('precious');
        expect(existsSync(join(occupied, '.git'))).toBe(false);

        expect(failure(h.send('project.create', { name: 'x', path: empty })).code).toBe('conflict');
    });

    test('project.update renames and merges settings', () => {
        const { id } = h.openRepo();

        h.ok('project.update', { projectId: id, name: 'Renamed', settings: { maxParallelRuns: 2, engine: 'fake' } });

        const { project } = h.ok('project.update', { projectId: id, settings: { targetBranch: 'develop' } });

        expect(project).toMatchObject({ name: 'Renamed', settings: { maxParallelRuns: 2, engine: 'fake', targetBranch: 'develop' } });
        expect(failure(h.send('project.update', { projectId: 'prj_nope', name: 'x' })).code).toBe('not_found');
    });
});

describe('chats', () => {
    test('create, rename, set mode', () => {
        const { id } = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: id });

        expect(chat).toMatchObject({ title: 'New chat', mode: 'autopilot' });
        expect(h.ok('chat.rename', { chatId: chat.id, title: '  Booking  ' }).chat.title).toBe('Booking');
        expect(h.ok('chat.setMode', { chatId: chat.id, mode: 'semi' }).chat.mode).toBe('semi');
        expect(failure(h.send('chat.create', { projectId: 'prj_nope' })).code).toBe('not_found');
        expect(failure(h.send('chat.rename', { chatId: chat.id, title: '   ' })).code).toBe('invalid');
    });
});

describe('tasks', () => {
    const setup = () => {
        const { id } = h.openRepo();

        return { projectId: id, create: (title: string, extra: Record<string, unknown> = {}) => h.ok('task.create', { projectId: id, title, ...extra }).task };
    };

    test('numbers and keys are per project and start in the todo status', () => {
        const { projectId, create } = setup();
        const other = h.openRepo('other');
        const first = create('First');
        const second = create('Second');
        const foreign = h.ok('task.create', { projectId: other.id, title: 'Foreign' }).task;
        const statuses = (h.events()[0].data as { statuses: { id: string; name: string }[] }).statuses;

        expect([first.key, second.key, foreign.key]).toEqual(['REP-1', 'REP-2', 'OTH-1']);
        expect(first.statusId).toBe(statuses.find(status => status.name === 'To do')?.id);
        expect(projectId).toBeTruthy();
    });

    test('task.create validates the status, the chat, and the dependencies', () => {
        const { projectId, create } = setup();
        const other = h.openRepo('other');
        const foreignTask = h.ok('task.create', { projectId: other.id, title: 'Foreign' }).task;
        const foreignChat = h.ok('chat.create', { projectId: other.id }).chat;

        expect(failure(h.send('task.create', { projectId, title: 'x', statusId: 'sts_nope' })).code).toBe('invalid');
        expect(failure(h.send('task.create', { projectId, title: 'x', chatId: foreignChat.id })).code).toBe('invalid');
        expect(failure(h.send('task.create', { projectId, title: 'x', dependsOn: [foreignTask.id] })).code).toBe('invalid');
        expect(create('ok').dependsOn).toEqual([]);
    });

    test('task.create with a chat links them and publishes the link', () => {
        const { projectId, create } = setup();
        const { chat } = h.ok('chat.create', { projectId });
        const task = create('Linked', { chatId: chat.id });

        expect(h.events().filter(event => event.data.type === 'link.chatTask').map(event => event.data)).toEqual([
            { type: 'link.chatTask', link: { chatId: chat.id, taskId: task.id }, present: true },
        ]);
    });

    test('dependency cycles are rejected, including through other tasks and on itself', () => {
        const { create } = setup();
        const a = create('A');
        const b = create('B', { dependsOn: [a.id] });
        const c = create('C', { dependsOn: [b.id] });

        expect(failure(h.send('task.update', { taskId: a.id, dependsOn: [c.id] })).message).toContain('Circular');
        expect(failure(h.send('task.update', { taskId: a.id, dependsOn: [b.id] })).code).toBe('invalid');
        expect(failure(h.send('task.update', { taskId: a.id, dependsOn: [a.id] })).code).toBe('invalid');
        expect(h.ok('task.update', { taskId: c.id, dependsOn: [a.id, b.id] }).task.dependsOn).toEqual([a.id, b.id]);
        expect(h.ok('task.update', { taskId: a.id, title: 'A2' }).task.dependsOn).toEqual([]);
    });

    test('task.update changes fields, validates the status, and publishes only real changes', () => {
        const { projectId, create } = setup();
        const task = create('Old');
        const done = (h.events()[0].data as { statuses: { id: string; category: string }[] }).statuses.find(status => status.category === 'done')!.id;
        const cursor = h.store.headCursor();

        expect(h.ok('task.update', { taskId: task.id, title: 'New', description: 'Body', statusId: done }).task).toMatchObject({ title: 'New', description: 'Body', statusId: done });
        expect(h.store.headCursor()).toBe(cursor + 1);
        h.ok('task.update', { taskId: task.id, title: 'New' });
        expect(h.store.headCursor()).toBe(cursor + 1);
        expect(failure(h.send('task.update', { taskId: task.id, statusId: 'sts_nope' })).code).toBe('invalid');
        expect(projectId).toBeTruthy();
    });

    test('task.delete removes the links and the dependency edges, and publishes each removal', () => {
        const { projectId, create } = setup();
        const { chat } = h.ok('chat.create', { projectId });
        const a = create('A', { chatId: chat.id });
        const b = create('B', { dependsOn: [a.id] });
        const cursor = h.store.headCursor();

        h.ok('task.delete', { taskId: a.id });

        const types = h.events(cursor).map(event => event.data);

        expect(types).toEqual([
            { type: 'link.chatTask', link: { chatId: chat.id, taskId: a.id }, present: false },
            { type: 'task.upserted', task: expect.objectContaining({ id: b.id, dependsOn: [] }) },
            { type: 'task.deleted', taskId: a.id },
        ]);
        expect((h.store.db.query('SELECT COUNT(*) AS n FROM chat_task_links').get() as { n: number }).n).toBe(0);
        expect((h.store.db.query('SELECT COUNT(*) AS n FROM task_deps').get() as { n: number }).n).toBe(0);
        expect(failure(h.send('task.delete', { taskId: a.id })).code).toBe('not_found');
    });

    test('the task detail lists chats, runs and artifacts', async () => {
        const { projectId, create } = setup();
        const { chat } = h.ok('chat.create', { projectId });
        const task = create('Detail', { chatId: chat.id });
        const { runId, chatId } = h.ok('task.start', { taskId: task.id });
        const detail = await (await h.fetch(`/v1/tasks/${ task.id }/detail`)).json();

        // Starting a task opens its own chat next to the one that discussed it.
        expect(detail).toEqual({ taskId: task.id, chatIds: [chat.id, chatId], runIds: [runId], artifacts: [] });
        expect((await h.fetch('/v1/tasks/tsk_nope/detail')).status).toBe(404);
    });
});
