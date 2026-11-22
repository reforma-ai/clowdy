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

async function setup(script: Script, overrides: Parameters<typeof startHarness>[0] = {}, stops?: ScriptEngine['stopAnswer']) {
    const engine = new ScriptEngine(script);

    engine.stopAnswer = stops;

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
        expect(explore).toMatchObject({ role: 'executor', origin: 'native', parentToolCallId: 't1', engine: 'fake', parentRunId: runId, rootRunId: runId, status: 'succeeded', summary: 'Look at the callers of the router', result: 'Three callers, none affected.', startedAt: expect.any(Number), finishedAt: expect.any(Number) });
        expect(review).toMatchObject({ status: 'failed', error: 'The diff was unreadable' });
        // An engine that does not say which call started a sub-agent leaves the run without one.
        expect(review.parentToolCallId).toBeUndefined();
        expect(plan).toMatchObject({ status: 'cancelled', statusReason: 'Not needed' });

        // Still running when the parent's turn ended: it ended with the turn.
        expect(slow).toMatchObject({ status: 'cancelled', statusReason: 'The parent run ended its turn' });

        // Text and tool events with an agentId went to that child's stream, the rest to the parent's.
        expect(items(explore.id).map(item => item.body)).toEqual([
            { kind: 'assistant', text: 'Found three callers.', done: true },
            { kind: 'tool', toolCallId: 'c1', name: 'grep', input: { pattern: 'x' }, state: 'done', output: { matches: 3 } },
        ]);
        expect(items(runId).flatMap(item => (item.body.kind === 'assistant' ? [item.body.text] : []))).toEqual(['The parent speaks.']);

        // They are not Clowdy runs: no numbering, no slot, no count in the work in progress.
        expect(h.run(runId).result).toBe('Looked into it.');
    });

    test('what a sub-agent thinks is a reasoning item of its own stream, between its other steps, and not of the parent\'s', async () => {
        const { h, runId, natives, items } = await setup(async function* () {
            yield { type: 'session', sessionId: 's1' };
            yield { type: 'thought', delta: 'The parent thinks.', done: true };
            yield { type: 'subagent', agentId: 'a1', parentToolCallId: 't1', name: 'Explore', description: 'Look at the callers', state: 'running' };
            yield { type: 'thought', delta: '\n\nThe callers are in the router.', done: false, agentId: 'a1' };
            yield { type: 'tool', toolCallId: 'c1', name: 'grep', input: { pattern: 'x' }, state: 'done', output: { matches: 3 }, agentId: 'a1' };
            yield { type: 'thought', delta: 'Three is enough.', done: false, agentId: 'a1' };
            yield { type: 'text', delta: 'Found three callers.', done: true, agentId: 'a1' };
            yield { type: 'subagent', agentId: 'a1', name: 'Explore', state: 'done', summary: 'Three callers.' };
            yield { type: 'done', result: 'Looked into it.' };
        });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to finish');
        await waitFor(() => natives()[0]?.status === 'succeeded', 'the sub-agent to finish');

        const [explore] = natives();

        expect(items(explore.id).map(item => item.body.kind)).toEqual(['reasoning', 'tool', 'reasoning', 'assistant']);
        expect(items(explore.id).flatMap(item => (item.body.kind === 'reasoning' ? [[item.body.text, item.body.done]] : []))).toEqual([['The callers are in the router.', true], ['Three is enough.', true]]);
        // The parent's own thought is in the parent's stream.
        expect(items(runId).flatMap(item => (item.body.kind === 'reasoning' ? [item.body.text] : []))).toEqual(['The parent thinks.']);
    });

    test('they take no slot, do not count as active work, and are not numbered', async () => {
        const gate = latch();
        const { h, engine, project, runId, natives } = await setup(async function* ({ signal }) {
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
        const task = h.ok('task.create', { projectId: project.id, title: 'Other' }).task;
        const other = h.ok('task.start', { taskId: task.id }).runId as string;

        await waitFor(() => h.run(other).status === 'running', 'the second run to start next to the sub-agents');
        expect(engine.turns).toHaveLength(2);
        gate.release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to finish');
        // A sub-agent keeps the name its engine gave it, and the next orchestrator's number counts orchestrators only.
        expect(natives().every(run => run.name === 'Explore')).toBe(true);
        expect(h.run(other).name).toBe('Orchestrator 02');
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
    test('through the HTTP API, a sub-agent its engine can end alone is cancelled alone; one it cannot, and one that did not say it can be stopped, are refused as before', async () => {
        const gate = latch();
        const script: Script = async function* (turn) {
            yield { type: 'session', sessionId: 's1' };
            yield { type: 'subagent', agentId: 'a1', parentToolCallId: 't1', name: 'Explore', state: 'running', stoppable: true };
            yield { type: 'subagent', agentId: 'a2', parentToolCallId: 't2', name: 'Review', state: 'running', stoppable: true };
            yield { type: 'subagent', agentId: 'a3', parentToolCallId: 't3', name: 'Plan', state: 'running' };

            // The engine ends the one it was asked to end, as the agent does, with its own event; the turn goes on.
            const agentId = await turn.stopRequested();

            if (agentId === undefined) {
                return;
            }

            yield { type: 'subagent', agentId, name: 'Explore', state: 'cancelled' };

            try {
                await gate.wait(turn.signal);
            }
            catch {
                return;
            }

            yield { type: 'done', result: 'ok' };
        };
        const { h, engine, runId, natives } = await setup(script, {}, () => true);
        const post = async (id: string) => (await h.fetch('/v1/commands', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: `r-${ id }-${ Math.random() }`, type: 'run.cancel', runId: id }) })).json() as Promise<{ ok: boolean; data?: { cancelled: string[] }; error?: { code: string; message: string } }>;

        await waitFor(() => natives().length === 3, 'three sub-agents');

        const [explore, review, plan] = natives();

        expect([explore.canStopAlone, review.canStopAlone, plan.canStopAlone]).toEqual([true, true, undefined]);
        expect(await post(plan.id)).toMatchObject({ ok: false, error: { code: 'conflict', message: expect.stringContaining('cancel the parent run instead') } });
        expect(engine.stopRequests).toEqual([]);

        expect(await post(explore.id)).toMatchObject({ ok: true, data: { cancelled: [explore.id] } });
        await waitFor(() => h.run(explore.id).status === 'cancelled', 'the sub-agent to end');
        expect(engine.stopRequests).toEqual(['a1']);
        // Only that one: its parent and the others go on, and the stop did not cancel the run.
        expect([h.run(review.id).status, h.run(plan.id).status, h.run(runId).status]).toEqual(['running', 'running', 'running']);
        // What is over cancels nothing.
        expect(await post(explore.id)).toMatchObject({ ok: true, data: { cancelled: [] } });

        gate.release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to finish');
    });
});
