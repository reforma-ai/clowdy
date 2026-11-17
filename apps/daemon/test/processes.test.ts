import { Database } from 'bun:sqlite';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { getRunWork } from '../src/db/runs';
import { isAlive, startTimeOf } from '../src/runs/processes';
import { cleanTempDirs, restartHarness, ScriptEngine, scriptEngines, startHarness, untilAborted, waitFor } from './helpers';

import type { Harness } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];
const spawned: number[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));

    for (const pid of spawned.splice(0)) {
        try {
            process.kill(-pid, 'SIGKILL');
        }
        catch {
            // already gone
        }
    }
});

/** A process in a group of its own, like an engine's process, that the test kills if the daemon does not. */
function startProcess(command: string): number {
    const child = spawn('sh', ['-c', command], { detached: true, stdio: 'ignore' });

    child.unref();
    spawned.push(child.pid!);

    return child.pid!;
}

const gone = (pid: number) => !isAlive(pid);

describe('cancelling a run whose engine does not stop', () => {
    test('signals the process group after the grace period: SIGTERM first, SIGKILL for what ignores it', async () => {
        const polite = startProcess('sleep 60');
        const stubborn = startProcess('trap "" TERM; while true; do sleep 1; done');
        const pids = [polite, stubborn];
        const engine = new ScriptEngine(async function* ({ number, options }) {
            yield { type: 'session', sessionId: `s${ number }` };

            const pid = pids[number - 1];

            yield { type: 'process', pid, pgid: pid };

            // The engine never notices the abort.
            await new Promise(() => undefined);
            yield { type: 'done', result: String(options.prompt.length) };
        });
        const h = await startHarness({ timings: { wakeWindowMs: 15, killGraceMs: 300, retryBaseMs: 10, pauseJitterMs: 0 } }, { engines: scriptEngines(engine) });

        harnesses.push(h);

        const project = h.openRepo();
        const runs = ['A', 'B'].map(title => h.ok('task.start', { taskId: h.ok('task.create', { projectId: project.id, title }).task.id }).runId as string);

        await waitFor(() => runs.every(id => getRunWork(h.store.db, id).process), 'both processes to be recorded');

        const recorded = getRunWork(h.store.db, runs[0]).process!;

        expect(recorded).toMatchObject({ pid: polite, pgid: polite });
        expect(Math.abs(recorded.startedAt! - startTimeOf(polite)!)).toBeLessThan(2000);

        const cancelledAt = Date.now();

        for (const id of runs) {
            h.ok('run.cancel', { runId: id });
        }

        // Nothing is signalled before the grace period is over.
        await Bun.sleep(150);
        expect(pids.every(isAlive)).toBe(true);

        await waitFor(() => gone(polite), 'SIGTERM to end the polite process', 3000);
        expect(Date.now() - cancelledAt).toBeGreaterThanOrEqual(300);
        expect(isAlive(stubborn)).toBe(true);
        await waitFor(() => gone(stubborn), 'SIGKILL to end the one that ignores SIGTERM', 3000);
        expect(Date.now() - cancelledAt).toBeGreaterThanOrEqual(600);
    });

    test('a run that stops by itself is left alone, and its process record is cleared', async () => {
        const pid = startProcess('sleep 60');
        const engine = new ScriptEngine(async function* ({ signal }) {
            yield { type: 'session', sessionId: 's1' };
            yield { type: 'process', pid, pgid: pid };
            await untilAborted(signal);
        });
        const h = await startHarness({ timings: { wakeWindowMs: 15, killGraceMs: 200, retryBaseMs: 10, pauseJitterMs: 0 } }, { engines: scriptEngines(engine) });

        harnesses.push(h);

        const project = h.openRepo();
        const runId = h.ok('task.start', { taskId: h.ok('task.create', { projectId: project.id, title: 'A' }).task.id }).runId as string;

        await waitFor(() => getRunWork(h.store.db, runId).process, 'the process to be recorded');
        h.ok('run.cancel', { runId });
        await waitFor(() => !getRunWork(h.store.db, runId).process, 'the record to be cleared');
        await Bun.sleep(600);
        expect(isAlive(pid)).toBe(true);
    });
});

describe('a daemon that crashed', () => {
    test('kills engine processes that outlived it, but only those that are still the recorded process, and interrupts their runs', async () => {
        const engine = new ScriptEngine(async function* ({ signal }) {
            yield { type: 'session', sessionId: 's1' };
            await untilAborted(signal);
        });
        const first = await startHarness({}, { engines: scriptEngines(engine) });
        const project = first.openRepo();
        const runs = ['A', 'B'].map(title => first.ok('task.start', { taskId: first.ok('task.create', { projectId: project.id, title }).task.id }).runId as string);

        await waitFor(() => engine.turns.length === 2 && runs.every(id => first.run(id).status === 'running'), 'two live runs');
        await first.stop();

        // What a crash leaves behind: runs still `running`, their engine processes still alive.
        const survivor = startProcess('sleep 60');
        const recycled = startProcess('sleep 60');
        const db = new Database(join(first.config.dataDir, 'clowdy.db'));
        const record = db.query('UPDATE runs SET pid = ?, pgid = ?, process_started_at = ?, status = \'running\' WHERE id = ?');

        // `recycled` stands for a pid the OS gave to another process after the engine died: it started long after the recorded time.
        record.run(survivor, survivor, startTimeOf(survivor)!, runs[0]);
        record.run(recycled, recycled, startTimeOf(recycled)! - 3_600_000, runs[1]);
        db.close();

        const after = new ScriptEngine(async function* () {
            yield { type: 'done' };
        });
        const second = await restartHarness(first, { engines: scriptEngines(after) });

        harnesses.push(second);
        await Bun.sleep(50);
        expect(after.turns).toHaveLength(0);
        expect(isAlive(survivor)).toBe(false);
        expect(isAlive(recycled)).toBe(true);
        expect(runs.map(id => second.run(id))).toEqual([
            expect.objectContaining({ status: 'interrupted', statusReason: 'Daemon restarted' }),
            expect.objectContaining({ status: 'interrupted', statusReason: 'Daemon restarted' }),
        ]);
        expect(runs.map(id => getRunWork(second.store.db, id).process)).toEqual([undefined, undefined]);
    });
});

describe('the process guard', () => {
    test('refuses to start an engine session beyond the cap on live processes', async () => {
        const engine = new ScriptEngine(async function* ({ signal }) {
            yield { type: 'session', sessionId: 's1' };
            await untilAborted(signal);
        });
        const h = await startHarness({ maxProcesses: 2 }, { engines: scriptEngines(engine) });

        harnesses.push(h);

        const project = h.openRepo();
        const runs = ['A', 'B', 'C'].map(title => h.ok('task.start', { taskId: h.ok('task.create', { projectId: project.id, title }).task.id }).runId as string);

        await waitFor(() => h.run(runs[2]).status === 'failed', 'the third run to be refused');
        expect(h.run(runs[2]).error).toBe('2 engine processes are alive, the most this daemon allows (CLOWDY_MAX_PROCESSES); the run was not started');
        expect(runs.slice(0, 2).map(id => h.run(id).status)).toEqual(['running', 'running']);
        expect(engine.turns).toHaveLength(2);
    });
});
