import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { itemRef, listItems } from '../src/db/items';
import { appendItem } from '../src/domain/items';
import { cleanTempDirs, latch, ScriptEngine, scriptEngines, startHarness, waitFor } from './helpers';

import type { Chat, StreamItem } from '@clowdy/protocol';
import type { EngineEvent } from '../src/engine/types';
import type { Harness, Script } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

/** Waits until `check`, which may read the stream over HTTP, comes back with something. */
async function eventually<T>(check: () => Promise<T | undefined | false | null>, what: string, timeoutMs = 4000): Promise<T> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
        const value = await check();

        if (value) {
            return value;
        }

        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${ what }`);
        }

        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

/** A message the agent says whole and ends, with its id when it gives one. */
const say = (text: string, messageId?: string): EngineEvent[] => [{ type: 'text', delta: text, done: false }, { type: 'text', delta: '', done: true, ...(messageId !== undefined && { messageId }) }];

/** A turn that says one message named `m<turn>` and ends. */
const answering: Script = async function* ({ number }) {
    yield { type: 'session', sessionId: 's1' };
    yield* say(`answer ${ number }`, `m${ number }`);
    yield { type: 'done', result: `answer ${ number }` };
};

/** `agent`: the agent the chat is made for. The script stands in for the program, which is not on this machine; Claude's is the one with a compact command. */
async function setup(script: Script = answering, flagged = true, agent = 'fake') {
    const engine = new ScriptEngine(script);

    engine.canFork = flagged;

    const h = await startHarness({}, { engines: scriptEngines(engine).set(agent, engine) });

    harnesses.push(h);

    const project = h.openRepo();
    const { chat } = h.ok('chat.create', { projectId: project.id, engine: agent }) as { chat: Chat };
    const send = (text: string, fields: Record<string, unknown> = {}) => h.ok('chat.send', { chatId: chat.id, text, ...fields }) as { runId: string };
    /** The stream as a client reads it. */
    const read = async () => await (await h.fetch(`/v1/chats/${ chat.id }/items`)).json() as StreamItem[];
    const settled = (runId: string, turns: number) => waitFor(() => engine.turns.length === turns && h.run(runId).status === 'succeeded', `turn ${ turns } to end`);

    return { h, engine, chat, send, read, settled };
}

/** What a client may offer on each item: the kind, then `fork`, `edit` or both. */
const offers = (items: StreamItem[]) => items.map(item => [item.body.kind, ...(item.canFork ? ['fork'] : []), ...(item.canEdit ? ['edit'] : [])].join(' '));

describe('the point a turn ends at', () => {
    test('is the id the agent gave the turn\'s last message, kept on that item and never sent to a client', async () => {
        const { h, send, read, settled } = await setup();
        const { runId } = send('Hello');

        await settled(runId, 1);

        const items = await read();

        expect(items.map(item => item.body.kind)).toEqual(['user', 'assistant']);
        expect(itemRef(h.store.db, runId, 2)).toBe('m1');
        expect(itemRef(h.store.db, runId, 1)).toBeUndefined();
        expect(JSON.stringify(items)).not.toContain('m1');
    });

    test('is made again by each turn: the answer of the second turn holds the second turn\'s id, and the first keeps its own', async () => {
        const { h, send, read, settled } = await setup();
        const { runId } = send('One');

        await settled(runId, 1);
        send('Two');
        await settled(runId, 2);

        expect(await read().then(offers)).toEqual(['user edit', 'assistant fork', 'user edit', 'assistant fork']);
        expect(listItems(h.store.db, runId, 0).map(item => itemRef(h.store.db, runId, item.seq))).toEqual([undefined, 'm1', undefined, 'm2']);
    });

    test('goes out as the item again once it is stamped, so a client that had the item learns it can fork', async () => {
        const { h, send, settled } = await setup();
        const { runId } = send('Hello');

        await settled(runId, 1);

        const about = h.events().flatMap(event => event.data.type === 'stream.item' && event.data.item.runId === runId && event.data.item.body.kind === 'assistant' ? [event.data.item] : []);

        // The text streamed without the flag, and the last publication of the item has it.
        expect(about.length).toBeGreaterThan(1);
        expect(about[0].canFork).toBeUndefined();
        expect(about.at(-1)?.canFork).toBe(true);
    });

    test('is not made for a message that has a tool call after it, since the turn did not end there', async () => {
        const { send, read, settled } = await setup(async function* () {
            yield { type: 'session', sessionId: 's1' };
            yield* say('Running it', 'm1');
            yield { type: 'tool', toolCallId: 'c1', name: 'Bash', input: { command: 'ls' }, state: 'running' };
            yield { type: 'tool', toolCallId: 'c1', name: 'Bash', input: { command: 'ls' }, state: 'done', output: 'a' };
            yield { type: 'done', result: 'Running it' };
        });
        const { runId } = send('Hello');

        await settled(runId, 1);

        expect(await read().then(offers)).toEqual(['user edit', 'assistant', 'tool']);
    });

    test('is not made for a message that has no id, a message with nothing in it, or a turn that failed', async () => {
        const { h, send, read, settled } = await setup(async function* ({ number }) {
            yield { type: 'session', sessionId: 's1' };

            if (number === 1) {
                yield* say('No id given');
                yield { type: 'done', result: 'No id given' };
            }
            else if (number === 2) {
                yield* say('   ', 'blank');
                yield { type: 'done' };
            }
            else {
                yield* say('Half an answer', 'm3');
                yield { type: 'error', message: 'The agent fell over' };
            }
        });
        const { runId } = send('One');

        await settled(runId, 1);
        send('Two');
        await settled(runId, 2);
        send('Three');
        await waitFor(() => h.run(runId).status === 'failed', 'the third turn to fail');

        expect(listItems(h.store.db, runId, 0).every(item => itemRef(h.store.db, runId, item.seq) === undefined)).toBe(true);
        expect(await read().then(offers)).toEqual(['user edit', 'assistant', 'user', 'assistant', 'user', 'assistant', 'error']);
    });

    test('is not made by the agent\'s compact turn, whose report is no answer of the conversation; the message after it starts no turn to edit', async () => {
        const { h, chat, send, read, settled } = await setup(async function* ({ number, options }) {
            yield { type: 'session', sessionId: 's1' };

            const text = options.prompt === '/compact' ? 'Compacted the conversation' : `answer ${ number }`;

            yield* say(text, `m${ number }`);
            yield { type: 'done', result: text };
        }, true, 'claude');
        const { runId } = send('One');

        await settled(runId, 1);
        h.ok('chat.compact', { chatId: chat.id });
        await settled(runId, 2);
        send('Two');
        await settled(runId, 3);

        expect(await read().then(offers)).toEqual(['user edit', 'assistant fork', 'assistant', 'user', 'assistant fork']);
        expect(listItems(h.store.db, runId, 0).map(item => itemRef(h.store.db, runId, item.seq))).toEqual([undefined, 'm1', undefined, undefined, 'm3']);
    });

    test('a turn the agent starts by itself in a session that stays open ends at a point of its own', async () => {
        const first = latch();
        const { h, engine, send, read } = await setup(async function* (turn) {
            yield { type: 'session', sessionId: 's1' };
            yield* say('Started', 'm1');
            yield { type: 'background', items: [{ id: 'job', kind: 'command', title: 'bun test' }] };
            yield { type: 'done', result: 'Started' };
            await turn.hold(first);
            // The command finished, and the agent reports on a turn nobody asked for.
            yield { type: 'background', items: [] };
            yield* say('It passed', 'm2');
            yield { type: 'done', result: 'It passed' };
        });

        engine.sendAnswer = () => true;

        const { runId } = send('Run the tests');

        // The session stays open (the command is in the background), so the run waits instead of ending.
        await waitFor(() => engine.turns.length === 1 && h.run(runId).status === 'waiting_background', 'the run to wait');

        first.release();
        await eventually(async () => (await read()).some(item => item.body.kind === 'assistant' && item.body.text === 'It passed' && item.canFork), 'the report to hold a point');

        // The stream says the command finished between the two answers; a note holds no point.
        expect(listItems(h.store.db, runId, 0).map(item => [item.body.kind, itemRef(h.store.db, runId, item.seq)])).toEqual([['user', undefined], ['assistant', 'm1'], ['note', undefined], ['assistant', 'm2']]);
    });
});

describe('what a client may offer on an item', () => {
    test('the first message of a chat can be edited from the start, and the answer can be forked once the turn is over', async () => {
        const gate = latch();
        const { send, read } = await setup(async function* (turn) {
            yield { type: 'session', sessionId: 's1' };
            yield* say('Thinking', 'm1');
            await gate.wait(turn.signal);
            yield { type: 'done', result: 'Thinking' };
        });

        send('Hello');
        await eventually(async () => (await read()).length === 2, 'the answer to be written');

        // A turn that is running offers Edit on its message and Fork on nothing yet.
        expect(offers(await read())).toEqual(['user edit', 'assistant']);

        gate.release();
        await eventually(async () => (await read())[1].canFork, 'the point');

        expect(offers(await read())).toEqual(['user edit', 'assistant fork']);
    });

    test('a message that follows a turn that ended at a point can be edited, one that follows a turn that did not cannot', async () => {
        const { h, send, read, settled } = await setup(async function* ({ number }) {
            yield { type: 'session', sessionId: 's1' };
            // The first turn gives no id; the second does.
            yield* say(`answer ${ number }`, number === 1 ? undefined : `m${ number }`);
            yield { type: 'done', result: `answer ${ number }` };
        });
        const { runId } = send('One');

        await settled(runId, 1);
        send('Two');
        await settled(runId, 2);
        send('Three');
        await settled(runId, 3);

        expect(listItems(h.store.db, runId, 0).map(item => item.body.kind)).toHaveLength(6);
        expect(offers(await read())).toEqual(['user edit', 'assistant', 'user', 'assistant fork', 'user edit', 'assistant fork']);
    });

    test('a steer in the middle of a turn is not a message that starts one, and the answer after it is the turn\'s point', async () => {
        const gate = latch();
        const { h, engine, send, read, settled } = await setup(async function* (turn) {
            yield { type: 'session', sessionId: 's1' };
            yield* say('First part', 'm-first');
            await gate.wait(turn.signal);
            yield* say('Second part', 'm-second');
            yield { type: 'done', result: 'Second part' };
        });

        engine.steerAnswer = () => true;

        const { runId } = send('Start');

        await waitFor(() => engine.turns.length === 1 && h.run(runId).status === 'running', 'the turn to run');
        send('Use the blue one', { mode: 'steer' });
        await eventually(async () => (await read()).length === 3, 'the steer to be taken');

        gate.release();
        await settled(runId, 1);

        // The part before the steer was closed by it, with no id of its own to cut at.
        expect(offers(await read())).toEqual(['user edit', 'assistant', 'user', 'assistant fork']);
    });

    test('a message another chat wrote, and a notice of threads, are never editable, wherever they stand', async () => {
        const { h, send, read, settled } = await setup();
        const { runId } = send('One');

        await settled(runId, 1);
        appendItem(h.store, runId, { kind: 'user', text: 'From a thread', from: { kind: 'thread', chatId: 'cht_other', title: 'Other' } });
        appendItem(h.store, runId, { kind: 'user', text: 'Done', from: { kind: 'threadNotice', threads: [] } });

        expect(offers(await read())).toEqual(['user edit', 'assistant fork', 'user', 'user']);
    });

    test('a note does not count as part of the turn: the message after it still starts one', async () => {
        const { h, send, read, settled } = await setup();
        const { runId } = send('One');

        await settled(runId, 1);
        appendItem(h.store, runId, { kind: 'note', text: 'Background command finished: bun test' });
        appendItem(h.store, runId, { kind: 'user', text: 'Two' });

        expect(offers(await read())).toEqual(['user edit', 'assistant fork', 'note', 'user edit']);
    });

    test('an agent that cannot fork offers neither, though its turns keep their points', async () => {
        const { h, send, read, settled } = await setup(answering, false);
        const { runId } = send('One');

        await settled(runId, 1);
        send('Two');
        await settled(runId, 2);

        expect(await read().then(offers)).toEqual(['user', 'assistant', 'user', 'assistant']);
        expect(itemRef(h.store.db, runId, 2)).toBe('m1');
        expect(itemRef(h.store.db, runId, 4)).toBe('m2');
    });

    test('the flag is read when an item is read: switching it off takes both away from a chat that had them', async () => {
        const { engine, send, read, settled } = await setup();
        const { runId } = send('One');

        await settled(runId, 1);
        expect(await read().then(offers)).toEqual(['user edit', 'assistant fork']);

        engine.canFork = false;
        expect(await read().then(offers)).toEqual(['user', 'assistant']);
    });

    test('the run\'s own stream reads the same, and a sub-agent\'s stream offers nothing', async () => {
        const { h, send, settled } = await setup(async function* ({ number }) {
            yield { type: 'session', sessionId: 's1' };
            yield { type: 'subagent', agentId: 'a1', name: 'Explore', state: 'running' };
            yield { type: 'text', delta: 'Looking', done: false, agentId: 'a1' };
            yield { type: 'text', delta: '', done: true, agentId: 'a1' };
            yield { type: 'subagent', agentId: 'a1', name: 'Explore', state: 'done', summary: 'Looking' };
            yield* say(`answer ${ number }`, `m${ number }`);
            yield { type: 'done', result: `answer ${ number }` };
        });
        const { runId } = send('One');

        await settled(runId, 1);

        const child = h.store.db.query('SELECT id FROM runs WHERE parent_run_id = ?').get(runId) as { id: string };
        const own = await (await h.fetch(`/v1/runs/${ runId }/items`)).json() as StreamItem[];
        const theirs = await (await h.fetch(`/v1/runs/${ child.id }/items`)).json() as StreamItem[];

        expect(offers(own)).toEqual(['user edit', 'assistant fork']);
        expect(theirs.length).toBeGreaterThan(0);
        expect(theirs.every(item => !item.canFork && !item.canEdit)).toBe(true);
    });
});
