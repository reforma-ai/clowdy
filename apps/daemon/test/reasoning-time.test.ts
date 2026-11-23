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

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** A thought in pieces, ending with the mark that closes it. */
const think = (...pieces: string[]): EngineEvent[] => [
    ...pieces.map((delta): EngineEvent => ({ type: 'thought', delta, done: false })),
    { type: 'thought', delta: '', done: true },
];

async function setup(script: Script) {
    const engine = new ScriptEngine(script);
    const h = await startHarness({}, { engines: scriptEngines(engine) });

    harnesses.push(h);

    const project = h.openRepo();
    const { chat } = h.ok('chat.create', { projectId: project.id, engine: 'fake' }) as { chat: Chat };
    const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Go' }) as { runId: string };

    await waitFor(() => engine.turns.length === 1 && h.run(runId).status === 'succeeded', 'the turn to end');

    return (await (await h.fetch(`/v1/chats/${chat.id}/items`)).json()) as StreamItem[];
}

const thoughts = (items: StreamItem[]) => items.flatMap(item => (item.body.kind === 'reasoning' ? [item.body] : []));

describe('how long a thought took, and how it reads', () => {
    test('is the time since the agent last said or did anything: both adapters send a thought whole once the thinking is over', async () => {
        const items = await setup(async function* () {
            // Starting the agent is no thinking: the time is dated from the session being ready.
            await pause(300);
            yield { type: 'session', sessionId: 's1' };
            await pause(80);
            yield* think('First.');
            yield {
                type: 'tool',
                toolCallId: 'c1',
                name: 'Read',
                input: { file_path: 'a.ts' },
                state: 'done',
                output: 'x',
            };
            await pause(120);
            yield* think('Second.');
            yield { type: 'text', delta: 'Done.', done: false };
            yield { type: 'text', delta: '', done: true };
            yield { type: 'done', result: 'Done.' };
        });
        const [first, second] = thoughts(items);

        expect(first.durationMs).toBeGreaterThanOrEqual(70);
        expect(first.durationMs).toBeLessThan(280);
        // Dated from the call before it, not from the first thought.
        expect(second.durationMs).toBeGreaterThanOrEqual(110);
        expect(second.durationMs).toBeLessThan(400);
    });

    test('is trimmed of the line breaks the agents pad it with', async () => {
        const items = await setup(async function* () {
            yield { type: 'session', sessionId: 's1' };
            yield* think('\n\n', '**Checking the current directory**');
            yield* think('The user wants a number', '.\n\n');
            yield { type: 'done' };
        });

        expect(thoughts(items).map(thought => thought.text)).toEqual([
            '**Checking the current directory**',
            'The user wants a number.',
        ]);
    });
});
