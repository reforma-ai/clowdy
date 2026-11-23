import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { executeCommandAsync } from '../src/commands';
import { listChildChats } from '../src/db/chats';
import { itemRef } from '../src/db/items';
import { getRunWork, setRunWork } from '../src/db/runs';
import { appendItem } from '../src/domain/items';
import { EngineFailure } from '../src/errors';
import { forkTitle } from '../src/runs/fork';
import {
    cleanTempDirs,
    command,
    latch,
    restartHarness,
    ScriptEngine,
    scriptEngines,
    startHarness,
    tempDir,
    waitFor,
} from './helpers';

import type { Attachment, Chat, CommandResult, Project, StreamItem } from '@clowdy/protocol';
import type { AgentEngine, EngineEvent } from '../src/engine/types';
import type { Harness, Script } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

/** A message the agent says whole and ends, with its id when it gives one. */
const say = (text: string, messageId?: string): EngineEvent[] => [
    { type: 'text', delta: text, done: false },
    { type: 'text', delta: '', done: true, ...(messageId !== undefined && { messageId }) },
];

/** A turn that says one message named `m<turn>` and ends, on the session the run holds (a fork's, once it is one). */
const answering: Script = async function* ({ number, options }) {
    yield { type: 'session', sessionId: options.resumeSessionId ?? 's1' };
    yield* say(`answer ${number}`, `m${number}`);
    yield { type: 'done', result: `answer ${number}` };
};

/** A chat of the harness's (`create` adds to what it is made with), with what a test does to it: send, read the stream as a client does, and run a whole turn. */
function chatOf(
    h: Harness,
    engine: ScriptEngine,
    projectId: string,
    agent: string,
    create: Record<string, unknown> = {}
) {
    const { chat } = h.ok('chat.create', { projectId, engine: agent, ...create }) as { chat: Chat };
    const send = (text: string, extra: Record<string, unknown> = {}) =>
        h.ok('chat.send', { chatId: chat.id, text, ...extra }) as { runId: string };
    const read = async (chatId = chat.id) =>
        (await (await h.fetch(`/v1/chats/${chatId}/items`)).json()) as StreamItem[];
    const turn = async (text: string, extra: Record<string, unknown> = {}) => {
        const turns = engine.turns.length;
        const { runId } = send(text, extra);

        await waitFor(
            () => engine.turns.length === turns + 1 && h.run(runId).status === 'succeeded',
            `the turn of "${text}" to end`
        );

        return runId;
    };

    return { chat, send, read, turn };
}

/** `agent`: the agent the chat is made for; `claude` is one that names its chats, which the title tests need. */
async function setup(script: Script = answering, agent = 'fake') {
    const engine = new ScriptEngine(script);

    engine.canFork = true;

    const engines = scriptEngines(engine).set(agent, engine);
    const h = await startHarness({}, { engines });

    harnesses.push(h);

    const project = h.openRepo();

    return { h, engine, engines, project, ...chatOf(h, engine, project.id, agent) };
}

const fork = (h: Harness, chatId: string, itemId: string) => h.sendAsync('chat.fork', { chatId, itemId });
const forked = async (h: Harness, chatId: string, itemId: string): Promise<Chat> =>
    ((await h.okAsync('chat.fork', { chatId, itemId })) as { chat: Chat }).chat;

/** The items a run holds, through the store. */
const itemsOf = (h: Harness, runId: string) =>
    (
        h.store.db.query('SELECT * FROM stream_items WHERE run_id = ? ORDER BY seq').all(runId) as {
            id: string;
            seq: number;
            at: number;
            body: string;
        }[]
    ).map(row => ({ ...row, body: JSON.parse(row.body) as StreamItem['body'] }));

const chatRow = (h: Harness, chatId: string) =>
    h.store.db.query('SELECT * FROM chats WHERE id = ?').get(chatId) as Record<string, unknown> | null;
const count = (h: Harness, table: string) =>
    (h.store.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const errorOf = (result: CommandResult) => (result.ok ? undefined : result.error.code);
const attachmentFolders = (h: Harness) =>
    existsSync(join(h.config.dataDir, 'attachments')) ? readdirSync(join(h.config.dataDir, 'attachments')).sort() : [];

describe('the title of a fork', () => {
    test('counts the forks a title has been through, and a chat with no title of its own keeps none', () => {
        expect(forkTitle('foo')).toBe('(1) foo');
        expect(forkTitle('(1) foo')).toBe('(2) foo');
        expect(forkTitle('(9) foo bar')).toBe('(10) foo bar');
        expect(forkTitle('  (1) foo  ')).toBe('(2) foo');
        // Only a number in parentheses, a space and a title count as a fork's number.
        expect(forkTitle('(1)foo')).toBe('(1) (1)foo');
        expect(forkTitle('(x) foo')).toBe('(1) (x) foo');
        expect(forkTitle('')).toBe('New chat');
        expect(forkTitle('   ')).toBe('New chat');
        expect(forkTitle('New chat')).toBe('New chat');
    });
});

describe('chat.fork', () => {
    test('makes a chat of the same project, agent and mode with the history through the answer, and says where it came from', async () => {
        const { h, engine, project, chat, turn, read } = await setup();
        const runId = await turn('foo');

        await turn('Second question');

        const source = await read();
        const result = await h.sendAsync('chat.fork', { chatId: chat.id, itemId: source[1].id });

        expect(result.ok).toBe(true);

        const { chat: made } = (result as Extract<CommandResult, { ok: true }>).data as { chat: Chat };

        expect(made).toMatchObject({
            projectId: project.id,
            title: '(1) foo',
            mode: 'autopilot',
            engine: 'fake',
            forkedFrom: { chatId: chat.id, atSeq: 2 },
        });
        // Not a thread, nothing queued, a run of its own.
        expect(made.parentChatId).toBeUndefined();
        expect(made.queue).toBeUndefined();
        expect(made.orchestratorRunId).toBeDefined();
        expect(made.orchestratorRunId).not.toBe(runId);
        expect(listChildChats(h.store.db, chat.id)).toEqual([]);

        // The agent was asked for the copy once, at the answer's point, in the folder and with what a turn of the run is opened with.
        expect(engine.forked).toHaveLength(1);
        expect(engine.forked[0]).toMatchObject({
            sessionId: 's1',
            ref: 'm1',
            cwd: project.path,
            additionalDirectories: [],
        });
        expect(engine.forked[0].systemPrompt).toContain('orchestrator');
        expect(engine.forked[0].systemPrompt).not.toContain('thread of');
        expect(engine.forked[0].tools?.map(tool => tool.name)).toContain('task_get');

        // The run rests like one whose turn ended, holding the copy's session, with nothing spent.
        const run = h.run(made.orchestratorRunId as string);

        expect(run).toMatchObject({
            role: 'orchestrator',
            status: 'succeeded',
            chatId: made.id,
            rootRunId: run.id,
            sessionId: 's1-fork-1',
            engine: 'fake',
            result: 'answer 1',
        });
        expect(run.parentRunId).toBeUndefined();
        expect(run.usage).toBeUndefined();
        expect(run.error).toBeUndefined();

        // The history is a copy: new ids, the same numbers, words and times, and the answer's rewind point.
        const copied = itemsOf(h, run.id);
        const original = itemsOf(h, runId).slice(0, 2);

        expect(copied.map(item => [item.seq, item.body.kind])).toEqual([
            [1, 'user'],
            [2, 'assistant'],
        ]);
        expect(copied.map(item => item.body)).toEqual(original.map(item => item.body));
        expect(copied.map(item => item.at)).toEqual(original.map(item => item.at));
        expect(copied.some(item => original.some(other => other.id === item.id))).toBe(false);
        expect(itemRef(h.store.db, run.id, 2)).toBe('m1');

        // A client reads it as an inherited conversation: the answer can be forked again, and the first message edited.
        expect((await read(made.id)).map(item => [item.body.kind, item.canFork, item.canEdit])).toEqual([
            ['user', undefined, true],
            ['assistant', true, undefined],
        ]);

        // The source is as it was.
        expect(itemsOf(h, runId)).toHaveLength(4);
        expect(h.run(runId)).toMatchObject({ status: 'succeeded', sessionId: 's1' });
        expect(chatRow(h, chat.id)).toMatchObject({ title: 'foo', source_chat_id: null });
    });

    test('is announced as a run and a chat and nothing else: the copied items are read when the chat is opened', async () => {
        const { h, chat, turn, read } = await setup();

        await turn('foo');

        const after = h.store.headCursor();
        const made = await forked(h, chat.id, (await read())[1].id);
        const events = h.events(after).map(event => event.data);

        expect(events.map(data => data.type)).toEqual(['run.upserted', 'chat.upserted']);
        expect(events[1]).toMatchObject({
            chat: { id: made.id, forkedFrom: { chatId: chat.id, atSeq: 2 }, orchestratorRunId: made.orchestratorRunId },
        });
    });

    test('is a command over HTTP like the others, and a repeat of its request id answers the first result without a second fork', async () => {
        const { h, engine, chat, turn, read } = await setup();

        await turn('foo');

        const body = JSON.stringify(command('chat.fork', { chatId: chat.id, itemId: (await read())[1].id }));
        const post = async () =>
            (await (await h.fetch('/v1/commands', { method: 'POST', body })).json()) as CommandResult;
        const first = await post();
        const again = await post();

        expect(first.ok).toBe(true);
        expect(again).toEqual(first);
        expect(engine.forked).toHaveLength(1);
        expect(count(h, 'chats')).toBe(2);
    });

    test('the synchronous executor refuses it, since the agent must be waited for', async () => {
        const { h, chat, turn, read } = await setup();

        await turn('foo');

        const result = h.send('chat.fork', { chatId: chat.id, itemId: (await read())[1].id });

        expect(result).toMatchObject({
            ok: false,
            error: { code: 'internal', message: expect.stringContaining('executeCommandAsync') },
        });
        expect(count(h, 'chats')).toBe(1);
    });

    test('a repeat that comes while the first still waits for the agent waits for it too', async () => {
        const gate = latch();
        const { h, engine, chat, turn, read } = await setup();

        await turn('foo');

        engine.forkAnswer = async options => {
            await gate.wait();

            return { sessionId: `${options.sessionId}-copy` };
        };

        const message = command('chat.fork', { chatId: chat.id, itemId: (await read())[1].id });
        const first = executeCommandAsync(h.daemon.services, message);
        const again = executeCommandAsync(h.daemon.services, message);

        await waitFor(() => engine.forked.length === 1, 'the fork to start');
        gate.release();

        const results = await Promise.all([first, again]);

        expect(results[0].ok).toBe(true);
        expect(results[1]).toEqual(results[0]);
        expect(engine.forked).toHaveLength(1);
        expect(count(h, 'chats')).toBe(2);
    });

    test('forks a fork at an answer it inherited: the points of the copied items are the ones the copied session knows', async () => {
        const { h, engine, chat, turn, read } = await setup();

        await turn('foo');
        await turn('bar');

        const one = await forked(h, chat.id, (await read())[1].id);
        const two = await forked(h, one.id, (await read(one.id))[1].id);

        // The agent was asked for the copy of the copy: the first copy's session, at the point the first fork kept.
        expect(engine.forked.map(({ sessionId, ref }) => [sessionId, ref])).toEqual([
            ['s1', 'm1'],
            ['s1-fork-1', 'm1'],
        ]);
        expect(two).toMatchObject({ title: '(2) foo', forkedFrom: { chatId: one.id, atSeq: 2 } });
        expect(h.run(two.orchestratorRunId as string).sessionId).toBe('s1-fork-1-fork-2');
        expect((await read(two.id)).map(item => item.body.kind)).toEqual(['user', 'assistant']);
    });

    test('a turn in a fork adds its own items after the inherited ones, with a point of its own to fork at', async () => {
        const { h, engine, chat, turn, read } = await setup();

        await turn('foo');
        await turn('bar');

        const one = await forked(h, chat.id, (await read())[1].id);
        const sent = h.ok('chat.send', { chatId: one.id, text: 'What did I ask?' }) as { runId: string };

        await waitFor(
            () => engine.turns.length === 3 && h.run(sent.runId).status === 'succeeded',
            'the turn in the fork to end'
        );

        const items = await read(one.id);

        expect(items.map(item => [item.seq, item.body.kind, item.canFork === true])).toEqual([
            [1, 'user', false],
            [2, 'assistant', true],
            [3, 'user', false],
            [4, 'assistant', true],
        ]);
        expect(itemRef(h.store.db, sent.runId, 4)).toBe('m3');

        const two = await forked(h, one.id, items[3].id);

        expect(engine.forked.at(-1)).toMatchObject({ sessionId: 's1-fork-1', ref: 'm3' });
        expect(two.forkedFrom).toEqual({ chatId: one.id, atSeq: 4 });
    });

    test('the first message of a fork resumes the copied session with no first-message prefix, and the stream shows it after the history', async () => {
        const { h, engine, chat, turn, read } = await setup();

        await turn('foo');

        const made = await forked(h, chat.id, (await read())[1].id);
        const sent = h.ok('chat.send', { chatId: made.id, text: 'And now?' }) as { runId: string };

        await waitFor(
            () => engine.turns.length === 2 && h.run(sent.runId).status === 'succeeded',
            'the turn in the fork to end'
        );

        expect(engine.turns[0].prompt).toStartWith('Follow clowdy:orchestrate');
        expect(engine.turns[1]).toMatchObject({ prompt: 'And now?', resumeSessionId: 's1-fork-1' });
        expect(
            (await read(made.id)).map(item => (item.body.kind === 'user' ? item.body.text : item.body.kind))
        ).toEqual(['foo', 'assistant', 'And now?', 'assistant']);
        // The same run: a fork has no second orchestrator to make. The relation is still there after a message: the chat is saved again with it.
        expect(sent.runId).toBe(made.orchestratorRunId as string);
        expect(chatRow(h, made.id)).toMatchObject({ source_chat_id: chat.id, forked_at_seq: 2 });
    });

    test("has no queue of the source's: what waits in the source stays there", async () => {
        const gate = latch();
        const { h, engine, chat, send, turn, read } = await setup(async function* ({ number, options }) {
            yield { type: 'session', sessionId: options.resumeSessionId ?? 's1' };
            yield* say(`answer ${number}`, `m${number}`);

            if (number === 2) {
                await gate.wait(options.signal);
            }

            yield { type: 'done', result: `answer ${number}` };
        });

        await turn('foo');

        const second = send('Second');

        await waitFor(() => engine.turns.length === 2, 'the second turn to run');
        send('Queued behind it');
        expect(h.store.db.query('SELECT queue FROM chats WHERE id = ?').get(chat.id)).not.toEqual({ queue: null });

        const made = await forked(h, chat.id, (await read())[1].id);

        expect(made.queue).toBeUndefined();
        expect(chatRow(h, made.id)).toMatchObject({ queue: null });
        expect(chatRow(h, chat.id)).not.toMatchObject({ queue: null });

        gate.release();
        await waitFor(
            () => engine.turns.length === 3 && h.run(second.runId).status === 'succeeded',
            'the queued turn of the source'
        );
    });

    test('keeps the title of a fork of a chat that is named for the first words of its message', async () => {
        const { h, engine, chat, turn, read } = await setup(answering, 'claude');

        await turn('Fix the login form so that the button works');

        const made = await forked(h, chat.id, (await read())[1].id);

        expect(made.title).toBe('(1) Fix the login form so that the button works');
        h.ok('chat.send', { chatId: made.id, text: 'Something else entirely' });
        await waitFor(
            () => engine.turns.length === 2 && h.run(made.orchestratorRunId as string).status === 'succeeded',
            'the turn in the fork'
        );

        expect(engine.turns[1].title).toEqual({ keep: '(1) Fix the login form so that the button works' });
        expect(chatRow(h, made.id)).toMatchObject({ title: '(1) Fix the login form so that the button works' });
    });

    test("is allowed while the source works: the agent copies the answer's session and the running turn goes on untouched", async () => {
        const gate = latch();
        const { h, engine, chat, send, turn, read } = await setup(async function* ({ number, options }) {
            yield { type: 'session', sessionId: options.resumeSessionId ?? 's1' };
            yield* say(`answer ${number}`, `m${number}`);

            if (number === 2) {
                await gate.wait(options.signal);
            }

            yield { type: 'done', result: `answer ${number}` };
        });

        await turn('foo');

        const second = send('bar');

        await waitFor(
            () => engine.turns.length === 2 && h.run(second.runId).status === 'running',
            'the second turn to run'
        );

        const made = await forked(h, chat.id, (await read())[1].id);

        expect(made.forkedFrom).toEqual({ chatId: chat.id, atSeq: 2 });
        expect(h.run(second.runId).status).toBe('running');
        expect(itemsOf(h, made.orchestratorRunId as string)).toHaveLength(2);

        gate.release();
        await waitFor(() => h.run(second.runId).status === 'succeeded', 'the source turn to end');
        expect(itemsOf(h, second.runId).map(item => item.body.kind)).toEqual([
            'user',
            'assistant',
            'user',
            'assistant',
        ]);
        expect(itemsOf(h, made.orchestratorRunId as string)).toHaveLength(2);
    });

    test('works in the folder the source works in, which the new run keeps for the turns after it', async () => {
        const { h, engine, chat, turn, read } = await setup();
        const runId = await turn('foo');
        const elsewhere = h.openRepo('elsewhere');

        setRunWork(h.store.db, runId, { cwd: elsewhere.path });

        const made = await forked(h, chat.id, (await read())[1].id);

        expect(engine.forked[0].cwd).toBe(elsewhere.path);
        expect(getRunWork(h.store.db, made.orchestratorRunId as string).cwd).toBe(elsewhere.path);
    });

    test('a chat that works in a folder of its project forks into a chat of that folder: the agent copies the session there and the next turn resumes it there', async () => {
        const engine = new ScriptEngine(answering);

        engine.canFork = true;

        const h = await startHarness({}, { engines: scriptEngines(engine).set('fake', engine) });

        harnesses.push(h);

        const parent = tempDir();
        const [web, api] = ['web', 'api'].map(name => {
            mkdirSync(join(parent, name));

            return join(parent, name);
        });
        const { project } = h.ok('project.add', { name: 'Shop', folders: [web, api] }) as { project: Project };
        // The project keeps the folders by their real paths, which differ from the temp folder's own on macOS.
        const apiPath = project.folders[1].path;
        const { chat, turn, read } = chatOf(h, engine, project.id, 'fake', { folderId: project.folders[1].id });

        await turn('foo');

        const made = await forked(h, chat.id, (await read())[1].id);

        expect(made.folderId).toBe(project.folders[1].id);
        expect(engine.forked[0].cwd).toBe(apiPath);

        const turns = engine.turns.length;

        h.ok('chat.send', { chatId: made.id, text: 'next' });
        await waitFor(() => engine.turns.length === turns + 1, 'the turn of the fork to start');
        expect(engine.turns[turns]).toMatchObject({ cwd: apiPath, resumeSessionId: 's1-fork-1' });
    });

    test("a thread can be forked, and its fork is a chat of the person's own", async () => {
        const { h, chat, turn, read } = await setup();

        await turn('foo');
        // The source says it is a thread of another chat; the fork does not follow.
        h.store.db.query('UPDATE chats SET parent_chat_id = ? WHERE id = ?').run('cht_parent', chat.id);

        const made = await forked(h, chat.id, (await read())[1].id);

        expect(made.parentChatId).toBeUndefined();
        expect(chatRow(h, made.id)).toMatchObject({ parent_chat_id: null, source_chat_id: chat.id, forked_at_seq: 2 });
    });

    test('the relation survives a rename, a model change, a restart and the snapshot, and is never a parent', async () => {
        const { h, engines, chat, turn, read } = await setup();

        await turn('foo');

        const made = await forked(h, chat.id, (await read())[1].id);

        h.ok('chat.rename', { chatId: made.id, title: 'Renamed' });
        h.ok('chat.setModel', { chatId: made.id, model: 'some-model' });
        await h.stop();

        const restarted = await restartHarness(h, { engines });

        harnesses.push(restarted);

        const snapshot = (await (await restarted.fetch(`/v1/projects/${made.projectId}/snapshot`)).json()) as {
            chats: Chat[];
        };
        const found = snapshot.chats.find(candidate => candidate.id === made.id);

        expect(found).toMatchObject({
            title: 'Renamed',
            model: 'some-model',
            forkedFrom: { chatId: chat.id, atSeq: 2 },
            orchestratorRunId: made.orchestratorRunId,
        });
        expect(found?.parentChatId).toBeUndefined();
    });

    test('lives on when its source is archived or deleted, and goes on taking messages', async () => {
        const { h, engine, chat, turn, read } = await setup();

        await turn('foo');

        const made = await forked(h, chat.id, (await read())[1].id);

        // Archived, the source hides alone: a fork is no thread, and is not archived with it.
        h.ok('chat.setArchived', { chatId: chat.id, archived: true });
        expect(chatRow(h, made.id)).toMatchObject({ archived_at: null });
        h.ok('chat.setArchived', { chatId: chat.id, archived: false });
        h.ok('chat.delete', { chatId: chat.id });

        expect(chatRow(h, chat.id)).toBeNull();
        // The relation names a chat that is gone: nothing deletes the fork, and its history is its own.
        expect(chatRow(h, made.id)).toMatchObject({ source_chat_id: chat.id, forked_at_seq: 2 });
        expect((await read(made.id)).map(item => item.body.kind)).toEqual(['user', 'assistant']);

        h.ok('chat.send', { chatId: made.id, text: 'Still here?' });
        await waitFor(
            () => engine.turns.length === 2 && h.run(made.orchestratorRunId as string).status === 'succeeded',
            'the turn in the fork'
        );
        expect(engine.turns[1].resumeSessionId).toBe('s1-fork-1');
        expect((await read(made.id)).map(item => item.body.kind)).toEqual(['user', 'assistant', 'user', 'assistant']);
    });

    test('a fork of an archived chat is not archived', async () => {
        const { h, chat, turn, read } = await setup();

        await turn('foo');

        const itemId = (await read())[1].id;

        h.ok('chat.setArchived', { chatId: chat.id, archived: true });

        expect((await forked(h, chat.id, itemId)).archivedAt).toBeUndefined();
    });

    test('does not copy the runs of native sub-agents: the card of their call stays in the history, with no child to open', async () => {
        const { h, chat, turn, read } = await setup(async function* ({ number, options }) {
            yield { type: 'session', sessionId: options.resumeSessionId ?? 's1' };
            yield {
                type: 'tool',
                toolCallId: 'call-agent',
                name: 'Agent',
                input: { subagent_type: 'Explore' },
                state: 'running',
            };
            yield {
                type: 'subagent',
                agentId: 'a1',
                name: 'Explore',
                state: 'running',
                parentToolCallId: 'call-agent',
            };
            yield { type: 'text', delta: 'Looking', done: false, agentId: 'a1' };
            yield { type: 'text', delta: '', done: true, agentId: 'a1' };
            yield {
                type: 'subagent',
                agentId: 'a1',
                name: 'Explore',
                state: 'done',
                summary: 'Looking',
                parentToolCallId: 'call-agent',
            };
            yield {
                type: 'tool',
                toolCallId: 'call-agent',
                name: 'Agent',
                input: { subagent_type: 'Explore' },
                state: 'done',
                output: 'Looking',
            };
            yield* say(`answer ${number}`, `m${number}`);
            yield { type: 'done', result: `answer ${number}` };
        });
        const runId = await turn('foo');
        const made = await forked(h, chat.id, (await read()).at(-1)?.id as string);
        const newRun = made.orchestratorRunId as string;

        expect(h.store.db.query('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = ?').get(runId)).toEqual({ n: 1 });
        expect(h.store.db.query('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = ?').get(newRun)).toEqual({
            n: 0,
        });
        expect(itemsOf(h, newRun).map(item => item.body.kind)).toEqual(['user', 'tool', 'assistant']);
        expect(itemsOf(h, newRun)[1].body).toMatchObject({
            kind: 'tool',
            name: 'Agent',
            toolCallId: 'call-agent',
            state: 'done',
        });
    });

    test('shows a call that was still running in the source as stopped: the fork has no process to finish it', async () => {
        const { h, chat, turn, read } = await setup();
        const runId = await turn('foo');

        appendItem(h.store, runId, {
            kind: 'tool',
            toolCallId: 'bg',
            name: 'Bash',
            input: { command: 'sleep 99' },
            state: 'running',
        });
        await turn('bar');

        const made = await forked(h, chat.id, (await read()).at(-1)?.id as string);
        const copied = itemsOf(h, made.orchestratorRunId as string);

        expect(copied.map(item => item.body.kind)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant']);
        expect(copied[2].body).toMatchObject({ kind: 'tool', state: 'error', error: 'Stopped before it finished' });
        // The source's own call is untouched.
        expect(itemsOf(h, runId)[2].body).toMatchObject({ kind: 'tool', state: 'running' });
    });
});

describe('chat.fork refusals', () => {
    test('a chat that does not exist, an item that is not in the chat, and a chat with no conversation', async () => {
        const { h, project, engine, chat, turn } = await setup();

        expect(errorOf(await fork(h, 'cht_nope', 'itm_x'))).toBe('not_found');

        const idle = h.ok('chat.create', { projectId: project.id, engine: 'fake' }).chat as Chat;

        expect(errorOf(await fork(h, idle.id, 'itm_x'))).toBe('invalid');

        await turn('foo');
        expect(errorOf(await fork(h, chat.id, 'itm_nope'))).toBe('not_found');

        // An item of another chat's stream is not an item of this one.
        const other = chatOf(h, engine, project.id, 'fake');

        await other.turn('elsewhere');
        expect(errorOf(await fork(h, chat.id, (await other.read())[1].id))).toBe('not_found');
        expect(engine.forked).toEqual([]);
    });

    test("an item that is not a final answer with a point: a message of the person's, an answer with no id, a tool call", async () => {
        const { h, engine, chat, turn, read } = await setup(async function* ({ number, options }) {
            yield { type: 'session', sessionId: options.resumeSessionId ?? 's1' };
            yield { type: 'tool', toolCallId: `c${number}`, name: 'Bash', input: {}, state: 'done', output: 'ok' };
            // The second turn's answer has no id, so no point.
            yield* say(`answer ${number}`, number === 1 ? 'm1' : undefined);
            yield { type: 'done', result: `answer ${number}` };
        });

        await turn('foo');
        await turn('bar');

        const items = await read();

        expect(items.map(item => item.body.kind)).toEqual(['user', 'tool', 'assistant', 'user', 'tool', 'assistant']);

        for (const index of [0, 1, 3, 4, 5]) {
            expect([index, errorOf(await fork(h, chat.id, items[index].id))]).toEqual([index, 'invalid']);
        }

        expect(engine.forked).toEqual([]);
        expect(errorOf(await fork(h, chat.id, items[2].id))).toBeUndefined();
        expect(engine.forked).toHaveLength(1);
    });

    test('an agent that cannot fork: not flagged, or flagged with no fork to call', async () => {
        const { h, engine, chat, turn, read } = await setup();

        await turn('foo');

        const itemId = (await read())[1].id;

        engine.canFork = false;
        expect(errorOf(await fork(h, chat.id, itemId))).toBe('invalid');
        expect(engine.forked).toEqual([]);
        expect(count(h, 'chats')).toBe(1);

        // The engine says it can and has nothing to do it with: the refusal comes from the runtime, and nothing is made.
        engine.canFork = true;

        const bare: AgentEngine = { id: 'fake', canFork: true, start: options => engine.start(options) };
        const other = await startHarness({}, { engines: scriptEngines(bare) });

        harnesses.push(other);

        const mine = chatOf(other, engine, other.openRepo().id, 'fake');

        await mine.turn('foo');

        const result = await fork(other, mine.chat.id, (await mine.read())[1].id);

        expect(errorOf(result)).toBe('unavailable');
        expect(count(other, 'chats')).toBe(1);
    });

    test('a chat whose run holds no session', async () => {
        const { h, chat, turn, read } = await setup();
        const runId = await turn('foo');

        h.store.db.query('UPDATE runs SET session_id = NULL WHERE id = ?').run(runId);

        expect(errorOf(await fork(h, chat.id, (await read())[1].id))).toBe('invalid');
    });

    test('an agent that is switched off in Clowdy', async () => {
        const { h, engine, chat, turn, read } = await setup(answering, 'claude');

        await turn('foo');
        h.ok('agent.update', { id: 'claude', enabled: false });

        const result = await fork(h, chat.id, (await read())[1].id);

        expect(errorOf(result)).toBe('unavailable');
        expect(result.ok ? '' : result.error.message).toContain('switched off');
        expect(engine.forked).toEqual([]);
    });

    test('a failed fork of the agent creates nothing: no chat, run, item, file or event, and a retry with a new request can work', async () => {
        const { h, engine, project, chat, send, turn, read } = await setup();

        await turn('foo');

        const file = (await (
            await h.fetch(`/v1/projects/${project.id}/attachments?name=a.txt`, {
                method: 'POST',
                body: new Uint8Array(4).fill(7),
            })
        ).json()) as Attachment;
        const second = send('with a file', { attachmentIds: [file.id] });

        await waitFor(() => engine.turns.length === 2 && h.run(second.runId).status === 'succeeded', 'the second turn');

        const itemId = (await read())[3].id;
        const tables = () => ({
            chats: count(h, 'chats'),
            runs: count(h, 'runs'),
            items: count(h, 'stream_items'),
            files: count(h, 'attachments'),
            folders: attachmentFolders(h),
        });
        const before = tables();
        const cursor = h.store.headCursor();
        let failures = 0;

        engine.forkAnswer = options => {
            if (failures++ === 0) {
                throw new EngineFailure('The adapter fell over.');
            }

            return { sessionId: `${options.sessionId}-retry` };
        };

        expect(await fork(h, chat.id, itemId)).toMatchObject({
            ok: false,
            error: { code: 'unavailable', message: "Couldn't fork the conversation: The adapter fell over" },
        });
        expect(tables()).toEqual(before);
        expect(h.events(cursor)).toEqual([]);

        expect(errorOf(await fork(h, chat.id, itemId))).toBeUndefined();
        expect(tables()).toMatchObject({ chats: before.chats + 1, runs: before.runs + 1, files: before.files + 1 });
    });

    test('a source that is deleted while the agent copies its session leaves nothing behind', async () => {
        const gate = latch();
        const { h, engine, chat, turn, read } = await setup();

        await turn('foo');

        const itemId = (await read())[1].id;

        engine.forkAnswer = async options => {
            await gate.wait();

            return { sessionId: `${options.sessionId}-copy` };
        };

        const pending = fork(h, chat.id, itemId);

        await waitFor(() => engine.forked.length === 1, 'the fork to start');
        h.ok('chat.delete', { chatId: chat.id });
        gate.release();

        expect(errorOf(await pending)).toBe('not_found');
        expect([count(h, 'chats'), count(h, 'runs'), count(h, 'stream_items')]).toEqual([0, 0, 0]);
    });

    test('a source whose stream is cut while the agent copies its session is a conflict that creates nothing', async () => {
        const gate = latch();
        const { h, engine, chat, turn, read } = await setup();
        const runId = await turn('foo');
        const itemId = (await read())[1].id;

        engine.forkAnswer = async options => {
            await gate.wait();

            return { sessionId: `${options.sessionId}-copy` };
        };

        const pending = fork(h, chat.id, itemId);

        await waitFor(() => engine.forked.length === 1, 'the fork to start');
        h.store.db.query('DELETE FROM stream_items WHERE run_id = ? AND seq >= 2').run(runId);
        gate.release();

        expect(errorOf(await pending)).toBe('conflict');
        expect([count(h, 'chats'), count(h, 'runs'), count(h, 'stream_items')]).toEqual([1, 1, 1]);
    });

    test('a failure of the agent is remembered for its request id, an unexpected one is not', async () => {
        const { h, engine, chat, turn, read } = await setup();

        await turn('foo');

        const itemId = (await read())[1].id;
        const failures = [new EngineFailure('The adapter fell over.'), new Error('boom')];

        engine.forkAnswer = options => {
            const failure = failures.shift();

            if (failure) {
                throw failure;
            }

            return { sessionId: `${options.sessionId}-ok` };
        };

        const asked = command('chat.fork', { chatId: chat.id, itemId });
        const crashed = command('chat.fork', { chatId: chat.id, itemId });
        // The daemon logs an unexpected failure; this one is the point of the test.
        const logged = spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            expect(errorOf(await executeCommandAsync(h.daemon.services, asked))).toBe('unavailable');
            // A repeat answers the same refusal without asking the agent again.
            expect(errorOf(await executeCommandAsync(h.daemon.services, asked))).toBe('unavailable');
            expect(engine.forked).toHaveLength(1);

            expect(errorOf(await executeCommandAsync(h.daemon.services, crashed))).toBe('internal');
            // Not remembered: the same request id is run again, and this time works.
            expect((await executeCommandAsync(h.daemon.services, crashed)).ok).toBe(true);
            expect(engine.forked).toHaveLength(3);
            expect(count(h, 'chats')).toBe(2);
        } finally {
            logged.mockRestore();
        }
    });
});

describe('the files of a fork', () => {
    /** A chat whose first message carries one file and whose answer can be forked. */
    async function withFile() {
        const base = await setup();
        const { h, project } = base;
        const response = await h.fetch(`/v1/projects/${project.id}/attachments?name=notes.txt`, {
            method: 'POST',
            body: new TextEncoder().encode('the notes'),
            headers: { 'content-type': 'text/plain' },
        });
        const file = (await response.json()) as Attachment;
        const runId = await base.turn('read this', { attachmentIds: [file.id] });

        return { ...base, file, runId, answer: (await base.read())[1] };
    }

    const served = async (h: Harness, projectId: string, file: Attachment) => {
        const response = await h.fetch(`/v1/projects/${projectId}/attachments/${file.id}`);

        return { status: response.status, text: response.status === 200 ? await response.text() : '' };
    };
    const filesOf = (h: Harness, runId: string) =>
        (itemsOf(h, runId)[0].body as { attachments: Attachment[] }).attachments;

    test('are copies of their own: new ids, the same name and bytes, sent with the new chat and run', async () => {
        const { h, project, chat, file, runId, answer } = await withFile();
        const made = await forked(h, chat.id, answer.id);
        const [copy] = filesOf(h, made.orchestratorRunId as string);

        expect(copy).toMatchObject({ name: 'notes.txt', mediaType: 'text/plain', size: file.size });
        expect(copy.id).not.toBe(file.id);
        expect(await served(h, project.id, copy)).toEqual({ status: 200, text: 'the notes' });
        expect(
            h.store.db.query('SELECT chat_id, run_id, project_id FROM attachments WHERE id = ?').get(copy.id)
        ).toEqual({ chat_id: made.id, run_id: made.orchestratorRunId, project_id: project.id });
        // The source's own is where it was, and its message still names it.
        expect(h.store.db.query('SELECT chat_id, run_id FROM attachments WHERE id = ?').get(file.id)).toEqual({
            chat_id: chat.id,
            run_id: runId,
        });
        expect(filesOf(h, runId)).toEqual([file]);
        expect(count(h, 'attachments')).toBe(2);
    });

    test('deleting the source takes only its own bytes, and deleting the fork takes only the copy', async () => {
        const { h, project, chat, file, answer } = await withFile();
        const made = await forked(h, chat.id, answer.id);
        const [copy] = filesOf(h, made.orchestratorRunId as string);

        h.ok('chat.delete', { chatId: chat.id });

        expect(await served(h, project.id, file)).toMatchObject({ status: 404 });
        expect(existsSync(join(h.config.dataDir, 'attachments', file.id))).toBe(false);
        expect(await served(h, project.id, copy)).toEqual({ status: 200, text: 'the notes' });
        expect(count(h, 'attachments')).toBe(1);

        // A fork of the fork has a copy of its own, which outlives the fork it came from.
        const third = await forked(
            h,
            made.id,
            ((await (await h.fetch(`/v1/chats/${made.id}/items`)).json()) as StreamItem[])[1].id
        );
        const [last] = filesOf(h, third.orchestratorRunId as string);

        h.ok('chat.delete', { chatId: made.id });

        expect(await served(h, project.id, copy)).toMatchObject({ status: 404 });
        expect(await served(h, project.id, last)).toEqual({ status: 200, text: 'the notes' });
    });

    test('a file whose bytes are gone from the source is left as the message had it, and the fork is still made', async () => {
        const { h, project, chat, file, answer } = await withFile();

        rmSync(join(h.config.dataDir, 'attachments', file.id), { recursive: true });

        const made = await forked(h, chat.id, answer.id);

        expect(filesOf(h, made.orchestratorRunId as string)).toEqual([file]);
        expect(count(h, 'attachments')).toBe(1);
        expect(await served(h, project.id, file)).toMatchObject({ status: 404 });
    });

    test('the copies are removed again when the fork cannot be completed', async () => {
        const { h, chat, answer } = await withFile();
        const before = attachmentFolders(h);

        // The copy of the answer fails after the files were copied.
        h.store.db.run(
            "CREATE TRIGGER no_forks BEFORE INSERT ON stream_items WHEN NEW.provider_ref IS NOT NULL BEGIN SELECT RAISE(ABORT, 'no forks today'); END"
        );

        // The daemon logs an unexpected failure; this one is the point of the test.
        const logged = spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            expect(errorOf(await fork(h, chat.id, answer.id))).toBe('internal');
        } finally {
            logged.mockRestore();
        }

        expect(attachmentFolders(h)).toEqual(before);
        expect([count(h, 'attachments'), count(h, 'chats'), count(h, 'runs')]).toEqual([1, 1, 1]);
    });
});
