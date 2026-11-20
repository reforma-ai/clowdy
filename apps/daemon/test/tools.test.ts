import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { getProject } from '../src/db/projects';
import { toolsFor } from '../src/runs/tools';
import { cleanTempDirs, latch, ScriptEngine, scriptEngines, startHarness, waitFor } from './helpers';

import type { Run } from '@clowdy/protocol';
import type { Harness, Script } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

/** A session that holds until the test releases it, then ends. The runs of these tests use it to stay alive. */
function holding(hold = latch()): { script: Script; hold: ReturnType<typeof latch> } {
    return {
        hold,
        script: async function* ({ options, number }) {
            yield { type: 'session', sessionId: `s-${ number }` };
            await hold.wait(options.signal);
            yield { type: 'done', result: 'finished' };
        },
    };
}

async function setup(script: Script = holding().script, overrides: Parameters<typeof startHarness>[0] = {}, mode?: 'semi') {
    const engine = new ScriptEngine(script);
    const h = await startHarness(overrides, { engines: scriptEngines(engine) });

    harnesses.push(h);

    const project = h.openRepo();
    const { chat } = h.ok('chat.create', { projectId: project.id, mode });
    const { store, runs, threads } = h.daemon.services;
    const entity = getProject(store.db, project.id)!;
    const orchestrator = runs.createRun({ project: entity, role: 'orchestrator', chatId: chat.id, summary: 'Plan' });
    const toolsOf = (run: Run) => toolsFor({ store, runs, threads }, run, runs.modeOf(run));
    const exec = async (run: Run, name: string, input: unknown = {}): Promise<any> => {
        const tool = toolsOf(run).find(candidate => candidate.name === name);

        if (!tool) {
            throw new Error(`${ run.name } has no ${ name } tool`);
        }

        return tool.execute(input, new AbortController().signal);
    };
    const task = async (title: string, extra: Record<string, unknown> = {}) => (await exec(orchestrator, 'task_create', { title, ...extra })).task;

    return { h, engine, project, chat, entity, orchestrator, toolsOf, exec, task };
}

describe('the tool vocabulary', () => {
    test('an orchestrator has the task tools, the thread tools, and ask_user only in semi-manual', async () => {
        const { orchestrator, toolsOf } = await setup();
        const names = (run: Run) => toolsOf(run).map(tool => tool.name);
        const threads = ['thread_spawn', 'thread_tell', 'thread_stop', 'thread_wait', 'thread_output', 'thread_log', 'thread_list'];

        expect(names(orchestrator)).toEqual(['task_get', 'task_list', 'task_create', 'task_update', ...threads]);

        const semi = await setup(undefined, {}, 'semi');

        expect(semi.toolsOf(semi.orchestrator).map(tool => tool.name)).toEqual(['task_get', 'task_list', 'task_create', 'task_update', ...threads, 'ask_user']);

        // Every tool brings its schema in both forms and says how to use it.
        for (const tool of toolsOf(orchestrator)) {
            expect(tool.description.length).toBeGreaterThan(40);
            expect(tool.inputSchema).toMatchObject({ type: 'object' });
            expect(tool.schema).toBeDefined();
        }
    });

    test('tasks come back with key, status name and category, dependency keys and active runs; task_list adds the statuses', async () => {
        const { exec, orchestrator, task, h, project } = await setup();
        const first = await task('Groundwork', { description: 'Outcome: x' });
        const second = await task('Build', { dependsOn: [first.key] });
        const { statuses, tasks } = await exec(orchestrator, 'task_list');

        expect(statuses.map((status: { name: string; category: string }) => [status.name, status.category])).toEqual([['To do', 'todo'], ['In progress', 'active'], ['Review', 'review'], ['Done', 'done'], ['Canceled', 'canceled']]);
        expect(statuses.every((status: { id: string }) => status.id.startsWith('sts_'))).toBe(true);
        expect(tasks.map((item: { key: string }) => item.key)).toEqual(['REP-1', 'REP-2']);

        const { task: got } = await exec(orchestrator, 'task_get', { taskId: second.key });

        expect(got).toEqual({
            id: second.id,
            key: 'REP-2',
            title: 'Build',
            description: '',
            statusId: statuses[0].id,
            status: 'To do',
            category: 'todo',
            dependsOn: ['REP-1'],
            activeRuns: [],
        });
        expect((await exec(orchestrator, 'task_get', { taskId: first.id })).task.description).toBe('Outcome: x');

        // The run of a chat started from the task shows up under activeRuns, and its start moves the task to In progress.
        const started = h.ok('task.start', { taskId: first.id });

        await waitFor(() => h.run(started.runId).status === 'running', 'the task\'s chat to start');
        expect((await exec(orchestrator, 'task_get', { taskId: first.key })).task.activeRuns).toEqual([{ runId: started.runId, name: 'Orchestrator 02', role: 'orchestrator', status: 'running' }]);

        // Filters
        expect((await exec(orchestrator, 'task_list', { query: 'BUILD' })).tasks.map((item: { key: string }) => item.key)).toEqual(['REP-2']);
        expect((await exec(orchestrator, 'task_list', { status: 'In progress' })).tasks.map((item: { key: string }) => item.key)).toEqual(['REP-1']);
        expect(project.id).toBeTruthy();
        expect(h.store.headCursor()).toBeGreaterThan(0);
    });

    test('task_list cuts long descriptions; task_get has them whole', async () => {
        const { exec, orchestrator, task } = await setup();
        const long = 'x'.repeat(1000);
        const created = await task('Long', { description: long });

        expect((await exec(orchestrator, 'task_list')).tasks[0].description).toHaveLength(400);
        expect((await exec(orchestrator, 'task_get', { taskId: created.key })).task.description).toBe(long);
    });

    test('a status may be given as an id, a name or a category, in any case; a wrong one lists what exists', async () => {
        const { exec, orchestrator, task } = await setup();
        const { statuses } = await exec(orchestrator, 'task_list');
        const byCategory = (category: string) => statuses.find((status: { category: string }) => status.category === category);
        const first = await task('A', { statusId: byCategory('active').id });

        expect(first.category).toBe('active');
        expect((await task('B', { statusId: 'in PROGRESS' })).category).toBe('active');
        expect((await task('C', { status: 'Review' })).status).toBe('Review');
        expect((await task('D', { statusId: 'DONE' })).category).toBe('done');

        const moved = await exec(orchestrator, 'task_update', { taskId: first.key, status: 'canceled' });

        expect(moved.task.category).toBe('canceled');
        await expect(exec(orchestrator, 'task_update', { taskId: first.key, statusId: 'sts_nope' })).rejects.toThrow(/Unknown status "sts_nope"\. Use the id of one of: sts_\w+ \(To do, todo\); .*\(Canceled, canceled\)/);
        await expect(task('E', { dependsOn: ['REP-99'] })).rejects.toThrow(/does not exist/);
        await expect(exec(orchestrator, 'task_get', {})).rejects.toThrow(/Invalid input for task_get/);
    });

    test('task_update changes any field of a task by key and refuses a circular dependency', async () => {
        const { exec, orchestrator, task } = await setup();
        const a = await task('A');
        const b = await task('B', { dependsOn: [a.key] });
        const { task: updated } = await exec(orchestrator, 'task_update', { taskId: a.key, title: 'A2', description: 'new text', dependsOn: [] });

        expect(updated).toMatchObject({ title: 'A2', description: 'new text', dependsOn: [] });
        await expect(exec(orchestrator, 'task_update', { taskId: a.key, dependsOn: [b.key] })).rejects.toThrow(/Circular dependency/);
    });

    test('a task created by an orchestrator is linked to its chat and to the run that created it', async () => {
        const { h, task, chat, orchestrator } = await setup();
        const created = await task('Linked');

        expect(h.store.db.query('SELECT chat_id FROM chat_task_links WHERE task_id = ?').all(created.id)).toEqual([{ chat_id: chat.id }]);
        expect(h.store.db.query('SELECT run_id, relation FROM run_task_links WHERE task_id = ?').all(created.id)).toEqual([{ run_id: orchestrator.id, relation: 'created' }]);
    });
});

describe('ask_user', () => {
    test('a second question while one is open is refused at once, so the first stays answerable', async () => {
        const outcomes: string[] = [];
        const engine = new ScriptEngine(async function* ({ options }) {
            yield { type: 'session', sessionId: 's-1' };

            const ask = options.tools.find(tool => tool.name === 'ask_user')!;
            const first = ask.execute({ question: 'First?', options: [{ id: 'a', label: 'A' }] }, options.signal);
            const second = await ask.execute({ question: 'Second?', options: [{ id: 'b', label: 'B' }] }, options.signal).catch((error: Error) => error.message);

            outcomes.push(`second: ${ second }`);
            outcomes.push(`first: ${ JSON.stringify(await first) }`);
            yield { type: 'done', result: 'ok' };
        });
        const h = await startHarness({}, { engines: scriptEngines(engine) });

        harnesses.push(h);

        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, mode: 'semi' });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'go' });

        await waitFor(() => h.run(runId).status === 'waiting_user', 'the first question');

        const [question] = h.store.db.query('SELECT body FROM stream_items WHERE run_id = ? ORDER BY seq').all(runId).map((row: any) => JSON.parse(row.body)).filter((body: any) => body.kind === 'question');

        expect(h.ok('run.answer', { runId, questionId: question.questionId, answer: 'A' })).toEqual({ runId });
        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to finish');
        expect(outcomes).toEqual(['second: Another question is waiting for the user. Ask one question at a time and wait for its answer.', 'first: {"answer":"A"}']);
        expect(h.store.db.query('SELECT body FROM stream_items WHERE run_id = ?').all(runId).filter((row: any) => JSON.parse(row.body).kind === 'question')).toHaveLength(1);
    });
});

describe('a run on a task', () => {
    test('waits while the task has unfinished dependencies, and starts by itself when the orchestrator sets the last one Done', async () => {
        const { engine, exec, orchestrator, task, h } = await setup();
        const a = await task('A');
        const b = await task('B', { dependsOn: [a.key] });
        const { runId } = h.ok('task.start', { taskId: b.id });

        expect(h.run(runId)).toMatchObject({ status: 'blocked', statusReason: 'Waiting for REP-1' });
        await Bun.sleep(30);
        expect(engine.turns).toHaveLength(0);

        await exec(orchestrator, 'task_update', { taskId: a.key, status: 'review' });
        await Bun.sleep(30);
        expect(h.run(runId).status).toBe('blocked');

        await exec(orchestrator, 'task_update', { taskId: a.key, status: 'done' });
        await waitFor(() => engine.turns.length === 1, 'the dependent run to start');
        expect(h.run(runId).status).toBe('running');
    });
});
