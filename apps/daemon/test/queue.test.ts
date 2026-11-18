import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { getChat } from '../src/db/chats';
import { listItems } from '../src/db/items';
import { placeQueued, settleSteers } from '../src/domain/queue';
import { isAtRest } from '../src/runs/queue';
import { cleanTempDirs, latch, restartHarness, ScriptEngine, scriptEngines, startHarness, waitFor } from './helpers';

import type { Attachment, Chat, QueuedMessage, Run, StreamItemBody } from '@clowdy/protocol';
import type { Harness, Script } from './helpers';

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

async function setup(fail?: (turn: number) => boolean, overrides = {}) {
    const turns = gatedTurns(fail);
    const engine = new ScriptEngine(turns.script);
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

        expect(isAtRest(undefined)).toBe(true);
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
