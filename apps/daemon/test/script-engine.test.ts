import { describe, expect, test } from 'bun:test';

import { latch, ScriptEngine, waitFor } from './helpers';

import type { BackgroundItem } from '@clowdy/protocol';
import type { EngineEvent, EngineSession, EngineStartOptions } from '../src/engine/types';
import type { Turn } from './helpers';

const command: BackgroundItem = { id: 'bg-1', kind: 'command', title: 'sleep 60' };

function start(engine: ScriptEngine, signal = new AbortController().signal): EngineSession {
    const options: EngineStartOptions = { cwd: '/tmp', prompt: 'Start the command', tools: [], signal };

    return engine.start(options);
}

/** Reads a session to its end in the background, so a test can look at what it said so far and whether it is over. */
function read(session: EngineSession) {
    const events: EngineEvent[] = [];
    const reading = { events, ended: false, failure: undefined as unknown, done: Promise.resolve() };

    reading.done = (async () => {
        try {
            for await (const event of session) {
                events.push(event);
            }
        }
        catch (error) {
            reading.failure = error;
        }
        finally {
            reading.ended = true;
        }
    })();

    return reading;
}

const types = (events: EngineEvent[]) => events.map(event => event.type);

describe('ScriptEngine, a session that outlives its done', () => {
    test('says its snapshots and its first done, then waits for the test, and runs the turn the agent starts by itself', async () => {
        const finished = latch();
        const engine = new ScriptEngine(async function* (turn) {
            yield { type: 'text', delta: 'Started it', done: true };
            yield { type: 'background', items: [command] };
            yield { type: 'done', result: 'Started it' };

            if (!await turn.hold(finished)) {
                return;
            }

            yield { type: 'background', items: [] };
            yield { type: 'text', delta: 'The command finished', done: true };
            yield { type: 'done', result: 'The command finished' };
        });
        const reading = read(start(engine));

        await waitFor(() => types(reading.events).includes('done'), 'the first turn to end');
        await Bun.sleep(20);
        expect(reading.ended).toBe(false);
        expect(types(reading.events)).toEqual(['text', 'background', 'done']);

        finished.release();
        await reading.done;
        expect(types(reading.events)).toEqual(['text', 'background', 'done', 'background', 'text', 'done']);
        expect(reading.events[3]).toEqual({ type: 'background', items: [] });
        expect(reading.failure).toBeUndefined();
    });

    test('has no send until the engine answers one, as an engine that cannot take a prompt after its turn', () => {
        const engine = new ScriptEngine(async function* () {
            yield { type: 'done' };
        });

        expect(start(engine).send).toBeUndefined();

        engine.sendAnswer = () => true;
        expect(start(engine).send).toBeFunction();
    });

    test('takes a prompt into the live session, which the script answers on the same iterator', async () => {
        const engine = new ScriptEngine(async function* (turn) {
            yield { type: 'background', items: [command] };
            yield { type: 'done' };

            for (let text = await turn.received(); text !== undefined; text = await turn.received()) {
                yield { type: 'text', delta: `Heard: ${ text }`, done: true };
                yield { type: 'done', result: `Heard: ${ text }` };
            }
        });

        engine.sendAnswer = () => true;

        const session = start(engine);
        const reading = read(session);

        await waitFor(() => types(reading.events).includes('done'), 'the first turn to end');
        expect(await session.send?.('Is it done')).toBe(true);
        await waitFor(() => reading.events.length === 4, 'the answer');
        expect(await session.send?.('And now')).toBe(true);
        await waitFor(() => reading.events.length === 6, 'the second answer');
        expect(reading.events.slice(2)).toEqual([
            { type: 'text', delta: 'Heard: Is it done', done: true },
            { type: 'done', result: 'Heard: Is it done' },
            { type: 'text', delta: 'Heard: And now', done: true },
            { type: 'done', result: 'Heard: And now' },
        ]);
        expect(engine.sent).toEqual(['Is it done', 'And now']);

        // Closing the session ends the script's wait, and the iterator ends without an error.
        await session.close();
        await reading.done;
        expect(reading.failure).toBeUndefined();
    });

    test('a prompt the engine refuses is recorded, never reaches the script, and answers false', async () => {
        const seen: (string | undefined)[] = [];
        const engine = new ScriptEngine(async function* (turn) {
            yield { type: 'done' };
            seen.push(await turn.received());
        });

        engine.sendAnswer = text => text !== 'Not now';

        const session = start(engine);
        const reading = read(session);

        await waitFor(() => types(reading.events).includes('done'), 'the first turn to end');
        expect(await session.send?.('Not now')).toBe(false);
        expect(engine.sent).toEqual(['Not now']);
        expect(seen).toEqual([]);

        expect(await session.send?.('Now')).toBe(true);
        await reading.done;
        expect(seen).toEqual(['Now']);
    });

    test('a session whose iterator ended refuses a prompt, whatever the engine would say', async () => {
        const engine = new ScriptEngine(async function* () {
            yield { type: 'done' };
        });

        engine.sendAnswer = () => true;

        const session = start(engine);

        await read(session).done;
        expect(await session.send?.('Too late')).toBe(false);
        expect(engine.sent).toEqual(['Too late']);
    });

    test('closing the session or aborting its signal ends a script that waits, without an error', async () => {
        const never = latch();
        const waits = async function* (turn: Turn) {
            yield { type: 'done' } as const;

            if (await turn.hold(never)) {
                yield { type: 'text', delta: 'Never', done: true } as const;
            }
        };
        const closed = new ScriptEngine(waits);
        const session = start(closed);
        const closedReading = read(session);

        await waitFor(() => closedReading.events.length === 1, 'the first turn to end');
        await session.close();
        await closedReading.done;
        expect(types(closedReading.events)).toEqual(['done']);
        expect(closedReading.failure).toBeUndefined();

        const controller = new AbortController();
        const aborted = read(start(new ScriptEngine(waits), controller.signal));

        await waitFor(() => aborted.events.length === 1, 'the first turn to end');
        controller.abort();
        await aborted.done;
        expect(types(aborted.events)).toEqual(['done']);
        expect(aborted.failure).toBeUndefined();
    });
});

describe('ScriptEngine, a fork', () => {
    test('is recorded, and gives a session of its own unless the test answers it; the flag is off until the test turns it on', async () => {
        const engine = new ScriptEngine(async function* () {
            yield { type: 'done' } as const;
        });

        expect(engine.canFork).toBe(false);

        const options = { sessionId: 's1', ref: 'm1', cwd: '/tmp' };

        expect(await engine.fork(options)).toEqual({ sessionId: 's1-fork-1' });
        expect(await engine.fork({ ...options, ref: 'm2' })).toEqual({ sessionId: 's1-fork-2' });
        expect(engine.forked.map(fork => fork.ref)).toEqual(['m1', 'm2']);

        engine.forkAnswer = () => ({ sessionId: 'answered' });
        expect(await engine.fork(options)).toEqual({ sessionId: 'answered' });

        engine.forkAnswer = () => {
            throw new Error('The adapter fell over');
        };
        await expect(engine.fork(options)).rejects.toThrow('The adapter fell over');
        expect(engine.forked).toHaveLength(4);
    });
});
