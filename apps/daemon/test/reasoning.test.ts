import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { cleanTempDirs, ScriptEngine, scriptEngines, startHarness, waitFor } from './helpers';

import type { Chat, StreamItem } from '@clowdy/protocol';
import type { EngineEvent } from '../src/engine/types';
import type { Harness, Script } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

/** A thought in pieces, ending with the mark that closes it. */
const think = (...pieces: string[]): EngineEvent[] => [...pieces.map((delta): EngineEvent => ({ type: 'thought', delta, done: false })), { type: 'thought', delta: '', done: true }];

/** A message the agent says whole and ends, with its id when it gives one. */
const say = (text: string, messageId?: string): EngineEvent[] => [{ type: 'text', delta: text, done: false }, { type: 'text', delta: '', done: true, ...(messageId !== undefined && { messageId }) }];

async function setup(script: Script) {
    const engine = new ScriptEngine(script);

    engine.canFork = true;

    const h = await startHarness({}, { engines: scriptEngines(engine) });

    harnesses.push(h);

    const project = h.openRepo();
    const { chat } = h.ok('chat.create', { projectId: project.id, engine: 'fake' }) as { chat: Chat };
    const send = (text: string) => h.ok('chat.send', { chatId: chat.id, text }) as { runId: string };
    const read = async () => await (await h.fetch(`/v1/chats/${ chat.id }/items`)).json() as StreamItem[];
    const settled = (runId: string, turns: number) => waitFor(() => engine.turns.length === turns && h.run(runId).status === 'succeeded', `turn ${ turns } to end`);

    return { h, engine, chat, send, read, settled };
}

const reasoning = (item: StreamItem) => (item.body.kind === 'reasoning' ? item.body : undefined);

describe('the agent\'s reasoning in the stream', () => {
    test('is one item that streams in place, then ends with the time it took, before the message it led to', async () => {
        const { h, send, read, settled } = await setup(async function* () {
            yield { type: 'session', sessionId: 's1' };
            yield* think('Let me ', 'look at ', 'the form.');
            yield* say('Looking now.', 'm1');
            yield { type: 'done', result: 'Looking now.' };
        });
        const { runId } = send('Fix the form');

        await settled(runId, 1);

        const items = await read();

        expect(items.map(item => item.body.kind)).toEqual(['user', 'reasoning', 'assistant']);
        expect(reasoning(items[1])).toMatchObject({ kind: 'reasoning', text: 'Let me look at the form.', done: true });
        expect(reasoning(items[1])?.durationMs).toBeGreaterThanOrEqual(0);

        // One item changed in place: every publication of it is the same item.
        const about = h.events().flatMap(event => event.data.type === 'stream.item' && event.data.item.runId === runId && event.data.item.body.kind === 'reasoning' ? [event.data.item] : []);

        expect(new Set(about.map(item => item.id)).size).toBe(1);
        expect(about.at(-1)?.body).toMatchObject({ done: true });
    });

    test('ends where a tool call begins, and a thought after it is another item', async () => {
        const { send, read, settled } = await setup(async function* () {
            yield { type: 'session', sessionId: 's1' };
            yield* think('First, read it.');
            yield { type: 'tool', toolCallId: 'c1', name: 'Read', input: { file_path: 'a.ts' }, state: 'done', output: 'x' };
            yield* think('Now edit.');
            yield { type: 'tool', toolCallId: 'c2', name: 'Edit', input: { file_path: 'a.ts' }, state: 'done' };
            yield* say('Done.', 'm1');
            yield { type: 'done', result: 'Done.' };
        });
        const { runId } = send('Go');

        await settled(runId, 1);

        const items = await read();

        expect(items.map(item => item.body.kind)).toEqual(['user', 'reasoning', 'tool', 'reasoning', 'tool', 'assistant']);
        expect(items.flatMap(item => reasoning(item)?.text ?? [])).toEqual(['First, read it.', 'Now edit.']);
        expect(items.flatMap(item => reasoning(item)?.done ?? [])).toEqual([true, true]);
    });

    test('is closed by the message that follows even when the agent never marks its end, and by the end of the turn', async () => {
        const { send, read, settled } = await setup(async function* ({ number }) {
            yield { type: 'session', sessionId: 's1' };

            if (number === 1) {
                yield { type: 'thought', delta: 'Never closed.', done: false };
                yield { type: 'text', delta: 'Answer', done: false };
                yield { type: 'text', delta: '', done: true };
            }
            else {
                yield { type: 'thought', delta: 'Left open at the end.', done: false };
            }

            yield { type: 'done' };
        });
        const first = send('One');

        await settled(first.runId, 1);
        send('Two');
        await settled(first.runId, 2);

        const items = await read();

        expect(items.map(item => item.body.kind)).toEqual(['user', 'reasoning', 'assistant', 'user', 'reasoning']);
        expect(items.flatMap(item => reasoning(item)?.done ?? [])).toEqual([true, true]);
    });

    test('makes no item of a thought that is only blank space', async () => {
        const { send, read, settled } = await setup(async function* () {
            yield { type: 'session', sessionId: 's1' };
            yield* think('  ', '\n');
            yield* say('Hi.', 'm1');
            yield { type: 'done', result: 'Hi.' };
        });
        const { runId } = send('Hello');

        await settled(runId, 1);

        expect((await read()).map(item => item.body.kind)).toEqual(['user', 'assistant']);
    });

    test('is no part of the story a turn is cut at: the answer still holds the point, and the next message can still be edited', async () => {
        const { send, read, settled } = await setup(async function* ({ number }) {
            yield { type: 'session', sessionId: 's1' };
            yield* think(`Thought of turn ${ number }.`);
            yield* say(`answer ${ number }`, `m${ number }`);

            // A thought that comes after the answer does not take the point away.
            yield* think('One more thing.');
            yield { type: 'done', result: `answer ${ number }` };
        });
        const { runId } = send('One');

        await settled(runId, 1);
        send('Two');
        await settled(runId, 2);

        const items = await read();

        expect(items.map(item => [item.body.kind, ...(item.canFork ? ['fork'] : []), ...(item.canEdit ? ['edit'] : [])].join(' '))).toEqual([
            'user edit',
            'reasoning',
            'assistant fork',
            'reasoning',
            'user edit',
            'reasoning',
            'assistant fork',
            'reasoning',
        ]);
    });

    test('does not hide the point an edit cuts the session at: the message after a thought that trails the answer is edited from the answer\'s point', async () => {
        const { h, engine, chat, send, read, settled } = await setup(async function* ({ number }) {
            yield { type: 'session', sessionId: 's1' };
            yield* say(`answer ${ number }`, `m${ number }`);
            yield* think('One more thing.');
            yield { type: 'done', result: `answer ${ number }` };
        });
        const { runId } = send('One');

        await settled(runId, 1);
        send('Two');
        await settled(runId, 2);

        const items = await read();

        expect(items.map(item => item.body.kind)).toEqual(['user', 'assistant', 'reasoning', 'user', 'assistant', 'reasoning']);

        const result = await h.sendAsync('chat.edit', { chatId: chat.id, itemId: items[3].id, text: 'Two, again' });

        expect(result).toMatchObject({ ok: true });
        expect(engine.forked[0]).toMatchObject({ ref: 'm1' });
    });
});
