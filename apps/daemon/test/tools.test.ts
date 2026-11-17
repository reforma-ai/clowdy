import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { getProject } from '../src/db/projects';
import { getTask } from '../src/db/tasks';
import { MAX_CHILDREN } from '../src/runs/driver';
import { toolsFor } from '../src/runs/tools';
import { cleanTempDirs, latch, ScriptEngine, scriptEngines, startHarness, tempDir, waitFor } from './helpers';

import type { Run } from '@clowdy/protocol';
import type { Harness, Script } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

/** A session that holds until the test releases it, then ends. Children of these tests use it to stay alive. */
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
    const { store, runs, driver } = h.daemon.services;
    const entity = getProject(store.db, project.id)!;
    const orchestrator = runs.createRun({ project: entity, role: 'orchestrator', chatId: chat.id, summary: 'Plan' });
    const toolsOf = (run: Run) => toolsFor({ store, runs, driver }, run, runs.modeOf(run));
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
    test('an orchestrator has the task and run tools, ask_user only in semi-manual; workers read tasks and report', async () => {
        const { orchestrator, toolsOf, h, entity } = await setup();
        const { runs } = h.daemon.services;
        const names = (run: Run) => toolsOf(run).map(tool => tool.name);

        expect(names(orchestrator)).toEqual(['task_get', 'task_list', 'task_create', 'task_update', 'run_spawn', 'run_inspect', 'run_wait', 'run_cancel']);

        const semi = await setup(undefined, {}, 'semi');

        expect(semi.toolsOf(semi.orchestrator).map(tool => tool.name)).toContain('ask_user');

        for (const role of ['executor', 'verifier'] as const) {
            const worker = runs.createRun({ project: entity, role, summary: 'x', parent: orchestrator, origin: 'spawned' });

            expect(names(worker)).toEqual(['task_get', 'task_list', 'task_update', 'report_result']);
        }

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

        // A queued run on the task shows up under activeRuns.
        const spawned = await exec(orchestrator, 'run_spawn', { taskIds: [first.key], prompt: 'go', idempotencyKey: 'k1' });

        expect((await exec(orchestrator, 'task_get', { taskId: first.key })).task.activeRuns).toEqual([{ runId: spawned.runId, name: 'Executor 01', role: 'executor', status: expect.stringMatching(/queued|running/) }]);

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

describe('run_spawn', () => {
    test('returns at once, starts the child with the entry skill and the mode, and passes cwd through', async () => {
        const { engine, exec, orchestrator, task, h, entity } = await setup();
        const a = await task('A');
        const worktree = join(tempDir(), 'worktree');

        mkdirSync(worktree);

        const spawned = await exec(orchestrator, 'run_spawn', { taskIds: [a.key], prompt: 'Goal: do A', idempotencyKey: 'REP-1-executor-1', cwd: worktree });

        expect(spawned).toMatchObject({ name: 'Executor 01', role: 'executor', status: expect.stringMatching(/queued|running/), duplicate: false });
        await waitFor(() => engine.turns.length === 1, 'the child to start');
        expect(engine.turns[0].prompt).toBe('/clowdy:executor Mode: autopilot\n\nGoal: do A');
        expect(engine.turns[0].cwd).toBe(worktree);
        expect(engine.turns[0].systemPrompt).toContain('Follow clowdy:executor');
        expect(engine.turns[0].tools.map(tool => tool.name)).toEqual(['task_get', 'task_list', 'task_update', 'report_result']);

        const child = h.run(spawned.runId);

        expect(child).toMatchObject({ parentRunId: orchestrator.id, rootRunId: orchestrator.id, origin: 'spawned', role: 'executor' });
        expect(h.store.db.query('SELECT relation FROM run_task_links WHERE run_id = ?').all(child.id)).toEqual([{ relation: 'assigned' }]);

        // Without cwd the engine works in the project's folder.
        const b = await task('B');

        await exec(orchestrator, 'run_spawn', { taskIds: [b.key], prompt: 'Goal: do B', idempotencyKey: 'REP-2-executor-1' });
        await waitFor(() => engine.turns.length === 2, 'the second child to start');
        expect(engine.turns[1].cwd).toBe(entity.path);
    });

    test('a verifier starts with /clowdy:verify, is bound to the tasks it checks, and waits for no dependency', async () => {
        const { engine, exec, orchestrator, task, h } = await setup();
        const a = await task('A');
        const b = await task('B', { dependsOn: [a.key] });
        const spawned = await exec(orchestrator, 'run_spawn', { taskIds: [b.key], role: 'verifier', prompt: 'Claim: B works', idempotencyKey: 'REP-2-verifier-1' });

        await waitFor(() => engine.turns.length === 1, 'the verifier to start');
        expect(engine.turns[0].prompt).toBe('/clowdy:verify Mode: autopilot\n\nClaim: B works');
        expect(engine.turns[0].systemPrompt).toContain('Follow clowdy:verify');
        expect(h.run(spawned.runId)).toMatchObject({ role: 'verifier', status: 'running' });
        expect(h.store.db.query('SELECT relation FROM run_task_links WHERE run_id = ?').all(spawned.runId)).toEqual([{ relation: 'verifies' }]);
    });

    test('the same idempotency key under the same parent starts nothing new', async () => {
        const { engine, exec, orchestrator, task, h } = await setup();
        const a = await task('A');
        const input = { taskIds: [a.key], prompt: 'go', idempotencyKey: 'REP-1-executor-1' };
        const first = await exec(orchestrator, 'run_spawn', input);
        const again = await exec(orchestrator, 'run_spawn', input);

        expect(again).toMatchObject({ runId: first.runId, duplicate: true });
        await waitFor(() => engine.turns.length === 1, 'the child');
        await Bun.sleep(30);
        expect(engine.turns).toHaveLength(1);
        expect(h.store.db.query('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = ?').get(orchestrator.id)).toEqual({ n: 1 });

        // Another key is a new attempt, but only once the first run is no longer active.
        await expect(exec(orchestrator, 'run_spawn', { ...input, idempotencyKey: 'REP-1-executor-2' })).rejects.toThrow(/Task REP-1 already has an active run \(Executor 01\)/);
        await exec(orchestrator, 'run_cancel', { runId: first.runId });

        const retry = await exec(orchestrator, 'run_spawn', { ...input, idempotencyKey: 'REP-1-executor-2' });

        expect(retry.runId).not.toBe(first.runId);
    });

    test('runs nest two levels at most, and one orchestrator starts at most 50', async () => {
        const { exec, orchestrator, task, h, entity } = await setup();
        const { runs, driver } = h.daemon.services;
        const a = await task('A');
        const { runId } = await exec(orchestrator, 'run_spawn', { taskIds: [a.key], prompt: 'go', idempotencyKey: 'k' });

        // An executor has no run_spawn, and the driver refuses it even if asked directly.
        expect(() => driver.spawn({ parent: h.run(runId), tasks: [], prompt: 'x', role: 'executor', idempotencyKey: 'deep' })).toThrow(/nest 2 levels deep at most/);
        expect(runs.createRun({ project: entity, role: 'orchestrator', summary: 'x' }).parentRunId).toBeUndefined();

        for (let index = 2; index <= MAX_CHILDREN; index++) {
            const created = await task(`T${ index }`);

            await exec(orchestrator, 'run_spawn', { taskIds: [created.key], prompt: 'go', idempotencyKey: `k${ index }` });
        }

        const extra = await task('One too many');

        await expect(exec(orchestrator, 'run_spawn', { taskIds: [extra.key], prompt: 'go', idempotencyKey: 'k51' })).rejects.toThrow(/already started 50 runs/);
        expect(h.store.db.query('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = ?').get(orchestrator.id)).toEqual({ n: MAX_CHILDREN });
    });

    test('a run on a task with unfinished dependencies waits, and starts by itself when the orchestrator sets the last one Done', async () => {
        const { engine, exec, orchestrator, task, h } = await setup();
        const a = await task('A');
        const b = await task('B', { dependsOn: [a.key] });
        const spawned = await exec(orchestrator, 'run_spawn', { taskIds: [b.key], prompt: 'go', idempotencyKey: 'k' });

        expect(spawned).toMatchObject({ status: 'blocked', statusReason: 'Waiting for REP-1' });
        await Bun.sleep(30);
        expect(engine.turns).toHaveLength(0);

        await exec(orchestrator, 'task_update', { taskId: a.key, status: 'review' });
        await Bun.sleep(30);
        expect(h.run(spawned.runId).status).toBe('blocked');

        await exec(orchestrator, 'task_update', { taskId: a.key, status: 'done' });
        await waitFor(() => engine.turns.length === 1, 'the dependent run to start');
        expect(h.run(spawned.runId).status).toBe('running');
    });

    test('a cwd that is not an existing absolute folder is refused', async () => {
        const { exec, orchestrator, task } = await setup();
        const a = await task('A');

        for (const cwd of ['relative/dir', join(tempDir(), 'missing')]) {
            await expect(exec(orchestrator, 'run_spawn', { taskIds: [a.key], prompt: 'go', idempotencyKey: `k-${ cwd.length }`, cwd })).rejects.toThrow(/cwd must be the absolute path of an existing folder/);
        }
    });

    test('run_inspect shows a child with its recent stream; run_cancel stops it and its subtree; both only for the caller\'s children', async () => {
        const { exec, orchestrator, task, h, entity } = await setup();
        const a = await task('A');
        const { runId } = await exec(orchestrator, 'run_spawn', { taskIds: [a.key], prompt: 'go', idempotencyKey: 'k' });

        await waitFor(() => h.run(runId).status === 'running', 'the child');

        const inspected = await exec(orchestrator, 'run_inspect', { runId });

        expect(inspected).toMatchObject({ runId, name: 'Executor 01', taskIds: ['REP-1'], state: 'running', status: 'running' });
        expect(inspected.recent).toEqual(['user: go']);

        const stranger = h.daemon.services.runs.createRun({ project: entity, role: 'orchestrator', summary: 'other' });

        await expect(exec(stranger, 'run_inspect', { runId })).rejects.toThrow(/not one of your child runs/);
        await expect(exec(stranger, 'run_cancel', { runId })).rejects.toThrow(/not one of your child runs/);

        expect(await exec(orchestrator, 'run_cancel', { runId, reason: 'plan changed' })).toEqual({ cancelled: [runId] });
        expect(h.run(runId)).toMatchObject({ status: 'cancelled', statusReason: 'Cancelled by the orchestrator: plan changed' });
    });
});

describe('executor tools', () => {
    test('an executor changes its own tasks up to Review, never to Done, and nobody else\'s', async () => {
        const { exec, orchestrator, task, h, entity } = await setup();
        const { runs } = h.daemon.services;
        const own = await task('Own');
        const other = await task('Other');
        const worker = runs.createRun({ project: entity, role: 'executor', summary: 'x', parent: orchestrator, origin: 'spawned', assigned: [getTask(h.store.db, own.id)!] });

        const moved = await exec(worker, 'task_update', { taskId: own.key, status: 'review', description: 'Outcome\n\n## Notes\n2026-11-17 (executor): did it' });

        expect(moved.task).toMatchObject({ category: 'review', description: expect.stringContaining('did it') });
        await expect(exec(worker, 'task_update', { taskId: own.key, status: 'Done' })).rejects.toThrow('Only the orchestrator moves a task to Done, after the work is verified. Move it to Review and say so in your report.');
        await expect(exec(worker, 'task_update', { taskId: own.key, statusId: 'canceled' })).rejects.toThrow(/Only the orchestrator moves a task to Canceled/);
        await expect(exec(worker, 'task_update', { taskId: other.key, status: 'review' })).rejects.toThrow(/not one of this run's tasks/);
        expect((await exec(worker, 'task_get', { taskId: other.key })).task.key).toBe('REP-2');
        expect((await exec(worker, 'task_list')).tasks).toHaveLength(2);
    });
});

describe('report_result', () => {
    async function runWorker(body: (turn: Parameters<Script>[0]) => AsyncGenerator<any>, mode?: 'semi') {
        const script: Script = async function* (turn) {
            yield { type: 'session', sessionId: 'worker-session' };
            yield* body(turn);
        };
        const setupResult = await setup(script, {}, mode);
        const created = await setupResult.task('Work');
        const spawned = await setupResult.exec(setupResult.orchestrator, 'run_spawn', { taskIds: [created.key], prompt: 'go', idempotencyKey: 'k' });

        return { ...setupResult, task: created, runId: spawned.runId as string };
    }

    test('done moves the tasks to Review, appends the note to the description and succeeds the run with the summary', async () => {
        const { h, runId, task } = await runWorker(async function* ({ call }) {
            yield* call('report_result', { status: 'done', summary: 'Result: done - it works', taskUpdates: [{ taskId: 'REP-1', status: 'review', note: 'Used the existing helper.' }] });
            yield { type: 'done', result: 'ignored final text' };
        });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to finish');
        expect(h.run(runId)).toMatchObject({ result: 'Result: done - it works' });

        const row = h.store.db.query('SELECT t.description, s.category FROM tasks t JOIN task_statuses s ON s.id = t.status_id WHERE t.id = ?').get(task.id) as { description: string; category: string };

        expect(row.category).toBe('review');
        expect(row.description).toMatch(/^## Notes\n\d{4}-\d{2}-\d{2} \(executor\): Used the existing helper\.$/);
    });

    test('a note goes under an existing Notes heading, after what is there', async () => {
        const { h, runId, task } = await runWorker(async function* ({ call }) {
            yield* call('task_update', { taskId: 'REP-1', description: 'Outcome: x\n\n## Notes\nfirst' });
            yield* call('report_result', { status: 'done', summary: 'ok', taskUpdates: [{ taskId: 'REP-1', note: 'second' }] });
            yield { type: 'done' };
        });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to finish');
        expect((h.store.db.query('SELECT description FROM tasks WHERE id = ?').get(task.id) as { description: string }).description).toMatch(/^Outcome: x\n\n## Notes\nfirst\n\d{4}-\d{2}-\d{2} \(executor\): second$/);
    });

    test('failed and blocked end the run as failed; the parent sees a blocked run as blocked', async () => {
        const { h, runId, exec, orchestrator } = await runWorker(async function* ({ call }) {
            yield* call('report_result', { status: 'blocked', summary: 'Result: blocked - needs a sandbox key\nQuestion: which one?' });
            yield { type: 'done' };
        });

        await waitFor(() => h.run(runId).status === 'failed', 'the run to end');
        expect(h.run(runId)).toMatchObject({ result: expect.stringContaining('which one?'), error: 'Blocked: Result: blocked - needs a sandbox key' });

        const inspected = await exec(orchestrator, 'run_inspect', { runId });

        expect(inspected).toMatchObject({ state: 'blocked', reason: 'Blocked: Result: blocked - needs a sandbox key' });
    });

    test('a report that moves a task to Done is refused whole: nothing is recorded and the run may report again', async () => {
        const { h, runId, task } = await runWorker(async function* ({ call }) {
            try {
                yield* call('report_result', { status: 'done', summary: 'x', taskUpdates: [{ taskId: 'REP-1', status: 'done' }] });
            }
            catch {
                // The model reads the refusal and reports again.
            }

            yield* call('report_result', { status: 'done', summary: 'second try', taskUpdates: [{ taskId: 'REP-1', status: 'review' }] });
            yield { type: 'done' };
        });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to finish');
        expect(h.run(runId).result).toBe('second try');
        expect((h.store.db.query('SELECT s.category FROM tasks t JOIN task_statuses s ON s.id = t.status_id WHERE t.id = ?').get(task.id) as { category: string }).category).toBe('review');
    });

    test('a run that ends its turn without reporting is done with its final text; an engine error fails it', async () => {
        const quiet = await runWorker(async function* () {
            yield { type: 'done', result: 'All finished.' };
        });

        await waitFor(() => quiet.h.run(quiet.runId).status === 'succeeded', 'the run to finish');
        expect(quiet.h.run(quiet.runId).result).toBe('All finished.');

        const broken = await runWorker(async function* () {
            yield { type: 'error', message: 'The model refused' };
        });

        await waitFor(() => broken.h.run(broken.runId).status === 'failed', 'the run to fail');
        expect(broken.h.run(broken.runId).error).toBe('The model refused');
    });

    test('a session that keeps going after the report is closed after a grace period, and the run still ends with the report', async () => {
        const forever = latch();
        const { h, runId, engine } = await runWorker(async function* ({ call, signal }) {
            yield* call('report_result', { status: 'done', summary: 'the report' });
            yield { type: 'text', delta: 'one more thing', done: false };
            await forever.wait(signal);
            yield { type: 'done', result: 'never reached' };
        });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to end after the grace period');
        expect(h.run(runId).result).toBe('the report');
        expect(engine.closed).toBeGreaterThan(0);
    });
});
