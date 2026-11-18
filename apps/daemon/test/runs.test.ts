import { isTerminalRunStatus } from '@clowdy/protocol';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { getProject } from '../src/db/projects';
import { canTransition, TRANSITIONS } from '../src/runs/transitions';
import { cleanTempDirs, GateEngine, gateEngines, Harness, restartHarness, startHarness, waitFor } from './helpers';

import type { ClowdyEvent, Run, RunStatus } from '@clowdy/protocol';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

async function setup(overrides: Parameters<typeof startHarness>[0] = {}) {
    const gate = new GateEngine();
    const h = await startHarness(overrides, { engines: gateEngines(gate) });

    harnesses.push(h);

    const project = h.openRepo();
    const task = (title: string, dependsOn: string[] = []) => h.ok('task.create', { projectId: project.id, title, dependsOn }).task;
    const start = (taskId: string, force?: boolean): string => h.ok('task.start', { taskId, force }).runId;

    return { h, gate, project, task, start };
}

/** The highest number of runs that were `running` at the same time, replaying the log. */
function peakRunning(events: ClowdyEvent[], projectId?: string): number {
    const status = new Map<string, RunStatus>();
    let peak = 0;

    for (const event of events) {
        if (event.data.type === 'run.upserted' && (!projectId || event.data.run.projectId === projectId)) {
            status.set(event.data.run.id, event.data.run.status);
            peak = Math.max(peak, [...status.values()].filter(value => value === 'running').length);
        }
    }

    return peak;
}

describe('status machine', () => {
    test('terminal states only lead back to queued, and running is entered from queued only', () => {
        for (const status of ['succeeded', 'failed', 'cancelled', 'interrupted'] as const) {
            expect(TRANSITIONS[status]).toEqual(['queued']);
        }

        for (const [from, to] of Object.entries(TRANSITIONS)) {
            expect(to.includes('running')).toBe(from === 'queued');
        }

        expect(canTransition('running', 'waiting_children')).toBe(true);
        expect(canTransition('queued', 'succeeded')).toBe(false);
        expect(canTransition('blocked', 'running')).toBe(false);
    });

    test('setStatus validates transitions, requires reasons, and stamps times', async () => {
        const { h, task, start } = await setup();
        const { runs } = h.daemon.services;
        const runId = start(task('A').id);

        await waitFor(() => h.run(runId).status === 'running', 'the run to start');
        expect(h.run(runId).startedAt).toBeNumber();
        expect(h.run(runId).finishedAt).toBeUndefined();

        expect(() => runs.setStatus(runId, 'queued')).toThrow(/Illegal run transition running -> queued/);
        expect(() => runs.setStatus(runId, 'waiting_user')).toThrow(/needs a status reason/);

        const waiting = runs.setStatus(runId, 'waiting_user', { reason: 'Waiting for your answer' });

        expect(waiting).toMatchObject({ status: 'waiting_user', statusReason: 'Waiting for your answer' });
        expect(runs.setStatus(runId, 'failed', { error: 'broke' })).toMatchObject({ status: 'failed', error: 'broke' });
        expect(h.run(runId).finishedAt).toBeNumber();
        expect(() => runs.setStatus(runId, 'running')).toThrow(/Illegal/);

        const resumed = runs.setStatus(runId, 'queued');

        expect(resumed.finishedAt).toBeUndefined();
        expect(resumed.error).toBeUndefined();
        expect(resumed.startedAt).toBe(h.run(runId).startedAt);
    });

    test('every status change is one run.upserted event carrying the whole run', async () => {
        const { h, gate, task, start } = await setup();
        const runId = start(task('A').id);

        await waitFor(() => gate.isStarted('REP-1'), 'the engine');
        gate.release('REP-1');
        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to finish');

        const statuses = h.events().flatMap(event => (event.data.type === 'run.upserted' && event.data.run.id === runId ? [event.data.run.status] : []));

        expect(statuses.filter((status, index) => status !== statuses[index - 1])).toEqual(['queued', 'running', 'succeeded']);
        expect(h.run(runId)).toMatchObject({ result: expect.stringContaining('Complete task REP-1: A'), sessionId: expect.stringContaining('gate-Follow clowdy:orchestrate. Mode: autopilot') });
    });

    test('a task moves with its run: in progress, review on success, back to todo when the run dies', async () => {
        const { h, gate, task, start } = await setup();
        const categoryOf = (taskId: string) => {
            const snapshot = h.store.db.query('SELECT s.category FROM tasks t JOIN task_statuses s ON s.id = t.status_id WHERE t.id = ?').get(taskId) as { category: string };

            return snapshot.category;
        };
        const a = task('A');
        const b = task('B');
        const runA = start(a.id);
        const runB = start(b.id);

        await waitFor(() => gate.isStarted('REP-1') && gate.isStarted('REP-2'), 'both engines');
        expect([categoryOf(a.id), categoryOf(b.id)]).toEqual(['active', 'active']);

        gate.release('REP-1');
        await waitFor(() => h.run(runA).status === 'succeeded', 'run A');
        expect(categoryOf(a.id)).toBe('review');

        h.ok('run.cancel', { runId: runB });
        expect(categoryOf(b.id)).toBe('todo');
    });

    test('task.start refuses a second active run on a task unless forced', async () => {
        const { h, task, start } = await setup();
        const a = task('A');

        start(a.id);

        expect(h.send('task.start', { taskId: a.id })).toMatchObject({ ok: false, error: { code: 'already_running' } });
        expect(() => start(a.id, true)).not.toThrow();
        expect(h.send('task.start', { taskId: 'tsk_missing' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    });
});

describe('scheduler', () => {
    test('never runs more than the global cap, queues the rest with a reason, and drains in order', async () => {
        const { h, gate, task, start } = await setup({ maxRuns: 2 });
        const runs = [1, 2, 3, 4, 5].map(index => start(task(`T${ index }`).id));

        await waitFor(() => gate.isStarted('REP-2'), 'two engines');
        expect(runs.map(id => h.run(id).status)).toEqual(['running', 'running', 'queued', 'queued', 'queued']);
        expect(h.run(runs[2]).statusReason).toBe('Waiting for a free slot');
        expect(gate.isStarted('REP-3')).toBe(false);

        gate.release('REP-1');
        await waitFor(() => h.run(runs[2]).status === 'running', 'the third run to take the free slot');
        expect(h.run(runs[3]).status).toBe('queued');
        expect(h.run(runs[0]).status).toBe('succeeded');

        gate.release('REP-2');
        await waitFor(() => h.run(runs[3]).status === 'running', 'the fourth run');
        gate.release('REP-3');
        await waitFor(() => h.run(runs[4]).status === 'running', 'the fifth run');
        gate.release('REP-4');
        gate.release('REP-5');
        await waitFor(() => h.run(runs[4]).status === 'succeeded', 'all runs to finish');

        expect(peakRunning(h.events())).toBe(2);
        expect(gate.started.map(prompt => /Complete task (REP-\d+)/.exec(prompt)?.[1])).toEqual(['REP-1', 'REP-2', 'REP-3', 'REP-4', 'REP-5']);
    });

    test('a project limit holds that project back without blocking others', async () => {
        const { h, gate, project, task, start } = await setup({ maxRuns: 8 });
        const other = h.openRepo('other');
        const otherTask = h.ok('task.create', { projectId: other.id, title: 'Other' }).task;

        h.ok('project.update', { projectId: project.id, settings: { maxParallelRuns: 1 } });

        const first = start(task('A').id);
        const second = start(task('B').id);
        const foreign = start(otherTask.id);

        await waitFor(() => gate.isStarted('OTH-1'), 'the other project to run');
        expect([first, second, foreign].map(id => h.run(id).status)).toEqual(['running', 'queued', 'running']);

        h.ok('project.update', { projectId: project.id, settings: { maxParallelRuns: 2 } });
        await waitFor(() => h.run(second).status === 'running', 'the raised limit to start the queued run');
        expect(peakRunning(h.events(), project.id)).toBe(2);
    });

    test('a queued run can be cancelled and then never starts', async () => {
        const { h, gate, task, start } = await setup({ maxRuns: 1 });
        const first = start(task('A').id);
        const second = start(task('B').id);
        const third = start(task('C').id);

        await waitFor(() => gate.isStarted('REP-1'), 'the first engine');
        h.ok('run.cancel', { runId: second });
        gate.release('REP-1');
        await waitFor(() => h.run(third).status === 'running', 'the third run');

        expect(h.run(first).status).toBe('succeeded');
        expect(h.run(second).status).toBe('cancelled');
        expect(gate.isStarted('REP-2')).toBe(false);
    });
});

describe('dependencies', () => {
    test('a run on a task with unfinished dependencies is blocked with a reason until they are done', async () => {
        const { h, gate, task, start } = await setup();
        const a = task('A');
        const b = task('B', [a.id]);
        const runB = start(b.id);

        expect(h.run(runB)).toMatchObject({ status: 'blocked', statusReason: 'Waiting for REP-1' });

        const runA = start(a.id);

        await waitFor(() => gate.isStarted('REP-1'), 'A to start');
        gate.release('REP-1');
        await waitFor(() => h.run(runA).status === 'succeeded', 'A to finish');

        // Review is not done: the dependent still waits.
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(h.run(runB).status).toBe('blocked');

        const done = (h.events()[0].data as { statuses: { id: string; category: string }[] }).statuses.find(status => status.category === 'done')!.id;

        h.ok('task.update', { taskId: a.id, statusId: done });
        await waitFor(() => gate.isStarted('REP-2'), 'B to start once A is done');
        expect(h.run(runB).status).toBe('running');
    });

    test('deleting the dependency unblocks the run', async () => {
        const { h, gate, task, start } = await setup();
        const a = task('A');
        const runB = start(task('B', [a.id]).id);

        expect(h.run(runB).status).toBe('blocked');
        h.ok('task.delete', { taskId: a.id });
        await waitFor(() => gate.isStarted('REP-2'), 'B to start');
    });
});

describe('cancellation', () => {
    test('cancels the whole active subtree, children first, aborts the engines, and keeps the history', async () => {
        const { h, gate, project, task } = await setup();
        const { runs, driver } = h.daemon.services;
        const entity = getProject(h.store.db, project.id)!;
        const root = runs.createRun({ project: entity, role: 'orchestrator', summary: 'root' });
        const spawn = (parent: Run, title: string) => {
            const created = task(title);
            const run = runs.createRun({ project: entity, role: 'executor', origin: 'spawned', summary: title, parent, assigned: [created], nextPrompt: `Task ${ created.key }: ${ title }` });

            driver.launch(run.id);

            return run;
        };
        const child = spawn(root, 'Child');
        const grandchild = spawn(child, 'Grandchild');
        const finished = spawn(root, 'Finished');

        await waitFor(() => gate.isStarted('REP-1') && gate.isStarted('REP-2') && gate.isStarted('REP-3'), 'all engines');
        gate.release('REP-3');
        await waitFor(() => h.run(finished.id).status === 'succeeded', 'the finished child');

        const cursor = h.store.headCursor();
        const result = h.ok('run.cancel', { runId: root.id });

        expect(result.cancelled).toEqual([grandchild.id, child.id, root.id]);
        expect([root, child, grandchild].map(run => h.run(run.id).status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
        expect(h.run(finished.id).status).toBe('succeeded');

        const order = h.events(cursor).flatMap(event => (event.data.type === 'run.upserted' && event.data.run.status === 'cancelled' ? [event.data.run.id] : []));

        expect(order).toEqual([grandchild.id, child.id, root.id]);
        await waitFor(() => gate.aborted.length === 2, 'both engines to be aborted');
        expect(h.run(grandchild.id).statusReason).toBe('Cancelled by user');

        // Cancelling again finds nothing active.
        expect(h.ok('run.cancel', { runId: root.id }).cancelled).toEqual([]);
        expect(h.send('run.cancel', { runId: 'run_missing' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    });
});

describe('restart recovery', () => {
    test('runs that were mid-turn come back interrupted with a notice; runs that only waited keep waiting', async () => {
        const gate = new GateEngine();
        const first = await startHarness({ maxRuns: 1 }, { engines: gateEngines(gate) });
        const project = first.openRepo();
        const task = (title: string, dependsOn: string[] = []) => first.ok('task.create', { projectId: project.id, title, dependsOn }).task;
        const done = task('Done');
        const running = task('Running');
        const blockedTask = task('Blocked', [done.id]);
        const queuedTask = task('Queued');
        const doneRun = first.ok('task.start', { taskId: done.id }).runId as string;
        const runningRun = first.ok('task.start', { taskId: running.id }).runId as string;
        const blockedRun = first.ok('task.start', { taskId: blockedTask.id }).runId as string;
        const queuedRun = first.ok('task.start', { taskId: queuedTask.id }).runId as string;

        await waitFor(() => gate.isStarted('REP-1'), 'the first engine');
        gate.release('REP-1');
        await waitFor(() => first.run(doneRun).status === 'succeeded', 'the first run');
        await waitFor(() => first.run(runningRun).status === 'running', 'the second run to take the slot');
        expect([blockedRun, queuedRun].map(id => first.run(id).status)).toEqual(['blocked', 'queued']);

        await first.stop();

        const next = new GateEngine();
        const second = await restartHarness(first, { engines: gateEngines(next) });

        harnesses.push(second);
        expect(second.run(doneRun).status).toBe('succeeded');
        expect(second.run(runningRun)).toMatchObject({ status: 'interrupted', statusReason: 'Daemon restarted' });
        expect(second.run(runningRun).finishedAt).toBeNumber();
        expect(isTerminalRunStatus(second.run(runningRun).status)).toBe(true);

        // The run that never started is started again, in its place in the queue; the one waiting for a task still waits.
        await waitFor(() => next.isStarted('REP-4'), 'the queued run to start after the restart');
        expect(second.run(queuedRun).status).toBe('running');
        expect(second.run(blockedRun)).toMatchObject({ status: 'blocked', statusReason: 'Waiting for REP-1' });
        expect(next.isStarted('REP-2')).toBe(false);

        const notice = second.events().find(event => event.data.type === 'notice');

        expect(notice?.data).toMatchObject({ level: 'warn', text: expect.stringContaining('1 run was interrupted') });

        // Their tasks no longer claim to be in progress, and the restarted one is.
        const categories = second.store.db.query('SELECT t.title, s.category FROM tasks t JOIN task_statuses s ON s.id = t.status_id ORDER BY t.number').all();

        expect(categories).toEqual([
            { title: 'Done', category: 'review' },
            { title: 'Running', category: 'todo' },
            { title: 'Blocked', category: 'todo' },
            { title: 'Queued', category: 'active' },
        ]);
    });
});

describe('daemon shutdown', () => {
    test('stop aborts live engines and leaves their runs for the next start to mark', async () => {
        const gate = new GateEngine();
        const h = await startHarness({}, { engines: gateEngines(gate) });
        const project = h.openRepo();
        const runId = h.ok('task.start', { taskId: h.ok('task.create', { projectId: project.id, title: 'A' }).task.id }).runId as string;

        await waitFor(() => gate.isStarted('REP-1'), 'the engine');
        await h.stop();
        expect(gate.aborted).toHaveLength(1);

        const again = await restartHarness(h);

        harnesses.push(again);
        expect(again.run(runId)).toMatchObject({ status: 'interrupted', statusReason: 'Daemon restarted' });
    });
});
