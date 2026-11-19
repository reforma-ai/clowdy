import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { listItems } from '../src/db/items';
import { getRun } from '../src/db/runs';
import { cleanTempDirs, latch, ScriptEngine, scriptEngines, startHarness, untilAborted, waitFor } from './helpers';

import type { StreamItemBody } from '@clowdy/protocol';
import type { EngineEvent } from '../src/engine/types';
import type { Harness, Script } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

async function setup(script: Script) {
    const engine = new ScriptEngine(script);
    const h = await startHarness({}, { engines: scriptEngines(engine) });

    harnesses.push(h);

    const project = h.openRepo();
    const { chat } = h.ok('chat.create', { projectId: project.id });
    const runId = h.ok('chat.send', { chatId: chat.id, text: 'Look into it' }).runId as string;
    const tools = (id: string) => listItems(h.store.db, id, 0).flatMap(item => (item.body.kind === 'tool' ? [item.body] : []));

    return { h, engine, chat, runId, tools };
}

const call = (toolCallId: string, state: 'running' | 'done', agentId?: string): EngineEvent => ({
    type: 'tool',
    toolCallId,
    name: 'Bash',
    input: { command: 'bun test' },
    state,
    ...(state === 'done' && { output: 'ok' }),
    ...(agentId !== undefined && { agentId }),
});

const states = (bodies: Extract<StreamItemBody, { kind: 'tool' }>[]) => bodies.map(body => [body.toolCallId, body.state, body.error]);

describe('a turn that ends with calls still running', () => {
    test('Stop fails the calls the agent never finished, so none is shown running afterwards', async () => {
        const started = latch();
        const { h, runId, tools } = await setup(async function* ({ signal }) {
            yield { type: 'session', sessionId: 's1' };
            yield call('c1', 'running');
            yield call('c1', 'done');
            yield call('c2', 'running');
            started.release();
            await untilAborted(signal);
        });

        await started.wait();
        await waitFor(() => tools(runId).length === 2, 'both calls in the stream');
        h.ok('run.cancel', { runId });
        await waitFor(() => tools(runId).every(body => body.state !== 'running'), 'the running call to be closed');

        expect(h.run(runId).status).toBe('cancelled');
        expect(states(tools(runId))).toEqual([['c1', 'done', undefined], ['c2', 'error', 'Stopped before it finished']]);
    });

    test('a failure does the same, and the run keeps the class of the failure until it works again', async () => {
        const { h, chat, runId, tools } = await setup(async function* ({ number }) {
            yield { type: 'session', sessionId: 's1' };

            if (number === 1) {
                yield call('c1', 'running');
                yield { type: 'error', message: 'The conversation no longer fits the model\'s context window. Start a new chat.', code: 'context_too_long' };

                return;
            }

            yield { type: 'done', result: 'ok' };
        });

        await waitFor(() => h.run(runId).status === 'failed', 'the turn to fail');
        expect(states(tools(runId))).toEqual([['c1', 'error', 'The turn ended before this finished']]);
        expect(h.run(runId)).toMatchObject({ status: 'failed', failureCode: 'context_too_long', error: expect.stringContaining('context window') });
        // It is stored with the run, not only published.
        expect(getRun(h.store.db, runId)?.failureCode).toBe('context_too_long');

        h.ok('chat.send', { chatId: chat.id, text: 'Try again' });
        expect(h.run(runId).failureCode).toBeUndefined();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the next turn');
        expect(getRun(h.store.db, runId)?.failureCode).toBeUndefined();
    });

    test('a failure the engine does not class leaves no code', async () => {
        const { h, runId } = await setup(async function* () {
            yield { type: 'session', sessionId: 's1' };
            yield { type: 'error', message: 'Something odd' };
        });

        await waitFor(() => h.run(runId).status === 'failed', 'the turn to fail');
        expect(h.run(runId).failureCode).toBeUndefined();
    });

    test('a sub-agent that ends leaves none of its calls running in its own stream', async () => {
        const { h, runId, tools } = await setup(async function* () {
            yield { type: 'session', sessionId: 's1' };
            yield { type: 'subagent', agentId: 'a1', name: 'Explore', state: 'running' };
            yield call('c1', 'running', 'a1');
            yield { type: 'subagent', agentId: 'a1', name: 'Explore', state: 'done', summary: 'Found it' };
            yield { type: 'subagent', agentId: 'a2', name: 'Review', state: 'running' };
            yield call('c2', 'running', 'a2');
            // a2 is still running when the turn ends, and ends with it.
            yield { type: 'done', result: 'ok' };
        });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the turn to end');

        const children = h.store.db.query('SELECT id FROM runs WHERE parent_run_id = ? ORDER BY created_at, id').all(runId) as { id: string }[];

        expect(children.map(child => states(tools(child.id)))).toEqual([
            [['c1', 'error', 'The turn ended before this finished']],
            [['c2', 'error', 'The turn ended before this finished']],
        ]);
    });
});
