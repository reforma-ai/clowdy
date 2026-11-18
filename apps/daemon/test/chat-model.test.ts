import { commandSchema } from '@clowdy/protocol';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { cleanTempDirs, latch, ScriptEngine, scriptEngines, startHarness, waitFor } from './helpers';

import type { Harness, Script } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

/** A turn that ends at once, so the chat is finished and its next message starts a new turn. */
const finishing: Script = async function* ({ number }) {
    yield { type: 'session', sessionId: `s${ number }` };
    yield { type: 'done', result: 'ok' };
};

async function setup(script: Script = finishing) {
    const engine = new ScriptEngine(script);
    // A second agent, for the tests that change a chat's provider.
    const other = new ScriptEngine(script);
    const engines = new Map([...scriptEngines(engine), ['other', other]]);
    const h = await startHarness({}, { engines });

    harnesses.push(h);

    const project = h.openRepo();

    return { h, engine, other, project };
}

const failure = (result: ReturnType<Harness['send']>) => {
    if (result.ok) {
        throw new Error('expected a failure');
    }

    return result.error;
};

describe('the provider, model and reasoning level of a chat', () => {
    test('a chat is made with them, and the first message starts its orchestrator on them', async () => {
        const { h, engine, project } = await setup();
        const { chat } = h.ok('chat.create', { projectId: project.id, engine: 'fake', model: 'smart', effort: 'max' });

        expect(chat).toMatchObject({ engine: 'fake', model: 'smart', effort: 'max' });

        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'hello' });

        await waitFor(() => engine.turns.length === 1, 'the orchestrator to start');
        expect(engine.turns[0]).toMatchObject({ model: 'smart', effort: 'max' });
        expect(h.run(runId)).toMatchObject({ engine: 'fake', model: 'smart', effort: 'max' });
    });

    test('the chat records what its orchestrator really got when it named nothing, the project\'s model included', async () => {
        const { h, engine, project } = await setup();

        h.ok('project.update', { projectId: project.id, settings: { model: 'smart' } });

        const { chat } = h.ok('chat.create', { projectId: project.id });

        expect(chat.engine).toBeUndefined();
        h.ok('chat.send', { chatId: chat.id, text: 'hello' });
        await waitFor(() => engine.turns.length === 1, 'the orchestrator to start');

        const saved = h.store.db.query('SELECT engine, model, effort FROM chats WHERE id = ?').get(chat.id);

        expect(saved).toEqual({ engine: 'fake', model: 'smart', effort: null });
    });

    test('a task\'s chat takes the choice of its orchestrator', async () => {
        const { h, project } = await setup();

        h.ok('project.update', { projectId: project.id, settings: { model: 'fast' } });

        const { id: taskId } = h.ok('task.create', { projectId: project.id, title: 'Fix it' }).task;
        const { chatId } = h.ok('task.start', { taskId });

        expect(h.store.db.query('SELECT engine, model FROM chats WHERE id = ?').get(chatId)).toEqual({ engine: 'fake', model: 'fast' });
    });

    test('a task started on an agent opens its chat on that agent', async () => {
        const { h, other, project } = await setup();
        const { id: taskId } = h.ok('task.create', { projectId: project.id, title: 'Fix it' }).task;
        const { chatId, runId } = h.ok('task.start', { taskId, engine: 'other' });

        await waitFor(() => other.turns.length === 1, 'the orchestrator to start on the other agent');
        expect(h.run(runId).engine).toBe('other');
        expect(h.store.db.query('SELECT engine, model, effort FROM chats WHERE id = ?').get(chatId)).toEqual({ engine: 'other', model: null, effort: null });
    });

    test('the project\'s model is for the project\'s agent, not for another one a chat names', async () => {
        const { h, project } = await setup();

        h.ok('project.update', { projectId: project.id, settings: { model: 'smart' } });

        const { chat } = h.ok('chat.create', { projectId: project.id, engine: 'other' });

        h.ok('chat.send', { chatId: chat.id, text: 'hello' });

        expect(h.store.db.query('SELECT engine, model FROM chats WHERE id = ?').get(chat.id)).toEqual({ engine: 'other', model: null });
    });

    test('changing the model is not activity: the chat keeps its place in the order', async () => {
        const { h, project } = await setup();
        const { chat } = h.ok('chat.create', { projectId: project.id, engine: 'fake', model: 'fast' });

        await Bun.sleep(5);

        const changed = h.ok('chat.setModel', { chatId: chat.id, model: 'smart' }).chat;

        expect(changed.model).toBe('smart');
        expect(changed.updatedAt).toBe(chat.updatedAt);
    });

    test('an agent the daemon does not know is refused when the chat is made', async () => {
        const { h, project } = await setup();

        expect(failure(h.send('chat.create', { projectId: project.id, engine: 'nobody' })).code).toBe('unavailable');
    });

    test('the model and level can change between turns, and the next turn runs on them', async () => {
        const { h, engine, project } = await setup();
        const { chat } = h.ok('chat.create', { projectId: project.id, engine: 'fake', model: 'fast', effort: 'low' });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'first' });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the first turn to end');

        const changed = h.ok('chat.setModel', { chatId: chat.id, model: 'smart', effort: 'high' }).chat;

        expect(changed).toMatchObject({ model: 'smart', effort: 'high' });
        expect(h.run(runId)).toMatchObject({ model: 'smart', effort: 'high' });

        h.ok('chat.send', { chatId: chat.id, text: 'second' });
        await waitFor(() => engine.turns.length === 2, 'the second turn to start');
        expect(engine.turns[1]).toMatchObject({ model: 'smart', effort: 'high', resumeSessionId: 's1' });
    });

    test('a change made while the orchestrator works waits for its next turn', async () => {
        const hold = latch();
        const { h, engine, project } = await setup(async function* ({ number, options }) {
            yield { type: 'session', sessionId: `s${ number }` };

            if (number === 1) {
                await hold.wait(options.signal);
            }

            yield { type: 'done', result: 'ok' };
        });
        const { chat } = h.ok('chat.create', { projectId: project.id, engine: 'fake', model: 'fast', effort: 'low' });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'first' });

        await waitFor(() => engine.turns.length === 1 && h.run(runId).status === 'running', 'the first turn to be under way');
        expect(h.ok('chat.setModel', { chatId: chat.id, model: 'smart', effort: 'high' }).chat).toMatchObject({ model: 'smart', effort: 'high' });

        // The row the next turn reads has the new choice; the session that is running keeps what it started with.
        expect(h.run(runId)).toMatchObject({ status: 'running', model: 'smart', effort: 'high' });
        expect(engine.turns).toHaveLength(1);
        expect(engine.turns[0]).toMatchObject({ model: 'fast', effort: 'low' });

        hold.release();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the first turn to end');
        h.ok('chat.send', { chatId: chat.id, text: 'second' });
        await waitFor(() => engine.turns.length === 2, 'the second turn to start');
        expect(engine.turns[1]).toMatchObject({ model: 'smart', effort: 'high', resumeSessionId: 's1' });
    });

    test('null clears one, and a new model clears the level it does not name', async () => {
        const { h, project } = await setup();
        const { chat } = h.ok('chat.create', { projectId: project.id, engine: 'fake', model: 'fast', effort: 'low' });
        const cleared = h.ok('chat.setModel', { chatId: chat.id, effort: null }).chat;

        expect(cleared.effort).toBeUndefined();
        expect(cleared.model).toBe('fast');

        h.ok('chat.setModel', { chatId: chat.id, effort: 'low' });

        const next = h.ok('chat.setModel', { chatId: chat.id, model: 'smart' }).chat;

        expect(next).toMatchObject({ model: 'smart' });
        expect(next.effort).toBeUndefined();

        // The same model keeps its level; one that names its level along with it gets that one.
        h.ok('chat.setModel', { chatId: chat.id, effort: 'high' });
        expect(h.ok('chat.setModel', { chatId: chat.id, model: 'smart' }).chat.effort).toBe('high');
        expect(h.ok('chat.setModel', { chatId: chat.id, model: 'fast', effort: 'low' }).chat).toMatchObject({ model: 'fast', effort: 'low' });

        // No model at all leaves the agent's own: the level stays, as the model did not change.
        h.ok('chat.setModel', { chatId: chat.id, model: null });
        expect(h.ok('chat.setModel', { chatId: chat.id, effort: 'high' }).chat).toMatchObject({ effort: 'high' });
        expect(h.ok('chat.setModel', { chatId: chat.id, model: null }).chat).toMatchObject({ effort: 'high' });
    });

    test('saying what is set already announces nothing, for the chat or for its orchestrator', async () => {
        const { h, project } = await setup();
        const { chat } = h.ok('chat.create', { projectId: project.id, engine: 'fake', model: 'fast', effort: 'low' });
        const bare = h.ok('chat.create', { projectId: project.id, engine: 'fake', effort: 'low' }).chat;
        const quiet = (id: string, change: Record<string, unknown>) => {
            const cursor = h.store.headCursor();

            h.ok('chat.setModel', { chatId: id, ...change });
            expect(h.events(cursor)).toHaveLength(0);
        };

        for (const change of [{}, { engine: 'fake' }, { model: 'fast' }, { effort: 'low' }, { engine: 'fake', model: 'fast', effort: 'low' }]) {
            quiet(chat.id, change);
        }

        // There is no model to clear, so the level that belongs to no model of ours stays too.
        quiet(bare.id, { model: null });
        expect(h.ok('chat.setModel', { chatId: bare.id, model: null }).chat.effort).toBe('low');

        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'first' });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the turn to end');
        quiet(chat.id, { model: 'fast', effort: 'low' });
    });

    test('the provider changes while the chat has no orchestrator, leaving behind the model and level of the old one, and is fixed after the first message', async () => {
        const { h, project } = await setup();
        const { chat } = h.ok('chat.create', { projectId: project.id, engine: 'fake', model: 'fast', effort: 'low' });

        // The same provider again changes nothing.
        expect(h.ok('chat.setModel', { chatId: chat.id, engine: 'fake' }).chat).toMatchObject({ engine: 'fake', model: 'fast', effort: 'low' });

        // Another provider has other models: the old model and level mean nothing there, unless the call names new ones.
        const other = h.ok('chat.setModel', { chatId: chat.id, engine: 'other' }).chat;

        expect(other.engine).toBe('other');
        expect(other.model).toBeUndefined();
        expect(other.effort).toBeUndefined();
        expect(h.ok('chat.setModel', { chatId: chat.id, engine: 'fake', model: 'smart', effort: 'high' }).chat).toMatchObject({ engine: 'fake', model: 'smart', effort: 'high' });

        h.ok('chat.send', { chatId: chat.id, text: 'hello' });

        const refused = failure(h.send('chat.setModel', { chatId: chat.id, engine: 'other' }));

        expect(refused.code).toBe('conflict');
        expect(h.store.db.query('SELECT engine FROM chats WHERE id = ?').get(chat.id)).toEqual({ engine: 'fake' });
    });

    test('an unknown chat is not found', async () => {
        const { h } = await setup();

        expect(failure(h.send('chat.setModel', { chatId: 'cht_nope', model: 'fast' })).code).toBe('not_found');
    });
});

describe('the commands of a chat\'s choice', () => {
    const parse = (fields: Record<string, unknown>) => commandSchema.safeParse({ requestId: 'req-12345678', ...fields }).success;

    test('take null to clear a model or level, but never an empty string, and bound what a client may send', () => {
        expect(parse({ type: 'chat.setModel', chatId: 'cht_1', model: null, effort: null })).toBe(true);
        expect(parse({ type: 'chat.setModel', chatId: 'cht_1', engine: 'claude', model: 'opus', effort: 'max' })).toBe(true);
        expect(parse({ type: 'chat.setModel', chatId: 'cht_1', model: '' })).toBe(false);
        expect(parse({ type: 'chat.setModel', chatId: 'cht_1', effort: '' })).toBe(false);
        expect(parse({ type: 'chat.setModel', chatId: 'cht_1', engine: null })).toBe(false);
        expect(parse({ type: 'chat.setModel', chatId: 'cht_1', model: 'm'.repeat(201) })).toBe(false);
        expect(parse({ type: 'chat.create', projectId: 'prj_1', engine: 'claude', model: 'opus', effort: 'high' })).toBe(true);
        expect(parse({ type: 'chat.create', projectId: 'prj_1', effort: 'e'.repeat(65) })).toBe(false);
    });
});

describe('the children of a chat', () => {
    test('a sub-agent inside the session shows the model and level of its parent', async () => {
        const { h, project } = await setup(async function* ({ number }) {
            yield { type: 'session', sessionId: `s${ number }` };
            yield { type: 'subagent', agentId: 'a1', name: 'Explore', state: 'running' };
            yield { type: 'subagent', agentId: 'a1', name: 'Explore', state: 'done', summary: 'Nothing found' };
            yield { type: 'done', result: 'ok' };
        });
        const { chat } = h.ok('chat.create', { projectId: project.id, engine: 'fake', model: 'smart', effort: 'high' });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'look around' });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the turn to end');
        expect(h.store.db.query('SELECT model, effort FROM runs WHERE origin = \'native\'').all()).toEqual([{ model: 'smart', effort: 'high' }]);
    });
});

describe('a provider that is switched off', () => {
    test('is named in the refusal of the first message, which writes nothing', async () => {
        const h = await startHarness();

        harnesses.push(h);

        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, engine: 'claude', model: 'opus' });

        h.ok('agent.update', { id: 'claude', enabled: false });

        const cursor = h.store.headCursor();
        const refused = failure(h.send('chat.send', { chatId: chat.id, text: 'hello' }));

        expect(refused.code).toBe('unavailable');
        expect(refused.message).toContain('Claude Code is switched off in Clowdy');
        expect(h.store.headCursor()).toBe(cursor);
        expect(h.store.db.query('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
    });

    test('is also refused for a chat that started, and works again when it is switched on', async () => {
        // Claude's own program is not on this machine, so a script stands in for it under its id.
        const claude = new ScriptEngine(finishing);
        const h = await startHarness({}, { engines: new Map([['fake', new ScriptEngine(finishing)], ['claude', claude]]) });

        harnesses.push(h);

        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, engine: 'claude' });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'first' });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the first turn to end');
        h.ok('agent.update', { id: 'claude', enabled: false });

        const cursor = h.store.headCursor();
        const refused = failure(h.send('chat.send', { chatId: chat.id, text: 'second' }));

        expect(refused.code).toBe('unavailable');
        expect(refused.message).toContain('Claude Code is switched off in Clowdy');
        expect(h.store.headCursor()).toBe(cursor);
        expect(claude.turns).toHaveLength(1);

        h.ok('agent.update', { id: 'claude', enabled: true });
        h.ok('chat.send', { chatId: chat.id, text: 'second' });
        await waitFor(() => claude.turns.length === 2, 'the second turn to start');
    });

    test('a chat that named no agent is checked against the one it will run on', async () => {
        const h = await startHarness({ engine: 'claude' }, { engines: new Map([['claude', new ScriptEngine(finishing)]]) });

        harnesses.push(h);

        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id });

        h.ok('agent.update', { id: 'claude', enabled: false });
        expect(failure(h.send('chat.send', { chatId: chat.id, text: 'hello' })).message).toContain('Claude Code is switched off in Clowdy');
    });

    test('also refuses to start a task on it, and opens no chat', async () => {
        const h = await startHarness({}, { engines: new Map([['fake', new ScriptEngine(finishing)], ['claude', new ScriptEngine(finishing)]]) });

        harnesses.push(h);

        const project = h.openRepo();
        const { id: taskId } = h.ok('task.create', { projectId: project.id, title: 'Fix it' }).task;

        h.ok('agent.update', { id: 'claude', enabled: false });

        const cursor = h.store.headCursor();
        const refused = failure(h.send('task.start', { taskId, engine: 'claude' }));

        expect(refused.code).toBe('unavailable');
        expect(refused.message).toContain('Claude Code is switched off in Clowdy');
        expect(h.store.headCursor()).toBe(cursor);
        expect(h.store.db.query('SELECT COUNT(*) AS n FROM chats').get()).toEqual({ n: 0 });
    });
});
