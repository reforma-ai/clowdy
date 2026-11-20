import { STOPPED_TOOL } from '@clowdy/protocol';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { getChat } from '../src/db/chats';
import { listItems } from '../src/db/items';
import { pendingMailbox } from '../src/db/runs';
import { placeQueued, settleSteers } from '../src/domain/queue';
import { projectSnapshot } from '../src/domain/snapshots';
import { STOPPED_TURN_MESSAGE } from '../src/runs/prompts';
import { isAtRest } from '../src/runs/queue';
import { STOPPED_TO_SEND_REASON } from '../src/runs/transitions';
import { cleanTempDirs, latch, restartHarness, ScriptEngine, scriptEngines, startHarness, untilAborted, waitFor } from './helpers';

import type { Attachment, Chat, QueuedMessage, Run, StreamItemBody } from '@clowdy/protocol';
import type { Harness, Script, Turn } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

/**
 * Turns the test holds open: each says `before <n>` (a message left open), waits until the test releases turn n, then says ` after <n>` and ends.
 * `fail` makes a turn end on an engine error instead.
 */
function gatedTurns(fail: (turn: number) => boolean = () => false) {
    const gates: ReturnType<typeof latch>[] = [];
    const gate = (turn: number) => (gates[turn - 1] ??= latch());
    const script: Script = async function* ({ number, signal }) {
        yield { type: 'session', sessionId: 's1' };
        yield { type: 'text', delta: `before ${ number }`, done: false };
        await gate(number).wait(signal);

        if (fail(number)) {
            yield { type: 'error', message: 'The agent fell over' };

            return;
        }

        yield { type: 'text', delta: ` after ${ number }`, done: true };
        yield { type: 'done', result: `turn ${ number }` };
    };

    return { script, release: (turn: number) => gate(turn).release() };
}

async function setup(fail?: (turn: number) => boolean, overrides = {}, engineOptions: { script?: Script; closeMs?: number } = {}) {
    const turns = gatedTurns(fail);
    const engine = new ScriptEngine(engineOptions.script ?? turns.script, engineOptions.closeMs);
    const h = await startHarness(overrides, { engines: scriptEngines(engine) });

    harnesses.push(h);

    const project = h.openRepo();
    const { chat } = h.ok('chat.create', { projectId: project.id }) as { chat: Chat };
    const send = (text: string, fields: Record<string, unknown> = {}) => h.ok('chat.send', { chatId: chat.id, text, ...fields }) as { chatId: string; runId: string };
    const chatNow = () => getChat(h.store.db, chat.id) as Chat;
    const queue = () => chatNow().queue ?? [];
    const bodies = (runId: string): StreamItemBody[] => listItems(h.store.db, runId, 0).map(item => item.body);
    const people = (runId: string) => bodies(runId).flatMap(body => (body.kind === 'user' ? [body.text] : []));

    /** Starts the chat with a first message and waits until its first turn is running. */
    const start = async () => {
        const { runId } = send('Start');

        await waitFor(() => engine.turns.length === 1 && h.run(runId).status === 'running', 'the first turn');

        return runId;
    };

    return { h, engine, project, chat, send, chatNow, queue, bodies, people, start, release: turns.release };
}

const brief = (item: QueuedMessage) => [item.mode, item.text];

describe('a message to a busy orchestrator', () => {
    test('waits in the queue without a bubble, and is the next turn when the orchestrator rests', async () => {
        const { h, engine, send, queue, people, bodies, start, release } = await setup();
        const runId = await start();

        expect(send('And the footer', { mode: 'queue' })).toEqual({ chatId: expect.any(String), runId });
        expect(queue()).toEqual([{ id: expect.stringMatching(/^que_/), mode: 'queue', text: 'And the footer', content: 'And the footer', createdAt: expect.any(Number) }]);
        expect(people(runId)).toEqual(['Start']);

        release(1);
        await waitFor(() => engine.turns.length === 2, 'the queued turn');

        expect(engine.turns[1]).toMatchObject({ prompt: 'And the footer', resumeSessionId: 's1' });
        expect(queue()).toEqual([]);
        // The bubble comes after everything the first turn said.
        expect(bodies(runId).map(body => body.kind)).toEqual(['user', 'assistant', 'user', 'assistant']);
        expect(people(runId)).toEqual(['Start', 'And the footer']);
        expect(h.run(runId).status).toBe('running');
    });

    test('goes out one message per turn, the steers first', async () => {
        const { engine, send, queue, start, release } = await setup();

        await start();
        send('first', { mode: 'queue' });
        send('second');
        send('urgent', { mode: 'steer' });
        // The agent of this engine takes no steer, so the steer waits with the others, ahead of them.
        await waitFor(() => engine.steered.length === 1, 'the steer to be tried');

        expect(queue().map(brief)).toEqual([['steer', 'urgent'], ['queue', 'first'], ['queue', 'second']]);

        for (const [turn, prompt] of [[2, 'urgent'], [3, 'first'], [4, 'second']] as const) {
            release(turn - 1);
            await waitFor(() => engine.turns.length === turn, `turn ${ turn }`);

            expect(engine.turns[turn - 1].prompt).toBe(prompt);
        }

        expect(queue()).toEqual([]);
    });

    test('goes to a chat at rest at once, whatever its mode', async () => {
        const { h, engine, send, queue, start, release } = await setup();
        const runId = await start();

        release(1);
        await waitFor(() => h.run(runId).status === 'succeeded', 'the first turn to end');
        send('Now this', { mode: 'steer' });
        await waitFor(() => engine.turns.length === 2, 'the second turn');

        expect(engine.turns[1].prompt).toBe('Now this');
        expect(queue()).toEqual([]);
    });

    test('keeps its files for the message, and puts them in the bubble and the agent\'s text when it goes out', async () => {
        const { h, engine, project, send, queue, bodies, start, release } = await setup();
        const runId = await start();
        const file = await (await h.fetch(`/v1/projects/${ project.id }/attachments?name=notes.txt`, { method: 'POST', body: 'hello', headers: { 'content-type': 'text/plain' } })).json() as Attachment;

        send('See the notes', { attachmentIds: [file.id] });

        expect(queue()[0]).toMatchObject({ text: 'See the notes', attachments: [file], content: expect.stringContaining('Attached files:') });

        release(1);
        await waitFor(() => engine.turns.length === 2, 'the queued turn');

        expect(bodies(runId).at(-2)).toEqual({ kind: 'user', text: 'See the notes', attachments: [file] });
        expect(engine.turns[1].prompt).toContain(join('attachments', file.id, 'notes.txt'));
    });
});

describe('Stop and failure', () => {
    test('Stop holds the queue, and Send now on a message sends it and lets the queue flow again', async () => {
        const { h, engine, chat, send, chatNow, queue, start, release } = await setup();
        const runId = await start();

        send('first');
        send('second');
        h.ok('run.cancel', { runId });
        await waitFor(() => h.run(runId).status === 'cancelled', 'the stop');
        await Bun.sleep(30);

        expect(chatNow().queuePaused).toBe('stopped');
        expect(queue().map(brief)).toEqual([['queue', 'first'], ['queue', 'second']]);
        expect(engine.turns).toHaveLength(1);

        const second = queue()[1];

        expect(h.ok('chat.sendQueued', { chatId: chat.id, itemId: second.id })).toEqual({ chatId: chat.id, runId });
        await waitFor(() => engine.turns.length === 2, 'the message sent now');

        expect(engine.turns[1].prompt).toBe('second');
        expect(chatNow().queuePaused).toBeUndefined();

        release(2);
        await waitFor(() => engine.turns.length === 3, 'the rest of the queue');

        expect(engine.turns[2].prompt).toBe('first');
    });

    test('a failed turn holds the queue as failed', async () => {
        const { h, engine, send, chatNow, queue, start, release } = await setup(turn => turn === 1);
        const runId = await start();

        send('after the failure');
        release(1);
        await waitFor(() => h.run(runId).status === 'failed', 'the failure');
        await Bun.sleep(30);

        expect(chatNow().queuePaused).toBe('failed');
        expect(queue().map(brief)).toEqual([['queue', 'after the failure']]);
        expect(engine.turns).toHaveLength(1);
    });

    test('a message to a chat at rest goes out at once and leaves a paused queue paused', async () => {
        const { h, engine, send, chatNow, queue, start, release } = await setup();
        const runId = await start();

        send('held back');
        h.ok('run.cancel', { runId });
        await waitFor(() => h.run(runId).status === 'cancelled', 'the stop');
        send('a fresh start');
        await waitFor(() => engine.turns.length === 2, 'the fresh message');

        expect(engine.turns[1].prompt).toBe('a fresh start');
        expect(chatNow().queuePaused).toBe('stopped');

        release(2);
        await waitFor(() => h.run(runId).status === 'succeeded', 'the fresh turn to end');
        await Bun.sleep(30);

        expect(engine.turns).toHaveLength(2);
        expect(queue().map(brief)).toEqual([['queue', 'held back']]);
    });

    test('Stop with nothing queued holds nothing', async () => {
        const { h, chatNow, start } = await setup();
        const runId = await start();

        h.ok('run.cancel', { runId });
        await waitFor(() => h.run(runId).status === 'cancelled', 'the stop');

        expect(chatNow().queuePaused).toBeUndefined();
    });

    test('a turn the daemon lost in a restart holds the queue as failed', async () => {
        const { h, chat, send, start } = await setup();

        await start();
        send('after the restart');
        await h.stop();

        const restarted = await restartHarness(h, { engines: scriptEngines(new ScriptEngine(gatedTurns().script)) });

        harnesses.push(restarted);

        expect(getChat(restarted.store.db, chat.id)).toMatchObject({ queuePaused: 'failed', queue: [{ text: 'after the restart' }] });

        // A queue that holds already is not written again by the next start.
        const head = restarted.store.headCursor();

        await restarted.stop();

        const again = await restartHarness(restarted, { engines: scriptEngines(new ScriptEngine(gatedTurns().script)) });

        harnesses.push(again);

        expect(again.store.eventsAfter(head, undefined, 100).filter(event => event.data.type === 'chat.upserted')).toEqual([]);
        expect(getChat(again.store.db, chat.id)).toMatchObject({ queuePaused: 'failed', queue: [{ text: 'after the restart' }] });
    });
});

describe('steering', () => {
    test('a steer the agent takes leaves the queue at once, and its bubble sits where the agent took it', async () => {
        const { h, engine, send, queue, bodies, start, release } = await setup();

        engine.steerAnswer = () => true;

        const runId = await start();

        send('Use the blue one', { mode: 'steer' });
        await waitFor(() => queue().length === 0, 'the steer to be taken');

        // The message the agent was writing ends at the bubble; what it says next follows it.
        expect(bodies(runId)).toEqual([
            { kind: 'user', text: 'Start' },
            { kind: 'assistant', text: 'before 1', done: true },
            { kind: 'user', text: 'Use the blue one' },
        ]);
        expect(engine.steered).toEqual(['Use the blue one']);

        release(1);
        await waitFor(() => h.run(runId).status === 'succeeded', 'the turn to end');

        expect(bodies(runId).at(-1)).toEqual({ kind: 'assistant', text: ' after 1', done: true });
        expect(engine.turns).toHaveLength(1);
    });

    test('Send now on a queued message while the agent works steers it', async () => {
        const { h, engine, chat, send, queue, people, start } = await setup();

        engine.steerAnswer = () => true;

        const runId = await start();

        send('later');
        send('much later');

        expect(engine.steered).toEqual([]);

        h.ok('chat.sendQueued', { chatId: chat.id, itemId: queue()[1].id });
        await waitFor(() => queue().length === 1, 'the steer to be taken');

        expect(engine.steered).toEqual(['much later']);
        expect(people(runId)).toEqual(['Start', 'much later']);
        expect(queue().map(brief)).toEqual([['queue', 'later']]);
    });

    test('a steer the agent refuses stays a steer, and the next turn starts with it', async () => {
        const { engine, send, queue, start, release } = await setup();

        engine.steerAnswer = () => false;
        await start();
        send('queued first');
        send('steered later', { mode: 'steer' });
        await waitFor(() => engine.steered.length === 1, 'the steer to be tried');

        expect(queue().map(brief)).toEqual([['steer', 'steered later'], ['queue', 'queued first']]);

        release(1);
        await waitFor(() => engine.turns.length === 2, 'the next turn');

        expect(engine.turns[1].prompt).toBe('steered later');
        expect(queue().map(brief)).toEqual([['queue', 'queued first']]);
    });

    describe('a steer still with the agent when the turn ends', () => {
        /** Steers `steer me` behind a queued message and ends the turn while the agent has not answered the steer yet. */
        async function steerOutAtTurnEnd() {
            const harness = await setup();
            const { h, engine, chat, send, queue, start, release } = harness;
            let answer!: (taken: boolean) => void;

            engine.steerAnswer = () => new Promise<boolean>((resolve) => {
                answer = resolve;
            });

            const runId = await start();

            send('queued');
            send('steer me', { mode: 'steer' });
            await waitFor(() => engine.steered.length === 1, 'the steer to reach the agent');

            const removal = h.send('chat.removeQueued', { chatId: chat.id, itemId: queue()[0].id });

            expect(removal.ok ? undefined : removal.error.code).toBe('conflict');

            release(1);
            await waitFor(() => h.run(runId).status === 'succeeded', 'the turn to end');
            await Bun.sleep(30);

            // The queue waits for the agent's answer: the steer must not go out twice, nor overtake it.
            expect(engine.turns).toHaveLength(1);

            return { ...harness, runId, answer };
        }

        test('taken, it leaves the queue and the next turn is the queued message', async () => {
            const { engine, queue, people, runId, answer } = await steerOutAtTurnEnd();

            answer(true);
            await waitFor(() => engine.turns.length === 2, 'the queued turn');

            expect(engine.turns[1].prompt).toBe('queued');
            expect(people(runId)).toEqual(['Start', 'steer me', 'queued']);
            expect(queue()).toEqual([]);
        });

        test('refused, it is the next turn, ahead of the queued message', async () => {
            const { engine, queue, people, runId, answer, release } = await steerOutAtTurnEnd();

            answer(false);
            await waitFor(() => engine.turns.length === 2, 'the steer as the next turn');

            expect(engine.turns[1].prompt).toBe('steer me');
            expect(queue().map(brief)).toEqual([['queue', 'queued']]);

            release(2);
            await waitFor(() => engine.turns.length === 3, 'the queued turn');

            expect(engine.turns[2].prompt).toBe('queued');
            expect(people(runId)).toEqual(['Start', 'steer me', 'queued']);
        });
    });

    test('a turn that fails while a steer is with the agent holds the queue at once, and a held queue steers nothing', async () => {
        const { h, engine, chat, send, chatNow, queue, start, release } = await setup(turn => turn === 1);
        let answer!: (taken: boolean) => void;

        engine.steerAnswer = () => new Promise<boolean>((resolve) => {
            answer = resolve;
        });

        const runId = await start();

        send('queued');
        send('steer me', { mode: 'steer' });
        await waitFor(() => engine.steered.length === 1, 'the steer to reach the agent');

        release(1);
        await waitFor(() => h.run(runId).status === 'failed', 'the turn to fail');
        await waitFor(() => chatNow().queuePaused === 'failed', 'the queue to hold');

        // The person writes before the agent answers the steer: that turn gets only their message.
        send('by hand');
        await waitFor(() => engine.turns.length === 2 && h.run(runId).status === 'running', 'the turn by hand');
        engine.steerAnswer = () => Promise.resolve(true);
        answer(false);
        await Bun.sleep(50);

        expect(engine.steered).toHaveLength(1);
        expect(chatNow().queuePaused).toBe('failed');
        expect(queue().map(item => item.text)).toEqual(['steer me', 'queued']);

        release(2);
        await waitFor(() => h.run(runId).status === 'succeeded', 'the turn by hand to end');
        await Bun.sleep(30);

        expect(engine.turns).toHaveLength(2);
        expect(getChat(h.store.db, chat.id)?.queue?.map(item => item.mode)).toEqual(['queue', 'queue']);
    });

    test('a steer while the orchestrator waits for an answer reaches its turn once the answer puts it back to work', async () => {
        const gate = latch();
        const engine = new ScriptEngine(async function* (turn) {
            yield { type: 'session', sessionId: 's1' };
            yield* turn.call('ask_user', { question: 'Which colour?', options: [{ id: 'blue', label: 'Blue' }] });
            await gate.wait(turn.signal);
            yield { type: 'done', result: 'done' };
        });
        const h = await startHarness({}, { engines: scriptEngines(engine) });

        harnesses.push(h);
        engine.steerAnswer = () => true;

        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, mode: 'semi' }) as { chat: Chat };
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Pick a colour' }) as { runId: string };

        await waitFor(() => h.run(runId).status === 'waiting_user', 'the question');
        h.ok('chat.send', { chatId: chat.id, text: 'Prefer dark tones', mode: 'steer' });
        await Bun.sleep(30);

        // A question holds the turn: a steer would push the agent past it.
        expect(engine.steered).toEqual([]);

        const question = listItems(h.store.db, runId, 0).find(item => item.body.kind === 'question')!.body as { questionId: string };

        h.ok('run.answer', { runId, questionId: question.questionId, answer: 'blue' });
        await waitFor(() => getChat(h.store.db, chat.id)?.queue === undefined, 'the steer to be taken');

        expect(engine.steered).toEqual(['Prefer dark tones']);
        gate.release();
    });

    test('a steer for an orchestrator that waits for a slot reaches its turn once the turn starts', async () => {
        const turns = gatedTurns();
        const engine = new ScriptEngine(turns.script);
        const h = await startHarness({ engineCaps: { fake: 1 } }, { engines: scriptEngines(engine) });

        harnesses.push(h);
        engine.steerAnswer = () => true;

        const project = h.openRepo();
        const first = (h.ok('chat.create', { projectId: project.id }) as { chat: Chat }).chat;
        const second = (h.ok('chat.create', { projectId: project.id }) as { chat: Chat }).chat;

        h.ok('chat.send', { chatId: first.id, text: 'Hold the slot' });
        await waitFor(() => engine.turns.length === 1, 'the first chat to start');

        const { runId } = h.ok('chat.send', { chatId: second.id, text: 'Wait for it' }) as { runId: string };

        expect(h.run(runId).status).toBe('queued');

        h.ok('chat.send', { chatId: second.id, text: 'And steer this', mode: 'steer' });
        await Bun.sleep(30);

        expect(engine.steered).toEqual([]);

        turns.release(1);
        await waitFor(() => getChat(h.store.db, second.id)?.queue === undefined, 'the steer to reach the second chat\'s turn');

        expect(engine.turns[1].prompt).toContain('Wait for it');
        expect(engine.steered).toEqual(['And steer this']);
        expect(listItems(h.store.db, runId, 0).flatMap(item => (item.body.kind === 'user' ? [item.body.text] : []))).toEqual(['Wait for it', 'And steer this']);
    });
});

describe('stop and send for an agent that cannot steer', () => {
    /** The statuses a run went through, in order, as the daemon published them. */
    const trail = (h: Harness, runId: string) => h.events()
        .flatMap(event => (event.data.type === 'run.upserted' && event.data.run.id === runId ? [event.data.run.status] : []))
        .filter((status, index, all) => status !== all[index - 1]);
    const stoppedToSend = (h: Harness, runId: string) => h.events().some(event => event.data.type === 'run.upserted' && event.data.run.id === runId && event.data.run.status === 'cancelled' && event.data.run.statusReason === STOPPED_TO_SEND_REASON);

    test('Send now ends the running turn, and the message is the next turn of the same session, told that the last one was stopped', async () => {
        const { h, engine, chat, send, chatNow, queue, bodies, people, start, release } = await setup();
        const runId = await start();

        send('first');
        send('second');
        h.ok('chat.sendQueued', { chatId: chat.id, itemId: queue()[1].id });
        await waitFor(() => engine.turns.length === 2, 'the message as the next turn');

        // The agent is told the runtime ended its turn; the person's bubble is their words alone.
        expect(engine.turns[1]).toMatchObject({ prompt: `${ STOPPED_TURN_MESSAGE }\n\nsecond`, resumeSessionId: 's1' });
        expect(people(runId)).toEqual(['Start', 'second']);
        // What the stopped turn had said stays, closed, before the bubble.
        expect(bodies(runId).slice(0, 3)).toEqual([{ kind: 'user', text: 'Start' }, { kind: 'assistant', text: 'before 1', done: true }, { kind: 'user', text: 'second' }]);
        expect(engine.steered).toEqual([]);
        expect(queue().map(brief)).toEqual([['queue', 'first']]);
        expect(chatNow().queuePaused).toBeUndefined();
        expect(h.run(runId).status).toBe('running');

        // The run rested as stopped for this, between the turns, and was never failed.
        expect(stoppedToSend(h, runId)).toBe(true);
        expect(trail(h, runId).slice(-4)).toEqual(['running', 'cancelled', 'queued', 'running']);
        expect(trail(h, runId)).not.toContain('failed');
        expect(bodies(runId).some(body => body.kind === 'error')).toBe(false);

        // The turn that was sent is an ordinary one: the rest of the queue goes after it, with no word of a stop.
        release(2);
        await waitFor(() => engine.turns.length === 3, 'the rest of the queue');

        expect(engine.turns[2].prompt).toBe('first');
        expect(chatNow().queuePaused).toBeUndefined();
    });

    test('a call the stopped turn left running is shown as stopped', async () => {
        const { h, engine, chat, send, queue, bodies, start } = await setup(undefined, {}, {
            script: async function* ({ number, signal }) {
                yield { type: 'session', sessionId: 's1' };

                if (number === 1) {
                    yield { type: 'tool', toolCallId: 'call-1', name: 'Bash', input: { command: 'sleep 60' }, state: 'running' };
                    await untilAborted(signal);
                }

                yield { type: 'done', result: `turn ${ number }` };
            },
        });
        const runId = await start();

        send('now please');
        h.ok('chat.sendQueued', { chatId: chat.id, itemId: queue()[0].id });
        await waitFor(() => engine.turns.length === 2 && h.run(runId).status === 'succeeded', 'the sent turn to end');

        expect(bodies(runId)[1]).toEqual({ kind: 'tool', toolCallId: 'call-1', name: 'Bash', input: { command: 'sleep 60' }, state: 'error', error: STOPPED_TOOL });
        expect(bodies(runId).some(body => body.kind === 'error')).toBe(false);
        expect(trail(h, runId)).not.toContain('failed');
    });

    test('an engine that errors on its way out is not a failure either, and the turn is not repeated', async () => {
        const { h, engine, chat, send, queue, bodies, start } = await setup(undefined, {}, {
            script: async function* ({ number, signal }) {
                yield { type: 'session', sessionId: 's1' };

                if (number === 1) {
                    await untilAborted(signal).catch(() => undefined);
                    // A process that was told to stop reports it as a passing engine failure, which would be retried after a wait.
                    yield { type: 'error', message: 'The agent process exited', retryable: true };

                    return;
                }

                yield { type: 'done', result: `turn ${ number }` };
            },
        });
        const runId = await start();

        send('now please');
        h.ok('chat.sendQueued', { chatId: chat.id, itemId: queue()[0].id });
        await waitFor(() => h.run(runId).status === 'succeeded', 'the sent turn to end');

        expect(engine.turns).toHaveLength(2);
        expect(engine.turns[1].prompt).toBe(`${ STOPPED_TURN_MESSAGE }\n\nnow please`);
        expect(trail(h, runId)).not.toContain('failed');
        expect(trail(h, runId)).not.toContain('blocked');
        expect(bodies(runId).some(body => body.kind === 'error')).toBe(false);
    });

    test('the runs the orchestrator spawned go on, and report to it as ever', async () => {
        const executor = latch();
        const isOrchestrator = (turn: Turn) => turn.options.tools.some(tool => tool.name === 'run_spawn');
        const { h, engine, chat, send, chatNow, queue, start } = await setup(undefined, {}, {
            script: async function* (turn) {
                if (!isOrchestrator(turn)) {
                    yield { type: 'session', sessionId: 's-executor' };
                    await executor.wait(turn.signal);
                    yield* turn.call('report_result', { status: 'done', summary: 'The footer is fixed' });
                    yield { type: 'done' };

                    return;
                }

                yield { type: 'session', sessionId: 's1' };

                if (!turn.options.resumeSessionId) {
                    const { task } = yield* turn.call('task_create', { title: 'Task 1' });

                    yield* turn.call('run_spawn', { taskIds: [task.key], prompt: `Goal: ${ task.key }`, idempotencyKey: 'executor-1' });
                    await untilAborted(turn.signal);
                }

                yield { type: 'done', result: 'Understood' };
            },
        });
        const orchestratorTurns = () => engine.turns.filter(options => options.tools.some(tool => tool.name === 'run_spawn'));
        const executorRun = () => projectSnapshot(h.store, h.run(runId).projectId).runs.find(run => run.origin === 'spawned') as Run;
        const { runId } = send('Start');

        await waitFor(() => engine.turns.length === 2 && h.run(runId).status === 'running', 'the orchestrator to start its executor');

        const executorId = executorRun().id;

        send('Change of plan');
        h.ok('chat.sendQueued', { chatId: chat.id, itemId: queue()[0].id });
        await waitFor(() => orchestratorTurns().length === 2, 'the message as the next turn of the orchestrator');

        // The orchestrator ended its turn for the message; the executor never noticed, and the queue is not held.
        expect(orchestratorTurns()[1]).toMatchObject({ prompt: `${ STOPPED_TURN_MESSAGE }\n\nChange of plan`, resumeSessionId: 's1' });
        await waitFor(() => h.run(runId).status === 'waiting_children', 'the orchestrator to wait for its executor again');

        expect(h.run(executorId).status).toBe('running');
        expect(trail(h, executorId)).not.toContain('cancelled');
        expect(chatNow().queuePaused).toBeUndefined();

        executor.release();
        await waitFor(() => h.run(runId).status === 'succeeded' && orchestratorTurns().length === 3, 'the orchestrator to hear the executor\'s result');

        expect(h.run(executorId).status).toBe('succeeded');
        expect(orchestratorTurns()[2].prompt).toContain('The footer is fixed');
        expect(orchestratorTurns()[2].prompt).not.toContain(STOPPED_TURN_MESSAGE);
    });

    test('a second Send now while the turn is ending goes after the first, not before it', async () => {
        const { h, engine, chat, send, queue, start, release } = await setup(undefined, {}, { closeMs: 150 });

        await start();
        send('one');
        send('two');
        h.ok('chat.sendQueued', { chatId: chat.id, itemId: queue()[0].id });
        h.ok('chat.sendQueued', { chatId: chat.id, itemId: queue()[1].id });
        await waitFor(() => engine.turns.length === 2, 'the first message as the next turn');

        expect(engine.turns[1].prompt).toBe(`${ STOPPED_TURN_MESSAGE }\n\none`);

        release(2);
        await waitFor(() => engine.turns.length === 3, 'the second message as the turn after it');

        expect(engine.turns[2].prompt).toBe('two');
        expect(queue()).toEqual([]);
    });

    test('an agent that can steer is not stopped: a steer it refuses waits for the end of the turn, as before', async () => {
        const { h, engine, chat, send, queue, start, release } = await setup();

        engine.steerAnswer = () => false;

        const runId = await start();

        send('later');
        h.ok('chat.sendQueued', { chatId: chat.id, itemId: queue()[0].id });
        await waitFor(() => engine.steered.length === 1, 'the steer to be tried');
        await Bun.sleep(30);

        expect(engine.turns).toHaveLength(1);
        expect(h.run(runId).status).toBe('running');
        expect(queue().map(brief)).toEqual([['steer', 'later']]);

        release(1);
        await waitFor(() => engine.turns.length === 2, 'the steer as the next turn');

        expect(engine.turns[1].prompt).toBe('later');
        expect(stoppedToSend(h, runId)).toBe(false);
    });

    test('an agent that answers while it is being stopped has finished: the run succeeds, and the message goes as an ordinary next turn', async () => {
        const answer = latch();
        const { h, engine, chat, send, queue, start } = await setup(undefined, {}, {
            script: async function* ({ number }) {
                yield { type: 'session', sessionId: 's1' };

                if (number === 1) {
                    // Does not notice the abort: its answer was on its way.
                    await answer.wait();
                }

                yield { type: 'done', result: `turn ${ number }` };
            },
        });
        const runId = await start();

        send('now please');
        h.ok('chat.sendQueued', { chatId: chat.id, itemId: queue()[0].id });
        answer.release();
        await waitFor(() => engine.turns.length === 2, 'the message as the next turn');

        expect(engine.turns[1].prompt).toBe('now please');
        expect(stoppedToSend(h, runId)).toBe(false);
        expect(trail(h, runId)).toContain('succeeded');
    });

    /**
     * An orchestrator that starts one executor on its first turn and then works until it is stopped; the stopped turn winds down only when the test says
     * (`winding`), which holds the run `running` with its turn ended, as a process that takes its time to leave does. Its second turn ends when the test
     * says (`second`), and any later one at once. The executor reports when the test releases it.
     */
    function orchestration() {
        const executor = latch();
        const winding = latch();
        const second = latch();
        let orchestratorTurns = 0;
        const script: Script = async function* (turn) {
            if (!turn.options.tools.some(tool => tool.name === 'run_spawn')) {
                yield { type: 'session', sessionId: 's-executor' };
                await executor.wait(turn.signal);
                yield* turn.call('report_result', { status: 'done', summary: 'The footer is fixed' });
                yield { type: 'done' };

                return;
            }

            yield { type: 'session', sessionId: 's1' };

            const number = ++orchestratorTurns;

            if (number === 1) {
                const { task } = yield* turn.call('task_create', { title: 'Task 1' });

                yield* turn.call('run_spawn', { taskIds: [task.key], prompt: `Goal: ${ task.key }`, idempotencyKey: 'executor-1' });
                await untilAborted(turn.signal).catch(() => undefined);
                await winding.wait();

                return;
            }

            if (number === 2) {
                await second.wait();
            }

            yield { type: 'done', result: `turn ${ number }` };
        };

        return { script, executor, winding, second };
    }

    /** The orchestration with its first turn running and the executor started; a message is queued and Send now pressed, so the turn is winding down. */
    async function stopping(options: { release?: boolean } = {}) {
        const o = orchestration();
        const rig = await setup(undefined, {}, { script: o.script });
        const { h, engine, chat, send, queue } = rig;
        const { runId } = send('Start');

        await waitFor(() => engine.turns.length === 2 && h.run(runId).status === 'running', 'the orchestrator to start its executor');

        const executorId = projectSnapshot(h.store, rig.project.id).runs.find(run => run.origin === 'spawned')!.id;
        const orchestratorTurns = () => engine.turns.filter(turn => turn.tools.some(tool => tool.name === 'run_spawn'));

        send('Change of plan');

        const itemId = queue()[0].id;

        h.ok('chat.sendQueued', { chatId: chat.id, itemId });

        if (options.release) {
            o.executor.release();
            await waitFor(() => h.run(executorId).status === 'succeeded', 'the executor to report');
        }

        return { ...rig, ...o, runId, executorId, itemId, orchestratorTurns };
    }

    test('a child that finishes while the turn is being stopped is told in the turn that sends the message', async () => {
        const { h, runId, executorId, winding, second, orchestratorTurns, engine } = await stopping({ release: true });

        // The turn has not wound down: the run is still `running`, and the finished child waits in its mailbox.
        expect(h.run(runId).status).toBe('running');
        expect(orchestratorTurns()).toHaveLength(1);

        winding.release();
        await waitFor(() => orchestratorTurns().length === 2, 'the message as the next turn');

        expect(h.run(executorId).status).toBe('succeeded');
        expect(orchestratorTurns()[1].prompt).toStartWith(`${ STOPPED_TURN_MESSAGE }\n\nChange of plan`);
        expect(orchestratorTurns()[1].prompt).toContain('The footer is fixed');

        second.release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the turn to end');
        await Bun.sleep(80);

        // Told once: nothing is owed after it.
        expect(engine.turns.filter(turn => turn.prompt.includes('The footer is fixed'))).toHaveLength(1);
        expect(orchestratorTurns()).toHaveLength(2);
    });

    test('a child that finishes while the turn that sends the message runs wakes the orchestrator when that turn ends', async () => {
        const { h, runId, executor, winding, second, orchestratorTurns } = await stopping();

        winding.release();
        await waitFor(() => orchestratorTurns().length === 2, 'the message as the next turn');

        expect(orchestratorTurns()[1].prompt).toBe(`${ STOPPED_TURN_MESSAGE }\n\nChange of plan`);

        executor.release();
        await waitFor(() => pendingMailbox(h.store.db, runId).length === 1, 'the result to wait in the mailbox');
        second.release();
        await waitFor(() => orchestratorTurns().length === 3, 'the wake-up turn');

        expect(orchestratorTurns()[2].prompt).toContain('The footer is fixed');
        expect(orchestratorTurns()[2].prompt).not.toContain(STOPPED_TURN_MESSAGE);
        await waitFor(() => h.run(runId).status === 'succeeded', 'the wake-up turn to end');
    });

    test('a message taken back while the turn ends leaves the orchestrator waiting for the runs it started, and their result wakes it', async () => {
        const { h, chat, runId, executorId, itemId, executor, winding, orchestratorTurns, chatNow } = await stopping();

        h.ok('chat.removeQueued', { chatId: chat.id, itemId });
        winding.release();
        await waitFor(() => h.run(runId).status === 'waiting_children', 'the orchestrator to wait for its executor');

        // Not left stopped, where nothing would wake it; the executor goes on.
        expect(h.run(runId).statusReason).toBe('Waiting for 1 child run');
        expect(h.run(executorId).status).toBe('running');
        expect(orchestratorTurns()).toHaveLength(1);
        expect(chatNow().queuePaused).toBeUndefined();

        executor.release();
        await waitFor(() => orchestratorTurns().length === 2, 'the wake-up turn');

        expect(orchestratorTurns()[1].prompt).toContain('The footer is fixed');
        expect(orchestratorTurns()[1].prompt).not.toContain(STOPPED_TURN_MESSAGE);
    });

    test('a message taken back after a child had finished leaves its result to wake the orchestrator at once', async () => {
        const { h, chat, runId, itemId, winding, orchestratorTurns } = await stopping({ release: true });

        h.ok('chat.removeQueued', { chatId: chat.id, itemId });
        winding.release();
        await waitFor(() => orchestratorTurns().length === 2, 'the wake-up turn');

        expect(orchestratorTurns()[1].prompt).toContain('The footer is fixed');
        expect(orchestratorTurns()[1].prompt).not.toContain(STOPPED_TURN_MESSAGE);
        expect(h.run(runId).status).not.toBe('cancelled');
    });

    test('a message taken back while the turn ends, with no run below it, leaves the orchestrator stopped, and the next message is an ordinary turn', async () => {
        const { h, engine, chat, send, chatNow, queue, start } = await setup(undefined, {}, { closeMs: 150 });
        const runId = await start();

        send('now please');
        h.ok('chat.sendQueued', { chatId: chat.id, itemId: queue()[0].id });
        h.ok('chat.removeQueued', { chatId: chat.id, itemId: queue()[0].id });
        await waitFor(() => h.run(runId).status === 'cancelled', 'the orchestrator to rest');

        expect(h.run(runId).statusReason).toBe(STOPPED_TO_SEND_REASON);
        expect(chatNow().queuePaused).toBeUndefined();

        send('a fresh start');
        await waitFor(() => engine.turns.length === 2, 'the fresh message');

        expect(engine.turns[1].prompt).toBe('a fresh start');
    });

    test('a Stop while the turn is ending is a Stop: the queue is held, the message stays, and sending it later carries no word of a stop and send', async () => {
        const { h, engine, chat, send, chatNow, queue, start } = await setup(undefined, {}, { closeMs: 150 });
        const runId = await start();

        send('now please');
        h.ok('chat.sendQueued', { chatId: chat.id, itemId: queue()[0].id });
        h.ok('run.cancel', { runId });
        await waitFor(() => engine.closedAt.length === 1, 'the stopped session to close');
        await Bun.sleep(30);

        expect(h.run(runId)).toMatchObject({ status: 'cancelled', statusReason: 'Cancelled by user' });
        expect(stoppedToSend(h, runId)).toBe(false);
        expect(chatNow().queuePaused).toBe('stopped');
        expect(queue().map(brief)).toEqual([['queue', 'now please']]);
        expect(engine.turns).toHaveLength(1);

        h.ok('chat.sendQueued', { chatId: chat.id, itemId: queue()[0].id });
        await waitFor(() => engine.turns.length === 2, 'the message sent from the held queue');

        expect(engine.turns[1].prompt).toBe('now please');
        expect(chatNow().queuePaused).toBeUndefined();
    });

    test('the task a chat was started from stays in its column while the turn is stopped to send a message, which is a rest and not a death', async () => {
        const { h, engine, project } = await setup();
        const task = h.ok('task.create', { projectId: project.id, title: 'Fix the footer' }).task;
        const { runId, chatId } = h.ok('task.start', { taskId: task.id });

        await waitFor(() => engine.turns.length === 1 && h.run(runId).status === 'running', 'the first turn');

        const message = h.ok('chat.send', { chatId, text: 'Change of plan' });
        const itemId = (getChat(h.store.db, chatId) as Chat).queue![0].id;

        expect(message.runId).toBe(runId);
        h.ok('chat.sendQueued', { chatId, itemId });
        await waitFor(() => engine.turns.length === 2 && h.run(runId).status === 'running', 'the message as the next turn');

        const columns = new Map(projectSnapshot(h.store, project.id).statuses.map(status => [status.id, status.category]));
        const trail = h.events().flatMap(event => (event.data.type === 'task.upserted' && event.data.task.id === task.id ? [columns.get(event.data.task.statusId)] : []));

        expect(trail.filter((category, index) => category !== trail[index - 1])).toEqual(['todo', 'active']);

        // A run that is really over still sends its task back.
        h.ok('run.cancel', { runId });
        await waitFor(() => h.run(runId).status === 'cancelled', 'the stop');

        expect(columns.get(projectSnapshot(h.store, project.id).tasks.find(candidate => candidate.id === task.id)!.statusId)).toBe('todo');
    });
});

describe('the queue commands', () => {
    test('remove drops a message with its files; with keepFiles the files go back to the project unsent', async () => {
        const { h, project, chat, send, queue, start } = await setup();

        await start();

        const upload = async (name: string) => await (await h.fetch(`/v1/projects/${ project.id }/attachments?name=${ name }`, { method: 'POST', body: 'data' })).json() as Attachment;
        const dropped = await upload('dropped.txt');
        const kept = await upload('kept.txt');

        send('drop me', { attachmentIds: [dropped.id] });
        send('edit me', { attachmentIds: [kept.id] });
        h.ok('chat.removeQueued', { chatId: chat.id, itemId: queue()[0].id });
        await Bun.sleep(10);

        expect(h.store.db.query('SELECT id FROM attachments WHERE id = ?').get(dropped.id)).toBeNull();
        expect(existsSync(join(h.config.dataDir, 'attachments', dropped.id))).toBe(false);

        expect(h.ok('chat.removeQueued', { chatId: chat.id, itemId: queue()[0].id, keepFiles: true }).chat.queue).toBeUndefined();
        expect(h.store.db.query('SELECT chat_id, run_id FROM attachments WHERE id = ?').get(kept.id)).toEqual({ chat_id: null, run_id: null });

        // Unsent again, so the next message can carry it.
        send('edited', { attachmentIds: [kept.id] });

        expect(queue()[0]).toMatchObject({ text: 'edited', attachments: [kept] });
    });

    test('move puts a message at a place among its own kind', async () => {
        const { h, chat, send, queue, start } = await setup();

        await start();
        ['one', 'two', 'three'].forEach(text => send(text));
        send('steer', { mode: 'steer' });

        const three = queue().find(item => item.text === 'three') as QueuedMessage;

        h.ok('chat.moveQueued', { chatId: chat.id, itemId: three.id, index: 0 });

        expect(queue().map(item => item.text)).toEqual(['steer', 'three', 'one', 'two']);

        h.ok('chat.moveQueued', { chatId: chat.id, itemId: three.id, index: 99 });

        expect(queue().map(item => item.text)).toEqual(['steer', 'one', 'two', 'three']);
    });

    test('a message that is not in the queue is not found', async () => {
        const { h, chat } = await setup();

        for (const type of ['chat.removeQueued', 'chat.moveQueued', 'chat.sendQueued'] as const) {
            const result = h.send(type, { chatId: chat.id, itemId: 'que_missing', index: 0 });

            expect(result.ok ? undefined : result.error.code).toBe('not_found');
        }
    });
});

describe('queue rules', () => {
    const item = (id: string, mode: QueuedMessage['mode']): QueuedMessage => ({ id, mode, text: id, content: id, createdAt: 0 });

    test('busy is any status but the terminal ones and waiting for children', () => {
        const at = (status: Run['status']) => isAtRest({ status } as Run);

        expect(['succeeded', 'failed', 'cancelled', 'interrupted', 'waiting_children'].map(status => at(status as Run['status']))).toEqual([true, true, true, true, true]);
        expect(['queued', 'running', 'waiting_user', 'blocked'].map(status => at(status as Run['status']))).toEqual([false, false, false, false]);
    });

    test('a message goes to the end of its own kind, the steers first', () => {
        const queue = [item('a', 'steer'), item('b', 'queue')];

        expect(placeQueued(queue, item('c', 'steer')).map(entry => entry.id)).toEqual(['a', 'c', 'b']);
        expect(placeQueued(queue, item('d', 'queue')).map(entry => entry.id)).toEqual(['a', 'b', 'd']);
        // Becoming a steer moves it to the end of the steers.
        expect(placeQueued(queue, { ...queue[1], mode: 'steer' }).map(entry => [entry.id, entry.mode])).toEqual([['a', 'steer'], ['b', 'steer']]);
    });

    test('at rest the steers become the next turns, in their order', () => {
        expect(settleSteers([item('a', 'steer'), item('b', 'steer'), item('c', 'queue')]).map(entry => [entry.id, entry.mode])).toEqual([['a', 'queue'], ['b', 'queue'], ['c', 'queue']]);
    });
});
