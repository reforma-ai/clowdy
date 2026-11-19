import { ACTIVE_RUN_STATUSES, isBusyRunStatus, isTerminalRunStatus } from '@clowdy/protocol';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { getProject } from '../src/db/projects';
import { listRuns, runningCounts } from '../src/db/runs';
import { QUEUE_REASON } from '../src/runs/scheduler';
import { BACKGROUND_REASON, canTransition, NEEDS_REASON, TRANSITIONS } from '../src/runs/transitions';
import { cleanTempDirs, GateEngine, gateEngines, Harness, restartHarness, startHarness, waitFor } from './helpers';

import type { BackgroundItem, ClowdyEvent, Run, RunStatus } from '@clowdy/protocol';

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

describe('waiting for background work', () => {
    /** A chat-less orchestrator that holds a slot, made by hand: no engine session is behind it, so the test is the one who moves its status. */
    async function runningRun() {
        const { h, project } = await setup();
        const { runs } = h.daemon.services;
        const create = () => {
            const run = runs.createRun({ project: getProject(h.store.db, project.id)!, role: 'orchestrator', summary: 'Plan' });

            runs.setStatus(run.id, 'running');

            return run.id;
        };

        return { h, project, runs, create };
    }

    test('is entered from running, or from the other wait while the session is open, and leaves by queued or an end, never straight to running', () => {
        for (const from of Object.keys(TRANSITIONS) as RunStatus[]) {
            expect(canTransition(from, 'waiting_background')).toBe(from === 'running' || from === 'waiting_background' || from === 'waiting_children');
        }

        // The two waits trade places as what the run waits for changes (children win), and a session that fails for a moment is retried through `blocked`.
        expect(TRANSITIONS.waiting_background).toEqual(['waiting_background', 'waiting_children', 'queued', 'blocked', 'succeeded', 'failed', 'cancelled', 'interrupted']);
        expect(TRANSITIONS.waiting_children).toEqual(['waiting_children', 'waiting_background', 'queued', 'blocked', 'succeeded', 'failed', 'cancelled', 'interrupted']);
        expect(NEEDS_REASON).toContain('waiting_background');
    });

    test('is active, not terminal and not busy: a message to such a run is delivered, not queued', () => {
        expect(ACTIVE_RUN_STATUSES).toContain('waiting_background');
        expect(isTerminalRunStatus('waiting_background')).toBe(false);
        expect(isBusyRunStatus('waiting_background')).toBe(false);

        // The statuses around it keep their meaning.
        expect(isBusyRunStatus('running')).toBe(true);
        expect(isBusyRunStatus('queued')).toBe(true);
        expect(isBusyRunStatus('waiting_children')).toBe(false);
        expect(isBusyRunStatus('succeeded')).toBe(false);
    });

    test('moves running to waiting_background to queued to running again, holding no slot while it waits, and ends from there', async () => {
        const { h, runs, create } = await runningRun();
        const runId = create();

        expect(() => runs.setStatus(runId, 'waiting_background')).toThrow(/needs a status reason/);
        expect(runningCounts(h.store.db)).toEqual([{ engine: 'fake', projectId: h.run(runId).projectId, count: 1 }]);

        expect(runs.setStatus(runId, 'waiting_background', { reason: BACKGROUND_REASON })).toMatchObject({ status: 'waiting_background', statusReason: 'Waiting for background work' });
        expect(runningCounts(h.store.db)).toEqual([]);
        expect(h.run(runId).finishedAt).toBeUndefined();

        // A repeat refreshes the reason; the same reason again changes nothing.
        expect(runs.setStatus(runId, 'waiting_background', { reason: 'Waiting for 2 background tasks' })).toMatchObject({ statusReason: 'Waiting for 2 background tasks' });

        const upserts = () => h.events().filter(event => event.data.type === 'run.upserted' && event.data.run.id === runId).length;
        const before = upserts();

        runs.setStatus(runId, 'waiting_background', { reason: 'Waiting for 2 background tasks' });
        expect(upserts()).toBe(before);

        expect(() => runs.setStatus(runId, 'running')).toThrow(/Illegal run transition waiting_background -> running/);
        expect(runs.setStatus(runId, 'queued')).toMatchObject({ status: 'queued', statusReason: QUEUE_REASON });
        expect(runs.setStatus(runId, 'running').status).toBe('running');
        expect(runs.setStatus(runId, 'waiting_background', { reason: BACKGROUND_REASON }).status).toBe('waiting_background');
        expect(runs.setStatus(runId, 'succeeded', { result: 'All done' })).toMatchObject({ status: 'succeeded', result: 'All done' });
        expect(h.run(runId).statusReason).toBeUndefined();
        expect(h.run(runId).finishedAt).toBeNumber();
    });

    test('ends as failed, cancelled or interrupted, and refuses every move that is not listed', async () => {
        const { h, runs, create } = await runningRun();

        for (const to of ['failed', 'cancelled', 'interrupted'] as const) {
            const runId = create();

            runs.setStatus(runId, 'waiting_background', { reason: BACKGROUND_REASON });
            expect(runs.setStatus(runId, to, { reason: 'Stopped' }).status).toBe(to);
        }

        const runId = create();

        runs.setStatus(runId, 'waiting_background', { reason: BACKGROUND_REASON });

        for (const to of ['running', 'waiting_user'] as const) {
            expect(() => runs.setStatus(runId, to, { reason: 'Nope' })).toThrow(`Illegal run transition waiting_background -> ${ to }`);
        }

        expect(runs.require(runId).status).toBe('waiting_background');

        // Only a running run waits for background work.
        const queued = runs.createRun({ project: getProject(h.store.db, runs.require(runId).projectId)!, role: 'orchestrator', summary: 'Queued' });

        expect(() => runs.setStatus(queued.id, 'waiting_background', { reason: BACKGROUND_REASON })).toThrow(/Illegal run transition queued -> waiting_background/);
    });

    test('refuses a question of a run that waits, in words a person can read, and keeps the run as it was', async () => {
        const { runs, create } = await runningRun();

        for (const status of ['waiting_background', 'waiting_children'] as const) {
            const runId = create();

            runs.setStatus(runId, status, { reason: 'Waiting' });
            await expect(runs.ask(runId, { text: 'Which one?', options: [{ id: 'a', label: 'A' }] }, new AbortController().signal)).rejects.toThrow('Can\'t ask a question while the run waits for background work or child runs');
            expect(runs.require(runId).status).toBe(status);
        }
    });

    describe('the open items', () => {
        const command: BackgroundItem = { id: 'bg-1', kind: 'command', title: 'sleep 60' };
        const subagent: BackgroundItem = { id: 'bg-2', kind: 'subagent', title: 'Researcher' };

        test('are stored with the run, read back from the database and published in its run.upserted event', async () => {
            const { h, project, runs, create } = await runningRun();
            const runId = create();

            expect(h.run(runId).background).toBeUndefined();

            runs.setBackground(runId, [command, subagent]);

            expect(h.run(runId).background).toEqual([command, subagent]);
            expect(listRuns(h.store.db, project.id).find(run => run.id === runId)?.background).toEqual([command, subagent]);
            expect(JSON.parse((h.store.db.query('SELECT background FROM runs WHERE id = ?').get(runId) as { background: string }).background)).toEqual([command, subagent]);

            const published = h.events().filter(event => event.data.type === 'run.upserted' && event.data.run.id === runId).at(-1)?.data;

            expect(published).toMatchObject({ type: 'run.upserted', run: { id: runId, background: [command, subagent] } });
        });

        test('are written only when the list changed, and an empty list clears them', async () => {
            const { h, runs, create } = await runningRun();
            const runId = create();
            const upserts = () => h.events().filter(event => event.data.type === 'run.upserted' && event.data.run.id === runId).length;
            const start = upserts();

            runs.setBackground(runId, []);
            expect(upserts()).toBe(start);

            runs.setBackground(runId, [command, subagent]);
            expect(upserts()).toBe(start + 1);

            runs.setBackground(runId, [{ ...command }, { ...subagent }]);
            expect(upserts()).toBe(start + 1);

            runs.setBackground(runId, [subagent, command]);
            expect(h.run(runId).background).toEqual([subagent, command]);
            expect(upserts()).toBe(start + 2);

            runs.setBackground(runId, [command]);
            expect(h.run(runId).background).toEqual([command]);
            expect(upserts()).toBe(start + 3);

            runs.setBackground(runId, []);
            expect(upserts()).toBe(start + 4);
            expect('background' in h.run(runId)).toBe(false);
            expect((h.store.db.query('SELECT background FROM runs WHERE id = ?').get(runId) as { background: string | null }).background).toBeNull();

            runs.setBackground(runId, []);
            expect(upserts()).toBe(start + 4);
        });

        test('keep only the fields of the protocol, and a status change that leaves the session alive leaves them as they are', async () => {
            const { h, runs, create } = await runningRun();
            const runId = create();

            runs.setBackground(runId, [{ ...command, pid: 4242 } as BackgroundItem]);
            expect(h.run(runId).background).toEqual([command]);

            runs.setStatus(runId, 'waiting_background', { reason: BACKGROUND_REASON });
            runs.setStatus(runId, 'queued');
            expect(h.run(runId).background).toEqual([command]);
        });

        test('a run that ended has nothing open, whichever terminal status it reached', async () => {
            const { h, runs, create } = await runningRun();
            const runId = create();

            runs.setBackground(runId, [command]);
            runs.setStatus(runId, 'waiting_background', { reason: BACKGROUND_REASON });
            runs.setStatus(runId, 'cancelled', { reason: 'Stopped' });

            expect(h.run(runId).background).toBeUndefined();
        });

        test('bound the list and the titles that an engine reports', async () => {
            const { h, runs, create } = await runningRun();
            const runId = create();
            const many = Array.from({ length: 80 }, (_, index) => ({ id: `task-${ index }`, kind: 'command' as const, title: 'x'.repeat(500) }));

            runs.setBackground(runId, many);

            const kept = h.run(runId).background ?? [];

            expect(kept).toHaveLength(50);
            expect(kept[0].title).toHaveLength(200);
            expect(kept[0].id).toBe('task-0');
        });
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

        const done = h.statuses(a.projectId).find(status => status.category === 'done')!.id;

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

    test('a run that waited for background work comes back interrupted even with no process recorded, since no restart keeps its session', async () => {
        const first = await startHarness();
        const project = first.openRepo();
        const { runs } = first.daemon.services;
        const { id } = runs.createRun({ project: getProject(first.store.db, project.id)!, role: 'orchestrator', summary: 'Plan' });

        runs.setStatus(id, 'running');
        runs.setStatus(id, 'waiting_background', { reason: BACKGROUND_REASON });
        await first.stop();

        const second = await restartHarness(first);

        harnesses.push(second);
        expect(second.run(id)).toMatchObject({ status: 'interrupted', statusReason: 'Daemon restarted' });
        expect(second.run(id).finishedAt).toBeNumber();
        expect(second.events().find(event => event.data.type === 'notice')?.data).toMatchObject({ level: 'warn', text: expect.stringContaining('1 run was interrupted') });
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
