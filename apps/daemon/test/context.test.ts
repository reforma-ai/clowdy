import { commandSchema } from '@clowdy/protocol';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { getChat } from '../src/db/chats';
import { openDatabase } from '../src/db/connection';
import { MIGRATIONS } from '../src/db/migrations';
import { getRun } from '../src/db/runs';
import { CONTINUE_MESSAGE } from '../src/runs/prompts';
import { cleanTempDirs, latch, restartHarness, ScriptEngine, startHarness, tempDir, untilAborted, waitFor } from './helpers';

import type { BackgroundItem, Chat } from '@clowdy/protocol';
import type { Config } from '../src/config';
import type { EngineEvent } from '../src/engine/types';
import type { Harness, Script } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

type Reading = [used: number, size: number];

const context = (used: number, size: number): EngineEvent => ({ type: 'context', used, size });

/** The session of a turn: a resumed one keeps its id, as the real agents do. */
const session = ({ number, options }: Parameters<Script>[0]): EngineEvent => ({ type: 'session', sessionId: options.resumeSessionId ?? `s${ number }` });

/** Turns that report the readings of their number (the first turn the first list, and so on; the last list repeats), then end. */
const perTurn = (...lists: Reading[][]): Script => async function* (turn) {
    yield session(turn);

    for (const [used, size] of lists[Math.min(turn.number, lists.length) - 1] ?? []) {
        yield context(used, size);
    }

    yield { type: 'done', result: 'ok' };
};

/** A turn that reports the readings it is given, then ends. */
const reporting = (...readings: Reading[]): Script => perTurn(readings);

/** A turn that ends at once. */
const finishing = reporting();

/** Claude's script stands in for its program, which is not on this machine; `other` is an agent with no compact command. */
async function setup(script: Script, other: Script = finishing, config: Partial<Config> = {}) {
    const claude = new ScriptEngine(script);
    const h = await startHarness(config, { engines: new Map([['fake', new ScriptEngine(finishing)], ['claude', claude], ['other', new ScriptEngine(other)]]) });

    harnesses.push(h);

    return { h, claude, project: h.openRepo() };
}

const start = async (h: Harness, projectId: string, engine = 'claude') => {
    const { chat } = h.ok('chat.create', { projectId, engine });
    const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'hello' });

    return { chat, runId };
};

const failure = (result: ReturnType<Harness['send']>) => {
    if (result.ok) {
        throw new Error('expected a failure');
    }

    return result.error;
};

/** Waits for the turn that is number `count` of the engine to end (a message or a compact makes the run `queued` at once, so `succeeded` is the end of the last one). */
const turnEnded = (h: Harness, engine: ScriptEngine, runId: string, count: number) =>
    waitFor(() => engine.turns.length === count && h.run(runId).status === 'succeeded', `turn ${ count } to end`);

/** What the run's fill was over its life, as the event feed announced it (a status change repeats the fill it holds). */
const shown = (h: Harness, runId: string) => h.events()
    .flatMap(event => (event.data.type === 'run.upserted' && event.data.run.id === runId && event.data.run.context ? [event.data.run.context.used] : []))
    .filter((used, index, all) => used !== all[index - 1]);

const chatOf = (h: Harness, chatId: string) => getChat(h.store.db, chatId) as Chat;

const storedStream = (h: Harness, runId: string) => h.store.db.query('SELECT body FROM stream_items WHERE run_id = ? ORDER BY seq').all(runId).map(row => JSON.parse((row as { body: string }).body));

describe('the context reading of a run', () => {
    test('is kept on the run, and a reading that moved less than a percent is not written until the turn ends', async () => {
        const { h, project } = await setup(reporting([10_000, 200_000], [10_500, 200_000], [11_999, 200_000], [12_000, 200_000], [12_100, 200_000]));
        const { runId } = await start(h, project.id);

        await waitFor(() => h.run(runId).status === 'succeeded', 'the turn to end');

        // 10 000 first; 10 500 and 11 999 are under a percent (2 000) of it; 12 000 is exactly a percent; 12 100 is the last, written when the turn ended.
        expect(shown(h, runId)).toEqual([10_000, 12_000, 12_100]);
        expect(h.run(runId).context).toEqual({ used: 12_100, size: 200_000 });
    });

    test('follows a window that changes size even when the fill did not move', async () => {
        const { h, project } = await setup(reporting([10_000, 200_000], [10_000, 1_000_000]));
        const { runId } = await start(h, project.id);

        await waitFor(() => h.run(runId).status === 'succeeded', 'the turn to end');
        expect(h.run(runId).context).toEqual({ used: 10_000, size: 1_000_000 });
    });

    test('a fall is written like a rise: at once from a percent of the window, and when the turn ends below that', async () => {
        const { h, claude, project } = await setup(perTurn(
            [[150_000, 200_000]],
            // 149 500 is under a percent below 150 000; 119 900 is far below it; 119 000 is under a percent below that, so only the end of the turn writes it.
            [[149_500, 200_000], [119_900, 200_000], [119_000, 200_000]],
            // The one reading of the turn is under a percent below the last: nothing but the end of the turn writes it.
            [[118_500, 200_000]]
        ));
        const { chat, runId } = await start(h, project.id);

        await turnEnded(h, claude, runId, 1);
        h.ok('chat.send', { chatId: chat.id, text: 'more' });
        await turnEnded(h, claude, runId, 2);
        expect(h.run(runId).context).toEqual({ used: 119_000, size: 200_000 });
        h.ok('chat.send', { chatId: chat.id, text: 'and more' });
        await turnEnded(h, claude, runId, 3);
        expect(h.run(runId).context).toEqual({ used: 118_500, size: 200_000 });
        expect(shown(h, runId)).toEqual([150_000, 119_900, 119_000, 118_500]);
    });

    test('stays on the run while the next turn has not reported, and is replaced by what it reports', async () => {
        const gate = latch();
        const { h, claude, project } = await setup(async function* (turn) {
            yield session(turn);

            if (turn.number === 1) {
                yield context(40_000, 200_000);
            }
            else {
                await gate.wait(turn.signal);
                yield context(55_000, 200_000);
            }

            yield { type: 'done', result: 'ok' };
        });
        const { chat, runId } = await start(h, project.id);

        await turnEnded(h, claude, runId, 1);
        expect(h.run(runId).context).toEqual({ used: 40_000, size: 200_000 });
        h.ok('chat.send', { chatId: chat.id, text: 'more' });
        await waitFor(() => h.run(runId).status === 'running' && claude.turns.length === 2, 'the second turn to run');
        expect(h.run(runId).context).toEqual({ used: 40_000, size: 200_000 });
        gate.release();
        await turnEnded(h, claude, runId, 2);
        expect(h.run(runId).context).toEqual({ used: 55_000, size: 200_000 });
    });

    test('is still there after the daemon restarts', async () => {
        const { h, project } = await setup(reporting([40_000, 200_000]));
        const { runId } = await start(h, project.id);

        await waitFor(() => h.run(runId).status === 'succeeded', 'the turn to end');
        await h.stop();

        const next = await restartHarness(h, { engines: new Map([['fake', new ScriptEngine(finishing)], ['claude', new ScriptEngine(finishing)]]) });

        harnesses.push(next);
        expect(next.run(runId).context).toEqual({ used: 40_000, size: 200_000 });
    });

    test('the last reading is written when the engine fails after it', async () => {
        const { h, project } = await setup(async function* (turn) {
            yield session(turn);
            yield context(10_000, 200_000);
            yield context(10_100, 200_000);
            throw new Error('The model call blew up');
        });
        const { runId } = await start(h, project.id);

        await waitFor(() => h.run(runId).status === 'failed', 'the run to fail');
        expect(h.run(runId).context).toEqual({ used: 10_100, size: 200_000 });
    });

    test('the last reading is written when the run is cancelled mid-turn', async () => {
        const reported = latch();
        const { h, project } = await setup(async function* (turn) {
            yield session(turn);
            yield context(10_000, 200_000);
            yield context(10_100, 200_000);
            // Pulled again, so the runtime has taken both readings.
            reported.release();
            await untilAborted(turn.signal).catch(() => undefined);
        });
        const { runId } = await start(h, project.id);

        await reported.wait();
        expect(h.run(runId).context).toEqual({ used: 10_000, size: 200_000 });
        h.ok('run.cancel', { runId });
        await waitFor(() => h.run(runId).context?.used === 10_100, 'the last reading to be written');
        expect(h.run(runId).status).toBe('cancelled');
    });

});

describe('the context migration', () => {
    test('gives the runs of an older database a column that reads as no reading, and stores one', () => {
        const path = join(tempDir(), 'clowdy.db');
        const old = openDatabase(path, MIGRATIONS.slice(0, 5));

        old.query('INSERT INTO projects (id, name, path, task_prefix, created_at) VALUES (?, ?, ?, ?, ?)').run('prj_1', 'Old', '/old', 'OLD', 1);
        old.query('INSERT INTO runs (id, project_id, root_run_id, role, name, status, engine, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('run_1', 'prj_1', 'run_1', 'orchestrator', 'Orchestrator 01', 'succeeded', 'claude', 1);
        old.close();

        const upgraded = openDatabase(path);
        const run = getRun(upgraded, 'run_1');

        expect(run).toMatchObject({ id: 'run_1', status: 'succeeded' });
        expect(run?.context).toBeUndefined();
        upgraded.query('UPDATE runs SET context = ? WHERE id = ?').run(JSON.stringify({ used: 7, size: 100 }), 'run_1');
        expect(getRun(upgraded, 'run_1')?.context).toEqual({ used: 7, size: 100 });
        upgraded.close();
    });
});

describe('chat.compact', () => {
    test('starts a turn of the orchestrator on the agent\'s own compact command, without a message of the person or a note, and the chat keeps its place', async () => {
        const { h, claude, project } = await setup(async function* (turn) {
            yield session(turn);
            yield context(turn.number === 1 ? 40_000 : 6_000, 200_000);

            // Like the real agents, the compaction says nothing in words: its tool call is all there is.
            yield { type: 'done', result: turn.number === 1 ? 'ok' : undefined };
        });
        const { chat, runId } = await start(h, project.id);

        await turnEnded(h, claude, runId, 1);

        const updatedAt = () => (h.store.db.query('SELECT updated_at FROM chats WHERE id = ?').get(chat.id) as { updated_at: number }).updated_at;
        const before = updatedAt();

        await Bun.sleep(5);

        expect(h.ok('chat.compact', { chatId: chat.id })).toEqual({ chatId: chat.id, runId });
        await turnEnded(h, claude, runId, 2);
        expect(claude.turns[1]).toMatchObject({ prompt: '/compact', resumeSessionId: 's1' });
        // The agent's report of the compaction is the stream's line; this script reports none.
        expect(storedStream(h, runId).map(body => body.kind)).toEqual(['user']);
        // A turn that ends with no words is a success, and the smaller reading replaces the old one.
        expect(h.run(runId)).toMatchObject({ status: 'succeeded', context: { used: 6_000, size: 200_000 } });
        expect(h.run(runId).result).toBeUndefined();
        expect(updatedAt()).toBe(before);
    });

    test('a compact turn that meets a passing problem sends the command again, since nothing was compacted; any other turn is asked to continue', async () => {
        const { h, claude, project } = await setup(async function* (turn) {
            yield session(turn);

            // The compact turn (the second session) and the turn of the message after it (the fourth) are overloaded once.
            if (turn.number === 2 || turn.number === 4) {
                yield { type: 'error', message: 'Overloaded (529)', retryable: true };

                return;
            }

            yield { type: 'done', result: 'ok' };
        });
        const { chat, runId } = await start(h, project.id);

        await turnEnded(h, claude, runId, 1);
        h.ok('chat.compact', { chatId: chat.id });
        await turnEnded(h, claude, runId, 3);
        expect(claude.turns.slice(1, 3).map(({ prompt, resumeSessionId }) => ({ prompt, resumeSessionId }))).toEqual([
            { prompt: '/compact', resumeSessionId: 's1' },
            { prompt: '/compact', resumeSessionId: 's1' },
        ]);

        h.ok('chat.send', { chatId: chat.id, text: 'more' });
        await turnEnded(h, claude, runId, 5);
        expect(claude.turns.slice(3).map(({ prompt, resumeSessionId }) => ({ prompt, resumeSessionId }))).toEqual([
            { prompt: 'more', resumeSessionId: 's1' },
            { prompt: CONTINUE_MESSAGE, resumeSessionId: 's1' },
        ]);
    });

    test('is refused for a chat that has not started', async () => {
        const { h, project } = await setup(finishing);
        const fresh = h.ok('chat.create', { projectId: project.id, engine: 'claude' }).chat;

        expect(failure(h.send('chat.compact', { chatId: fresh.id })).code).toBe('invalid');
    });

    test('is refused for a chat whose first turn never got a session', async () => {
        const { h, project } = await setup(async function* () {
            yield { type: 'error', message: 'Claude is not signed in' };
        });
        const { chat, runId } = await start(h, project.id);

        await waitFor(() => h.run(runId).status === 'failed', 'the first turn to fail');
        expect(failure(h.send('chat.compact', { chatId: chat.id })).code).toBe('invalid');
    });

    test('is refused for an agent that has no such command, and for one that is switched off', async () => {
        const { h, project } = await setup(finishing);
        const { chat, runId } = await start(h, project.id, 'other');

        await waitFor(() => h.run(runId).status === 'succeeded', 'the turn to end');
        expect(failure(h.send('chat.compact', { chatId: chat.id })).code).toBe('invalid');

        const claude = await start(h, project.id);

        await waitFor(() => h.run(claude.runId).status === 'succeeded', 'the turn to end');
        h.ok('agent.update', { id: 'claude', enabled: false });
        expect(failure(h.send('chat.compact', { chatId: claude.chat.id })).code).toBe('unavailable');
    });


    test('works on a chat whose run was interrupted by a restart', async () => {
        const held = latch();
        const { h, project } = await setup(async function* (turn) {
            yield session(turn);
            held.release();
            await untilAborted(turn.signal);
        });
        const { chat, runId } = await start(h, project.id);

        await held.wait();
        await waitFor(() => h.run(runId).sessionId === 's1', 'the session to be recorded');
        await h.stop();

        const engine = new ScriptEngine(finishing);
        const next = await restartHarness(h, { engines: new Map([['fake', new ScriptEngine(finishing)], ['claude', engine]]) });

        harnesses.push(next);
        expect(next.run(runId).status).toBe('interrupted');
        next.ok('chat.compact', { chatId: chat.id });
        await waitFor(() => next.run(runId).status === 'succeeded', 'the compact turn to end');
        expect(engine.turns[0]).toMatchObject({ prompt: '/compact', resumeSessionId: 's1' });
    });

    test('acts once for a repeated request, and a second request while it runs changes nothing', async () => {
        const { h, claude, project } = await setup(finishing);
        const { chat, runId } = await start(h, project.id);

        await turnEnded(h, claude, runId, 1);

        const request = { requestId: 'req-compact-once', chatId: chat.id };
        const first = h.send('chat.compact', request);
        const repeat = h.send('chat.compact', request);

        expect(first).toEqual({ ok: true, requestId: 'req-compact-once', data: { chatId: chat.id, runId } });
        expect(repeat).toEqual(first);
        // Another request that arrives before the turn ends finds the agent compacting already: nothing joins the queue.
        expect(h.ok('chat.compact', { chatId: chat.id })).toEqual({ chatId: chat.id, runId });
        expect(chatOf(h, chat.id).queue).toBeUndefined();
        await turnEnded(h, claude, runId, 2);
        expect(claude.turns.filter(options => options.prompt === '/compact')).toHaveLength(1);
    });

    describe('while the orchestrator works', () => {
        /** Turns the test holds open until it releases them by number. */
        function held() {
            const gates: ReturnType<typeof latch>[] = [];
            const gate = (number: number) => (gates[number - 1] ??= latch());
            const script: Script = async function* (turn) {
                yield session(turn);
                await gate(turn.number).wait(turn.signal).catch(() => untilAborted(turn.signal));
                yield { type: 'done', result: `turn ${ turn.number }` };
            };

            return { script, release: (number: number) => gate(number).release() };
        }

        async function busy() {
            const turns = held();
            const { h, claude, project } = await setup(turns.script);
            const { chat, runId } = await start(h, project.id);

            await waitFor(() => h.run(runId).status === 'running' && h.run(runId).sessionId !== undefined, 'the first turn to run');

            return { h, claude, chat, runId, release: turns.release };
        }

        test('it joins the queue as a compact item, and is the next turn once the orchestrator has finished: the command alone, with no bubble', async () => {
            const { h, claude, chat, runId, release } = await busy();

            expect(h.ok('chat.compact', { chatId: chat.id })).toEqual({ chatId: chat.id, runId });
            expect(chatOf(h, chat.id).queue).toEqual([
                { id: expect.stringMatching(/^que_/), mode: 'queue', command: 'compact', text: 'Compact the conversation', content: '/compact', createdAt: expect.any(Number) },
            ]);

            release(1);
            await waitFor(() => claude.turns.length === 2, 'the compact turn');
            expect(claude.turns[1]).toMatchObject({ prompt: '/compact', resumeSessionId: 's1' });
            expect(chatOf(h, chat.id).queue).toBeUndefined();
            release(2);
            await turnEnded(h, claude, runId, 2);
            expect(storedStream(h, runId).filter(body => body.kind === 'user').map(body => body.text)).toEqual(['hello']);
        });

        test('asked again while one waits, nothing more joins the queue; a message after it waits behind it', async () => {
            const { h, claude, chat, runId, release } = await busy();

            h.ok('chat.compact', { chatId: chat.id });
            expect(h.ok('chat.compact', { chatId: chat.id })).toEqual({ chatId: chat.id, runId });
            h.ok('chat.send', { chatId: chat.id, text: 'then this', mode: 'queue' });
            expect(chatOf(h, chat.id).queue?.map(item => item.command ?? item.text)).toEqual(['compact', 'then this']);

            release(1);
            await waitFor(() => claude.turns.length === 2, 'the compact turn');
            release(2);
            await waitFor(() => claude.turns.length === 3, 'the queued message');
            release(3);
            await turnEnded(h, claude, runId, 3);
            expect(claude.turns.map(turn => turn.prompt)).toEqual(['Follow clowdy:orchestrate. Mode: autopilot\n\nhello', '/compact', 'then this']);
        });

        test('Send now on it steers nothing: it keeps its place in the queue', async () => {
            const { h, claude, chat, release } = await busy();

            h.ok('chat.compact', { chatId: chat.id });

            const [item] = chatOf(h, chat.id).queue ?? [];

            h.ok('chat.sendQueued', { chatId: chat.id, itemId: item.id });
            await Bun.sleep(20);
            expect(claude.steered).toEqual([]);
            expect(chatOf(h, chat.id).queue).toEqual([item]);
            release(1);
            await waitFor(() => claude.turns[1]?.prompt === '/compact', 'the compact turn');
        });

        test('after a Stop it waits in the held queue: Send now runs it as a compact turn, and so does Compact, which takes the item along', async () => {
            const { h, claude, chat, runId, release } = await busy();

            h.ok('chat.compact', { chatId: chat.id });
            h.ok('run.cancel', { runId });
            await waitFor(() => h.run(runId).status === 'cancelled', 'the orchestrator to stop');
            expect(chatOf(h, chat.id)).toMatchObject({ queuePaused: 'stopped', queue: [{ command: 'compact' }] });

            const [item] = chatOf(h, chat.id).queue ?? [];

            expect(h.ok('chat.sendQueued', { chatId: chat.id, itemId: item.id })).toEqual({ chatId: chat.id, runId });
            expect(chatOf(h, chat.id).queue).toBeUndefined();
            await waitFor(() => claude.turns[1]?.prompt === '/compact', 'the compact turn from the queue');
            release(2);
            await turnEnded(h, claude, runId, 2);

            // Compact pressed at rest while a compact item waits in a held queue: the item goes with it, and only one turn runs.
            h.ok('chat.send', { chatId: chat.id, text: 'more', mode: 'queue' });
            await waitFor(() => claude.turns.length === 3, 'the message');
            h.ok('chat.compact', { chatId: chat.id });
            h.ok('run.cancel', { runId });
            await waitFor(() => h.run(runId).status === 'cancelled', 'the orchestrator to stop again');
            h.ok('chat.compact', { chatId: chat.id });
            expect(chatOf(h, chat.id).queue).toBeUndefined();
            await waitFor(() => claude.turns.length === 4, 'the compact turn');
            release(4);
            await turnEnded(h, claude, runId, 4);
            expect(claude.turns.map(turn => turn.prompt).slice(1)).toEqual(['/compact', 'more', '/compact']);
            expect(storedStream(h, runId).filter(body => body.kind === 'user').map(body => body.text)).toEqual(['hello', 'more']);
        });
    });

    describe('while the orchestrator waits for background work', () => {
        test('it waits in the queue for the session to end, and runs after it', async () => {
            const finished = latch();
            const command: BackgroundItem = { id: 'bg-1', kind: 'command', title: 'bun test' };
            const { h, claude, project } = await setup(async function* (turn) {
                yield session(turn);

                if (turn.number > 1) {
                    yield { type: 'done', result: 'ok' };

                    return;
                }

                yield { type: 'background', items: [command] };
                yield { type: 'done', result: 'Started the tests' };

                if (await turn.hold(finished)) {
                    yield { type: 'background', items: [] };
                    yield { type: 'done', result: 'The tests passed' };
                }
            });

            // An agent that takes a prompt after its turn keeps its session for the background work.
            claude.sendAnswer = () => true;

            const { chat, runId } = await start(h, project.id);

            await waitFor(() => h.run(runId).status === 'waiting_background', 'the orchestrator to wait for background work');
            expect(h.ok('chat.compact', { chatId: chat.id })).toEqual({ chatId: chat.id, runId });
            expect(chatOf(h, chat.id).queue?.map(item => item.command)).toEqual(['compact']);

            // Send now cannot run it while the session is open.
            const [item] = chatOf(h, chat.id).queue ?? [];
            const refused = failure(h.send('chat.sendQueued', { chatId: chat.id, itemId: item.id }));

            expect(refused).toMatchObject({ code: 'conflict', message: 'The orchestrator is waiting for background work. Compact the chat when it has finished' });

            finished.release();
            await waitFor(() => claude.turns.at(-1)?.prompt === '/compact' && h.run(runId).status === 'succeeded', 'the compact turn to end');
            expect(claude.turns.map(turn => turn.prompt)).toEqual(['Follow clowdy:orchestrate. Mode: autopilot\n\nhello', '/compact']);
            expect(chatOf(h, chat.id).queue).toBeUndefined();
        });
    });

    test('an unknown chat is not found', async () => {
        const { h } = await setup(finishing);

        expect(failure(h.send('chat.compact', { chatId: 'cht_nope' })).code).toBe('not_found');
    });

    test('takes a chat id and nothing else', () => {
        const parse = (fields: Record<string, unknown>) => commandSchema.safeParse({ requestId: 'req-12345678', type: 'chat.compact', ...fields });

        expect(parse({ chatId: 'cht_1' }).success).toBe(true);
        expect(parse({}).success).toBe(false);
        expect(parse({ chatId: 7 }).success).toBe(false);
        expect(commandSchema.safeParse({ type: 'chat.compact', chatId: 'cht_1' }).success).toBe(false);
    });
});
