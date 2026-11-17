import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';

import { getRunWork } from '../src/db/runs';
import { getProject } from '../src/db/projects';
import { isAlive } from '../src/runs/processes';
import { toolsFor } from '../src/runs/tools';
import { cleanTempDirs, latch, ScriptEngine, scriptEngines, startHarness, untilAborted, waitFor } from './helpers';

import type { Harness, Script } from './helpers';

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

function startProcess(command: string): number {
    const child = spawn('sh', ['-c', command], { detached: true, stdio: 'ignore' });

    child.unref();
    spawned.push(child.pid!);

    return child.pid!;
}

async function setup(script: Script, overrides: Parameters<typeof startHarness>[0] = {}) {
    const engine = new ScriptEngine(script);
    const h = await startHarness(overrides, { engines: scriptEngines(engine) });

    harnesses.push(h);

    const project = h.openRepo();
    const start = (title: string) => h.ok('task.start', { taskId: h.ok('task.create', { projectId: project.id, title }).task.id }).runId as string;

    return { h, engine, project, start };
}

describe('a subscription rejection', () => {
    test('does not fail a run that waits for the user\'s answer; the run keeps waiting and can still be answered', async () => {
        const resets = Date.now() + 300;
        const { h, engine, project, start } = await setup(async function* ({ options, signal, number, call }) {
            yield { type: 'session', sessionId: options.resumeSessionId ?? `s${ number }` };

            if (number === 1) {
                yield* call('ask_user', { question: 'Which one?', options: [{ id: 'a', label: 'A' }] });
                yield { type: 'done', result: 'asked' };

                return;
            }

            yield { type: 'limit', status: 'rejected', resetsAt: resets };
            await untilAborted(signal);
        });

        h.ok('project.update', { projectId: project.id, settings: { chatMode: 'semi' } });

        const asking = start('Ask');

        await waitFor(() => h.run(asking).status === 'waiting_user', 'the question');

        const other = start('Other');

        await waitFor(() => h.run(other).status === 'blocked', 'the other run to wait for the reset');
        await Bun.sleep(100);
        expect(h.run(asking).status).toBe('waiting_user');
        expect(h.run(asking).error).toBeUndefined();

        const question = h.store.db.query('SELECT body FROM stream_items WHERE run_id = ? ORDER BY seq').all(asking).map(row => JSON.parse((row as { body: string }).body)).find(body => body.kind === 'question');

        h.ok('run.answer', { runId: asking, questionId: question.questionId, answer: 'a' });
        await waitFor(() => h.run(asking).status === 'succeeded', 'the answered run to finish');
        expect(engine.turns.length).toBeGreaterThanOrEqual(2);
    });

    test('with a reset time that already passed pauses for a while instead of retrying in a loop', async () => {
        const { h, engine, start } = await setup(async function* ({ options, signal, number }) {
            yield { type: 'session', sessionId: options.resumeSessionId ?? `s${ number }` };
            yield { type: 'limit', status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) - 3600 };
            await untilAborted(signal);
        });
        const run = start('Loop');

        await waitFor(() => h.run(run).status === 'blocked', 'the run to wait');
        await Bun.sleep(400);
        expect(engine.turns.length).toBe(1);
        expect(h.run(run).status).toBe('blocked');
    });
});

describe('cancelling', () => {
    test('a cancelled orchestrator can no longer start child runs, even from a tool call already on its way', async () => {
        const hold = latch();
        const { h, project } = await setup(async function* ({ signal }) {
            yield { type: 'session', sessionId: 's1' };
            await hold.wait(signal);
            yield { type: 'done' };
        });
        const { store, runs, driver } = h.daemon.services;
        const { chat } = h.ok('chat.create', { projectId: project.id });
        const orchestrator = runs.createRun({ project: getProject(store.db, project.id)!, role: 'orchestrator', chatId: chat.id, summary: 'Plan' });
        const tools = toolsFor({ store, runs, driver }, orchestrator, 'autopilot');
        const exec = (name: string, input: unknown) => tools.find(tool => tool.name === name)!.execute(input, new AbortController().signal) as Promise<any>;
        const { task } = await exec('task_create', { title: 'A' });

        runs.cancel(orchestrator.id);

        await expect(exec('run_spawn', { taskIds: [task.key], prompt: 'Goal', idempotencyKey: 'k1' })).rejects.toThrow(/not running|cancelled/i);
        expect(store.db.query('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = ?').get(orchestrator.id)).toEqual({ n: 0 });
    });

    test('the kill ladder of a cancelled run does not touch the process of its next turn', async () => {
        const stale = startProcess('sleep 60');
        const next = startProcess('sleep 60');
        const hold = latch();
        const { h, project } = await setup(async function* ({ options, signal, number }) {
            yield { type: 'session', sessionId: `s${ number }` };
            yield { type: 'process', pid: number === 1 ? stale : next, pgid: number === 1 ? stale : next };

            if (number === 1) {
                await untilAborted(signal);
            }
            else {
                await hold.wait(signal);
            }

            yield { type: 'done', result: 'ok' };
        }, { timings: { wakeWindowMs: 15, killGraceMs: 200, retryBaseMs: 10, pauseJitterMs: 0 } });
        const { chat } = h.ok('chat.create', { projectId: project.id });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'first' });

        await waitFor(() => getRunWork(h.store.db, runId).process?.pid === stale, 'the first process');
        h.ok('run.cancel', { runId });
        await waitFor(() => h.run(runId).status === 'cancelled' && !getRunWork(h.store.db, runId).process, 'the first turn to end');
        h.ok('chat.send', { chatId: chat.id, text: 'second' });
        await waitFor(() => getRunWork(h.store.db, runId).process?.pid === next, 'the second process');
        await Bun.sleep(600);
        expect(isAlive(next)).toBe(true);
        expect(h.run(runId).status).toBe('running');
    });
});
