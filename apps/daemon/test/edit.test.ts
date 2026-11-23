import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { executeCommandAsync } from '../src/commands';
import { getChatLastRun } from '../src/db/chats';
import { getRunWork } from '../src/db/runs';
import { appendItem } from '../src/domain/items';
import { EngineFailure } from '../src/errors';
import { cleanTempDirs, command, latch, ScriptEngine, scriptEngines, startHarness, waitFor } from './helpers';

import type { Attachment, Chat, CommandResult, StreamItem } from '@clowdy/protocol';
import type { EngineEvent } from '../src/engine/types';
import type { Harness, Script } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

/** A message the agent says whole and ends, with its id when it gives one. */
const say = (text: string, messageId?: string): EngineEvent[] => [{ type: 'text', delta: text, done: false }, { type: 'text', delta: '', done: true, ...(messageId !== undefined && { messageId }) }];

/**
 * A turn that starts a sub-agent through a call of its own, says one message `m<turn>` and ends, on the session the run holds (a fresh session is
 * `s<turn>`). A gate registered for a turn holds it open after its answer, so a test sees the chat while the turn runs.
 */
function scripted(gates: Map<number, ReturnType<typeof latch>> = new Map()): Script {
    return async function* ({ number, options }) {
        const call = `call-${ number }`;

        yield { type: 'session', sessionId: options.resumeSessionId ?? `s${ number }` };
        yield { type: 'tool', toolCallId: call, name: 'Agent', input: { subagent_type: 'Explore' }, state: 'running' };
        yield { type: 'subagent', agentId: `a${ number }`, name: 'Explore', state: 'running', parentToolCallId: call };
        yield { type: 'text', delta: 'Looking', done: false, agentId: `a${ number }` };
        yield { type: 'text', delta: '', done: true, agentId: `a${ number }` };
        yield { type: 'subagent', agentId: `a${ number }`, name: 'Explore', state: 'done', summary: 'Looking', parentToolCallId: call };
        yield { type: 'tool', toolCallId: call, name: 'Agent', input: { subagent_type: 'Explore' }, state: 'done', output: 'Looking' };
        yield* say(`answer ${ number }`, `m${ number }`);
        await gates.get(number)?.wait(options.signal);
        yield { type: 'done', result: `answer ${ number }` };
    };
}

/** A daemon with an agent that can fork, and a chat of it with what a test does to it. */
async function setup(script: Script = scripted(), agent = 'fake') {
    const engine = new ScriptEngine(script);

    engine.canFork = true;

    const engines = scriptEngines(engine).set(agent, engine);
    const h = await startHarness({}, { engines });

    harnesses.push(h);

    const project = h.openRepo();

    return { h, engine, engines, agent, project, ...chatOf(h, engine, project.id, agent) };
}

function chatOf(h: Harness, engine: ScriptEngine, projectId: string, agent: string) {
    const { chat } = h.ok('chat.create', { projectId, engine: agent }) as { chat: Chat };
    const send = (text: string, extra: Record<string, unknown> = {}) => h.ok('chat.send', { chatId: chat.id, text, ...extra }) as { runId: string };
    const read = async () => await (await h.fetch(`/v1/chats/${ chat.id }/items`)).json() as StreamItem[];
    const turn = async (text: string, extra: Record<string, unknown> = {}) => {
        const turns = engine.turns.length;
        const { runId } = send(text, extra);

        await waitFor(() => engine.turns.length === turns + 1 && h.run(runId).status === 'succeeded', `the turn of "${ text }" to end`);

        return runId;
    };

    return { chat, send, read, turn };
}

const edit = (h: Harness, chatId: string, itemId: string, text: string, extra: Record<string, unknown> = {}) => h.sendAsync('chat.edit', { chatId, itemId, text, ...extra });
const errorOf = (result: CommandResult) => result.ok ? undefined : result.error.code;
const count = (h: Harness, table: string) => (h.store.db.query(`SELECT COUNT(*) AS n FROM ${ table }`).get() as { n: number }).n;
const attachmentFolders = (h: Harness) => existsSync(join(h.config.dataDir, 'attachments')) ? readdirSync(join(h.config.dataDir, 'attachments')).sort() : [];
const textOf = (item: StreamItem) => item.body.kind === 'user' || item.body.kind === 'assistant' ? item.body.text : item.body.kind;
const upload = async (h: Harness, projectId: string, name: string) => await (await h.fetch(`/v1/projects/${ projectId }/attachments?name=${ name }`, { method: 'POST', body: new TextEncoder().encode(name) })).json() as Attachment;
const rowsOf = (h: Harness, runId: string) => (h.store.db.query('SELECT seq, provider_ref FROM stream_items WHERE run_id = ? ORDER BY seq').all(runId) as { seq: number; provider_ref: string | null }[]);
const callsOf = (h: Harness, runId: string) => (h.store.db.query('SELECT parent_tool_call_id AS call FROM runs WHERE parent_run_id = ? ORDER BY created_at, id').all(runId) as { call: string | null }[]).map(row => row.call);
const setStatus = (h: Harness, runId: string, status: string, reason: string | null = null) => h.store.db.query('UPDATE runs SET status = ?, status_reason = ? WHERE id = ?').run(status, reason, runId);

/** What a refused command must leave as it was: the tables an edit writes, the files, the orchestrator's row and the event log. */
const state = (h: Harness) => ({
    chats: count(h, 'chats'),
    runs: count(h, 'runs'),
    items: count(h, 'stream_items'),
    files: count(h, 'attachments'),
    folders: attachmentFolders(h),
    rows: h.store.db.query('SELECT * FROM runs ORDER BY created_at, id').all(),
    queue: h.store.db.query('SELECT queue, queue_paused FROM chats ORDER BY created_at, id').all(),
    cursor: h.store.headCursor(),
});

/** Three turns, each with a sub-agent: items 1 to 3, 4 to 6 and 7 to 9. */
async function threeTurns(gates?: Map<number, ReturnType<typeof latch>>) {
    const base = await setup(scripted(gates));
    const runId = await base.turn('one');

    await base.turn('two');
    await base.turn('three');

    return { ...base, runId, items: await base.read() };
}

describe('chat.edit', () => {
    test('rewrites the chat from a message in the middle: the suffix and its sub-agents go, the new turn runs on the copy of the session cut before the message', async () => {
        const { h, engine, chat, runId, items, read } = await threeTurns();

        expect(items.map(item => [item.seq, item.body.kind])).toEqual([[1, 'user'], [2, 'tool'], [3, 'assistant'], [4, 'user'], [5, 'tool'], [6, 'assistant'], [7, 'user'], [8, 'tool'], [9, 'assistant']]);
        expect(items.flatMap(item => item.canEdit ? [item.seq] : [])).toEqual([1, 4, 7]);
        expect(callsOf(h, runId)).toEqual(['call-1', 'call-2', 'call-3']);

        const result = await edit(h, chat.id, items[3].id, '  two, again  ');

        expect(result).toMatchObject({ ok: true, data: { chatId: chat.id, runId } });

        // The agent copied the session the run holds, at the point of the turn before the message.
        expect(engine.forked).toHaveLength(1);
        expect(engine.forked[0]).toMatchObject({ sessionId: 's1', ref: 'm1' });

        await waitFor(() => engine.turns.length === 4 && h.run(runId).status === 'succeeded', 'the new turn to end');

        // An ordinary turn: the new text and no first-message prefix, on the copy.
        expect(engine.turns[3]).toMatchObject({ prompt: 'two, again', resumeSessionId: 's1-fork-1' });
        expect(h.run(runId).sessionId).toBe('s1-fork-1');

        const after = await read();

        expect(after.map(item => [item.seq, textOf(item)])).toEqual([[1, 'one'], [2, 'tool'], [3, 'answer 1'], [4, 'two, again'], [5, 'tool'], [6, 'answer 4']]);
        // The new message takes the number of the old one under a new id, and stands for a turn again: it can be edited, and its answer forked.
        expect(after[3].id).not.toBe(items[3].id);
        expect(after.flatMap(item => item.canEdit ? [item.seq] : [])).toEqual([1, 4]);
        expect(after.flatMap(item => item.canFork ? [item.seq] : [])).toEqual([3, 6]);
        expect(rowsOf(h, runId).flatMap(row => row.provider_ref !== null ? [[row.seq, row.provider_ref]] : [])).toEqual([[3, 'm1'], [6, 'm4']]);
        // The sub-agent of the first turn is still there; those of the dropped turns are gone, and the new turn has its own.
        expect(callsOf(h, runId)).toEqual(['call-1', 'call-4']);
    });

    test('takes away the last run of the chat when the cut reaches the turn it describes, and the turn that follows measures its own', async () => {
        const writing: Script = async function* (turn) {
            // The daemon takes the tree of the place while the agent starts, which a real agent takes seconds over.
            await Bun.sleep(400);
            writeFileSync(join(turn.options.cwd, `by-turn-${ turn.number }.txt`), `turn ${ turn.number }\n`);
            yield* scripted()(turn);
        };
        const { h, chat, turn, read } = await setup(writing);

        await turn('one');
        await turn('two');

        const items = await read();
        const lastRun = () => getChatLastRun(h.store.db, chat.id);
        const before = lastRun();

        expect(before).toMatchObject({ seq: 6 });

        // A cut at the second message takes the second turn away: its record goes with it, and the chat is published without it.
        const cursor = h.events().at(-1)?.cursor ?? 0;

        expect(await edit(h, chat.id, items[3].id, 'two, again')).toMatchObject({ ok: true });

        const published = h.events(cursor).flatMap(event => (event.data.type === 'chat.upserted' && event.data.chat.id === chat.id ? [event.data.chat.lastRun] : []));

        expect(published[0]).toBeUndefined();
        // The edited turn writes a file of its own, and its record replaces the one that went.
        await waitFor(() => lastRun() !== undefined && lastRun()?.at !== before?.at, 'the edited turn to be measured');
        expect(lastRun()?.endTree).not.toBe(before?.endTree);
        expect(lastRun()?.startTree).not.toBe(before?.startTree);
    });

    test('is announced in one transaction: the cut with the runs it removed, the run, the new message, the chat and the queued turn, in that order', async () => {
        const { h, chat, turn, read } = await setup();
        const runId = await turn('one');

        await turn('two');

        const items = await read();
        const dropped = h.store.db.query('SELECT id FROM runs WHERE parent_tool_call_id = ?').get('call-2') as { id: string };

        h.store.db.query('UPDATE runs SET context = ? WHERE id = ?').run(JSON.stringify({ used: 5000, size: 200000 }), runId);

        const cursor = h.store.headCursor();

        expect((await edit(h, chat.id, items[3].id, 'again')).ok).toBe(true);

        const events = h.events(cursor);

        expect(events[0].data).toEqual({ type: 'stream.truncated', runId, fromSeq: 4, removedRunIds: [dropped.id] });
        expect(events.slice(0, 5).map(event => event.data.type)).toEqual(['stream.truncated', 'run.upserted', 'stream.item', 'chat.upserted', 'run.upserted']);
        // The run forgets what the dropped part left on it before its turn is queued.
        expect(events[1].data).toMatchObject({ type: 'run.upserted', run: { id: runId, sessionId: 's1-fork-1' } });
        expect(events[1].data.type === 'run.upserted' && events[1].data.run.context).toBeUndefined();
        expect(events[2].data).toMatchObject({ type: 'stream.item', item: { seq: 4, canEdit: true, body: { kind: 'user', text: 'again' } } });
        expect(events[4].data).toMatchObject({ type: 'run.upserted', run: { id: runId, status: 'queued' } });
    });

    test('rewrites the first message of the chat with no fork: the session is cleared and the new turn starts a fresh one with the first-message prefix', async () => {
        const { h, engine, chat, runId, items, read } = await threeTurns();
        const cursor = h.store.headCursor();

        expect(items[0].canEdit).toBe(true);
        expect((await edit(h, chat.id, items[0].id, 'uno')).ok).toBe(true);
        expect(engine.forked).toEqual([]);

        // The session was cleared in the transaction, and the new turn started another.
        const first = h.events(cursor).find(event => event.data.type === 'run.upserted');

        expect(first?.data).toMatchObject({ type: 'run.upserted', run: { id: runId } });
        expect(first?.data.type === 'run.upserted' && first.data.run.sessionId).toBeUndefined();

        await waitFor(() => engine.turns.length === 4 && h.run(runId).status === 'succeeded', 'the new turn to end');

        // Nothing is behind the new session: it has to be told the entry skill and the mode, as the first message of a chat is.
        expect(engine.turns[3].resumeSessionId).toBeUndefined();
        expect(engine.turns[3].prompt).toStartWith('Follow clowdy:orchestrate. Mode: autopilot');
        expect(engine.turns[3].prompt).toEndWith('\n\nuno');
        expect(engine.turns[3].history).toBeUndefined();
        expect(h.run(runId).sessionId).toBe('s4');
        expect((await read()).map(item => [item.seq, textOf(item)])).toEqual([[1, 'uno'], [2, 'tool'], [3, 'answer 4']]);
        expect(callsOf(h, runId)).toEqual(['call-4']);
        // The turn that follows a first message that was rewritten is an ordinary one again.
        await h.ok('chat.send', { chatId: chat.id, text: 'next' });
        await waitFor(() => engine.turns.length === 5 && h.run(runId).status === 'succeeded', 'the next turn to end');
        expect(engine.turns[4]).toMatchObject({ prompt: 'next', resumeSessionId: 's4' });
    });

    test('takes the first words of the new first message as the title when the chat was named for the old one, and keeps a title the person chose', async () => {
        const { h, chat, items } = await threeTurns();

        expect(h.store.db.query('SELECT title FROM chats WHERE id = ?').get(chat.id)).toEqual({ title: 'one' });
        expect((await edit(h, chat.id, items[0].id, 'uno')).ok).toBe(true);
        expect(h.store.db.query('SELECT title FROM chats WHERE id = ?').get(chat.id)).toEqual({ title: 'uno' });

        const other = await setup();

        await other.turn('first');
        other.h.ok('chat.rename', { chatId: other.chat.id, title: 'Mine' });
        expect((await edit(other.h, other.chat.id, (await other.read())[0].id, 'second')).ok).toBe(true);
        expect(other.h.store.db.query('SELECT title FROM chats WHERE id = ?').get(other.chat.id)).toEqual({ title: 'Mine' });
    });

    test('forgets what the dropped part left on the run, and keeps what was spent', async () => {
        const { h, engine, chat, runId, items } = await threeTurns();
        const usage = { inputTokens: 10, outputTokens: 5, costUsd: 0.5 };

        h.store.db.query('UPDATE runs SET context = ?, usage = ?, lost_background = ?, next_prompt = ? WHERE id = ?')
            .run(JSON.stringify({ used: 5000, size: 200000 }), JSON.stringify(usage), JSON.stringify([{ id: 'bg1', kind: 'command', title: 'sleep 99' }]), 'leftover', runId);
        expect((await edit(h, chat.id, items[3].id, 'two, again')).ok).toBe(true);
        await waitFor(() => engine.turns.length === 4 && h.run(runId).status === 'succeeded', 'the new turn to end');

        // The turn is told the new message alone: no leftover prompt, no background work that the dropped part started and lost.
        expect(engine.turns[3].prompt).toBe('two, again');
        expect(h.run(runId)).toMatchObject({ usage });
        expect(h.run(runId).context).toBeUndefined();
        expect(getRunWork(h.store.db, runId).lostBackground).toBeUndefined();
    });

    test('keeps what is not part of the dropped messages: queued messages, threads, tasks and the usage', async () => {
        const { h, engine, project, chat, turn, read } = await setup();
        const thread = chatOf(h, engine, project.id, 'fake');

        await thread.turn('thread work');
        h.store.db.query('UPDATE chats SET parent_chat_id = ? WHERE id = ?').run(chat.id, thread.chat.id);

        const runId = await turn('one');

        await turn('two');
        h.ok('task.create', { projectId: project.id, title: 'A task' });
        h.store.db.query('UPDATE chats SET queue = ?, queue_paused = ? WHERE id = ?')
            .run(JSON.stringify([{ id: 'que_1', mode: 'queue', text: 'later', content: 'later', createdAt: 1 }]), 'stopped', chat.id);
        h.store.db.query('UPDATE runs SET usage = ? WHERE id = ?').run(JSON.stringify({ inputTokens: 3, outputTokens: 4 }), runId);

        const threadRun = h.store.db.query('SELECT * FROM runs WHERE chat_id = ?').get(thread.chat.id);
        const threadItems = await thread.read();
        const tasks = count(h, 'tasks');
        const items = await read();

        expect((await edit(h, chat.id, items[3].id, 'again')).ok).toBe(true);
        await waitFor(() => h.run(runId).status === 'succeeded' && engine.turns.length === 4, 'the new turn to end');

        expect(h.store.db.query('SELECT queue, queue_paused FROM chats WHERE id = ?').get(chat.id)).toEqual({ queue: expect.stringContaining('que_1'), queue_paused: 'stopped' });
        expect(h.store.db.query('SELECT parent_chat_id FROM chats WHERE id = ?').get(thread.chat.id)).toEqual({ parent_chat_id: chat.id });
        expect(h.store.db.query('SELECT * FROM runs WHERE chat_id = ?').get(thread.chat.id)).toEqual(threadRun);
        expect(await thread.read()).toEqual(threadItems);
        expect(count(h, 'tasks')).toBe(tasks);
        expect(h.run(runId).usage).toEqual({ inputTokens: 3, outputTokens: 4 });
    });

    test('drops the files of the dropped messages, rows and folders, except those the new message carries on, which the new message claims again', async () => {
        const { h, engine, project, chat, turn, read } = await setup();
        const [a, b, c, d, e] = await Promise.all(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'].map(name => upload(h, project.id, name)));
        const runId = await turn('one', { attachmentIds: [a.id] });

        await turn('two', { attachmentIds: [b.id, c.id] });
        await turn('three', { attachmentIds: [d.id] });

        const items = await read();

        expect(attachmentFolders(h)).toEqual([a, b, c, d, e].map(file => file.id).sort());
        expect((await edit(h, chat.id, items[3].id, 'two, again', { attachmentIds: [c.id, e.id] })).ok).toBe(true);
        await waitFor(() => engine.turns.length === 4 && h.run(runId).status === 'succeeded', 'the new turn to end');

        const after = await read();
        const files = after[3].body.kind === 'user' ? after[3].body.attachments : undefined;

        // The new message names the kept file as it was and the new upload; the files of the dropped messages are gone with their folders.
        expect(files).toEqual([c, e]);
        expect(attachmentFolders(h)).toEqual([a, c, e].map(file => file.id).sort());
        expect(h.store.db.query('SELECT id, chat_id, run_id FROM attachments ORDER BY id').all()).toEqual([a, c, e].map(file => ({ id: file.id, chat_id: chat.id, run_id: runId })).sort((x, y) => x.id.localeCompare(y.id)));
        expect(engine.turns[3].prompt).toContain('c.txt');
        expect(engine.turns[3].prompt).toContain('e.txt');
        expect(engine.turns[3].prompt).not.toContain('b.txt');
    });

    test('refuses a file of an earlier message, one that does not exist and a list with a file twice, before the agent is asked', async () => {
        const { h, engine, project, chat, turn, read } = await setup();
        const [a, c] = await Promise.all(['a.txt', 'c.txt'].map(name => upload(h, project.id, name)));

        await turn('one', { attachmentIds: [a.id] });
        await turn('two');

        const items = await read();
        const before = state(h);

        expect(errorOf(await edit(h, chat.id, items[3].id, 'again', { attachmentIds: [a.id] }))).toBe('conflict');
        expect(errorOf(await edit(h, chat.id, items[3].id, 'again', { attachmentIds: ['att_nope'] }))).toBe('not_found');
        expect(errorOf(await edit(h, chat.id, items[3].id, 'again', { attachmentIds: [c.id, c.id] }))).toBe('invalid');
        expect(engine.forked).toEqual([]);
        expect(state(h)).toEqual(before);
    });

    test('a message of files alone is a message, and an empty one is refused before the agent is asked', async () => {
        const { h, engine, project, chat, turn, read } = await setup();
        const file = await upload(h, project.id, 'only.txt');

        await turn('one');
        await turn('two');

        const items = await read();
        const before = state(h);

        expect(errorOf(await edit(h, chat.id, items[3].id, '   '))).toBe('invalid');
        expect(errorOf(await edit(h, chat.id, items[3].id, '', { attachmentIds: [] }))).toBe('invalid');
        expect(engine.forked).toEqual([]);
        expect(state(h)).toEqual(before);

        expect((await edit(h, chat.id, items[3].id, '', { attachmentIds: [file.id] })).ok).toBe(true);
        expect((await read())[3].body).toMatchObject({ kind: 'user', text: '', attachments: [file] });
    });
});

describe('chat.edit refusals', () => {
    test('a chat that does not exist, one with no conversation, an item that is not there, and an item of another chat', async () => {
        const { h, engine, project, chat, turn, read } = await setup();

        expect(errorOf(await edit(h, 'cht_nope', 'itm_x', 'again'))).toBe('not_found');

        const idle = h.ok('chat.create', { projectId: project.id, engine: 'fake' }).chat as Chat;

        expect(errorOf(await edit(h, idle.id, 'itm_x', 'again'))).toBe('invalid');

        await turn('one');
        expect(errorOf(await edit(h, chat.id, 'itm_nope', 'again'))).toBe('not_found');

        const other = chatOf(h, engine, project.id, 'fake');

        await other.turn('elsewhere');
        expect(errorOf(await edit(h, chat.id, (await other.read())[0].id, 'again'))).toBe('not_found');
        expect(engine.forked).toEqual([]);
        expect((await read()).map(textOf)).toEqual(['one', 'tool', 'answer 1']);
    });

    test('an item that is not a message the person started a turn with: an answer, a call, a steer inside a turn, a message of a thread', async () => {
        const { h, engine, chat, turn, read } = await setup();
        const runId = await turn('one');

        appendItem(h.store, runId, { kind: 'tool', toolCallId: 'extra', name: 'Bash', input: {}, state: 'done', output: 'ok' });
        appendItem(h.store, runId, { kind: 'user', text: 'a steer' });
        appendItem(h.store, runId, { kind: 'user', text: 'from a thread', from: { kind: 'thread', chatId: 'cht_x', title: 'T' } });

        const items = await read();
        const before = state(h);

        expect(items.map(item => item.canEdit === true)).toEqual([true, false, false, false, false, false]);

        for (const item of items.slice(1)) {
            expect([item.seq, errorOf(await edit(h, chat.id, item.id, 'again'))]).toEqual([item.seq, 'invalid']);
        }

        // The flag of the agent is off: the message that starts the chat is not editable either.
        engine.canFork = false;
        expect(errorOf(await edit(h, chat.id, items[0].id, 'again'))).toBe('invalid');
        expect(engine.forked).toEqual([]);
        expect(state(h)).toEqual(before);
    });

    test('a message past the first of a chat whose run holds no session to copy; the first message needs none', async () => {
        const { h, engine, chat, runId, items } = await threeTurns();

        h.store.db.query('UPDATE runs SET session_id = NULL WHERE id = ?').run(runId);

        const before = state(h);

        expect(errorOf(await edit(h, chat.id, items[3].id, 'again'))).toBe('invalid');
        expect(engine.forked).toEqual([]);
        expect(state(h)).toEqual(before);
        expect(errorOf(await edit(h, chat.id, items[0].id, 'uno'))).toBeUndefined();
    });

    test('an agent that is switched off in Clowdy', async () => {
        const { h, engine, chat, turn, read } = await setup(scripted(), 'claude');

        await turn('one');
        await turn('two');
        h.ok('agent.update', { id: 'claude', enabled: false });

        const before = state(h);
        const result = await edit(h, chat.id, (await read())[3].id, 'again');

        expect(errorOf(result)).toBe('unavailable');
        expect(result.ok ? '' : result.error.message).toContain('switched off');
        expect(engine.forked).toEqual([]);
        expect(state(h)).toEqual(before);
    });

    test('a chat whose orchestrator is not at rest, in every status that is not: the Stop comes first', async () => {
        const { h, engine, chat, runId, items } = await threeTurns();
        const before = state(h);

        const busy: [string, string | null][] = [['queued', 'Waiting for a slot'], ['blocked', 'Waiting for CLW-1'], ['running', null], ['waiting_user', 'Waiting for an answer'], ['waiting_background', 'Waiting for background work'], ['cancelled', 'Stopped to send a message']];

        for (const [status, reason] of busy) {
            setStatus(h, runId, status, reason);

            const result = await edit(h, chat.id, items[3].id, 'again');

            expect([status, errorOf(result)]).toEqual([status, 'conflict']);
            expect(result.ok ? '' : result.error.message).toBe('Stop the agent to edit this message');
        }

        setStatus(h, runId, 'succeeded');
        expect(engine.forked).toEqual([]);
        expect(state(h)).toEqual(before);
    });

    test('a turn that is running now, and the chat at rest again after it', async () => {
        const gates = new Map([[4, latch()]]);
        const { h, engine, chat, runId, items, send } = await threeTurns(gates);

        send('four');
        await waitFor(() => engine.turns.length === 4 && h.run(runId).status === 'running', 'the fourth turn to run');
        expect(errorOf(await edit(h, chat.id, items[3].id, 'again'))).toBe('conflict');
        expect(engine.forked).toEqual([]);

        gates.get(4)?.release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the turn to end');
        expect(errorOf(await edit(h, chat.id, items[3].id, 'again'))).toBeUndefined();
    });

    test('a chat whose last turn failed, was stopped or was lost in a restart can be edited: those rest', async () => {
        for (const status of ['failed', 'cancelled', 'interrupted']) {
            const { h, engine, chat, runId, items } = await threeTurns();

            setStatus(h, runId, status, status === 'failed' ? null : 'Stopped');
            expect([status, errorOf(await edit(h, chat.id, items[3].id, 'again'))]).toEqual([status, undefined]);
            await waitFor(() => engine.turns.length === 4 && h.run(runId).status === 'succeeded', 'the new turn to end');
        }
    });

    test('a failed fork of the agent changes nothing: no row, file or event, and the same request can be tried again', async () => {
        const { h, engine, project, chat, turn, read } = await setup();
        const file = await upload(h, project.id, 'a.txt');

        await turn('one');
        await turn('two', { attachmentIds: [file.id] });

        const items = await read();
        const before = state(h);
        let failures = 0;

        engine.forkAnswer = (options) => {
            if (failures++ === 0) {
                throw new EngineFailure('The adapter fell over.');
            }

            return { sessionId: `${ options.sessionId }-retry` };
        };

        expect(await edit(h, chat.id, items[3].id, 'again')).toMatchObject({ ok: false, error: { code: 'unavailable', message: 'Couldn\'t rewind the conversation: The adapter fell over' } });
        expect(state(h)).toEqual(before);
        expect((await read()).map(textOf)).toEqual(items.map(textOf));

        // The chat is not stuck as "being edited": the next attempt gets through.
        expect((await edit(h, chat.id, items[3].id, 'again')).ok).toBe(true);
        expect(engine.forked).toHaveLength(2);
    });

    test('a failure of the agent is remembered for its request id, an unexpected one is not', async () => {
        const { h, engine, chat, turn, read } = await setup();

        await turn('one');
        await turn('two');

        const itemId = (await read())[3].id;
        const failures = [new EngineFailure('The adapter fell over.'), new Error('boom')];

        engine.forkAnswer = (options) => {
            const failure = failures.shift();

            if (failure) {
                throw failure;
            }

            return { sessionId: `${ options.sessionId }-ok` };
        };

        const asked = command('chat.edit', { chatId: chat.id, itemId, text: 'again' });
        const crashed = command('chat.edit', { chatId: chat.id, itemId, text: 'again' });
        const logged = spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            expect(errorOf(await executeCommandAsync(h.daemon.services, asked))).toBe('unavailable');
            expect(errorOf(await executeCommandAsync(h.daemon.services, asked))).toBe('unavailable');
            expect(engine.forked).toHaveLength(1);

            expect(errorOf(await executeCommandAsync(h.daemon.services, crashed))).toBe('internal');
            expect((await executeCommandAsync(h.daemon.services, crashed)).ok).toBe(true);
            expect(engine.forked).toHaveLength(3);
        }
        finally {
            logged.mockRestore();
        }
    });
});

describe('chat.edit races', () => {
    /** A chat with three turns whose agent copy of a session waits for the test, and the gate that releases it. */
    async function waiting() {
        const gate = latch();
        const base = await threeTurns(new Map());

        base.engine.forkAnswer = async (options) => {
            await gate.wait();

            return { sessionId: `${ options.sessionId }-copy` };
        };

        return { ...base, gate };
    }

    test('a message sent from the composer while the agent copies the session is a conflict, and the edit changes nothing', async () => {
        const { h, engine, chat, runId, items, gate, send, read } = await waiting();
        const pending = edit(h, chat.id, items[3].id, 'again');

        await waitFor(() => engine.forked.length === 1, 'the copy to start');
        send('sneaky');
        await waitFor(() => engine.turns.length === 4, 'the sneaky turn to start');
        gate.release();

        expect(errorOf(await pending)).toBe('conflict');
        await waitFor(() => h.run(runId).status === 'succeeded', 'the sneaky turn to end');

        // The person's message is in the stream and the dropped part is still there.
        expect((await read()).map(textOf)).toEqual(['one', 'tool', 'answer 1', 'two', 'tool', 'answer 2', 'three', 'tool', 'answer 3', 'sneaky', 'tool', 'answer 4']);
        expect(h.run(runId).sessionId).toBe('s1');
    });

    test('also when that turn is over before the agent is done: the stream moved, and the message that was written meanwhile is not cut away unseen', async () => {
        const { h, engine, chat, runId, items, gate, turn, read } = await waiting();
        const pending = edit(h, chat.id, items[3].id, 'again');

        await waitFor(() => engine.forked.length === 1, 'the copy to start');
        await turn('sneaky');
        expect(h.run(runId).status).toBe('succeeded');
        gate.release();

        expect(errorOf(await pending)).toBe('conflict');
        expect((await read()).map(textOf).slice(-3)).toEqual(['sneaky', 'tool', 'answer 4']);
        expect(callsOf(h, runId)).toEqual(['call-1', 'call-2', 'call-3', 'call-4']);
    });

    test('a second edit of a chat whose copy is still being made is a conflict that asks the agent for nothing; the first goes through', async () => {
        const { h, engine, chat, items, gate } = await waiting();
        const first = edit(h, chat.id, items[3].id, 'first');

        await waitFor(() => engine.forked.length === 1, 'the copy to start');

        expect(errorOf(await edit(h, chat.id, items[6].id, 'second'))).toBe('conflict');
        expect(engine.forked).toHaveLength(1);

        gate.release();
        expect((await first).ok).toBe(true);
    });

    test('the edit is one transaction: a message that cannot be sent after the cut puts everything back, files and events included', async () => {
        const { h, engine, project, chat, runId, items, gate } = await waiting();
        const file = await upload(h, project.id, 'fresh.txt');
        const before = state(h);
        const pending = edit(h, chat.id, items[3].id, 'again', { attachmentIds: [file.id] });

        await waitFor(() => engine.forked.length === 1, 'the copy to start');
        // The upload is swept away while the agent copies the session: the plan accepted it, the send cannot.
        h.store.db.query('DELETE FROM attachments WHERE id = ?').run(file.id);
        gate.release();

        expect(errorOf(await pending)).toBe('not_found');
        expect({ ...state(h), cursor: 0, files: 0 }).toEqual({ ...before, cursor: 0, files: 0 });
        expect(h.store.headCursor()).toBe(before.cursor);
        expect(h.run(runId).sessionId).toBe('s1');
        expect(callsOf(h, runId)).toEqual(['call-1', 'call-2', 'call-3']);

        // The turn the send would have started never launches: that is left to the commit, which did not happen.
        await Bun.sleep(100);
        expect(engine.turns).toHaveLength(3);
        expect(h.run(runId).status).toBe('succeeded');
    });

    test('the chat must still rest, and the message still be editable, at the moment of writing, whatever the stream did meanwhile', async () => {
        const changes: [string, (base: Awaited<ReturnType<typeof waiting>>) => unknown][] = [
            ['the run is working again', ({ h, runId }) => setStatus(h, runId, 'running')],
            ['the run waits for background work', ({ h, runId }) => setStatus(h, runId, 'waiting_background', 'Waiting for background work')],
            ['the agent can no longer fork', ({ engine }) => Object.assign(engine, { canFork: false })],
        ];

        for (const [what, change] of changes) {
            const base = await waiting();
            const { h, engine, chat, runId, items, gate } = base;
            const pending = edit(h, chat.id, items[3].id, 'again');

            await waitFor(() => engine.forked.length === 1, 'the copy to start');
            change(base);
            gate.release();

            // The stream did not move, so only the state of the run or the message can have refused it.
            expect([what, errorOf(await pending)]).toEqual([what, 'conflict']);
            expect(h.run(runId).sessionId).toBe('s1');
            expect((await base.read()).map(textOf)).toEqual(items.map(textOf));
        }
    });

    test('an edit into the history of a fork ends that history where the cut begins, so the divider never follows new messages; an edit after it leaves it', async () => {
        const { h, chat, items } = await threeTurns();
        const { chat: fork } = await h.okAsync('chat.fork', { chatId: chat.id, itemId: items[5].id }) as { chat: Chat };
        const forkRunId = fork.orchestratorRunId as string;
        const forked = () => h.store.db.query('SELECT source_chat_id AS source, forked_at_seq AS at FROM chats WHERE id = ?').get(fork.id);
        const read = async () => await (await h.fetch(`/v1/chats/${ fork.id }/items`)).json() as StreamItem[];

        expect(fork.forkedFrom).toEqual({ chatId: chat.id, atSeq: 6 });
        h.ok('chat.send', { chatId: fork.id, text: 'four' });
        await waitFor(() => h.run(forkRunId).status === 'succeeded' && rowsOf(h, forkRunId).length === 9, 'the fork\'s own turn to end');

        // The message after the divider is the fork's own: the history it inherited stays as long as it was.
        const own = (await read()).find(item => item.seq === 7) as StreamItem;

        expect((await edit(h, fork.id, own.id, 'four, again')).ok).toBe(true);
        expect(forked()).toEqual({ source: chat.id, at: 6 });
        await waitFor(() => h.run(forkRunId).status === 'succeeded', 'the turn to end');

        // An edit of an inherited message ends the history before it, and the chat says so to its clients in the same transaction.
        const inherited = (await read()).find(item => item.seq === 4) as StreamItem;
        const cursor = h.store.headCursor();

        expect((await edit(h, fork.id, inherited.id, 'two, again')).ok).toBe(true);
        expect(forked()).toEqual({ source: chat.id, at: 3 });
        expect(h.events(cursor).flatMap(event => event.data.type === 'chat.upserted' && event.data.chat.id === fork.id ? [event.data.chat.forkedFrom?.atSeq] : []).at(-1)).toBe(3);
        await waitFor(() => h.run(forkRunId).status === 'succeeded', 'the turn to end');

        // Nothing is left of what the first message said: the fork inherits nothing any more.
        const first = (await read())[0];

        expect((await edit(h, fork.id, first.id, 'one, again')).ok).toBe(true);
        expect(forked()).toEqual({ source: chat.id, at: 0 });

        // The source is not touched by any of it.
        expect((await h.fetch(`/v1/chats/${ chat.id }/items`).then(response => response.json()) as StreamItem[]).map(textOf)).toEqual(items.map(textOf));
    });
});

describe('chat.edit as a command', () => {
    test('a repeat of its request id answers the first result without a second copy or a second message, over HTTP too', async () => {
        const { h, engine, chat, runId, items, read } = await threeTurns();
        const body = JSON.stringify(command('chat.edit', { chatId: chat.id, itemId: items[3].id, text: 'again' }));
        const post = async () => await (await h.fetch('/v1/commands', { method: 'POST', body })).json() as CommandResult;
        const first = await post();
        const again = await post();

        expect(first).toMatchObject({ ok: true, data: { chatId: chat.id, runId } });
        expect(again).toEqual(first);
        expect(engine.forked).toHaveLength(1);

        await waitFor(() => engine.turns.length === 4 && h.run(runId).status === 'succeeded', 'the new turn to end');
        expect((await read()).map(textOf)).toEqual(['one', 'tool', 'answer 1', 'again', 'tool', 'answer 4']);
    });

    test('a repeat that comes while the first still waits for the agent waits for it too', async () => {
        const gate = latch();
        const { h, engine, chat, items } = await threeTurns();

        engine.forkAnswer = async (options) => {
            await gate.wait();

            return { sessionId: `${ options.sessionId }-copy` };
        };

        const message = command('chat.edit', { chatId: chat.id, itemId: items[3].id, text: 'again' });
        const first = executeCommandAsync(h.daemon.services, message);
        const again = executeCommandAsync(h.daemon.services, message);

        await waitFor(() => engine.forked.length === 1, 'the copy to start');
        gate.release();

        const results = await Promise.all([first, again]);

        expect(results[0].ok).toBe(true);
        expect(results[1]).toEqual(results[0]);
        expect(engine.forked).toHaveLength(1);
    });

    test('the synchronous executor refuses it: the agent must be waited for', async () => {
        const { h, chat, items } = await threeTurns();
        const before = state(h);
        const result = h.send('chat.edit', { chatId: chat.id, itemId: items[3].id, text: 'again' });

        expect(result).toMatchObject({ ok: false, error: { code: 'internal', message: expect.stringContaining('executeCommandAsync') } });
        expect(state(h)).toEqual(before);
    });
});

describe('what an edit cuts of the runs', () => {
    test('the sub-agents of the dropped part go with theirs, those that name no call by the time they began, and those of the kept part stay', async () => {
        const { h, engine, chat, turn, read } = await setup();
        const runId = await turn('one');
        const orchestrator = h.run(runId);
        const runs = h.daemon.services.runs;
        const kept = runs.createNative(orchestrator, { name: 'Kept', summary: 'kept' });
        const keptChild = runs.createNative(kept, { name: 'Kept child', summary: 'kept child' });

        await Bun.sleep(5);
        await turn('two');

        const dropped = runs.createNative(orchestrator, { name: 'Dropped', summary: 'dropped' });
        const droppedChild = runs.createNative(dropped, { name: 'Dropped child', summary: 'dropped child' });

        for (const run of [kept, keptChild, dropped, droppedChild]) {
            setStatus(h, run.id, 'succeeded');
        }

        const items = await read();
        const named = h.store.db.query('SELECT id FROM runs WHERE parent_tool_call_id = ?').get('call-2') as { id: string };

        expect((await edit(h, chat.id, items[3].id, 'again')).ok).toBe(true);
        await waitFor(() => engine.turns.length === 3 && h.run(runId).status === 'succeeded', 'the new turn to end');

        const left = (h.store.db.query('SELECT id FROM runs').all() as { id: string }[]).map(row => row.id);

        expect(left).toContain(kept.id);
        expect(left).toContain(keptChild.id);
        expect(left).not.toContain(dropped.id);
        expect(left).not.toContain(droppedChild.id);
        expect(left).not.toContain(named.id);
        // The streams of the removed runs went with them.
        expect(h.store.db.query('SELECT COUNT(*) AS n FROM stream_items WHERE run_id IN (?, ?, ?)').get(dropped.id, droppedChild.id, named.id)).toEqual({ n: 0 });
    });
});

describe('chat.edit with the fake engine the dev daemon runs', () => {
    test('rewrites a chat of two turns, the sub-agent runs of the dropped turn included, and the new turn runs to the end', async () => {
        const h = await startHarness();

        harnesses.push(h);

        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id }) as { chat: Chat };
        const read = async () => await (await h.fetch(`/v1/chats/${ chat.id }/items`)).json() as StreamItem[];
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Plan the work' }) as { runId: string };
        const users = () => (h.store.db.query('SELECT json_extract(body, \'$.text\') AS text FROM stream_items WHERE run_id = ? AND json_extract(body, \'$.kind\') = \'user\' ORDER BY seq').all(runId) as { text: string }[]).map(row => row.text);
        // A turn ended once the run rests with the message it answers in the stream and its own answer written after it.
        const ended = async (text: string) => waitFor(() => h.run(runId).status === 'succeeded' && users().at(-1) === text && (h.store.db.query('SELECT json_extract(body, \'$.kind\') AS kind FROM stream_items WHERE run_id = ? ORDER BY seq DESC LIMIT 1').get(runId) as { kind: string }).kind === 'assistant', `the turn of "${ text }" to end`, 15_000);

        await ended('Plan the work');
        h.ok('chat.send', { chatId: chat.id, text: 'Now something else' });
        await ended('Now something else');

        const items = await read();
        const second = items.filter(item => item.canEdit)[1];

        expect(second).toBeDefined();
        expect((h.store.db.query('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = ?').get(runId) as { n: number }).n).toBeGreaterThan(0);
        expect((await edit(h, chat.id, second.id, 'Do it differently')).ok).toBe(true);
        await ended('Do it differently');

        const after = await read();

        expect(users()).toEqual(['Plan the work', 'Do it differently']);
        expect(after.slice(0, second.seq - 1).map(item => item.id)).toEqual(items.slice(0, second.seq - 1).map(item => item.id));
        expect(after.find(item => item.seq === second.seq)?.id).not.toBe(second.id);
    });
});
