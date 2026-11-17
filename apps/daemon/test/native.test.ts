import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { projectSnapshot } from '../src/domain/snapshots';
import { cleanTempDirs, latch, ScriptEngine, scriptEngines, startHarness, waitFor } from './helpers';

import type { Run, StreamItem } from '@clowdy/protocol';
import type { Harness, Script } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

async function setup(script: Script, overrides: Parameters<typeof startHarness>[0] = {}) {
    const engine = new ScriptEngine(script);
    const h = await startHarness(overrides, { engines: scriptEngines(engine) });

    harnesses.push(h);

    const project = h.openRepo();
    const { chat } = h.ok('chat.create', { projectId: project.id });
    const runId = h.ok('chat.send', { chatId: chat.id, text: 'Look into it' }).runId as string;
    const natives = (): Run[] => projectSnapshot(h.store, project.id).runs.filter(run => run.origin === 'native');
    const items = (id: string): StreamItem[] => h.store.db.query('SELECT * FROM stream_items WHERE run_id = ? ORDER BY seq').all(id).map((row: any) => ({ id: row.id, runId: row.run_id, seq: row.seq, at: row.at, body: JSON.parse(row.body) }));

    return { h, engine, project, chat, runId, natives, items };
}

describe('native sub-agents as child runs', () => {
    test('a sub-agent becomes a native child run with its own stream, and its states map to run statuses', async () => {
        const { h, runId, natives, items } = await setup(async function* () {
            yield { type: 'session', sessionId: 's1' };
            yield { type: 'subagent', agentId: 'a1', parentToolCallId: 't1', name: 'Explore', description: 'Look at the callers', state: 'running' };
            yield { type: 'text', delta: 'Found ', done: false, agentId: 'a1' };
            yield { type: 'text', delta: 'three callers.', done: true, agentId: 'a1' };
            yield { type: 'tool', toolCallId: 'c1', name: 'grep', input: { pattern: 'x' }, state: 'running', agentId: 'a1' };
            yield { type: 'tool', toolCallId: 'c1', name: 'grep', input: { pattern: 'x' }, state: 'done', output: { matches: 3 }, agentId: 'a1' };
            yield { type: 'text', delta: 'The parent speaks.', done: true };
            yield { type: 'subagent', agentId: 'a1', name: 'Explore', description: 'Look at the callers of the router', state: 'running' };
            yield { type: 'subagent', agentId: 'a1', name: 'Explore', state: 'done', summary: 'Three callers, none affected.' };
            yield { type: 'subagent', agentId: 'a2', name: 'Review', description: 'Review the diff', state: 'running' };
            yield { type: 'subagent', agentId: 'a2', name: 'Review', state: 'error', summary: 'The diff was unreadable' };
            yield { type: 'subagent', agentId: 'a3', name: 'Plan', state: 'running' };
            yield { type: 'subagent', agentId: 'a3', name: 'Plan', state: 'cancelled', summary: 'Not needed' };
            yield { type: 'subagent', agentId: 'a4', name: 'Slow', state: 'running' };
            yield { type: 'done', result: 'Looked into it.' };
        });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to finish');

        const [explore, review, plan, slow] = natives();

        expect([explore, review, plan, slow].map(run => run.name)).toEqual(['Explore', 'Review', 'Plan', 'Slow']);
        expect(explore).toMatchObject({ role: 'executor', origin: 'native', engine: 'fake', parentRunId: runId, rootRunId: runId, status: 'succeeded', summary: 'Look at the callers of the router', result: 'Three callers, none affected.', startedAt: expect.any(Number), finishedAt: expect.any(Number) });
        expect(review).toMatchObject({ status: 'failed', error: 'The diff was unreadable' });
        expect(plan).toMatchObject({ status: 'cancelled', statusReason: 'Not needed' });

        // Still running when the parent's turn ended: it ended with the turn.
        expect(slow).toMatchObject({ status: 'cancelled', statusReason: 'The parent run ended its turn' });

        // Text and tool events with an agentId went to that child's stream, the rest to the parent's.
        expect(items(explore.id).map(item => item.body)).toEqual([
            { kind: 'assistant', text: 'Found three callers.', done: true },
            { kind: 'tool', toolCallId: 'c1', name: 'grep', input: { pattern: 'x' }, state: 'done', output: { matches: 3 } },
        ]);
        expect(items(runId).flatMap(item => (item.body.kind === 'assistant' ? [item.body.text] : []))).toEqual(['The parent speaks.']);

        // They are not Clowdy runs: no numbering, no mailbox, no slot, no count in the work in progress.
        expect(h.store.db.query('SELECT COUNT(*) AS n FROM run_mailbox').get()).toEqual({ n: 0 });
        expect(h.run(runId).result).toBe('Looked into it.');
    });

    test('they take no slot, do not count as active work, and do not number the executors', async () => {
        const gate = latch();
        const { h, engine, runId, natives } = await setup(async function* ({ signal }) {
            yield { type: 'session', sessionId: 's1' };

            for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) {
                yield { type: 'subagent', agentId: id, name: 'Explore', state: 'running' };
            }

            await gate.wait(signal);
            yield { type: 'done', result: 'ok' };
        }, { maxRuns: 2 });

        await waitFor(() => natives().length === 5, 'five sub-agents');
        expect(natives().every(run => run.status === 'running')).toBe(true);
        expect(h.daemon.services.runs.activeCount()).toBe(1);
        expect(((await (await fetch(`${ h.url }/v1/health`)).json()) as { activeRuns: number }).activeRuns).toBe(1);

        // The cap of two runs is not used up by six rows in `running`: a second root run starts.
        const task = h.ok('task.create', { projectId: (h.store.db.query('SELECT id FROM projects').get() as { id: string }).id, title: 'Other' }).task;
        const other = h.ok('task.start', { taskId: task.id }).runId as string;

        await waitFor(() => h.run(other).status === 'running', 'the second run to start next to the sub-agents');
        expect(engine.turns).toHaveLength(2);
        gate.release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to finish');
        expect((h.store.db.query('SELECT COUNT(*) AS n FROM runs WHERE role = \'executor\' AND origin IS NOT \'native\'').get() as { n: number }).n).toBe(0);
    });

    test('a burst of hundreds is written in a few batches and listed up to a cap', async () => {
        const total = 400;
        const { h, runId, natives, items } = await setup(async function* () {
            yield { type: 'session', sessionId: 's1' };

            for (let index = 1; index <= total; index++) {
                yield { type: 'subagent', agentId: `a${ index }`, name: `Agent ${ index }`, state: 'running' };
                yield { type: 'text', delta: 'working', done: true, agentId: `a${ index }` };
                yield { type: 'subagent', agentId: `a${ index }`, name: `Agent ${ index }`, state: 'done', summary: `result ${ index }` };
            }

            yield { type: 'done', result: 'all done' };
        });
        const batches: number[] = [];

        h.store.subscribe(events => batches.push(events.length));
        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to finish', 10_000);

        expect(natives()).toHaveLength(300);
        expect(natives().every(run => run.status === 'succeeded')).toBe(true);
        expect(items(runId).filter(item => item.body.kind === 'note').map(item => (item.body as { text: string }).text)).toEqual(['100 more sub-agents ran and are not listed here']);

        const published = batches.reduce((sum, size) => sum + size, 0);

        expect(published).toBeGreaterThan(900);
        expect(batches.length).toBeLessThan(published / 5);
    });

    test('a sub-agent cannot be cancelled alone; cancelling the parent ends them all, and late events change nothing', async () => {
        const gate = latch();
        const { h, runId, natives } = await setup(async function* ({ signal }) {
            yield { type: 'session', sessionId: 's1' };
            yield { type: 'subagent', agentId: 'a1', name: 'Explore', state: 'running' };

            try {
                await gate.wait(signal);
            }
            catch {
                // A badly behaved engine keeps talking after the abort.
            }

            yield { type: 'subagent', agentId: 'a1', name: 'Explore', state: 'done', summary: 'too late' };
            yield { type: 'text', delta: 'too late', done: true, agentId: 'a1' };
        });

        await waitFor(() => natives().length === 1, 'the sub-agent');

        const [native] = natives();

        expect(h.send('run.cancel', { runId: native.id })).toMatchObject({ ok: false, error: { code: 'conflict', message: expect.stringContaining('cancel the parent run instead') } });

        const { cancelled } = h.ok('run.cancel', { runId });

        expect(cancelled).toEqual([native.id, runId]);
        await Bun.sleep(100);
        expect(h.run(native.id)).toMatchObject({ status: 'cancelled', statusReason: 'Cancelled by user' });
        expect(h.run(runId).status).toBe('cancelled');
    });
});
