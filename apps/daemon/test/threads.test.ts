import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { getChat } from '../src/db/chats';
import { listItems } from '../src/db/items';
import { getRunWork } from '../src/db/runs';
import { createChat } from '../src/domain/chats';
import { clipOutput } from '../src/runs/threads';
import { clip } from '../src/runs/tool-kit';
import { toolsFor } from '../src/runs/tools';
import { cleanTempDirs, latch, restartHarness, ScriptEngine, scriptEngines, SHORT_TIMINGS, startHarness, tempDir, untilAborted, waitFor } from './helpers';

import type { Chat, MessageSource, Run, StreamItemBody, ThreadNotice } from '@clowdy/protocol';
import type { EngineEvent } from '../src/engine/types';
import type { Harness, Script } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

type Latch = ReturnType<typeof latch>;

/** A turn that says `say`, then holds until `gate` is released (or the run is stopped), then ends. */
function held(gate: Latch, say = 'working'): Script {
    return async function* ({ number, signal }) {
        yield { type: 'session', sessionId: `s-${ number }` };
        yield { type: 'text', delta: say, done: true };
        await gate.wait(signal);
        yield { type: 'done', result: say };
    };
}

/** A turn that says each text as a message of its own and ends. */
function says(...texts: string[]): Script {
    return async function* ({ number }) {
        yield { type: 'session', sessionId: `s-${ number }` };

        for (const text of texts) {
            yield { type: 'text', delta: text, done: true };
        }

        yield { type: 'done', result: texts.at(-1) };
    };
}

/** A turn that waits for `gate` (or the run's stop), then gives `answer` as its final message and ends. */
function answers(gate: Latch, answer: string): Script {
    return async function* ({ number, signal }) {
        yield { type: 'session', sessionId: `s-${ number }` };
        await gate.wait(signal);
        yield { type: 'text', delta: answer, done: true };
        yield { type: 'done', result: answer };
    };
}

/**
 * A daemon whose one engine runs a script per message: the turn whose prompt ends with a route's text runs that route (a first message is the entry line
 * and then the text, a thread's message the line naming its sender and then the text), or whose prompt passes a route's test (`onPrompt`); any other turn
 * answers "Done", the notices of threads that stopped included.
 */
async function setup(overrides: Parameters<typeof startHarness>[0] = {}) {
    const routes: [(prompt: string) => boolean, Script][] = [];
    const engine = new ScriptEngine(async function* (turn) {
        const route = routes.find(([matches]) => matches(turn.options.prompt));

        yield* (route ? route[1] : says('Done'))(turn);
    });
    // The same scripts stand in for Claude Code, the agent with a compact command, for a thread that names it.
    const h = await startHarness(overrides, { engines: new Map([['fake', engine], ['claude', engine]]) });

    harnesses.push(h);

    const project = h.openRepo();
    const { store, runs, threads } = h.daemon.services;
    const chatOf = (chatId: string) => getChat(store.db, chatId) as Chat;
    const runOf = (chatId: string) => h.run(chatOf(chatId).orchestratorRunId as string);
    const bodies = (runId: string): StreamItemBody[] => listItems(store.db, runId, 0).map(item => item.body);
    const on = (ending: string, script: Script) => routes.push([prompt => prompt.endsWith(ending), script]);
    const onPrompt = (matches: (prompt: string) => boolean, script: Script) => routes.push([matches, script]);
    /** Runs a tool of `run` as its agent would: the very definition its turn gets. */
    const exec = async (run: Run, name: string, input: Record<string, unknown> = {}, signal = new AbortController().signal): Promise<any> => {
        const tool = toolsFor({ store, runs, threads }, run, runs.modeOf(run)).find(candidate => candidate.name === name);

        if (!tool) {
            throw new Error(`${ run.name } has no ${ name } tool`);
        }

        return tool.execute(input, signal);
    };
    /** The notices of threads that stopped that reached the chat's orchestrator, oldest first: each is the threads of one message. */
    const noticesTo = (chatId: string): ThreadNotice[][] => bodies(runOf(chatId).id).flatMap(body => (body.kind === 'user' && body.from?.kind === 'threadNotice' ? [body.from.threads] : []));
    const turnOf = (ending: string) => engine.turns.find(turn => turn.prompt.endsWith(ending));
    /** Waits until the turn of the chat's message that ends with `ending` runs. */
    const running = (chatId: string, ending: string) => waitFor(() => turnOf(ending) && runOf(chatId).status === 'running', `the turn on "${ ending }"`);

    /** A chat the person starts with `text`, whose first turn holds until `gate` is released; resolves once it runs. */
    const root = async (text: string, gate: Latch, fields: Record<string, unknown> = {}) => {
        const { chat } = h.ok('chat.create', { projectId: project.id, ...fields }) as { chat: Chat };

        on(text, held(gate));
        h.ok('chat.send', { chatId: chat.id, text });
        await running(chat.id, text);

        return { chat: chatOf(chat.id), run: runOf(chat.id) };
    };

    /** A thread `caller` starts on `prompt`, whose turn runs `script` (a held turn by default); resolves once that turn runs, or ends with `settled`. */
    const spawn = async (caller: Run, prompt: string, script: Script = held(latch()), extra: Record<string, unknown> = {}) => {
        on(prompt, script);

        const result = await exec(caller, 'thread_spawn', { prompt, ...extra });

        await waitFor(() => turnOf(prompt), `the thread on "${ prompt }" to start`);

        return { ...result, run: () => runOf(result.threadId) } as { threadId: string; title: string; state: string; note: string; run: () => Run };
    };

    return { h, engine, project, store, chatOf, runOf, bodies, on, onPrompt, exec, noticesTo, turnOf, running, root, spawn };
}

const fromChat = (chat: Chat): MessageSource => ({ kind: 'thread', chatId: chat.id, title: chat.title });
const told = (sender: Chat, text: string) => `[Message from thread "${ sender.title }" (${ sender.id })]\n\n${ text }`;

describe('thread_spawn', () => {
    test('makes a chat below the caller\'s whose first message comes from the caller, and starts it on the caller\'s agent, model, level and mode', async () => {
        const { h, chatOf, runOf, bodies, exec, turnOf, root, spawn } = await setup();
        const parent = await root('Plan the release', latch(), { model: 'big', effort: 'high', mode: 'semi' });
        const thread = await spawn(parent.run, 'Look into the cache\nand report what you find');

        expect(thread).toEqual({ threadId: expect.stringMatching(/^cht_/), title: 'Look into the cache', state: 'working', note: expect.stringContaining('Do not poll'), run: expect.any(Function) });
        expect(chatOf(thread.threadId)).toMatchObject({ parentChatId: parent.chat.id, projectId: parent.chat.projectId, title: 'Look into the cache', mode: 'semi', engine: 'fake', model: 'big', effort: 'high' });

        const run = thread.run();

        // Its own root run, not a child of the caller's.
        expect(run).toMatchObject({ chatId: thread.threadId, rootRunId: run.id, role: 'orchestrator', engine: 'fake', model: 'big', effort: 'high' });
        expect(run.parentRunId).toBeUndefined();
        expect(bodies(run.id)[0]).toEqual({ kind: 'user', text: 'Look into the cache\nand report what you find', from: fromChat(parent.chat) });
        expect(turnOf('and report what you find')).toMatchObject({
            prompt: 'Follow clowdy:orchestrate. Mode: semi-manual\n\nLook into the cache\nand report what you find',
            model: 'big',
            effort: 'high',
        });
        await waitFor(() => runOf(thread.threadId).status === 'running', 'the thread to run');

        // The parent's chat is not touched: no item, no queue.
        expect(chatOf(parent.chat.id).queue).toBeUndefined();
        expect(bodies(parent.run.id).filter(body => body.kind === 'user')).toHaveLength(1);

        // A title is the chat's own; a model of its own leaves the caller's level behind; a mode of its own.
        const named = await spawn(parent.run, 'Audit the logs', says('Audited'), { title: 'Log audit', model: 'small', mode: 'autopilot' });

        await waitFor(() => named.run().status === 'succeeded', 'the named thread to finish');
        expect(chatOf(named.threadId)).toMatchObject({ title: 'Log audit', mode: 'autopilot', model: 'small' });
        expect(named.run()).toMatchObject({ model: 'small' });
        expect(named.run().effort).toBeUndefined();
        expect(h.run(parent.run.id).status).toBe('running');
    });

    test('works in the folder of its parent\'s chat, and the run\'s own cwd still wins', async () => {
        const { h, engine, chatOf, on, turnOf, spawn } = await setup();
        const parentDir = tempDir('clowdy-thread-folders');

        for (const name of ['web', 'api']) {
            mkdirSync(join(parentDir, name));
        }

        const { project } = h.ok('project.add', { name: 'Shop', folders: ['web', 'api'].map(name => join(parentDir, name)) });
        const [web, api] = project.folders as { id: string; path: string }[];
        const inApi = h.ok('chat.create', { projectId: project.id, folderId: api.id }).chat as Chat;
        const inMain = h.ok('chat.create', { projectId: project.id }).chat as Chat;
        const runOfChat = (chatId: string) => h.run(chatOf(chatId).orchestratorRunId as string);

        for (const [chat, text] of [[inApi, 'Plan in the api'], [inMain, 'Plan in the web']] as const) {
            on(text, held(latch()));
            h.ok('chat.send', { chatId: chat.id, text });
            await waitFor(() => turnOf(text), `the turn on "${ text }" to start`);
        }

        const threadOfApi = await spawn(runOfChat(inApi.id), 'Look into the api');
        const threadOfMain = await spawn(runOfChat(inMain.id), 'Look into the web');
        const elsewhere = tempDir('clowdy-thread-own');
        const own = await spawn(runOfChat(inApi.id), 'Look elsewhere', held(latch()), { cwd: elsewhere });

        expect(chatOf(threadOfApi.threadId).folderId).toBe(api.id);
        expect(chatOf(threadOfMain.threadId)).not.toHaveProperty('folderId');
        expect(chatOf(own.threadId).folderId).toBe(api.id);
        expect(turnOf('Look into the api')?.cwd).toBe(api.path);
        expect(turnOf('Look into the web')?.cwd).toBe(web.path);
        expect(turnOf('Look elsewhere')?.cwd).toBe(elsewhere);
        expect(engine.turns).toHaveLength(5);
    });

    test('works in the folder it names, and refuses a folder that is not an absolute existing one, the fake engine and an unknown one, leaving nothing behind', async () => {
        const { store, exec, root, spawn } = await setup();
        const parent = await root('Plan the release', latch());
        const folder = tempDir('clowdy-thread-cwd');
        const thread = await spawn(parent.run, 'Work over there', held(latch()), { cwd: folder });

        expect(getRunWork(store.db, thread.run().id).cwd).toBe(folder);
        await waitFor(() => thread.run().status === 'running', 'the thread to run');

        await expect(exec(parent.run, 'thread_spawn', { prompt: 'Nope', cwd: 'relative/path' })).rejects.toThrow('cwd must be the absolute path of an existing folder: relative/path');
        await expect(exec(parent.run, 'thread_spawn', { prompt: 'Nope', cwd: join(folder, 'missing') })).rejects.toThrow(/absolute path of an existing folder/);
        await expect(exec(parent.run, 'thread_spawn', { prompt: 'Nope', engine: 'fake' })).rejects.toThrow(/fake engine is not available to agents/);
        await expect(exec(parent.run, 'thread_spawn', { prompt: 'Nope', engine: 'nobody' })).rejects.toThrow(/not available in this daemon/);
        await expect(exec(parent.run, 'thread_spawn', {})).rejects.toThrow(/Invalid input for thread_spawn/);

        expect((await exec(parent.run, 'thread_list')).threads.map((entry: { threadId: string }) => entry.threadId)).toEqual([thread.threadId]);
    });

    test('assigns the thread\'s run to its tasks and links its chat, refuses a task another run works on, and lets a chat started from a task hand it on', async () => {
        const { h, store, chatOf, exec, root, spawn, running, on } = await setup();
        const parent = await root('Plan the release', latch());
        const { task: a } = await exec(parent.run, 'task_create', { title: 'A' });
        const { task: b } = await exec(parent.run, 'task_create', { title: 'B', dependsOn: [a.key] });
        const first = await spawn(parent.run, 'Do A', held(latch()), { tasks: [a.key] });

        expect(store.db.query('SELECT run_id, relation FROM run_task_links WHERE task_id = ? AND relation = \'assigned\'').all(a.id)).toEqual([{ run_id: first.run().id, relation: 'assigned' }]);
        expect(store.db.query('SELECT chat_id FROM chat_task_links WHERE task_id = ? ORDER BY rowid').all(a.id)).toContainEqual({ chat_id: first.threadId });
        await waitFor(() => first.run().status === 'running', 'the thread on A to run');
        expect((await exec(parent.run, 'task_get', { taskId: a.key })).task.category).toBe('active');

        // A second thread on the same task would do the work twice.
        const twice = exec(parent.run, 'thread_spawn', { prompt: 'Do A again', tasks: [a.key] });

        await expect(twice).rejects.toMatchObject({ code: 'already_running', message: expect.stringContaining(`Task ${ a.key } already has an active run`) });

        // A task whose dependency is not Done makes the thread wait.
        const waiting = await exec(parent.run, 'thread_spawn', { prompt: 'Do B', tasks: [b.key] });

        expect(waiting.state).toBe('working');
        expect(h.run(chatOf(waiting.threadId).orchestratorRunId as string)).toMatchObject({ status: 'blocked', statusReason: `Waiting for ${ a.key }` });

        // The run of a chat started from a task may give the task to a thread of its own; then the thread has it.
        const { task: c } = await exec(parent.run, 'task_create', { title: 'C' });

        on(`This chat is bound to ${ c.key }; read it with \`clowdy task get ${ c.key }\`, do the work, and finish with a short report.`, held(latch()));

        const started = h.ok('task.start', { taskId: c.id });

        await running(started.chatId, 'finish with a short report.');

        const handed = await spawn(h.run(started.runId), 'Do C', held(latch()), { tasks: [c.key] });

        expect(handed.state).toBe('working');
        await expect(exec(h.run(started.runId), 'thread_spawn', { prompt: 'Do C twice', tasks: [c.key] })).rejects.toMatchObject({ code: 'already_running' });
    });
});

describe('thread_tell', () => {
    test('steers a busy thread, queues for its next turn, starts a turn of one at rest, and marks every message with its sender', async () => {
        const { engine, chatOf, bodies, exec, running, root, spawn } = await setup();
        const parent = await root('Plan the release', latch());
        const gate = latch();
        const thread = await spawn(parent.run, 'Fix the header', held(gate));
        const users = () => bodies(thread.run().id).filter(body => body.kind === 'user');

        await running(thread.threadId, 'Fix the header');
        engine.steerAnswer = () => true;

        // Steer, the default: the running turn takes it, and the stream shows it where the agent got it.
        expect(await exec(parent.run, 'thread_tell', { thread: thread.threadId, message: 'Also check the footer' })).toEqual({ delivery: 'queued' });
        await waitFor(() => users().length === 2, 'the steer to reach the stream');
        expect(engine.steered).toEqual([told(parent.chat, 'Also check the footer')]);
        expect(users()[1]).toEqual({ kind: 'user', text: 'Also check the footer', from: fromChat(parent.chat) });
        expect(chatOf(thread.threadId).queue).toBeUndefined();

        // Queue: it waits in the thread's queue with its sender, and is the next turn.
        expect(await exec(parent.run, 'thread_tell', { thread: thread.threadId, message: 'Then the header', mode: 'queue' })).toEqual({ delivery: 'queued' });
        expect(chatOf(thread.threadId).queue).toEqual([{
            id: expect.stringMatching(/^que_/),
            mode: 'queue',
            text: 'Then the header',
            content: told(parent.chat, 'Then the header'),
            from: fromChat(parent.chat),
            createdAt: expect.any(Number),
        }]);
        gate.release();
        await waitFor(() => engine.turns.some(turn => turn.prompt === told(parent.chat, 'Then the header')), 'the queued turn');
        await waitFor(() => thread.run().status === 'succeeded', 'the thread to rest');
        expect(users()[2]).toEqual({ kind: 'user', text: 'Then the header', from: fromChat(parent.chat) });

        // At rest: a turn starts on it at once.
        expect(await exec(parent.run, 'thread_tell', { thread: thread.threadId, message: 'One more thing' })).toEqual({ delivery: 'started' });
        await waitFor(() => engine.turns.some(turn => turn.prompt === told(parent.chat, 'One more thing')), 'the turn at rest');
        expect(users()[3]).toEqual({ kind: 'user', text: 'One more thing', from: fromChat(parent.chat) });
    });

    test('reaches the parent and a sibling, and refuses a chat outside the tree, the caller itself, an archived chat, and a stopped caller', async () => {
        const { h, project, chatOf, exec, root, spawn } = await setup();
        const parent = await root('Plan the release', latch());
        const first = await spawn(parent.run, 'First job', held(latch()));
        const second = await spawn(parent.run, 'Second job', held(latch()));

        await waitFor(() => first.run().status === 'running' && second.run().status === 'running', 'both threads to run');

        // Up to the busy parent: it waits in the parent's queue, from the thread.
        expect(await exec(first.run(), 'thread_tell', { thread: parent.chat.id, message: 'Found a bug', mode: 'queue' })).toEqual({ delivery: 'queued' });
        expect(chatOf(parent.chat.id).queue?.[0]).toMatchObject({ text: 'Found a bug', content: told(chatOf(first.threadId), 'Found a bug'), from: fromChat(chatOf(first.threadId)) });

        // Across to a sibling.
        expect(await exec(first.run(), 'thread_tell', { thread: second.threadId, message: 'Use the new API', mode: 'queue' })).toEqual({ delivery: 'queued' });
        expect(chatOf(second.threadId).queue?.[0]).toMatchObject({ text: 'Use the new API', from: fromChat(chatOf(first.threadId)) });

        const { chat: stranger } = h.ok('chat.create', { projectId: project.id, title: 'Somebody else' });

        await expect(exec(first.run(), 'thread_tell', { thread: stranger.id, message: 'Hi' })).rejects.toThrow(`Chat ${ stranger.id } is not in your thread tree`);
        await expect(exec(first.run(), 'thread_tell', { thread: first.threadId, message: 'Hi' })).rejects.toThrow('That is your own chat');
        await expect(exec(first.run(), 'thread_tell', { thread: 'cht_nope', message: 'Hi' })).rejects.toThrow('Thread cht_nope does not exist');

        // An archived thread takes no messages from threads.
        const done = await spawn(parent.run, 'Short job', says('Short answer'));

        await waitFor(() => done.run().status === 'succeeded', 'the short thread to finish');
        h.ok('chat.setArchived', { chatId: done.threadId, archived: true });
        await expect(exec(parent.run, 'thread_tell', { thread: done.threadId, message: 'Hi' })).rejects.toThrow(/is archived and takes no messages from threads/);
        expect(chatOf(done.threadId).archivedAt).toBeGreaterThan(0);

        // A stopped orchestrator whose session still makes a call starts nothing.
        h.ok('run.cancel', { runId: second.run().id });
        await expect(exec(second.run(), 'thread_tell', { thread: parent.chat.id, message: 'Late' })).rejects.toThrow(/is cancelled and cannot start threads or message them/);
        // The short thread's notice may wait there too; of the threads' messages only the first did.
        expect(chatOf(parent.chat.id).queue?.filter(item => item.from?.kind === 'thread')).toHaveLength(1);
    });
});

describe('thread_stop', () => {
    test('stops a thread below the caller as the person\'s Stop does, holds its queue, leaves its own threads going, and refuses one that is not below', async () => {
        const { chatOf, exec, root, spawn } = await setup();
        const parent = await root('Plan the release', latch());
        const child = await spawn(parent.run, 'Child job', held(latch()));

        await waitFor(() => child.run().status === 'running', 'the child to run');

        const grandchild = await spawn(child.run(), 'Grandchild job', held(latch()));

        await waitFor(() => grandchild.run().status === 'running', 'the grandchild to run');
        await exec(parent.run, 'thread_tell', { thread: child.threadId, message: 'Waiting message', mode: 'queue' });

        // Neither a chat above the caller nor the caller itself is below it.
        await expect(exec(grandchild.run(), 'thread_stop', { thread: child.threadId })).rejects.toThrow(/is not below you/);
        await expect(exec(child.run(), 'thread_stop', { thread: child.threadId })).rejects.toThrow(/is not below you/);

        expect(await exec(parent.run, 'thread_stop', { thread: child.threadId })).toEqual({ stopped: true, state: 'stopped' });
        await waitFor(() => child.run().status === 'cancelled', 'the child to stop');
        expect(child.run().statusReason).toBe('Stopped by Plan the release');
        expect(chatOf(child.threadId)).toMatchObject({ queuePaused: 'stopped', queue: [expect.objectContaining({ text: 'Waiting message' })] });

        // Its thread goes on; the caller can stop that one too, and a thread whose work is over is left as it is.
        expect(grandchild.run().status).toBe('running');
        expect(await exec(parent.run, 'thread_stop', { thread: child.threadId })).toEqual({ stopped: false, state: 'stopped' });
        expect(await exec(parent.run, 'thread_stop', { thread: grandchild.threadId })).toEqual({ stopped: true, state: 'stopped' });
        await waitFor(() => grandchild.run().status === 'cancelled', 'the grandchild to stop');
    });

    test('stops a thread that waits for a task it depends on, and leaves one that has no run yet', async () => {
        const { h, store, project, chatOf, exec, root } = await setup();
        const parent = await root('Plan the release', latch());
        const { task: a } = await exec(parent.run, 'task_create', { title: 'A' });
        const { task: b } = await exec(parent.run, 'task_create', { title: 'B', dependsOn: [a.key] });
        const waiting = await exec(parent.run, 'thread_spawn', { prompt: 'Do B', tasks: [b.key] });
        const run = () => h.run(chatOf(waiting.threadId).orchestratorRunId as string);

        expect(run().status).toBe('blocked');
        expect(await exec(parent.run, 'thread_stop', { thread: waiting.threadId })).toEqual({ stopped: true, state: 'stopped' });
        expect(run()).toMatchObject({ status: 'cancelled', statusReason: 'Stopped by Plan the release' });

        const fresh = createChat(store, { projectId: project.id, title: 'Not started yet', parentChatId: parent.chat.id });

        expect(await exec(parent.run, 'thread_stop', { thread: fresh.id })).toEqual({ stopped: false, state: 'new' });
    });
});

describe('thread_output and thread_log', () => {
    test('output is the latest turn\'s final answer, cut at 4,000 characters; a failed thread says why; background work it keeps open is listed', async () => {
        const { engine, exec, root, spawn, on } = await setup();
        const parent = await root('Plan the release', latch());
        const answered = await spawn(parent.run, 'Check the cache', says(`First I looked around. ${ 'Still looking. '.repeat(300) }`, 'The cache is fine.'));

        // Its final answer, whole: what it said on the way, however long, is not part of it.
        await waitFor(() => answered.run().status === 'succeeded', 'the thread to answer');
        expect(await exec(parent.run, 'thread_output', { thread: answered.threadId })).toEqual({
            threadId: answered.threadId,
            title: 'Check the cache',
            state: 'idle',
            text: 'The cache is fine.',
            open: [],
        });

        // Only what the latest turn said.
        on('And the database?', says('The database is fine too.'));
        await exec(parent.run, 'thread_tell', { thread: answered.threadId, message: 'And the database?' });
        await waitFor(() => engine.turns.some(turn => turn.prompt.endsWith('And the database?')) && answered.run().status === 'succeeded', 'the second answer');
        expect((await exec(parent.run, 'thread_output', { thread: answered.threadId })).text).toBe('The database is fine too.');

        const long = await spawn(parent.run, 'Write a lot', says('x'.repeat(5000)));

        await waitFor(() => long.run().status === 'succeeded', 'the long answer');
        expect((await exec(parent.run, 'thread_output', { thread: long.threadId })).text).toBe(`${ 'x'.repeat(4000) }\n\n[... 1000 more characters cut ...]`);

        // A cut never splits an emoji (two UTF-16 units) in two: a lone half is not valid text, and a strict JSON reader refuses the result over it.
        const emoji = `a${ '😀'.repeat(2500) }`;

        expect(clipOutput(emoji)).toBe(`a${ '😀'.repeat(1999) }\n\n[... 1002 more characters cut ...]`);
        expect(clip(`ab${ '😀'.repeat(5) }`, 4)).toBe('ab…');

        const failed = await spawn(parent.run, 'Fall over', async function* ({ number }) {
            yield { type: 'session', sessionId: `s-${ number }` };
            yield { type: 'error', message: 'The agent fell over' };
        });

        await waitFor(() => failed.run().status === 'failed', 'the thread to fail');
        expect(await exec(parent.run, 'thread_output', { thread: failed.threadId })).toMatchObject({ state: 'failed', text: null, error: 'The agent fell over' });

        // A session that keeps background work open: idle, and its work is listed.
        engine.sendAnswer = () => true;

        const lingering = await spawn(parent.run, 'Start the build', async function* (turn) {
            yield { type: 'session', sessionId: `s-${ turn.number }` };
            yield { type: 'text', delta: 'Started the build', done: true };
            yield { type: 'background', items: [{ id: 'bg-1', kind: 'command', title: 'bun run build' }] };
            yield { type: 'done', result: 'Started the build' };
            await turn.hold(latch());
        });

        await waitFor(() => lingering.run().status === 'waiting_background', 'the thread to wait for its build');
        expect(await exec(parent.run, 'thread_output', { thread: lingering.threadId })).toMatchObject({ state: 'idle', reason: 'Waiting for background work', text: 'Started the build', open: ['bun run build'] });
        expect((await exec(parent.run, 'thread_list')).threads.find((entry: { threadId: string }) => entry.threadId === lingering.threadId)).toMatchObject({ state: 'idle', open: ['bun run build'] });
    });

    test('log shows the last lines with their numbers and who wrote each message', async () => {
        const { h, exec, root, spawn, on } = await setup();
        const parent = await root('Plan the release', latch());
        const thread = await spawn(parent.run, 'Check the tasks', async function* (turn) {
            yield { type: 'session', sessionId: `s-${ turn.number }` };
            yield* turn.call('task_list');
            yield { type: 'text', delta: 'All clear\nnothing to do', done: true };
            yield { type: 'done', result: 'All clear' };
        });

        await waitFor(() => thread.run().status === 'succeeded', 'the thread to answer');
        on('Person here', says('Hello'));
        h.ok('chat.send', { chatId: thread.threadId, text: 'Person here' });
        await waitFor(() => thread.run().status === 'succeeded' && h.run(thread.run().id).result === 'Hello', 'the answer to the person');

        const { lines } = await exec(parent.run, 'thread_log', { thread: thread.threadId });

        expect(lines).toEqual([
            `#1 thread "Plan the release" (${ parent.chat.id }): Check the tasks`,
            '#2 tool task_list (done)',
            '#3 assistant: All clear nothing to do',
            '#4 person: Person here',
            '#5 assistant: Hello',
        ]);
        expect(await exec(parent.run, 'thread_log', { thread: thread.threadId, limit: 2 })).toEqual({ threadId: thread.threadId, title: 'Check the tasks', state: 'idle', lines: lines.slice(3) });
        await expect(exec(parent.run, 'thread_log', { thread: thread.threadId, limit: 101 })).rejects.toThrow(/Invalid input for thread_log/);

        // The thread reads its parent's log too: any chat of the tree.
        expect((await exec(thread.run(), 'thread_log', { thread: parent.chat.id })).lines[0]).toBe('#1 person: Plan the release');
    });
});

describe('thread_log and reasoning', () => {
    test('leaves out what the thread thought, and the limit counts the lines it shows', async () => {
        const { exec, root, spawn } = await setup();
        const parent = await root('Plan the release', latch());
        const thought = (text: string): EngineEvent[] => [{ type: 'thought', delta: text, done: false }, { type: 'thought', delta: '', done: true }];
        const thread = await spawn(parent.run, 'Check the tasks', async function* (turn) {
            yield { type: 'session', sessionId: `s-${ turn.number }` };
            yield* thought('Let me look at the tasks first.');
            yield* turn.call('task_list');
            yield* thought('Nothing to do.');
            yield* thought('Really nothing.');
            yield { type: 'text', delta: 'All clear', done: true };
            yield { type: 'done', result: 'All clear' };
        });

        await waitFor(() => thread.run().status === 'succeeded', 'the thread to answer');

        const { lines } = await exec(parent.run, 'thread_log', { thread: thread.threadId });

        // Items 2, 4 and 5 are thoughts: the numbers keep their place in the stream.
        expect(lines).toEqual([`#1 thread "Plan the release" (${ parent.chat.id }): Check the tasks`, '#3 tool task_list (done)', '#6 assistant: All clear']);
        // The two lines of the rest, though the last two items of the stream are a thought and a message.
        expect((await exec(parent.run, 'thread_log', { thread: thread.threadId, limit: 2 })).lines).toEqual(lines.slice(1));
    });
});

describe('thread_list', () => {
    test('lists the caller\'s own threads, or every chat below it with its depth and parent', async () => {
        const { exec, root, spawn } = await setup();
        const parent = await root('Plan the release', latch());
        const a = await spawn(parent.run, 'Job A', held(latch()));
        const b = await spawn(parent.run, 'Job B', says('B is done'), { model: 'small' });

        await waitFor(() => a.run().status === 'running' && b.run().status === 'succeeded', 'A to run and B to finish');

        const a1 = await spawn(a.run(), 'Job A1', held(latch()));
        const own = (await exec(parent.run, 'thread_list')).threads;

        expect(own).toEqual([
            { threadId: a.threadId, title: 'Job A', parent: parent.chat.id, state: 'working', engine: 'fake', open: [], updatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) },
            { threadId: b.threadId, title: 'Job B', parent: parent.chat.id, state: 'idle', engine: 'fake', model: 'small', open: [], updatedAt: expect.any(String) },
        ]);

        const all = (await exec(parent.run, 'thread_list', { all: true })).threads;

        expect(all.map((entry: { threadId: string; depth: number; parent: string }) => [entry.threadId, entry.depth, entry.parent])).toEqual([
            [a.threadId, 1, parent.chat.id],
            [b.threadId, 1, parent.chat.id],
            [a1.threadId, 2, a.threadId],
        ]);
        expect((await exec(a.run(), 'thread_list')).threads.map((entry: { threadId: string }) => entry.threadId)).toEqual([a1.threadId]);
        expect((await exec(a1.run(), 'thread_list', { all: true })).threads).toEqual([]);
    });
});

describe('thread limits', () => {
    test('a tree is three levels deep: a thread of a thread starts none', async () => {
        const { exec, root, spawn } = await setup();
        const parent = await root('Plan the release', latch());
        const child = await spawn(parent.run, 'Child job', held(latch()));

        await waitFor(() => child.run().status === 'running', 'the child to run');

        const grandchild = await spawn(child.run(), 'Grandchild job', held(latch()));

        await waitFor(() => grandchild.run().status === 'running', 'the grandchild to run');
        await expect(exec(grandchild.run(), 'thread_spawn', { prompt: 'Too deep' })).rejects.toMatchObject({
            code: 'conflict',
            message: expect.stringContaining('Threads nest 3 levels deep at most, counting the chat the person started, and this chat is level 3'),
        });
        expect((await exec(grandchild.run(), 'thread_list')).threads).toEqual([]);
    });

    test('a chat has at most so many threads at work, a thread without a run counting, and room comes back when one stops', async () => {
        const { store, project, exec, root, spawn } = await setup({ maxActiveThreads: 2 });
        const parent = await root('Plan the release', latch());
        const first = await spawn(parent.run, 'First job', held(latch()));

        createChat(store, { projectId: project.id, title: 'Not started yet', parentChatId: parent.chat.id });
        await expect(exec(parent.run, 'thread_spawn', { prompt: 'Third job' })).rejects.toThrow('This chat has 2 threads at work, the most it may have at once; a thread whose turn is over counts while its background work runs. Start the next when one is done (you are told each time one stops)');

        await exec(parent.run, 'thread_stop', { thread: first.threadId });
        await waitFor(() => first.run().status === 'cancelled', 'the first thread to stop');

        expect((await spawn(parent.run, 'Third job', says('Third done'))).state).toBe('working');
    });

    test('a chat starts at most so many threads over its life, finished ones counting', async () => {
        const { exec, root, spawn } = await setup({ maxThreads: 2 });
        const parent = await root('Plan the release', latch());
        const first = await spawn(parent.run, 'First job', says('One'));
        const second = await spawn(parent.run, 'Second job', says('Two'));

        await waitFor(() => first.run().status === 'succeeded' && second.run().status === 'succeeded', 'both threads to finish');
        await expect(exec(parent.run, 'thread_spawn', { prompt: 'Third job' })).rejects.toThrow('This chat has started 2 threads, the most one chat may start');
    });
});

describe('archive and delete', () => {
    /** A finished chat with a thread A and A's thread A1, both finished, and the notices of their stops answered up the tree. */
    async function tree() {
        const context = await setup();
        const { root, spawn, chatOf, noticesTo } = context;
        const gate = latch();
        const parent = await root('Plan the release', gate);
        const childGate = latch();
        const child = await spawn(parent.run, 'Child job', held(childGate));

        await waitFor(() => child.run().status === 'running', 'the child to run');

        const grandchild = await spawn(child.run(), 'Grandchild job', says('Grandchild done'));

        gate.release();
        childGate.release();
        // The child answers its thread's notice ("Done"), and the parent hears of that answer last.
        await waitFor(() => noticesTo(parent.chat.id).at(-1)?.some(notice => notice.chatId === child.threadId && notice.text === 'Done')
            && [parent.run.id, child.run().id, grandchild.run().id].every(id => context.h.run(id).status === 'succeeded')
            && !chatOf(parent.chat.id).queue && !chatOf(child.threadId).queue, 'the tree to finish');

        return { ...context, parent, child, grandchild };
    }

    test('archiving a chat archives its threads, bringing it back brings only the chat, and a thread at work refuses the archive', async () => {
        const { h, chatOf, parent, child, grandchild, exec, on } = await tree();
        const ids = [parent.chat.id, child.threadId, grandchild.threadId];

        h.ok('chat.setArchived', { chatId: parent.chat.id, archived: true });

        const archivedAt = chatOf(parent.chat.id).archivedAt;

        expect(ids.map(id => chatOf(id).archivedAt)).toEqual([archivedAt, archivedAt, archivedAt]);

        h.ok('chat.setArchived', { chatId: parent.chat.id, archived: false });
        expect(ids.map(id => chatOf(id).archivedAt)).toEqual([undefined, archivedAt, archivedAt]);

        // A message to the parent brings it to work again, and the thread it starts keeps the archive from happening.
        on('Again', async function* (turn) {
            yield { type: 'session', sessionId: `s-${ turn.number }` };
            yield* turn.call('thread_spawn', { prompt: 'Busy job', title: 'Busy thread' });
            yield { type: 'done', result: 'Started it' };
        });
        on('Busy job', async function* ({ number, signal }) {
            yield { type: 'session', sessionId: `s-${ number }` };
            await untilAborted(signal);
        });
        h.ok('chat.send', { chatId: parent.chat.id, text: 'Again' });
        await waitFor(() => h.run(parent.run.id).status === 'succeeded' && h.run(parent.run.id).result === 'Started it', 'the parent to start a thread');

        const busy = (await exec(h.run(parent.run.id), 'thread_list')).threads.find((entry: { title: string }) => entry.title === 'Busy thread');

        await waitFor(() => h.run(chatOf(busy.threadId).orchestratorRunId as string).status === 'running', 'the busy thread to run');
        expect(h.send('chat.setArchived', { chatId: parent.chat.id, archived: true })).toMatchObject({
            ok: false,
            error: { code: 'conflict', message: 'The thread "Busy thread" below this chat is still working. Stop it first.' },
        });
        expect(ids.map(id => chatOf(id).archivedAt)).toEqual([undefined, archivedAt, archivedAt]);
        expect(chatOf(busy.threadId).archivedAt).toBeUndefined();
    });

    test('deleting a chat deletes every thread below it with its runs, announcing each chat, the deepest first', async () => {
        const { h, store, parent, child, grandchild } = await tree();
        const runIds = [grandchild.run().id, child.run().id, parent.run.id];
        const cursor = store.headCursor();

        h.ok('chat.delete', { chatId: parent.chat.id });

        const deleted = h.events(cursor).map(event => event.data as { type: string; chatId: string; runIds: string[] });

        expect(deleted.map(event => [event.type, event.chatId, event.runIds])).toEqual([
            ['chat.deleted', grandchild.threadId, [runIds[0]]],
            ['chat.deleted', child.threadId, [runIds[1]]],
            ['chat.deleted', parent.chat.id, [runIds[2]]],
        ]);
        expect([parent.chat.id, child.threadId, grandchild.threadId].map(id => getChat(store.db, id))).toEqual([undefined, undefined, undefined]);
        expect(store.db.query(`SELECT COUNT(*) AS n FROM runs WHERE id IN (${ runIds.map(() => '?').join(', ') })`).get(...runIds)).toEqual({ n: 0 });
    });

    test('a delete is refused while a thread below the chat works, naming it, and deletes nothing', async () => {
        const { h, store, chatOf, root, spawn } = await setup();
        const gate = latch();
        const parent = await root('Plan the release', gate);
        const child = await spawn(parent.run, 'Long job', held(latch()), { title: 'Long thread' });

        gate.release();
        await waitFor(() => h.run(parent.run.id).status === 'succeeded' && child.run().status === 'running', 'the parent to finish while its thread works');
        expect(h.send('chat.delete', { chatId: parent.chat.id })).toMatchObject({
            ok: false,
            error: { code: 'conflict', message: 'The thread "Long thread" below this chat is still working. Stop it first.' },
        });
        expect(chatOf(parent.chat.id)).toBeDefined();
        expect(chatOf(child.threadId)).toBeDefined();
        expect(store.db.query('SELECT COUNT(*) AS n FROM chats WHERE parent_chat_id = ?').get(parent.chat.id)).toEqual({ n: 1 });
    });
});

describe('a scripted orchestrator', () => {
    test('spawns a thread, steers it, queues for it, reads its output and log, and stops it, each through its tools', async () => {
        const { h, engine, project, chatOf, bodies, on, runOf } = await setup();
        const results: Record<string, any> = {};

        engine.steerAnswer = () => true;
        on('Worker job', async function* ({ number, signal }) {
            yield { type: 'session', sessionId: `s-${ number }` };
            yield { type: 'text', delta: 'Working on it', done: true };
            await untilAborted(signal);
        });
        on('Coordinate the work', async function* (turn) {
            yield { type: 'session', sessionId: `s-${ turn.number }` };
            results.spawned = yield* turn.call('thread_spawn', { prompt: 'Worker job', title: 'Worker' });

            const thread = results.spawned.threadId as string;

            await waitFor(() => runOf(thread).status === 'running' && engine.turns.some(options => options.prompt.endsWith('Worker job')), 'the worker to run');
            results.steer = yield* turn.call('thread_tell', { thread, message: 'Steer this' });
            await waitFor(() => engine.steered.length === 1, 'the steer to reach the worker');
            results.queue = yield* turn.call('thread_tell', { thread, message: 'Queue this', mode: 'queue' });
            results.output = yield* turn.call('thread_output', { thread });
            results.log = yield* turn.call('thread_log', { thread });
            results.stop = yield* turn.call('thread_stop', { thread });
            yield { type: 'text', delta: 'Coordinated', done: true };
            yield { type: 'done', result: 'Coordinated' };
        });

        const { chat } = h.ok('chat.create', { projectId: project.id }) as { chat: Chat };
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Coordinate the work' });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to finish', 8000);

        const thread = results.spawned.threadId as string;
        const parent = chatOf(chat.id);

        expect(results.spawned).toMatchObject({ title: 'Worker', state: 'working' });
        expect(results.steer).toEqual({ delivery: 'queued' });
        expect(results.queue).toEqual({ delivery: 'queued' });
        expect(results.output).toMatchObject({ threadId: thread, title: 'Worker', state: 'working' });
        expect(results.log.lines[0]).toBe(`#1 thread "Coordinate the work" (${ chat.id }): Worker job`);
        expect(results.log.lines).toContain(`#3 thread "Coordinate the work" (${ chat.id }): Steer this`);
        expect(results.stop).toEqual({ stopped: true, state: 'stopped' });
        expect(engine.steered).toEqual([told(parent, 'Steer this')]);
        expect(chatOf(thread)).toMatchObject({ parentChatId: chat.id, queuePaused: 'stopped', queue: [expect.objectContaining({ text: 'Queue this', from: fromChat(parent) })] });
        await waitFor(() => runOf(thread).status === 'cancelled', 'the worker to stop');

        // Each call is a tool card in the orchestrator's stream.
        expect(bodies(runId).flatMap(body => (body.kind === 'tool' ? [[body.name, body.state]] : []))).toEqual([
            ['thread_spawn', 'done'],
            ['thread_tell', 'done'],
            ['thread_tell', 'done'],
            ['thread_output', 'done'],
            ['thread_log', 'done'],
            ['thread_stop', 'done'],
        ]);
    });
});

/** The line every notice ends with. */
const RULE = 'Do not reply to this message just to acknowledge it, and do not message a thread unless you need something from it.';

/** Long enough for the notice window that every test waits through to have passed several times over. */
const QUIET_MS = 200;

const finished = (chatId: string, title: string, text: string): ThreadNotice => ({ chatId, title, outcome: 'finished', text });

describe('notices to the parent', () => {
    test('a thread\'s turn that ends tells its parent at rest once, with its final answer, and the parent starts a turn on it', async () => {
        const { h, engine, chatOf, exec, root, spawn, noticesTo, bodies } = await setup();
        const gate = latch();
        const parent = await root('Plan the release', gate);
        const threadGate = latch();
        const thread = await spawn(parent.run, 'Check the cache', answers(threadGate, 'The cache is fine'));
        const content = `[Thread "Check the cache" (${ thread.threadId }) finished]\n\nThe cache is fine\n\n${ RULE }`;

        gate.release();
        await waitFor(() => h.run(parent.run.id).status === 'succeeded', 'the parent to rest');
        threadGate.release();
        await waitFor(() => engine.prompts.includes(content) && h.run(parent.run.id).status === 'succeeded', 'the parent\'s turn on the notice');

        // A notice has no words of its own: the stream draws it from `from`, and the agent reads the content.
        expect(bodies(parent.run.id).filter(body => body.kind === 'user').at(-1)).toEqual({
            kind: 'user',
            text: '',
            from: { kind: 'threadNotice', threads: [finished(thread.threadId, 'Check the cache', 'The cache is fine')] },
        });
        expect(engine.turns.find(turn => turn.prompt === content)?.resumeSessionId).toBe('s-1');
        expect(chatOf(parent.chat.id).queue).toBeUndefined();
        await Bun.sleep(QUIET_MS);
        expect(noticesTo(parent.chat.id)).toHaveLength(1);
        expect(h.run(parent.run.id)).toMatchObject({ status: 'succeeded', result: 'Done' });
        // The parent's log says how the thread stopped.
        expect((await exec(thread.run(), 'thread_log', { thread: parent.chat.id })).lines.slice(-2)).toEqual(['#3 notice: "Check the cache" finished', '#4 assistant: Done']);
    });

    test('two stops of one thread inside the window are one notice with the latest answer', async () => {
        const { h, engine, root, spawn, on, noticesTo } = await setup({ timings: { ...SHORT_TIMINGS, noticeWindowMs: 500 } });
        const gate = latch();
        const parent = await root('Plan the release', gate);
        const threadGate = latch();
        const thread = await spawn(parent.run, 'Check the cache', answers(threadGate, 'First answer'));

        on('Look again', says('Second answer'));
        gate.release();
        await waitFor(() => h.run(parent.run.id).status === 'succeeded', 'the parent to rest');
        threadGate.release();
        await waitFor(() => thread.run().status === 'succeeded' && thread.run().result === 'First answer', 'the first answer');
        h.ok('chat.send', { chatId: thread.threadId, text: 'Look again' });
        await waitFor(() => thread.run().status === 'succeeded' && thread.run().result === 'Second answer', 'the second answer');
        await waitFor(() => noticesTo(parent.chat.id).length > 0 && h.run(parent.run.id).status === 'succeeded', 'the notice');
        await Bun.sleep(600);

        expect(noticesTo(parent.chat.id)).toEqual([[finished(thread.threadId, 'Check the cache', 'Second answer')]]);
        expect(engine.prompts.filter(prompt => prompt.includes('[Thread "Check the cache"'))).toEqual([`[Thread "Check the cache" (${ thread.threadId }) finished]\n\nSecond answer\n\n${ RULE }`]);
    });

    test('stops of two threads inside the window are one message with an entry for each', async () => {
        const { h, engine, root, spawn, noticesTo } = await setup({ timings: { ...SHORT_TIMINGS, noticeWindowMs: 300 } });
        const gate = latch();
        const parent = await root('Plan the release', gate);
        const gateA = latch();
        const gateB = latch();
        const a = await spawn(parent.run, 'Job A', answers(gateA, 'A is done'));
        const b = await spawn(parent.run, 'Job B', answers(gateB, 'B is done'));

        gate.release();
        await waitFor(() => h.run(parent.run.id).status === 'succeeded', 'the parent to rest');
        gateA.release();
        gateB.release();
        await waitFor(() => noticesTo(parent.chat.id).length > 0 && h.run(parent.run.id).status === 'succeeded', 'the notice');
        await Bun.sleep(400);

        const [notice] = noticesTo(parent.chat.id);
        const block = (entry: ThreadNotice) => `[Thread "${ entry.title }" (${ entry.chatId }) finished]\n\n${ entry.text }`;

        expect(noticesTo(parent.chat.id)).toHaveLength(1);
        expect([...notice].sort((x, y) => x.title.localeCompare(y.title))).toEqual([finished(a.threadId, 'Job A', 'A is done'), finished(b.threadId, 'Job B', 'B is done')]);
        expect(engine.prompts).toContain(`Threads that stopped:\n\n${ block(notice[0]) }\n\n${ block(notice[1]) }\n\n${ RULE }`);
    });

    test('a thread whose session waits for background work says so with the work\'s titles, and its own report turn tells the parent again', async () => {
        const { h, engine, root, spawn, noticesTo } = await setup();
        const gate = latch();
        const begin = latch();
        const build = latch();
        const sessionEnd = latch();

        engine.sendAnswer = () => true;

        const parent = await root('Plan the release', gate);
        const thread = await spawn(parent.run, 'Start the build', async function* (turn) {
            yield { type: 'session', sessionId: `s-${ turn.number }` };
            await turn.hold(begin);
            yield { type: 'text', delta: 'Started the build', done: true };
            yield { type: 'background', items: [{ id: 'bg-1', kind: 'command', title: 'bun run build' }] };
            yield { type: 'done', result: 'Started the build' };

            if (!await turn.hold(build)) {
                return;
            }

            // The agent reports by itself once the build is over, and its session stays a while longer before it ends.
            yield { type: 'background', items: [] };
            yield { type: 'text', delta: 'The build passed', done: true };
            yield { type: 'done', result: 'The build passed' };
            await turn.hold(sessionEnd);
        });
        const waiting = `[Thread "Start the build" (${ thread.threadId }) finished its turn and still has work running in the background: bun run build]\n\nStarted the build\n\nThis is not its final result; it will report again when that work finishes.\n\n${ RULE }`;

        gate.release();
        await waitFor(() => h.run(parent.run.id).status === 'succeeded', 'the parent to rest');
        begin.release();
        await waitFor(() => engine.prompts.includes(waiting) && h.run(parent.run.id).status === 'succeeded', 'the first notice');
        expect(thread.run().status).toBe('waiting_background');
        expect(noticesTo(parent.chat.id)).toEqual([[{ chatId: thread.threadId, title: 'Start the build', outcome: 'finished', text: 'Started the build', background: ['bun run build'] }]]);

        build.release();
        await waitFor(() => noticesTo(parent.chat.id).length === 2 && h.run(parent.run.id).status === 'succeeded', 'the second notice');
        expect(noticesTo(parent.chat.id)[1]).toEqual([finished(thread.threadId, 'Start the build', 'The build passed')]);
        expect(engine.prompts).toContain(`[Thread "Start the build" (${ thread.threadId }) finished]\n\nThe build passed\n\n${ RULE }`);

        // The session's end after the report is no turn of its own: the parent was told already.
        sessionEnd.release();
        await waitFor(() => thread.run().status === 'succeeded', 'the thread\'s session to end');
        await Bun.sleep(QUIET_MS);
        expect(noticesTo(parent.chat.id)).toHaveLength(2);
    });

    test('a session that ends without the report its notice promised tells the parent that the thread finished', async () => {
        const { h, engine, root, spawn, noticesTo } = await setup();
        const gate = latch();
        const begin = latch();
        const gone = latch();

        engine.sendAnswer = () => true;

        const parent = await root('Plan the release', gate);
        const thread = await spawn(parent.run, 'Start the build', async function* (turn) {
            yield { type: 'session', sessionId: `s-${ turn.number }` };
            await turn.hold(begin);
            yield { type: 'text', delta: 'Started the build', done: true };
            yield { type: 'background', items: [{ id: 'bg-1', kind: 'command', title: 'bun run build' }] };
            yield { type: 'done', result: 'Started the build' };
            // The process goes away with the work: no report turn.
            await turn.hold(gone);
        });

        gate.release();
        await waitFor(() => h.run(parent.run.id).status === 'succeeded', 'the parent to rest');
        begin.release();
        await waitFor(() => noticesTo(parent.chat.id).length === 1 && h.run(parent.run.id).status === 'succeeded', 'the first notice');
        gone.release();
        await waitFor(() => noticesTo(parent.chat.id).length === 2, 'the second notice');

        expect(thread.run()).toMatchObject({ status: 'succeeded', result: 'Started the build' });
        expect(noticesTo(parent.chat.id)[1]).toEqual([finished(thread.threadId, 'Start the build', 'Started the build')]);
    });

    test('a report turn of the agent\'s own that says nothing tells the parent that the thread finished, without the words of the turn before it', async () => {
        const { h, engine, root, spawn, noticesTo } = await setup();
        const gate = latch();
        const begin = latch();
        const build = latch();
        const sessionEnd = latch();

        engine.sendAnswer = () => true;

        const parent = await root('Plan the release', gate);
        const thread = await spawn(parent.run, 'Start the build', async function* (turn) {
            yield { type: 'session', sessionId: `s-${ turn.number }` };
            await turn.hold(begin);
            yield { type: 'text', delta: 'Started the build', done: true };
            yield { type: 'background', items: [{ id: 'bg-1', kind: 'command', title: 'bun run build' }] };
            yield { type: 'done', result: 'Started the build' };

            if (!await turn.hold(build)) {
                return;
            }

            // The agent's own turn after the build looks at it and says nothing, and its `done` carries no result.
            yield { type: 'background', items: [] };
            yield { type: 'tool', toolCallId: 'look', name: 'Read', input: { title: 'Read build.log' }, state: 'done', output: 'ok' };
            yield { type: 'done' };
            await turn.hold(sessionEnd);
        });

        gate.release();
        await waitFor(() => h.run(parent.run.id).status === 'succeeded', 'the parent to rest');
        begin.release();
        await waitFor(() => noticesTo(parent.chat.id).length === 1 && h.run(parent.run.id).status === 'succeeded', 'the first notice');
        expect(thread.run().status).toBe('waiting_background');

        build.release();
        await waitFor(() => noticesTo(parent.chat.id).length === 2 && h.run(parent.run.id).status === 'succeeded', 'the second notice');
        expect(noticesTo(parent.chat.id)[1]).toEqual([{ chatId: thread.threadId, title: 'Start the build', outcome: 'finished' }]);

        // The session's end after it tells nothing more: the parent knows the thread is done.
        sessionEnd.release();
        await waitFor(() => thread.run().status === 'succeeded', 'the thread\'s session to end');
        await Bun.sleep(QUIET_MS);
        expect(noticesTo(parent.chat.id)).toHaveLength(2);
    });

    test('a turn that says nothing and leaves nothing open tells nothing', async () => {
        const { h, root, spawn, on, noticesTo } = await setup();
        const gate = latch();
        const begin = latch();
        const parent = await root('Plan the release', gate);
        const thread = await spawn(parent.run, 'Stay quiet', async function* (turn) {
            yield { type: 'session', sessionId: `s-${ turn.number }` };
            await turn.hold(begin);
            yield { type: 'done' };
        });

        // An agent whose `done` carries no result: its last message is the turn's text.
        on('Say something', async function* (turn) {
            yield { type: 'session', sessionId: `s-${ turn.number }` };
            yield { type: 'text', delta: 'Now I speak', done: true };
            yield { type: 'done' };
        });
        gate.release();
        await waitFor(() => h.run(parent.run.id).status === 'succeeded', 'the parent to rest');
        begin.release();
        await waitFor(() => thread.run().status === 'succeeded', 'the quiet turn to end');
        await Bun.sleep(QUIET_MS);
        expect(noticesTo(parent.chat.id)).toEqual([]);

        // The same thread's next turn says something, and that one is told.
        h.ok('chat.send', { chatId: thread.threadId, text: 'Say something' });
        await waitFor(() => noticesTo(parent.chat.id).length === 1, 'the notice of the turn that spoke');
        expect(noticesTo(parent.chat.id)).toEqual([[finished(thread.threadId, 'Stay quiet', 'Now I speak')]]);
    });

    test('a thread stopped by thread_stop or by the person\'s Stop tells nothing', async () => {
        const { h, exec, root, spawn, noticesTo } = await setup();
        const gate = latch();
        const parent = await root('Plan the release', gate);
        const byParent = await spawn(parent.run, 'Job A', held(latch()));
        const byPerson = await spawn(parent.run, 'Job B', held(latch()));
        const lastGate = latch();
        const last = await spawn(parent.run, 'Job C', answers(lastGate, 'C is done'));

        gate.release();
        await waitFor(() => h.run(parent.run.id).status === 'succeeded' && byParent.run().status === 'running' && byPerson.run().status === 'running', 'the parent to rest while A and B work');
        expect(await exec(parent.run, 'thread_stop', { thread: byParent.threadId })).toMatchObject({ stopped: true });
        h.ok('run.cancel', { runId: byPerson.run().id });
        await waitFor(() => byParent.run().status === 'cancelled' && byPerson.run().status === 'cancelled', 'both to stop');
        await Bun.sleep(QUIET_MS);
        expect(noticesTo(parent.chat.id)).toEqual([]);

        lastGate.release();
        await waitFor(() => noticesTo(parent.chat.id).length === 1, 'the notice of the thread that finished');
        await Bun.sleep(QUIET_MS);
        expect(noticesTo(parent.chat.id)).toEqual([[finished(last.threadId, 'Job C', 'C is done')]]);
    });

    test('a compact turn of a thread tells nothing, though the agent says something about it', async () => {
        const { h, root, spawn, onPrompt, noticesTo } = await setup();
        const gate = latch();
        const parent = await root('Plan the release', gate);
        const thread = await spawn(parent.run, 'Check the cache', says('The cache is fine'), { engine: 'claude' });

        onPrompt(prompt => prompt === '/compact', says('Compacted the conversation'));
        gate.release();
        await waitFor(() => noticesTo(parent.chat.id).length === 1 && h.run(parent.run.id).status === 'succeeded' && thread.run().status === 'succeeded', 'the notice of the first answer');

        h.ok('chat.compact', { chatId: thread.threadId });
        await waitFor(() => thread.run().status === 'succeeded' && thread.run().result === 'Compacted the conversation', 'the compact turn');
        await Bun.sleep(QUIET_MS);
        expect(noticesTo(parent.chat.id)).toEqual([[finished(thread.threadId, 'Check the cache', 'The cache is fine')]]);
    });

    test('a thread that fails always tells its parent, with the error and how to look at it', async () => {
        const { h, engine, root, spawn, noticesTo } = await setup();
        const gate = latch();
        const begin = latch();
        const parent = await root('Plan the release', gate);
        const thread = await spawn(parent.run, 'Fall over', async function* (turn) {
            yield { type: 'session', sessionId: `s-${ turn.number }` };
            await turn.hold(begin);
            yield { type: 'text', delta: 'Trying', done: true };
            yield { type: 'error', message: 'The agent fell over' };
        });

        gate.release();
        await waitFor(() => h.run(parent.run.id).status === 'succeeded', 'the parent to rest');
        begin.release();
        await waitFor(() => noticesTo(parent.chat.id).length === 1 && h.run(parent.run.id).status === 'succeeded', 'the notice');

        expect(thread.run().status).toBe('failed');
        expect(noticesTo(parent.chat.id)).toEqual([[{ chatId: thread.threadId, title: 'Fall over', outcome: 'failed', text: 'The agent fell over' }]]);
        expect(engine.prompts).toContain(`[Thread "Fall over" (${ thread.threadId }) failed]\n\nThe agent fell over\n\nLook at it with clowdy thread log ${ thread.threadId } before deciding what to do.\n\n${ RULE }`);
    });

    test('a thread that a restart interrupted tells its parent once, and the next start does not tell it again', async () => {
        const { h, engine, root, spawn } = await setup();
        const gate = latch();
        const parent = await root('Plan the release', gate);
        const thread = await spawn(parent.run, 'Long job', held(latch()));
        const notices = (harness: Harness) => listItems(harness.store.db, parent.run.id, 0).filter(item => item.body.kind === 'user' && item.body.from?.kind === 'threadNotice');
        const content = `[Thread "Long job" (${ thread.threadId }) was interrupted because the daemon restarted]\n\n${ RULE }`;

        gate.release();
        await waitFor(() => h.run(parent.run.id).status === 'succeeded' && thread.run().status === 'running', 'the parent to rest while its thread works');

        const threadRunId = thread.run().id;

        await h.stop();

        const second = await restartHarness(h, { engines: scriptEngines(engine) });

        harnesses.push(second);
        await waitFor(() => engine.prompts.includes(content) && second.run(parent.run.id).status === 'succeeded', 'the parent\'s turn on the notice');
        expect(second.run(threadRunId).status).toBe('interrupted');
        expect(notices(second).map(item => item.body)).toEqual([{
            kind: 'user',
            text: '',
            from: { kind: 'threadNotice', threads: [{ chatId: thread.threadId, title: 'Long job', outcome: 'interrupted' }] },
        }]);

        await second.stop();

        const third = await restartHarness(second, { engines: scriptEngines(engine) });

        harnesses.push(third);
        await Bun.sleep(QUIET_MS);
        expect(notices(third)).toHaveLength(1);
        expect(engine.prompts.filter(prompt => prompt === content)).toHaveLength(1);
    });

    test('a notice that waits in the queue survives a restart, held with the queue of the parent the restart interrupted', async () => {
        const { h, engine, chatOf, root, spawn } = await setup();
        const parent = await root('Plan the release', latch());

        await spawn(parent.run, 'Quick job', says('Quick answer'));
        await waitFor(() => chatOf(parent.chat.id).queue?.length === 1, 'the notice in the busy parent\'s queue');

        const waiting = chatOf(parent.chat.id).queue;

        await h.stop();

        const second = await restartHarness(h, { engines: scriptEngines(engine) });

        harnesses.push(second);
        expect(getChat(second.store.db, parent.chat.id)).toMatchObject({ queuePaused: 'failed', queue: waiting });
        expect(second.run(parent.run.id).status).toBe('interrupted');
    });

    test('a busy parent gets the notice in its queue, merged with the next of the same thread and with another thread\'s, and takes it as its next turn', async () => {
        const { h, engine, chatOf, root, spawn, on, noticesTo, bodies } = await setup();
        const gate = latch();
        const parent = await root('Plan the release', gate);
        const gateA = latch();
        const gateB = latch();
        const a = await spawn(parent.run, 'Job A', answers(gateA, 'A first'));
        const b = await spawn(parent.run, 'Job B', answers(gateB, 'B is done'));
        const queued = () => chatOf(parent.chat.id).queue ?? [];
        const threadsOf = (index = 0) => {
            const from = queued()[index]?.from;

            return from?.kind === 'threadNotice' ? from.threads : [];
        };

        gateA.release();
        await waitFor(() => queued().length === 1, 'the notice to wait in the parent\'s queue');
        expect(queued()).toEqual([{
            id: expect.stringMatching(/^que_/),
            mode: 'queue',
            text: 'Thread "Job A" finished',
            content: `[Thread "Job A" (${ a.threadId }) finished]\n\nA first\n\n${ RULE }`,
            from: { kind: 'threadNotice', threads: [finished(a.threadId, 'Job A', 'A first')] },
            createdAt: expect.any(Number),
        }]);

        const [{ id, createdAt }] = queued();

        // The same thread stops again: its entry is replaced, in the same item.
        on('Look again', says('A second'));
        h.ok('chat.send', { chatId: a.threadId, text: 'Look again' });
        await waitFor(() => threadsOf()[0]?.text === 'A second', 'the second notice of A to replace the first');
        expect(queued()).toHaveLength(1);

        // Another thread joins it.
        gateB.release();
        await waitFor(() => threadsOf().length === 2, 'B to join the notice');

        const content = `Threads that stopped:\n\n[Thread "Job A" (${ a.threadId }) finished]\n\nA second\n\n[Thread "Job B" (${ b.threadId }) finished]\n\nB is done\n\n${ RULE }`;

        expect(queued()).toEqual([{
            id,
            mode: 'queue',
            text: '2 threads stopped',
            content,
            from: { kind: 'threadNotice', threads: [finished(a.threadId, 'Job A', 'A second'), finished(b.threadId, 'Job B', 'B is done')] },
            createdAt,
        }]);
        expect(noticesTo(parent.chat.id)).toEqual([]);

        // Nothing steers the running turn: it goes when the parent rests.
        gate.release();
        await waitFor(() => engine.prompts.includes(content) && h.run(parent.run.id).status === 'succeeded', 'the parent\'s turn on the notice');
        expect(chatOf(parent.chat.id).queue).toBeUndefined();
        expect(engine.steered).toEqual([]);
        expect(bodies(parent.run.id).filter(body => body.kind === 'user').at(-1)).toEqual({
            kind: 'user',
            text: '',
            from: { kind: 'threadNotice', threads: [finished(a.threadId, 'Job A', 'A second'), finished(b.threadId, 'Job B', 'B is done')] },
        });
    });

    test('a queue a Stop holds keeps the notice, and so does the queue of a stopped parent that had nothing waiting, until the person sends it', async () => {
        const { h, engine, chatOf, root, spawn, noticesTo } = await setup();
        const gate = latch();
        const parent = await root('Plan the release', gate);
        const threadGate = latch();
        const thread = await spawn(parent.run, 'Check the cache', answers(threadGate, 'The cache is fine'));

        h.ok('chat.send', { chatId: parent.chat.id, text: 'Then do this' });
        h.ok('run.cancel', { runId: parent.run.id });
        await waitFor(() => h.run(parent.run.id).status === 'cancelled', 'the parent to stop');
        threadGate.release();
        await waitFor(() => (chatOf(parent.chat.id).queue ?? []).length === 2, 'the notice to join the held queue');
        await Bun.sleep(QUIET_MS);
        expect(chatOf(parent.chat.id)).toMatchObject({
            queuePaused: 'stopped',
            queue: [expect.objectContaining({ text: 'Then do this' }), expect.objectContaining({ text: 'Thread "Check the cache" finished', from: expect.objectContaining({ kind: 'threadNotice' }) })],
        });
        expect(h.run(parent.run.id).status).toBe('cancelled');
        expect(noticesTo(parent.chat.id)).toEqual([]);

        // A parent stopped with nothing in its queue holds the notice all the same.
        const otherGate = latch();
        const other = await root('Plan the launch', otherGate);
        const otherThreadGate = latch();
        const otherThread = await spawn(other.run, 'Check the docs', answers(otherThreadGate, 'The docs are fine'));

        h.ok('run.cancel', { runId: other.run.id });
        await waitFor(() => h.run(other.run.id).status === 'cancelled', 'the other parent to stop');
        otherThreadGate.release();
        await waitFor(() => chatOf(other.chat.id).queue?.length === 1, 'the notice to wait in the other parent\'s queue');
        await Bun.sleep(QUIET_MS);
        expect(chatOf(other.chat.id).queuePaused).toBe('stopped');
        expect(h.run(other.run.id).status).toBe('cancelled');

        // The person sends it: the parent takes it as a turn.
        const content = `[Thread "Check the docs" (${ otherThread.threadId }) finished]\n\nThe docs are fine\n\n${ RULE }`;

        h.ok('chat.sendQueued', { chatId: other.chat.id, itemId: (chatOf(other.chat.id).queue ?? [])[0].id });
        await waitFor(() => engine.prompts.includes(content) && h.run(other.run.id).status === 'succeeded', 'the other parent\'s turn on the notice');
        expect(noticesTo(other.chat.id)).toEqual([[finished(otherThread.threadId, 'Check the docs', 'The docs are fine')]]);
        expect(thread.run().status).toBe('succeeded');
    });

    test('a parent that waits for background work gets the notice in its live session', async () => {
        const { h, engine, project, on, spawn, noticesTo, runOf } = await setup();
        const threadGate = latch();

        engine.sendAnswer = () => true;
        on('Watch the build', async function* (turn) {
            yield { type: 'session', sessionId: `s-${ turn.number }` };
            yield { type: 'text', delta: 'Started the build', done: true };
            yield { type: 'background', items: [{ id: 'bg-1', kind: 'command', title: 'bun run build' }] };
            yield { type: 'done', result: 'Started the build' };

            for (let text = await turn.received(); text !== undefined; text = await turn.received()) {
                yield { type: 'text', delta: 'Noted', done: true };
                yield { type: 'done', result: 'Noted' };
            }
        });

        const { chat } = h.ok('chat.create', { projectId: project.id }) as { chat: Chat };

        h.ok('chat.send', { chatId: chat.id, text: 'Watch the build' });
        await waitFor(() => runOf(chat.id).status === 'waiting_background', 'the parent to wait for its build');

        const sessions = engine.turns.length;
        const thread = await spawn(runOf(chat.id), 'Check the cache', answers(threadGate, 'The cache is fine'));
        const content = `[Thread "Check the cache" (${ thread.threadId }) finished]\n\nThe cache is fine\n\n${ RULE }`;

        threadGate.release();
        await waitFor(() => engine.sent.includes(content) && runOf(chat.id).status === 'waiting_background' && runOf(chat.id).statusReason === 'Waiting for background work' && noticesTo(chat.id).length === 1, 'the notice in the live session');
        // No new session for the parent: only the thread's turn started.
        expect(engine.turns).toHaveLength(sessions + 1);
        expect(engine.sent).toEqual([content]);
    });

    test('an archived parent is told nothing', async () => {
        const { h, chatOf, root, spawn, on, noticesTo } = await setup();
        const gate = latch();
        const parent = await root('Plan the release', gate);
        const threadGate = latch();
        const thread = await spawn(parent.run, 'Check the cache', answers(threadGate, 'The cache is fine'));

        gate.release();
        threadGate.release();
        await waitFor(() => noticesTo(parent.chat.id).length === 1 && h.run(parent.run.id).status === 'succeeded' && thread.run().status === 'succeeded', 'the first notice to be answered');
        h.ok('chat.setArchived', { chatId: parent.chat.id, archived: true });

        // The person writes to the archived thread, which brings only the thread back; its answer tells the archived parent nothing.
        on('Look again', says('Still fine'));
        h.ok('chat.send', { chatId: thread.threadId, text: 'Look again' });
        await waitFor(() => thread.run().status === 'succeeded' && thread.run().result === 'Still fine', 'the thread\'s second answer');
        await Bun.sleep(QUIET_MS);

        expect(chatOf(parent.chat.id).archivedAt).toBeGreaterThan(0);
        expect(chatOf(parent.chat.id).queue).toBeUndefined();
        expect(noticesTo(parent.chat.id)).toHaveLength(1);
    });

    test('a thread of a thread wakes its parent, whose answer wakes the chat above it', async () => {
        const { h, root, spawn, onPrompt, noticesTo } = await setup();
        const gate = latch();
        const middleGate = latch();
        const leafGate = latch();
        const parent = await root('Plan the release', gate);
        const middle = await spawn(parent.run, 'Middle job', held(middleGate, 'Middle started'));

        await waitFor(() => middle.run().status === 'running', 'the middle thread to run');

        const leaf = await spawn(middle.run(), 'Leaf job', answers(leafGate, 'Leaf result'));

        onPrompt(prompt => prompt.startsWith('[Thread "Leaf job"'), says('Middle relays: Leaf result'));
        gate.release();
        middleGate.release();
        await waitFor(() => noticesTo(parent.chat.id).length === 1 && h.run(parent.run.id).status === 'succeeded' && middle.run().status === 'succeeded', 'the middle thread\'s first notice');

        leafGate.release();
        await waitFor(() => noticesTo(parent.chat.id).length === 2 && h.run(parent.run.id).status === 'succeeded', 'the middle thread\'s answer to reach the top');
        expect(noticesTo(middle.threadId)).toEqual([[finished(leaf.threadId, 'Leaf job', 'Leaf result')]]);
        expect(noticesTo(parent.chat.id)).toEqual([[finished(middle.threadId, 'Middle job', 'Middle started')], [finished(middle.threadId, 'Middle job', 'Middle relays: Leaf result')]]);
    });
});

describe('thread_wait', () => {
    test('answers at once for a thread that is not working, waits for one that is, and gives up at its timeout', async () => {
        const { exec, root, spawn } = await setup();
        const parent = await root('Plan the release', latch());
        const quick = await spawn(parent.run, 'Quick job', says('Quick answer'));

        await waitFor(() => quick.run().status === 'succeeded', 'the quick thread to finish');

        let started = Date.now();

        expect(await exec(parent.run, 'thread_wait', { thread: quick.threadId })).toEqual({ threadId: quick.threadId, title: 'Quick job', state: 'idle', text: 'Quick answer', open: [], timedOut: false });
        expect(Date.now() - started).toBeLessThan(500);

        const lateGate = latch();
        const late = await spawn(parent.run, 'Late job', answers(lateGate, 'Late answer'));
        let answered = false;
        const waiting = exec(parent.run, 'thread_wait', { thread: late.threadId, timeoutSeconds: 10 }).finally(() => {
            answered = true;
        });

        await Bun.sleep(150);
        expect(answered).toBe(false);
        lateGate.release();
        expect(await waiting).toMatchObject({ threadId: late.threadId, state: 'idle', text: 'Late answer', timedOut: false });

        const slow = await spawn(parent.run, 'Slow job', held(latch(), 'Still at it'));

        await waitFor(() => slow.run().status === 'running', 'the slow thread to run');
        started = Date.now();
        expect(await exec(parent.run, 'thread_wait', { thread: slow.threadId, timeoutSeconds: 1 })).toMatchObject({ state: 'working', text: 'Still at it', timedOut: true });
        expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    });

    test('answers at once for a thread that asks the person, ends with the caller\'s stop, and takes only threads below the caller', async () => {
        const { exec, root, spawn } = await setup();
        const parent = await root('Plan the release', latch());
        const asking = await spawn(parent.run, 'Ask the person', async function* (turn) {
            yield { type: 'session', sessionId: `s-${ turn.number }` };
            yield* turn.call('ask_user', { question: 'Which color?', options: [{ id: 'red', label: 'Red' }] });
            yield { type: 'done', result: 'Asked' };
        }, { mode: 'semi' });

        await waitFor(() => asking.run().status === 'waiting_user', 'the thread to ask');
        expect(await exec(parent.run, 'thread_wait', { thread: asking.threadId })).toMatchObject({ state: 'asking', timedOut: false });

        const busy = await spawn(parent.run, 'Busy job', held(latch()));
        const stop = new AbortController();
        const waiting = exec(parent.run, 'thread_wait', { thread: busy.threadId }, stop.signal);

        await Bun.sleep(50);
        stop.abort(new Error('The caller was stopped'));
        await expect(waiting).rejects.toThrow('The caller was stopped');

        await expect(exec(busy.run(), 'thread_wait', { thread: asking.threadId })).rejects.toThrow(/is not below you/);
        await expect(exec(busy.run(), 'thread_wait', { thread: parent.chat.id })).rejects.toThrow(/is not below you/);
        await expect(exec(parent.run, 'thread_wait', { thread: busy.threadId, timeoutSeconds: 0 })).rejects.toThrow(/Invalid input for thread_wait/);
        await expect(exec(parent.run, 'thread_wait', { thread: busy.threadId, timeoutSeconds: 601 })).rejects.toThrow(/Invalid input for thread_wait/);
    });
});

describe('reading a thread instead of its notice', () => {
    test('a parent that waited for its thread is not told of that stop again, and is not woken for it', async () => {
        const { h, chatOf, exec, root, spawn, noticesTo } = await setup();
        const gate = latch();
        const parent = await root('Plan the release', gate);
        const threadGate = latch();
        const thread = await spawn(parent.run, 'Check the cache', answers(threadGate, 'The cache is fine'));
        const waiting = exec(parent.run, 'thread_wait', { thread: thread.threadId });

        threadGate.release();
        expect(await waiting).toMatchObject({ state: 'idle', text: 'The cache is fine', timedOut: false });
        await Bun.sleep(QUIET_MS);
        expect(chatOf(parent.chat.id).queue).toBeUndefined();

        gate.release();
        await waitFor(() => h.run(parent.run.id).status === 'succeeded', 'the parent to rest');
        await Bun.sleep(QUIET_MS);
        expect(noticesTo(parent.chat.id)).toEqual([]);
        expect(h.run(parent.run.id).result).toBe('working');
    });

    test('thread_output of the parent takes its thread out of the queued notice; a sibling\'s reading leaves it', async () => {
        const { chatOf, exec, root, spawn } = await setup();
        const parent = await root('Plan the release', latch());
        const gateA = latch();
        const gateB = latch();
        const a = await spawn(parent.run, 'Job A', answers(gateA, 'A is done'));
        const b = await spawn(parent.run, 'Job B', answers(gateB, 'B is done'));
        const sibling = await spawn(parent.run, 'Job C', held(latch()));
        const queued = () => chatOf(parent.chat.id).queue ?? [];

        await waitFor(() => sibling.run().status === 'running', 'the sibling to run');
        gateA.release();
        gateB.release();
        await waitFor(() => queued().length === 1 && queued()[0].text === '2 threads stopped', 'both notices in the queue');

        // A sibling reads A: the parent's notice stays whole.
        expect((await exec(sibling.run(), 'thread_output', { thread: a.threadId })).text).toBe('A is done');
        expect(queued()[0]).toMatchObject({ text: '2 threads stopped' });

        // The parent reads A: only B is left, with its own line and content.
        expect((await exec(parent.run, 'thread_output', { thread: a.threadId })).text).toBe('A is done');
        expect(queued()).toEqual([expect.objectContaining({
            text: 'Thread "Job B" finished',
            content: `[Thread "Job B" (${ b.threadId }) finished]\n\nB is done\n\n${ RULE }`,
            from: { kind: 'threadNotice', threads: [finished(b.threadId, 'Job B', 'B is done')] },
        })]);

        // And then B: the notice is gone.
        await exec(parent.run, 'thread_output', { thread: b.threadId });
        expect(chatOf(parent.chat.id).queue).toBeUndefined();
    });

    test('a read that finds the thread at work again leaves the notice of its stop, whose answer the read did not have', async () => {
        const { h, chatOf, exec, root, spawn, on, bodies } = await setup();
        const parent = await root('Plan the release', latch());
        const threadGate = latch();
        const thread = await spawn(parent.run, 'Check the cache', answers(threadGate, 'The cache is fine'));
        const queued = () => chatOf(parent.chat.id).queue ?? [];
        const notice: MessageSource = { kind: 'threadNotice', threads: [finished(thread.threadId, 'Check the cache', 'The cache is fine')] };

        // The thread's next message waits in its queue, so the thread is at work again in the moment its turn ends.
        on('Look again', held(latch(), 'Looking again'));
        h.ok('chat.send', { chatId: thread.threadId, text: 'Look again' });
        expect(chatOf(thread.threadId).queue).toHaveLength(1);

        const waiting = exec(parent.run, 'thread_wait', { thread: thread.threadId });

        threadGate.release();
        expect(await waiting).toMatchObject({ state: 'working', text: null, timedOut: false });
        await waitFor(() => queued().length === 1, 'the notice in the busy parent\'s queue');
        expect(queued()[0].from).toEqual(notice);

        // Reading it while it works shows the new turn's words, not the answer: the notice stays too.
        await waitFor(() => bodies(thread.run().id).some(body => body.kind === 'assistant' && body.text === 'Looking again'), 'the thread\'s next turn to speak');
        expect(await exec(parent.run, 'thread_output', { thread: thread.threadId })).toMatchObject({ state: 'working', text: 'Looking again' });
        expect(queued().map(item => item.from)).toEqual([notice]);
    });
});
