import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { cleanTempDirs, latch, restartHarness, ScriptEngine, scriptEngines, SHORT_TIMINGS, startHarness, waitFor } from './helpers';

import type { EngineEvent } from '../src/engine/types';
import type { Harness, Script, Turn } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

type Part = (turn: Turn, spawned: string[]) => AsyncGenerator<EngineEvent>;

interface Plan {
    /** Executors the orchestrator starts on its first turn, one task each. */
    children: number;
    /** What an executor does; `key` is the task it was given. */
    child: (turn: Turn, key: string) => AsyncGenerator<EngineEvent>;
    /** More work of the orchestrator's first turn, after it started the executors (`spawned` are their run ids). */
    afterSpawn?: Part;
    /** The orchestrator's later turns. */
    onWake?: Part;
}

const isOrchestrator = (turn: Turn) => turn.options.tools.some(tool => tool.name === 'run_spawn');

/** An orchestrator that starts executors and ends its turn, and executors that do what the test says. */
function scripted(plan: Plan): Script {
    return async function* (turn) {
        const { options, call } = turn;

        yield { type: 'session', sessionId: options.resumeSessionId ?? `s-${ turn.number }` };

        if (!isOrchestrator(turn)) {
            yield* plan.child(turn, /Goal: (\S+)/.exec(options.prompt)![1]);

            return;
        }

        if (options.resumeSessionId) {
            yield* plan.onWake?.(turn, []) ?? [];
            yield { type: 'done', result: 'wrapped up' };

            return;
        }

        const spawned: string[] = [];

        for (let index = 1; index <= plan.children; index++) {
            const { task } = yield* call('task_create', { title: `Task ${ index }` });
            const child = yield* call('run_spawn', { taskIds: [task.key], prompt: `Goal: ${ task.key }`, idempotencyKey: `${ task.key }-executor-1` });

            spawned.push(child.runId);
        }

        yield* plan.afterSpawn?.(turn, spawned) ?? [];
        yield { type: 'done', result: 'spawned' };
    };
}

/** An executor that waits for `gate`, then reports `status` with `summary`. */
function reporting(gate: ReturnType<typeof latch> | undefined, summary: string, status: 'done' | 'failed' | 'blocked' = 'done'): Plan['child'] {
    return async function* (turn, key) {
        await gate?.wait(turn.signal);
        yield* turn.call('report_result', { status, summary, taskUpdates: [{ taskId: key, status: 'review' }] });
        yield { type: 'done' };
    };
}

async function setup(plan: Plan, overrides: Parameters<typeof startHarness>[0] = {}, closeMs = 0) {
    const engine = new ScriptEngine(scripted(plan), closeMs);
    const h = await startHarness(overrides, { engines: scriptEngines(engine) });

    harnesses.push(h);

    const project = h.openRepo();
    const { chat } = h.ok('chat.create', { projectId: project.id });
    const runId = h.ok('chat.send', { chatId: chat.id, text: 'Do the work' }).runId as string;
    const children = () => h.store.db.query('SELECT id FROM runs WHERE parent_run_id = ? AND origin = \'spawned\' ORDER BY created_at, id').all(runId).map(row => (row as { id: string }).id);
    const resumed = () => engine.turns.filter(options => options.resumeSessionId);

    return { h, engine, project, chat, runId, children, resumed };
}

describe('ending the turn after spawning', () => {
    test('the parent parks and frees its slot and process, then the same session resumes with the child\'s summary', async () => {
        const gate = latch();
        const { h, engine, runId, children, resumed } = await setup({ children: 1, child: reporting(gate, 'Result: done - the footer is fixed') }, { maxRuns: 1 });

        await waitFor(() => h.run(runId).status === 'waiting_children', 'the orchestrator to park');
        expect(h.run(runId).statusReason).toBe('Waiting for 1 child run');

        // The only slot is free for the child, and the parent's session is closed.
        const [childId] = children();

        await waitFor(() => h.run(childId).status === 'running', 'the child to take the freed slot');
        expect(engine.closed).toBeGreaterThanOrEqual(1);
        expect(h.run(runId).sessionId).toBe('s-1');
        expect(h.daemon.services.runs.activeCount()).toBe(2);

        gate.release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to finish');

        expect(h.run(runId)).toMatchObject({ status: 'succeeded', sessionId: 's-1', result: 'wrapped up' });
        expect(resumed()).toHaveLength(1);

        const [wake] = resumed();

        expect(wake.resumeSessionId).toBe('s-1');
        expect(wake.prompt).toContain('A child run has finished.');
        expect(wake.prompt).toContain(`1. Executor 01 (${ childId }) on REP-1: succeeded`);
        expect(wake.prompt).toContain('Summary: Result: done - the footer is fixed');

        // The wake-up shows in the chat as a line, and the stream kept growing in the same run.
        const notes = h.store.db.query('SELECT body FROM stream_items WHERE run_id = ? ORDER BY seq').all(runId).map(row => JSON.parse((row as { body: string }).body)).filter(body => body.kind === 'note').map(body => body.text);

        expect(notes).toEqual(['Started Executor 01 on REP-1', 'Executor 01 finished: succeeded']);
    });

    test('a wake-up never overlaps the previous turn of the same run, even when its session closes slowly', async () => {
        const { h, engine, runId } = await setup({ children: 1, child: reporting(undefined, 'instant') }, {}, 120);

        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to finish', 5000);

        // Session 1 is the orchestrator's first turn, 2 the executor, 3 the wake-up.
        expect(engine.turns[2].resumeSessionId).toBe('s-1');
        expect(engine.startedAt[2]).toBeGreaterThanOrEqual(engine.closedAt[0]);
    });

    test('a parent is not succeeded while a child still works, however many turns it takes', async () => {
        const first = latch();
        const second = latch();
        const { h, runId, children, resumed } = await setup({
            children: 2,
            child: async function* (turn, key) {
                yield* reporting(key === 'REP-1' ? first : second, `done ${ key }`)(turn, key);
            },
        });

        await waitFor(() => h.run(runId).status === 'waiting_children', 'the orchestrator to park');
        first.release();
        await waitFor(() => resumed().length === 1, 'the first wake-up');
        await waitFor(() => h.run(runId).status === 'waiting_children' && h.run(runId).statusReason === 'Waiting for 1 child run', 'the parent to park again');
        expect(resumed()[0].prompt).toContain('A child run has finished.');
        expect(resumed()[0].prompt).not.toContain('REP-2');

        second.release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to finish');
        expect(resumed()).toHaveLength(2);
        expect(resumed()[1].prompt).toContain(`(${ children()[1] }) on REP-2: succeeded`);
    });

    test('children finishing together arrive in one wake-up', async () => {
        const gate = latch();
        const { h, runId, resumed } = await setup({ children: 3, child: reporting(gate, 'ok') }, { timings: { ...SHORT_TIMINGS, wakeWindowMs: 120 } });

        await waitFor(() => h.run(runId).status === 'waiting_children', 'the orchestrator to park');
        gate.release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to finish');

        expect(resumed()).toHaveLength(1);
        expect(resumed()[0].prompt).toContain('3 child runs have finished.');

        for (const number of [1, 2, 3]) {
            expect(resumed()[0].prompt).toContain(`${ number }. Executor 0${ number } (run_`);
        }
    });

    test('a failure and a cancellation wake the parent with their reasons, and say not to restart cancelled work', async () => {
        const never = latch();
        const { h, runId, children, resumed } = await setup({
            children: 2,
            child: async function* (turn, key) {
                if (key === 'REP-1') {
                    yield { type: 'error', message: 'The build exploded' };
                }
                else {
                    await never.wait(turn.signal);
                }
            },
        });

        await waitFor(() => children().length === 2 && h.run(children()[0]).status === 'failed', 'the first child to fail');
        h.ok('run.cancel', { runId: children()[1] });
        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to finish');

        const prompts = resumed().map(options => options.prompt).join('\n---\n');

        expect(prompts).toContain('on REP-1: failed\nReason: The build exploded');
        expect(prompts).toContain('on REP-2: cancelled\nReason: Cancelled by user\nSomeone stopped this run on purpose. Do not restart it silently');
    });

    test('a cancelled orchestrator is not woken; the next message resumes it and tells it what happened to its children', async () => {
        const never = latch();
        const { h, engine, runId, chat, children, resumed } = await setup({ children: 1, child: reporting(never, 'never') });

        await waitFor(() => h.run(runId).status === 'waiting_children', 'the orchestrator to park');
        h.ok('run.cancel', { runId });
        expect(h.run(children()[0]).status).toBe('cancelled');
        await Bun.sleep(100);
        expect(resumed()).toHaveLength(0);
        expect(h.store.db.query('SELECT delivered_at FROM run_mailbox').all()).toEqual([{ delivered_at: null }]);

        h.ok('chat.send', { chatId: chat.id, text: 'Where were we?' });
        await waitFor(() => resumed().length === 1, 'the resumed turn');
        expect(resumed()[0].prompt.startsWith('Where were we?\n\nA child run has finished.')).toBe(true);
        expect(resumed()[0].prompt).toContain('Executor 01');
        expect(resumed()[0].prompt).toContain(': cancelled');
        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to finish');
        expect(h.store.db.query('SELECT delivered_at IS NOT NULL AS delivered FROM run_mailbox').all()).toEqual([{ delivered: 1 }]);
        expect(engine.turns.filter(options => options.resumeSessionId)).toHaveLength(1);
    });

    test('a message while the parent waits resumes the session at once, then it waits for the rest', async () => {
        const gate = latch();
        const { h, runId, chat, resumed } = await setup({ children: 1, child: reporting(gate, 'ok') });

        await waitFor(() => h.run(runId).status === 'waiting_children', 'the orchestrator to park');
        h.ok('chat.send', { chatId: chat.id, text: 'Also add tests' });
        expect(h.run(runId).status).toBe('queued');
        await waitFor(() => resumed().length === 1, 'the message to start a turn');
        expect(resumed()[0].prompt).toBe('Also add tests');
        await waitFor(() => h.run(runId).status === 'waiting_children', 'the parent to wait again');

        gate.release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to finish');
        expect(resumed()).toHaveLength(2);
        expect(resumed()[1].prompt).toContain('on REP-1: succeeded');
    });

    test('results that arrive before the parent ends its turn wake it straight away', async () => {
        const turnEnd = latch();
        const { h, runId, children, resumed } = await setup({
            children: 1,
            child: reporting(undefined, 'quick'),
            afterSpawn: async function* (turn) {
                yield { type: 'text', delta: 'Busy with something else.', done: true };
                await turnEnd.wait(turn.signal);
            },
        });

        await waitFor(() => children().length === 1 && h.run(children()[0]).status === 'succeeded', 'the child to finish while the parent still works');
        expect(h.run(runId).status).toBe('running');
        turnEnd.release();
        await waitFor(() => resumed().length === 1, 'the wake-up');
        expect(resumed()[0].prompt).toContain('on REP-1: succeeded');
        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to finish');
        expect(resumed()).toHaveLength(1);
    });

    test('run_wait hands over the results, so the parent is not told about the same children again', async () => {
        const gate = latch();
        const seen: unknown[] = [];
        const { h, runId, resumed } = await setup({
            children: 1,
            child: reporting(gate, 'waited for'),
            afterSpawn: async function* (turn, spawned) {
                setTimeout(() => gate.release(), 40);
                seen.push(yield* turn.call('run_wait', { runIds: spawned, timeoutSeconds: 5 }));
            },
        });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to finish');
        expect(seen).toEqual([{ runs: [expect.objectContaining({ name: 'Executor 01', state: 'succeeded', summary: 'waited for', taskIds: ['REP-1'] })], timedOut: false }]);
        expect(resumed()).toHaveLength(0);
    });

    test('run_wait gives up after its timeout and reports the child as still working', async () => {
        const never = latch();
        const seen: any[] = [];
        const { h, runId } = await setup({
            children: 1,
            child: reporting(never, 'never'),
            afterSpawn: async function* (turn, spawned) {
                seen.push(yield* turn.call('run_wait', { runIds: spawned, timeoutSeconds: 1 }));
            },
        });

        await waitFor(() => h.run(runId).status === 'waiting_children', 'the orchestrator to park', 5000);
        expect(seen[0]).toMatchObject({ timedOut: true, runs: [{ state: 'running' }] });
    });
});

describe('restarts', () => {
    test('a parent that waited through a restart is woken once, with its interrupted child', async () => {
        const never = latch();
        const first = new ScriptEngine(scripted({ children: 1, child: reporting(never, 'never') }));
        const h1 = await startHarness({}, { engines: scriptEngines(first) });
        const project = h1.openRepo();
        const { chat } = h1.ok('chat.create', { projectId: project.id });
        const runId = h1.ok('chat.send', { chatId: chat.id, text: 'Do the work' }).runId as string;

        await waitFor(() => h1.run(runId).status === 'waiting_children' && first.turns.length === 2, 'the parent to park and the child to start');
        await h1.stop();

        const second = new ScriptEngine(scripted({ children: 1, child: reporting(never, 'never') }));
        const h2 = await restartHarness(h1, { engines: scriptEngines(second) });

        harnesses.push(h2);
        await waitFor(() => h2.run(runId).status === 'succeeded', 'the parent to be woken and finish');

        const [child] = h2.store.db.query('SELECT id, status, status_reason FROM runs WHERE parent_run_id = ?').all(runId) as { id: string; status: string; status_reason: string }[];

        expect(child).toMatchObject({ status: 'interrupted', status_reason: 'Daemon restarted' });
        expect(second.turns).toHaveLength(1);
        expect(second.turns[0].resumeSessionId).toBe('s-1');
        expect(second.turns[0].prompt).toContain(`(${ child.id }) on REP-1: interrupted\nReason: Daemon restarted`);
        expect(second.turns[0].prompt).toContain('The process died or the app restarted.');

        // Delivered once: a further restart tells nobody anything.
        await h2.stop();

        const third = new ScriptEngine(scripted({ children: 1, child: reporting(never, 'never') }));
        const h3 = await restartHarness(h2, { engines: scriptEngines(third) });

        harnesses.push(h3);
        await Bun.sleep(100);
        expect(third.turns).toHaveLength(0);
        expect(h3.run(runId).status).toBe('succeeded');
    });

    test('a result the parent never heard is delivered after a restart', async () => {
        const gate = latch();
        const first = new ScriptEngine(scripted({ children: 1, child: reporting(gate, 'finished early') }));
        const h1 = await startHarness({ timings: { ...SHORT_TIMINGS, wakeWindowMs: 60_000 } }, { engines: scriptEngines(first) });
        const project = h1.openRepo();
        const { chat } = h1.ok('chat.create', { projectId: project.id });
        const runId = h1.ok('chat.send', { chatId: chat.id, text: 'Do the work' }).runId as string;

        await waitFor(() => h1.run(runId).status === 'waiting_children' && first.turns.length === 2, 'the parent to park and the child to start');
        gate.release();
        await waitFor(() => (h1.store.db.query('SELECT COUNT(*) AS n FROM run_mailbox WHERE delivered_at IS NULL').get() as { n: number }).n === 1, 'the result to be recorded');
        expect(h1.run(runId).status).toBe('waiting_children');
        await h1.stop();

        const second = new ScriptEngine(scripted({ children: 1, child: reporting(gate, 'x') }));
        const h2 = await restartHarness(h1, { engines: scriptEngines(second) }, { timings: SHORT_TIMINGS });

        harnesses.push(h2);
        await waitFor(() => h2.run(runId).status === 'succeeded', 'the parent to be woken and finish');
        expect(second.turns).toHaveLength(1);
        expect(second.turns[0]).toMatchObject({ resumeSessionId: 's-1', prompt: expect.stringContaining('on REP-1: succeeded\nSummary: finished early') });
    });
});
