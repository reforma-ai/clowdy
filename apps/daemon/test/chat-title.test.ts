import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { firstWords, titleFrom } from '../src/domain/chats';
import { CHAT_TITLE_SETTING } from '../src/engine/acp/catalog';
import { cleanTempDirs, latch, ScriptEngine, startHarness, waitFor } from './helpers';

import type { AgentEngine } from '../src/engine/types';
import type { Harness, Script } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

/** A turn that ends at once, with an agent that gives no title. */
const silent: Script = async function* ({ number }) {
    yield { type: 'session', sessionId: `s${number}` };
    yield { type: 'done', result: 'ok' };
};

/** What an agent does that names its session: the message as the title first (Codex), then a name of its own. */
const naming = (title: string): Script =>
    async function* ({ number, options }) {
        yield { type: 'session', sessionId: `s${number}` };

        if (options.title && 'onTitle' in options.title) {
            options.title.onTitle(options.prompt.replace(/\s+/g, ' '));
            options.title.onTitle(title);
        }

        yield { type: 'done', result: 'ok' };
    };

/** Claude, Codex and Cursor stand for agents that have the switch and one that has not; every turn goes to the engine given. */
async function setup(script: Script) {
    const engine = new ScriptEngine(script);
    const engines = new Map<string, AgentEngine>([
        ['fake', engine],
        ['claude', engine],
        ['codex', engine],
        ['cursor', engine],
    ]);
    const h = await startHarness({}, { engines });

    harnesses.push(h);

    return { h, engine, project: h.openRepo() };
}

const titleOf = (h: Harness, chatId: string): string =>
    (h.store.db.query('SELECT title FROM chats WHERE id = ?').get(chatId) as { title: string }).title;

const FIRST = 'Fix the login form so that the button works';
const LINK = 'https://github.com/reforma-ai/briefback/pull/9';

describe('first-message titles', () => {
    test.each([
        [`${LINK}\n\nСделай ревью этого изменения`, 'Сделай ревью этого изменения'],
        [`${LINK} Review this change`, 'Review this change'],
        [`${LINK}\nhttps://example.com/issue/12\n\nCompare these changes\nMore details`, 'Compare these changes'],
        ['<https://example.com> www.example.org Compare these pages', 'Compare these pages'],
        [`${LINK}\nhttps://example.com`, LINK],
        [`Review ${LINK}\nMore details`, `Review ${LINK}`],
    ])('chooses the first meaningful line of %s', (text, expected) => {
        expect(firstWords({ text })).toBe(expected);
    });

    test('keeps the existing title length and attachment fallback', () => {
        expect(firstWords({ text: `${LINK}\n${'a'.repeat(70)}` })).toBe(`${'a'.repeat(59)}…`);
        expect(firstWords({ text: '', attachments: [{ name: 'screenshot.png' }] })).toBe('screenshot.png');
    });
});

describe('the title of a chat', () => {
    test('uses the request after a pasted URL immediately and lets the agent replace it later', async () => {
        const text = `${LINK}\n\nPlease review this change`;
        const script: Script = async function* (turn) {
            const title = turn.options.title;

            if (title && 'onTitle' in title) {
                expect(title.onTitle(LINK)).toBe(false);
                expect(title.onTitle(text.replace(/\s+/g, ' '))).toBe(false);
            }

            yield* naming('Review pull request')(turn);
        };
        const { h, engine, project } = await setup(script);
        const { chat } = h.ok('chat.create', { projectId: project.id, engine: 'codex' });

        h.ok('chat.send', { chatId: chat.id, text });
        expect(titleOf(h, chat.id)).toBe('Please review this change');
        await waitFor(() => engine.closed === 1, 'the turn to end');
        expect(titleOf(h, chat.id)).toBe('Review pull request');
    });

    test('still accepts an agent title for a chat with an older URL-based fallback', async () => {
        const script: Script = async function* (turn) {
            yield* (turn.number === 1 ? silent : naming('Review pull request'))(turn);
        };
        const { h, engine, project } = await setup(script);
        const { chat } = h.ok('chat.create', { projectId: project.id, engine: 'codex' });

        h.ok('chat.send', { chatId: chat.id, text: `${LINK}\n\nPlease review this change` });
        await waitFor(() => engine.closed === 1, 'the first turn to end');
        // The database may already contain a title written by the old fallback.
        h.store.db.query('UPDATE chats SET title = ? WHERE id = ?').run(titleFrom(LINK), chat.id);
        h.ok('chat.send', { chatId: chat.id, text: 'What do you think?' });
        await waitFor(() => engine.closed === 2, 'the second turn to end');
        expect(titleOf(h, chat.id)).toBe('Review pull request');
    });

    test("is the first words of its first message until the agent names it, and then the agent's name", async () => {
        const { h, engine, project } = await setup(naming('Fix login form button'));
        const { chat } = h.ok('chat.create', { projectId: project.id, engine: 'claude' });

        h.ok('chat.send', { chatId: chat.id, text: FIRST });
        await waitFor(() => engine.turns.length === 1, 'the orchestrator to start');
        await waitFor(() => titleOf(h, chat.id) === 'Fix login form button', "the agent's title");

        // The person's app hears of the name as of any other change of the chat.
        const upserted = h
            .events()
            .map(event => event.data)
            .filter(data => data.type === 'chat.upserted' && data.chat.id === chat.id);

        expect(upserted.at(-1)).toMatchObject({ chat: { title: 'Fix login form button' } });
    });

    test('is never the message the agent gave back as its title', async () => {
        const echoOnly: Script = async function* ({ number, options }) {
            yield { type: 'session', sessionId: `s${number}` };

            if (options.title && 'onTitle' in options.title) {
                expect(options.title.onTitle(options.prompt.replace(/\s+/g, ' '))).toBe(false);
                expect(options.title.onTitle(`${options.prompt.replace(/\s+/g, ' ').slice(0, 59)}…`)).toBe(false);
                // The first message of the conversation, when this turn is a later one.
                expect(
                    options.title.onTitle(
                        'Follow clowdy:orchestrate. Mode: autopilot Something else the person said first'
                    )
                ).toBe(false);
            }

            yield { type: 'done', result: 'ok' };
        };
        const { h, engine, project } = await setup(echoOnly);
        const { chat } = h.ok('chat.create', { projectId: project.id, engine: 'codex' });

        h.ok('chat.send', { chatId: chat.id, text: FIRST });
        await waitFor(() => engine.closed === 1, 'the turn to end');
        expect(titleOf(h, chat.id)).toBe(FIRST);
    });

    test('stays the one the person gave it, when they renamed the chat before the agent named it', async () => {
        const named = latch();
        let taken: boolean | undefined;
        const lateNaming: Script = async function* ({ number, options }) {
            yield { type: 'session', sessionId: `s${number}` };
            await named.wait(options.signal);

            if (options.title && 'onTitle' in options.title) {
                taken = options.title.onTitle("Agent's name");
            }

            yield { type: 'done', result: 'ok' };
        };
        const { h, engine, project } = await setup(lateNaming);
        const { chat } = h.ok('chat.create', { projectId: project.id, engine: 'claude' });

        h.ok('chat.send', { chatId: chat.id, text: FIRST });
        await waitFor(() => engine.turns.length === 1, 'the orchestrator to start');
        h.ok('chat.rename', { chatId: chat.id, title: 'My own name' });
        named.release();
        await waitFor(() => taken !== undefined, 'the agent to give its title');
        expect(taken).toBe(false);
        expect(titleOf(h, chat.id)).toBe('My own name');
    });

    test("is the name of a chat's task when it was started from one, and its agent is told to keep that name", async () => {
        const { h, engine, project } = await setup(naming("Agent's name"));
        const { id: taskId } = h.ok('task.create', { projectId: project.id, title: 'Fix it' }).task;
        const { chatId } = h.ok('task.start', { taskId, engine: 'claude' });

        await waitFor(() => engine.turns.length === 1, 'the orchestrator to start');
        await waitFor(() => engine.closed === 1, 'the turn to end');
        expect(engine.turns[0].title).toEqual({ keep: 'Fix it' });
        expect(titleOf(h, chatId)).toBe('Fix it');
    });

    test("is the first words, and the agent is told to keep them, when the person switched the agent's chat titles off", async () => {
        const { h, engine, project } = await setup(naming("Agent's name"));

        h.daemon.services.agents.update('claude', { settings: { [CHAT_TITLE_SETTING]: false } });

        const { chat } = h.ok('chat.create', { projectId: project.id, engine: 'claude' });

        h.ok('chat.send', { chatId: chat.id, text: FIRST });
        await waitFor(() => engine.closed === 1, 'the turn to end');
        expect(engine.turns[0].title).toEqual({ keep: FIRST });
        expect(titleOf(h, chat.id)).toBe(FIRST);
    });

    test('is the first words, and the agent is left alone, for an agent that has no switch for it', async () => {
        const { h, engine, project } = await setup(naming("Agent's name"));
        const { chat } = h.ok('chat.create', { projectId: project.id, engine: 'cursor' });

        h.ok('chat.send', { chatId: chat.id, text: FIRST });
        await waitFor(() => engine.closed === 1, 'the turn to end');
        expect(engine.turns[0].title).toBeUndefined();
        expect(titleOf(h, chat.id)).toBe(FIRST);
    });

    test('is asked of the agent again on a later turn only while nobody has named the chat', async () => {
        const { h, engine, project } = await setup(silent);
        const { chat } = h.ok('chat.create', { projectId: project.id, engine: 'codex' });

        h.ok('chat.send', { chatId: chat.id, text: FIRST });
        await waitFor(() => engine.closed === 1, 'the first turn to end');
        // The agent gave nothing: the chat still has the first words, so the next turn may be named.
        h.ok('chat.send', { chatId: chat.id, text: 'And the logout button too' });
        await waitFor(() => engine.closed === 2, 'the second turn to end');
        expect(engine.turns[0].title).toMatchObject({ onTitle: expect.any(Function) });
        expect(engine.turns[1].title).toMatchObject({ onTitle: expect.any(Function) });

        h.ok('chat.rename', { chatId: chat.id, title: 'Mine' });
        h.ok('chat.send', { chatId: chat.id, text: 'One more thing' });
        await waitFor(() => engine.closed === 3, 'the third turn to end');
        // The agent is told the chat's name, whatever the session: it sends the name to a session that is new, and one that continues has its own.
        expect(engine.turns[2].title).toEqual({ keep: 'Mine' });
    });

    test('is waited for by an agent that runs on after its turn, which the daemon stopping ends', async () => {
        const { h, engine, project } = await setup(silent);
        const { chat } = h.ok('chat.create', { projectId: project.id, engine: 'codex' });

        h.ok('chat.send', { chatId: chat.id, text: FIRST });
        await waitFor(() => engine.closed === 1, 'the turn to end');
        // The run's own signal is gone with its turn; the session of an agent left running for a title still hears of the daemon stopping.
        expect(engine.turns[0].signal.aborted).toBe(false);
        await h.stop();
        expect(engine.turns[0].signal.aborted).toBe(true);
    });
});
