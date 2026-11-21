import { STOPPED_TOOL } from '@clowdy/protocol';
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { probeAgent } from '../src/engine/acp/probe';
import { alive, collect, PROTOCOLS, rig, textOf, tool, types, until } from './acp-helpers';

import type { BackgroundItem } from '@clowdy/protocol';
import type { AgentProtocol } from '../src/engine/acp/catalog';
import type { EngineEvent, EngineSession } from '../src/engine/types';
import type { Rig } from './acp-helpers';

let current: Rig | undefined;
/** The protocol the scenarios being run speak: `use` starts the fake agent of that protocol. */
let speaking: AgentProtocol = 'v1';

const use = (options?: Parameters<typeof rig>[0]) => (current = rig({ protocol: speaking, ...options }));

/**
 * Registers the scenarios of `body` once for each protocol of the engine, so what they check holds for both layers. `body` is given the protocol,
 * for a scenario that is one protocol's own (`test.skipIf(protocol === 'v2')`).
 */
function eachProtocol(name: string, body: (protocol: AgentProtocol) => void): void {
    for (const protocol of PROTOCOLS) {
        describe(`${ name } over ${ protocol }`, () => {
            beforeEach(() => {
                speaking = protocol;
            });
            afterEach(() => {
                speaking = 'v1';
            });

            body(protocol);
        });
    }
}

afterEach(() => {
    current?.stop();
    current = undefined;
});

eachProtocol('a turn on an ACP agent', (protocol) => {
    test('streams the message and ends with done carrying its text', async () => {
        const { session } = use().start('say hello world');
        const events = await collect(session);

        await session.close();

        expect(types(events)).toEqual(['process', 'session', 'text', 'text', 'text', 'done']);
        expect(events[1]).toMatchObject({ type: 'session', sessionId: 'fake-1' });
        expect(textOf(events)).toBe('hello world');
        // Over v2 the message that ends the turn says the agent's id of it, which is where the session can be cut; v1 agents name none.
        expect(events.at(-2)).toEqual({ type: 'text', delta: '', done: true, ...(protocol === 'v2' && { messageId: expect.any(String) }) });
        expect(events.at(-1)).toEqual({ type: 'done', result: 'hello world' });
        expect(events[0]).toMatchObject({ type: 'process', pid: expect.any(Number), pgid: expect.any(Number) });
    });

    test('a tool call runs, then finishes with its output, under the name of its kind', async () => {
        const { session } = use().start('tool search {"pattern":"x"}\nsay done');
        const events = await collect(session);
        const tools = events.filter(event => event.type === 'tool');

        await session.close();

        expect(tools).toEqual([
            { type: 'tool', toolCallId: 't1-1', name: 'Read', input: { pattern: 'x' }, state: 'running' },
            { type: 'tool', toolCallId: 't1-1', name: 'Read', input: { pattern: 'x' }, state: 'done', output: 'search finished' },
        ]);
        // The message before a tool call and the one after it are two messages.
        expect(events.at(-1)).toEqual({ type: 'done', result: 'done' });
    });

    test('permission requests are answered by the daemon: allow takes the one-time option, reject refuses', async () => {
        const allow = use().start('perm');
        const allowed = await collect(allow.session);

        await allow.session.close();
        current?.stop();

        const reject = use({ permissions: 'reject' }).start('perm');
        const rejected = await collect(reject.session);

        await reject.session.close();

        expect(textOf(allowed)).toBe('permission: once');
        expect(textOf(rejected)).toBe('permission: reject');
    });

    test('usage reports the prompt tokens and the cost of the turn, not the running total', async () => {
        const { session, abort } = use().start('usage 100 20 0.25\nusage 10 5 0.5');
        const events = await collect(session);

        await session.close();
        abort.abort();

        // The prompt's tokens add up, and its cost is the session's total so far.
        expect(events.filter(event => event.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 110, outputTokens: 25, costUsd: 0.75 }]);
    });

    test('the window\'s fill the agent reports becomes a context event', async () => {
        const { session } = use().start('context 21269 1000000\ncontext 22062 1000000\nsay ok');
        const events = await collect(session);

        await session.close();

        expect(events.filter(event => event.type === 'context')).toEqual([{ type: 'context', used: 21269, size: 1_000_000 }, { type: 'context', used: 22062, size: 1_000_000 }]);
    });

    test('a compact command reports its tool call and the smaller window, and a turn with no words still ends with done', async () => {
        const { session } = use().start('/compact');
        const events = await collect(session);

        await session.close();

        expect(events.filter(event => event.type === 'tool').map(event => event.type === 'tool' && [event.name, event.state])).toEqual([['compact', 'running'], ['compact', 'done']]);
        // The counts reach the stream as the call's output, for the line that says what the compaction saved.
        expect(events.findLast(event => event.type === 'tool')).toMatchObject({ output: JSON.stringify({ trigger: 'manual', preTokens: 22_062, postTokens: 6111, durationMs: 4200 }) });
        expect(events.filter(event => event.type === 'context')).toEqual([{ type: 'context', used: 6111, size: 1_000_000 }]);
        expect(events.at(-1)).toEqual({ type: 'done', result: undefined });
    });

    test('a rate limit signal in the Claude adapter format becomes a limit event', async () => {
        const { session } = use().start('limit rejected 1900000000\nlimit allowed 1');
        const events = await collect(session);

        await session.close();

        expect(events.filter(event => event.type === 'limit')).toEqual([{ type: 'limit', status: 'rejected', kind: 'five_hour', utilization: 0.95, resetsAt: 1_900_000_000 }]);
    });

    test('the model, the folder and the system prompt reach the session', async () => {
        const { session } = use().start('info', { model: 'Smart', cwd: '/tmp', systemPrompt: 'be brief' });
        const events = await collect(session);

        await session.close();

        expect(JSON.parse(textOf(events))).toEqual({ cwd: '/tmp', servers: [], systemPrompt: 'be brief', model: 'smart', prompts: 1 });
    });

    describe('the reasoning level', () => {
        const choice = async (options: Parameters<Rig['start']>[1], agentEnv = { FAKE_ACP_EFFORT: '1' }) => {
            const { session } = use({ agentEnv }).start('choice', options);
            const events = await collect(session);

            await session.close();

            return JSON.parse(textOf(events)) as { model: string; effort: string; sets: number };
        };

        test('is set after the model, on the level the new model offers', async () => {
            // `max` exists on `smart` only: set before the model it would be refused, so the order is the point.
            expect(await choice({ model: 'smart', effort: 'max' })).toEqual({ model: 'smart', effort: 'max', sets: 2 });
        });

        test('is found by its value in any case, or by the name the agent shows for it', async () => {
            expect(await choice({ model: 'smart', effort: 'MEDIUM' })).toEqual({ model: 'smart', effort: 'medium', sets: 2 });
            expect(await choice({ model: 'smart', effort: 'extra high' })).toEqual({ model: 'smart', effort: 'xhigh', sets: 2 });
        });

        test('is looked for in every reasoning option, so an option of another kind in front of it does not hide it', async () => {
            expect(await choice({ model: 'smart', effort: 'max' }, { FAKE_ACP_EFFORT: 'thinking' })).toEqual({ model: 'smart', effort: 'max', sets: 2 });
        });

        test('is left to the agent, with a note in the log, when the model has no such level', async () => {
            const warn = spyOn(console, 'warn').mockImplementation(() => undefined);

            try {
                expect(await choice({ model: 'fast', effort: 'max' })).toEqual({ model: 'fast', effort: 'high', sets: 0 });
                expect(warn).toHaveBeenCalledWith(expect.stringContaining('offers no reasoning level called "max" for fast'));
            }
            finally {
                warn.mockRestore();
            }
        });

        test('is not sent again when the agent is on it already, and neither is the model', async () => {
            expect(await choice({ model: 'fast', effort: 'high' })).toEqual({ model: 'fast', effort: 'high', sets: 0 });
        });

        test('can be set without a model', async () => {
            expect(await choice({ effort: 'low' })).toEqual({ model: 'fast', effort: 'low', sets: 1 });
        });

        test('is set again on a session that resumes, since each turn is a new agent process', async () => {
            expect(await choice({ model: 'smart', effort: 'max', resumeSessionId: 'earlier-7' })).toEqual({ model: 'smart', effort: 'max', sets: 2 });
        });
    });

    test('the warning of Codex about resuming a session recorded with another model is not shown as a message', async () => {
        const { session } = use({ agentEnv: { FAKE_ACP_RESUME_WARNING: '1' } }).start('say fresh', { resumeSessionId: 'earlier-7' });
        const events = await collect(session);

        await session.close();

        expect(textOf(events)).toBe('fresh');
    });

    test('what the agent needs to hear about the client reaches it as the _meta of the capabilities', async () => {
        const meta = { parameterizedModelPicker: true };
        const heard = async (options?: Parameters<typeof use>[0]) => {
            const { session } = use(options).start('capabilities');
            const events = await collect(session);

            await session.close();

            return JSON.parse(textOf(events));
        };

        // Version 1 says it offers no terminal; version 2 has none to offer and is silent on it, as on files.
        const told = await heard({ clientMeta: meta });

        expect(told).toMatchObject(protocol === 'v1' ? { terminal: false, _meta: meta } : { _meta: meta });

        if (protocol === 'v2') {
            expect(told).not.toHaveProperty('terminal');
            expect(told).not.toHaveProperty('fs');
        }

        // An agent that asks for nothing gets none.
        expect(await heard()).not.toHaveProperty('_meta');
    });

    test('the options an adapter reads reach it as the _meta of the session', async () => {
        const meta = { claudeCode: { options: { disallowedTools: ['AskUserQuestion'] } } };
        const { session } = use({ sessionMeta: meta }).start('info');
        const events = await collect(session);

        await session.close();

        expect(JSON.parse(textOf(events))).toMatchObject({ meta });
    });

    test('an agent without the system prompt capability gets it in front of the first message', async () => {
        const { session } = use({ agentEnv: { FAKE_ACP_SYSTEM_PROMPT: '0' } }).start('prompt', { systemPrompt: 'be brief' });
        const events = await collect(session);

        await session.close();

        expect(JSON.parse(textOf(events).replace(/^(ok)+/, ''))).toBe('be brief\n\n---\n\nprompt');
    });

    test('the agent gets the daemon\'s environment without its secrets or the provider keys of the agent', async () => {
        const env = { HOME: '/home/someone', CLOWDY_TOKEN: 'secret', ELECTRON_RUN_AS_NODE: '1', PATH: process.env.PATH };
        const { session } = use({ env }).start('env HOME\nenv CLOWDY_TOKEN\nenv ELECTRON_RUN_AS_NODE');
        const events = await collect(session);

        await session.close();

        expect(textOf(events)).toBe('HOME=/home/someoneCLOWDY_TOKEN=ELECTRON_RUN_AS_NODE=');
        // Bun starts the fake agent with a home folder that does not exist, which can take a while on a busy machine.
    }, 20_000);
});

eachProtocol('steering', (protocol) => {
    /** Reads the session to its end, steering `text` once the agent has said `after`; returns the events and what the steer resolved to. */
    async function steerDuring(prompt: string, after: string, text: string, options?: Parameters<typeof rig>[0]) {
        const { session } = use(options).start(prompt);
        const events: EngineEvent[] = [];
        let answer: Promise<boolean> | undefined;

        for await (const event of session) {
            events.push(event);

            if (!answer && textOf(events).includes(after)) {
                answer = session.steer!(text);
            }

            if (event.type === 'done' || event.type === 'error') {
                break;
            }
        }

        const taken = await answer;

        await session.close();

        return { events, taken };
    }

    test('a steer of the running prompt is injected, and the agent answers it in the same turn', async () => {
        const { events, taken } = await steerDuring('say first\nsleep 200\nsay last', 'first', 'say steered', { agentEnv: { FAKE_ACP_STEERING: '1' } });

        expect(taken).toBe(true);
        expect(types(events).filter(type => type === 'done')).toHaveLength(1);
        expect(textOf(events)).toBe('firststeeredlast');
    });

    test.skipIf(protocol === 'v2')('an agent that does not say it can steer is not asked, and the message stays with the runtime', async () => {
        const log = join(mkdtempSync(join(tmpdir(), 'clowdy-steer-')), 'requests');
        const { events, taken } = await steerDuring('say first\nsleep 100\nsay last', 'first', 'say steered', { agentEnv: { FAKE_ACP_LOG: log } });

        expect(taken).toBe(false);
        expect(textOf(events)).toBe('firstlast');
        expect(readFileSync(log, { encoding: 'utf8', flag: 'a+' })).toBe('');
        rmSync(dirname(log), { recursive: true, force: true });
    });

    /** What the session says of steering before it has started and once the agent has answered the handshake (its `session` event). */
    async function canSteerAround(options?: Parameters<typeof rig>[0]) {
        const { session } = use(options).start('say hello');
        const before = session.canSteer;

        for await (const event of session) {
            if (event.type === 'session') {
                break;
            }
        }

        const after = session.canSteer;

        await session.close();

        return { before, after };
    }

    test('an agent that says in its handshake that it can steer says so, and is taken to until it has spoken', async () => {
        expect(await canSteerAround({ agentEnv: { FAKE_ACP_STEERING: '1' } })).toEqual({ before: true, after: true });
    });

    test.skipIf(protocol === 'v2')('an agent that does not say it can steer cannot, once its handshake is answered', async () => {
        expect(await canSteerAround()).toEqual({ before: true, after: false });
    });

    test.skipIf(protocol === 'v1')('an agent over v2 can always steer: a prompt into a running turn is inserted', async () => {
        expect(await canSteerAround()).toEqual({ before: true, after: true });
    });

    test.skipIf(protocol === 'v1')('a steer is a prompt the agent inserts into the turn: no steering method is asked, and one answer ends the whole turn', async () => {
        const log = join(mkdtempSync(join(tmpdir(), 'clowdy-steer-')), 'requests');
        const { events, taken } = await steerDuring('say first\nsleep 200\nsay last', 'first', 'say steered', { agentEnv: { FAKE_ACP_LOG: log } });

        expect(taken).toBe(true);
        // The agent logs a prompt that came while its turn ran, which is how a v2 steer arrives.
        expect(readFileSync(log, 'utf8')).toBe('steer say steered\n');
        expect(types(events).filter(type => type === 'done')).toHaveLength(1);
        expect(textOf(events)).toBe('firststeeredlast');
        rmSync(dirname(log), { recursive: true, force: true });
    });

    test.skipIf(protocol === 'v1')('a prompt the agent holds until the turn is over is no steer that landed, even when its answer comes before the reader looks again', async () => {
        const log = join(mkdtempSync(join(tmpdir(), 'clowdy-steer-')), 'requests');
        const { session } = use({ agentEnv: { FAKE_ACP_QUEUE: '1', FAKE_ACP_LOG: log } }).start('say first\nsleep 200\nsay last');
        const events: EngineEvent[] = [];
        let steer: Promise<boolean> | undefined;

        for await (const event of session) {
            events.push(event);

            if (!steer && textOf(events).includes('first')) {
                steer = session.steer!('say steered');
            }

            if (event.type === 'done') {
                // Codex answers the held prompt right after the `idle` that ends the turn; the session is still open while the reader is busy.
                await until(() => readFileSync(log, 'utf8').includes('queued'), 'the agent to hold the prompt');
                await Bun.sleep(200);
                break;
            }
        }

        await session.close();

        // The turn ended on its own `idle`: the held prompt belongs to a turn this layer never reads, so the runtime keeps the message.
        expect(await steer).toBe(false);
        expect(types(events).filter(type => type === 'done')).toHaveLength(1);
        expect(textOf(events)).toBe('firstlast');
        rmSync(dirname(log), { recursive: true, force: true });
    });

    test('a steer that comes before the prompt waits for it, and one after the turn is refused', async () => {
        // The steer goes out right behind the prompt, and the agent may answer it before its turn has begun (the fake one does: its steering handler comes
        // first in its dispatch), so the session asks again 100 ms later. The turn outlasts that retry by far, or the turn could end before it.
        const { session } = use({ agentEnv: { FAKE_ACP_STEERING: '1' } }).start('say first\nsleep 1000');
        // Nothing runs until the session is read: the agent is not even started yet.
        const early = session.steer!('say early');
        const events = await collect(session);
        const late = await session.steer!('say late');

        await session.close();

        expect(await early).toBe(true);
        expect(late).toBe(false);
        expect(textOf(events)).toBe('firstearly');
    });

    test('a session that ends before its prompt refuses the steer that waited for it', async () => {
        const { session, abort } = use({ agentEnv: { FAKE_ACP_STEERING: '1' } }).start('say first');
        const waiting = session.steer!('say steered');

        abort.abort();
        await collect(session);
        await session.close();

        expect(await waiting).toBe(false);
    });
});

eachProtocol('resuming', (protocol) => {
    test('session/resume continues the earlier session id', async () => {
        const { session } = use().start('info', { resumeSessionId: 'earlier-7' });
        const events = await collect(session);

        await session.close();

        expect(events.find(event => event.type === 'session')).toEqual({ type: 'session', sessionId: 'earlier-7' });
        expect(JSON.parse(textOf(events))).toMatchObject({ prompts: 1 });
    });

    test.skipIf(protocol === 'v2')('session/load replays the conversation, which is swallowed', async () => {
        const { session } = use({ agentEnv: { FAKE_ACP_RESUME: 'load' } }).start('say fresh', { resumeSessionId: 'earlier-7' });
        const events = await collect(session);

        await session.close();

        expect(events.find(event => event.type === 'session')).toEqual({ type: 'session', sessionId: 'earlier-7' });
        expect(textOf(events)).toBe('fresh');
    });

    test.skipIf(protocol === 'v1')('a resume asks for no replay of the history, and one the agent sends anyway, with a stale end of turn in it, is not news', async () => {
        const { session } = use({ agentEnv: { FAKE_ACP_REPLAY: 'always' } }).start('info\nsay fresh', { resumeSessionId: 'earlier-7' });
        const events = await collect(session);

        await session.close();

        expect(events.find(event => event.type === 'session')).toEqual({ type: 'session', sessionId: 'earlier-7' });
        // The turn did not end at the replayed `idle`: the agent's own words are all there, and nothing of the history.
        expect(JSON.parse(textOf(events).replace(/fresh$/, ''))).not.toHaveProperty('replayFrom');
        expect(textOf(events)).toMatch(/fresh$/);
        expect(textOf(events)).not.toContain('replayed');
        expect(types(events).filter(type => type === 'done')).toHaveLength(1);
    });

    test.skipIf(protocol === 'v1')('an agent that replays only when asked is not asked, and the turn runs on the session it continues', async () => {
        const { session } = use({ agentEnv: { FAKE_ACP_RESUME_WARNING: '1' } }).start('info', { resumeSessionId: 'earlier-7' });
        const events = await collect(session);

        await session.close();

        expect(JSON.parse(textOf(events))).toMatchObject({ prompts: 1 });
        expect(JSON.parse(textOf(events))).not.toHaveProperty('replayFrom');
    });

    test('an agent that cannot resume starts a new session, which the runtime stores instead', async () => {
        const { session } = use({ agentEnv: { FAKE_ACP_RESUME: 'none' } }).start('say fresh', { resumeSessionId: 'earlier-7' });
        const events = await collect(session);

        await session.close();

        expect(events.find(event => event.type === 'session')).toEqual({ type: 'session', sessionId: 'fake-1' });
    });
});

eachProtocol('the project\'s other folders', (protocol) => {
    const folders = ['/work/api', '/work/notes'];
    const advertised = { FAKE_ACP_DIRECTORIES: '1' };

    /** The session a turn ended up in and the folders it was opened with, as the fake agent's `info` directive reports them. */
    const opened = async (agentEnv: Record<string, string>, options: Parameters<Rig['start']>[1] = {}) => {
        const { session } = use({ agentEnv }).start('info', options);
        const events = await collect(session);

        await session.close();
        current?.stop();

        const said = events.find(event => event.type === 'session');

        return { sessionId: said?.type === 'session' ? said.sessionId : undefined, ...JSON.parse(textOf(events)) as { directories?: string[]; prompts: number } };
    };

    test('reach a new session of an agent that advertises them, in their order', async () => {
        expect(await opened(advertised, { additionalDirectories: folders })).toMatchObject({ sessionId: 'fake-1', directories: folders });
    });

    test('reach a session that resumes (or loads, on v1), and a list changed since the last turn continues the same session', async () => {
        const first = await opened(advertised, { additionalDirectories: ['/work/api'] });
        const resumed = await opened(advertised, { additionalDirectories: folders, resumeSessionId: first.sessionId });
        expect(first).toMatchObject({ sessionId: 'fake-1', directories: ['/work/api'] });
        expect(resumed).toMatchObject({ sessionId: 'fake-1', directories: folders });

        // Version 2 has no `session/load`.
        if (protocol === 'v1') {
            expect(await opened({ ...advertised, FAKE_ACP_RESUME: 'load' }, { additionalDirectories: folders, resumeSessionId: 'earlier-7' })).toMatchObject({ sessionId: 'earlier-7', directories: folders });
        }
    });

    test('are left out for an agent that does not advertise them, new or resumed, and when there are none', async () => {
        expect(await opened({}, { additionalDirectories: folders })).not.toHaveProperty('directories');
        // Grok's resume refuses a list it did not ask for.
        const resumed = await opened({}, { additionalDirectories: folders, resumeSessionId: 'earlier-7' });

        expect(resumed.sessionId).toBe('earlier-7');
        expect(resumed).not.toHaveProperty('directories');
        expect(await opened(advertised, { additionalDirectories: [] })).not.toHaveProperty('directories');
        expect(await opened(advertised)).not.toHaveProperty('directories');
    });
});

eachProtocol('a session that cannot be continued', () => {
    const record = 'RECORD: the person asked for a footer.';
    /** The fake agent answers every line it does not know with `ok` and the `prompt` directive with the whole prompt as a JSON string, last. */
    const promptIn = (events: EngineEvent[]): string => {
        const said = textOf(events);

        return JSON.parse(said.slice(said.indexOf('"'))) as string;
    };
    /** What the agent was asked in its first prompt of the new session, as the fake agent's `prompt` directive reports it. */
    const promptOf = async (agentEnv: Record<string, string>, options: Partial<Parameters<ReturnType<typeof use>['start']>[1]> & object = {}) => {
        const { session } = use({ agentEnv }).start('prompt', { resumeSessionId: 'earlier-7', ...options });
        const events = await collect(session);

        await session.close();

        return { events, prompt: promptIn(events) };
    };

    test('starts a new session that is told what the conversation was, ahead of the message', async () => {
        const { events, prompt } = await promptOf({ FAKE_ACP_LOST: '1' }, { history: () => record });

        expect(events.find(event => event.type === 'session')).toEqual({ type: 'session', sessionId: 'fake-1' });
        expect(prompt).toBe(`${ record }\n\n---\n\nprompt`);
    });

    test('an agent that cannot resume at all is told as well', async () => {
        const { prompt } = await promptOf({ FAKE_ACP_RESUME: 'none' }, { history: () => record });

        expect(prompt).toBe(`${ record }\n\n---\n\nprompt`);
    });

    test('an agent that takes no system prompt gets it first, then the record, then the message', async () => {
        const { prompt } = await promptOf({ FAKE_ACP_LOST: '1', FAKE_ACP_SYSTEM_PROMPT: '0' }, { history: () => record, systemPrompt: 'SYSTEM' });

        expect(prompt).toBe(`SYSTEM\n\n---\n\n${ record }\n\n---\n\nprompt`);
    });

    test('a session that resumes is not told, and the record is not even made', async () => {
        const history = mock(() => record);
        const { prompt } = await promptOf({}, { history });

        expect(prompt).toBe('prompt');
        expect(history).not.toHaveBeenCalled();
    });

    test('a first session, which has nothing to continue, is not told either', async () => {
        const history = mock(() => record);
        const { session } = use().start('prompt', { history });
        const events = await collect(session);

        await session.close();

        expect(promptIn(events)).toBe('prompt');
        expect(history).not.toHaveBeenCalled();
    });

    test('a record that cannot be made, or that is empty, leaves the message as it is', async () => {
        const failing = await promptOf({ FAKE_ACP_LOST: '1' }, { history: () => {
            throw new Error('the stream is gone');
        } });
        const empty = await promptOf({ FAKE_ACP_LOST: '1' }, { history: () => undefined });

        expect(failing.prompt).toBe('prompt');
        expect(failing.events.at(-1)).toMatchObject({ type: 'done' });
        expect(empty.prompt).toBe('prompt');
    });
});

eachProtocol('failures', () => {
    const errorOf = async (prompt: string, options?: Parameters<typeof rig>[0]) => {
        const { session } = use(options).start(prompt);
        const events = await collect(session);

        await session.close();

        return events.find(event => event.type === 'error');
    };

    test('authentication required names the agent and its sign-in command', async () => {
        expect(await errorOf('say hi', { agentEnv: { FAKE_ACP_AUTH: '1' } })).toMatchObject({ type: 'error', code: 'not_logged_in', message: expect.stringContaining('Fake ACP is not signed in') });
    });

    test('an overloaded service is retryable', async () => {
        expect(await errorOf('fail -32603 API Error: 529 {"error":{"message":"Overloaded"}}')).toMatchObject({ code: 'overloaded', retryable: true });
    });

    test('a usage limit says when it resets and is retryable', async () => {
        expect(await errorOf('fail -32603 You have hit your limit. It resets 3pm')).toMatchObject({ code: 'usage_limit', retryable: true, message: expect.stringContaining('resets 3pm') });
    });

    test('a crash quotes the end of what the agent wrote to stderr', async () => {
        expect(await errorOf('say before\ncrash')).toMatchObject({ code: 'process_crashed', retryable: true, message: expect.stringContaining('boom: the fake agent crashed') });
    });

    test('an agent that is not installed fails with engine_missing before anything starts', async () => {
        const { session } = use({ command: '/nonexistent/agent', args: [] }).start('say hi');
        const events = await collect(session);

        expect(events).toEqual([{ type: 'error', message: 'The command "/nonexistent/agent" of Fake ACP was not found', code: 'engine_missing' }]);
    });

    test('a program that exists but is not an ACP agent ends as a crash, not a hang', async () => {
        const { session } = use({ command: process.execPath, args: ['-e', 'process.exit(2)'] }).start('say hi');
        const events = await collect(session);

        await session.close();

        expect(events.at(-1)).toMatchObject({ type: 'error', code: 'process_crashed' });
    });
});

eachProtocol('cancelling', () => {
    test('aborting stops the agent and its process group, and the session ends without an error', async () => {
        const { session, abort } = use().start('say working\nsleep 30000');
        const events: EngineEvent[] = [];
        let pid = 0;

        for await (const event of session) {
            events.push(event);

            if (event.type === 'process') {
                pid = event.pid;
            }

            if (event.type === 'text' && textOf(events) === 'working') {
                abort.abort();
            }
        }

        const started = Date.now();

        await session.close();

        expect(Date.now() - started).toBeLessThan(4000);
        expect(types(events)).not.toContain('done');
        expect(types(events)).not.toContain('error');
        expect(() => process.kill(pid, 0)).toThrow();
    });

    test('the agent is told with session/cancel before its input closes', async () => {
        const log = join(mkdtempSync(join(tmpdir(), 'clowdy-cancel-')), 'cancels');
        const { session, abort } = use({ agentEnv: { FAKE_ACP_LOG: log } }).start('say working\nsleep 30000');

        for await (const event of session) {
            if (event.type === 'text' && event.delta) {
                abort.abort();
            }
        }

        await session.close();

        expect(readFileSync(log, 'utf8')).toBe('cancel fake-1\n');
        rmSync(dirname(log), { recursive: true, force: true });
    });

    test('a program that never answers the handshake ends the turn with a message, and its process is stopped', async () => {
        // Not an ACP agent: it writes to stderr and says nothing on the wire.
        const { session } = use({ command: '/bin/sh', args: ['-c', 'echo not an agent >&2; sleep 30'], initializeTimeoutMs: 400 }).start('say hi');
        const events = await collect(session);
        const failed = events.find(event => event.type === 'error');

        await session.close();

        expect(failed).toMatchObject({ type: 'error' });
        expect((failed as { message: string }).message).toMatch(/did not answer the ACP handshake.*not an agent/s);

        const launched = events.find(event => event.type === 'process');

        await until(() => launched === undefined || !alive(launched.pid), 'the process to be gone');
    });

    test('aborting while the agent is still starting ends the session and leaves no process', async () => {
        const { session, abort } = use().start('sleep 30000');
        const iterator = session[Symbol.asyncIterator]();
        const first = iterator.next();
        const events: EngineEvent[] = [];

        // Nothing has happened yet: the program is still being looked for.
        abort.abort();

        for (let event = await first; !event.done; event = await iterator.next()) {
            events.push(event.value);
        }

        const started = Date.now();

        await session.close();

        expect(Date.now() - started).toBeLessThan(4000);
        expect(types(events)).not.toContain('session');
        expect(types(events)).not.toContain('error');

        const launched = events.find(event => event.type === 'process');

        await until(() => launched === undefined || !alive(launched.pid), 'the agent to be gone');
    });

    test('a reader that stops right at the process event does not leave the process behind', async () => {
        const { session } = use().start('sleep 30000');
        let pid = 0;

        for await (const event of session) {
            if (event.type === 'process') {
                pid = event.pid;
                break;
            }
        }

        await session.close();
        await until(() => !alive(pid), 'the agent to be gone');
    });
});

eachProtocol('the runtime\'s tools', () => {
    test('an agent calls them through the bridge, the call runs in the daemon, and its calls show under the tool\'s own name', async () => {
        const seen: unknown[] = [];
        const tools = [
            tool('task_list', async (input) => {
                seen.push(input);

                return { tasks: ['CLW-1'] };
            }),
            tool('task_get', async () => {
                throw new Error('No task CLW-9');
            }),
        ];
        const { session } = use().start('info\ncall task_list {"project":"p"}\ncall task_get {}', { tools });
        const events = await collect(session);

        await session.close();

        expect(seen).toEqual([{ project: 'p' }]);
        expect(JSON.parse(textOf(events).split('}')[0] + '}')).toMatchObject({ servers: ['clowdy'] });
        expect(textOf(events)).toContain('result: {"tasks":["CLW-1"]}');
        expect(textOf(events)).toContain('error: No task CLW-9');
        expect(events.filter(event => event.type === 'tool').map(event => event.type === 'tool' && [event.name, event.state])).toEqual([
            ['task_list', 'running'],
            ['task_list', 'done'],
            ['task_get', 'running'],
            ['task_get', 'error'],
        ]);
    });

    test('cancelling the run aborts a tool call that is still running', async () => {
        let entered = false;
        let aborted = false;
        const tools = [tool('ask_user', (_input, signal) => new Promise((_resolve, reject) => {
            entered = true;
            signal.addEventListener('abort', () => {
                aborted = true;
                reject(new Error('cancelled'));
            });
        }))];

        const { session, abort } = use().start('call ask_user {}', { tools });
        const reading = collect(session);

        await until(() => entered, 'the agent to call the tool');
        abort.abort();
        await reading;
        await session.close();

        expect(aborted).toBe(true);
    });
});

describe('probing an agent', () => {
    test('opens a session without a prompt and reports what the agent can do', async () => {
        const { registry, bridge } = use();
        const probe = await probeAgent(registry, bridge, 'fake-acp', { cwd: process.cwd() });

        expect(probe).toMatchObject({ id: 'fake-acp', protocolVersion: 1, agentInfo: { name: 'fake-acp-agent', version: '1.0.0' }, sessionId: 'fake-1', options: ['model (model)'], capabilities: { sessionCapabilities: { resume: {}, systemPrompt: {} } } });
    });

    test('tells the agent what a run tells it about the client, so the options it shows are the ones a run gets', async () => {
        const meta = { parameterizedModelPicker: true };
        const heard = async (options: Parameters<typeof use>[0]) => {
            current?.stop();

            const { registry, bridge } = use({ ...options, agentEnv: { FAKE_ACP_ECHO_CLIENT: '1' } });

            return (await probeAgent(registry, bridge, 'fake-acp', { cwd: process.cwd() })).capabilities._meta?.client;
        };

        expect(await heard({ clientMeta: meta })).toMatchObject({ terminal: false, _meta: meta });
        expect(await heard({})).not.toHaveProperty('_meta');
    });

    test('says why an agent that is not there, or is not an ACP agent, cannot be probed', async () => {
        const missing = use({ command: '/nonexistent/agent', args: [] });

        await expect(probeAgent(missing.registry, missing.bridge, 'fake-acp', { cwd: process.cwd() })).rejects.toThrow('was not found');

        const broken = use({ command: process.execPath, args: ['-e', 'console.error("not an agent"); process.exit(2)'] });

        await expect(probeAgent(broken.registry, broken.bridge, 'fake-acp', { cwd: process.cwd(), timeoutMs: 5000 })).rejects.toThrow('The agent wrote: not an agent');
    });
});

eachProtocol('the title an agent gives its session', () => {
    const named = { FAKE_ACP_TITLES: '1' };
    const logPath = () => join(mkdtempSync(join(tmpdir(), 'clowdy-titles-')), 'agent.log');

    /** What a runtime that wants the name does: takes the first title that is not the message again, and says so. */
    const wanting = (message = 'a message that is no title') => {
        const given: string[] = [];

        return { given, title: { onTitle: (title: string) => given.push(title) > 0 && title !== message } };
    };

    const pidOf = (events: EngineEvent[]) => {
        const process = events.find(event => event.type === 'process');

        return process?.type === 'process' ? process.pid : -1;
    };

    test('a title the runtime keeps is given to the agent before the first message, and the agent names nothing over it', async () => {
        const log = logPath();
        const { session } = use({ agentEnv: { ...named, FAKE_ACP_LOG: log } }).start('title Made by the agent\ninfo', { title: { keep: 'Fix the login form' } });
        const events = await collect(session);

        await session.close();

        expect(JSON.parse(textOf(events))).toMatchObject({ title: 'Fix the login form' });
        expect(readFileSync(log, 'utf8')).toBe('title fake-1 Fix the login form\n');
        rmSync(dirname(log), { recursive: true, force: true });
    });

    test('an agent that does not name sessions is not asked to keep one', async () => {
        const log = logPath();
        const { session } = use({ agentEnv: { FAKE_ACP_LOG: log } }).start('info', { title: { keep: 'Fix the login form' } });
        const events = await collect(session);

        await session.close();

        expect(JSON.parse(textOf(events))).not.toHaveProperty('title');
        expect(() => readFileSync(log, 'utf8')).toThrow();
        rmSync(dirname(log), { recursive: true, force: true });
    });

    test('a title the agent gives during the turn goes to the runtime, and the agent stops with the turn', async () => {
        const { given, title } = wanting();
        const { session } = use({ agentEnv: named }).start('title Dark mode toggle\nsay done', { title });
        const events = await collect(session);

        await session.close();

        expect(given).toEqual(['Dark mode toggle']);
        await until(() => !alive(pidOf(events)), 'the agent to stop');
    });

    test('an agent that names its session after the turn keeps running for the name, and stops when the runtime has it', async () => {
        const message = 'echo\nlate 300 Dark mode toggle\nsay done';
        const { given, title } = wanting(message.replace(/\s+/g, ' '));
        const { session } = use({ agentEnv: named }).start(message, { title });
        const events = await collect(session);
        const pid = pidOf(events);

        // The turn is over, and the run does not wait for the agent.
        await session.close();
        expect(events.at(-1)).toMatchObject({ type: 'done' });
        expect(alive(pid)).toBe(true);

        await until(() => given.includes('Dark mode toggle'), 'the name');
        // The message as a title came first and was not taken.
        expect(given).toEqual([message.replace(/\s+/g, ' '), 'Dark mode toggle']);
        await until(() => !alive(pid), 'the agent to stop');
    });

    test('an agent that never names its session is stopped when the wait is over', async () => {
        const { given, title } = wanting();
        const { session } = use({ agentEnv: named, titleWaitMs: 200 }).start('late 5000 Too late\nsay done', { title });
        const events = await collect(session);

        await session.close();
        expect(alive(pidOf(events))).toBe(true);
        await until(() => !alive(pidOf(events)), 'the agent to stop');
        expect(given).toEqual([]);
    });

    test('cancelling the run ends the wait', async () => {
        const { title } = wanting();
        const { session, abort } = use({ agentEnv: named }).start('late 5000 Too late\nsay done', { title });
        const events = await collect(session);

        await session.close();
        expect(alive(pidOf(events))).toBe(true);
        abort.abort();
        await until(() => !alive(pidOf(events)), 'the agent to stop');
    });

    test('a title the runtime fails to take does not end the turn', async () => {
        const warn = spyOn(console, 'warn').mockImplementation(() => undefined);

        try {
            const onTitle = (): boolean => {
                throw new Error('the store is closed');
            };
            const { session } = use({ agentEnv: named, titleWaitMs: 200 }).start('title Dark mode toggle\nsay done', { title: { onTitle } });
            const events = await collect(session);

            await session.close();
            expect(events.at(-1)).toMatchObject({ type: 'done', result: 'done' });
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('the store is closed'));
            await until(() => !alive(pidOf(events)), 'the agent to stop');
        }
        finally {
            warn.mockRestore();
        }
    });

    test('a session that continues has its title already: it is given none to keep and is not waited for', async () => {
        const log = logPath();
        const { given, title } = wanting();
        const wants = use({ agentEnv: named }).start('late 5000 Too late\nsay done', { resumeSessionId: 'earlier-7', title });
        const events = await collect(wants.session);

        await wants.session.close();
        // The agent stops with the turn, as one that is not waited for, not after the ten seconds of the wait.
        await until(() => !alive(pidOf(events)), 'the agent to stop');
        expect(given).toEqual([]);
        current?.stop();

        const keeps = use({ agentEnv: { ...named, FAKE_ACP_LOG: log } }).start('say done', { resumeSessionId: 'earlier-7', title: { keep: 'Fix the login form' } });

        await collect(keeps.session);
        await keeps.session.close();
        expect(() => readFileSync(log, 'utf8')).toThrow();
        rmSync(dirname(log), { recursive: true, force: true });
    });

    test('a session that was to continue and starts a new one is named like any new session', async () => {
        const log = logPath();
        const { session } = use({ agentEnv: { ...named, FAKE_ACP_LOST: '1', FAKE_ACP_LOG: log } }).start('say done', { resumeSessionId: 'earlier-7', title: { keep: 'Fix the login form' } });

        await collect(session);
        await session.close();
        expect(readFileSync(log, 'utf8')).toMatch(/^title fake-\d+ Fix the login form\n$/);
        rmSync(dirname(log), { recursive: true, force: true });
    });

    test('an agent that does not name sessions is not waited for, and a turn that failed is not either', async () => {
        const quiet = wanting();
        const first = use().start('say done', { title: quiet.title });
        const done = await collect(first.session);

        await first.session.close();
        await until(() => !alive(pidOf(done)), 'the agent to stop');
        current?.stop();

        const failing = wanting();
        const second = use({ agentEnv: named }).start('fail -32000 broken', { title: failing.title });
        const failed = await collect(second.session);

        await second.session.close();
        expect(failed.at(-1)).toMatchObject({ type: 'error' });
        await until(() => !alive(pidOf(failed)), 'the agent to stop');
    });
});

describe('the turn of an ACP v2 agent', () => {
    beforeEach(() => {
        speaking = 'v2';
    });
    afterEach(() => {
        speaking = 'v1';
    });

    const run = async (prompt: string, options?: Parameters<typeof rig>[0]) => {
        const { session } = use(options).start(prompt);
        const events = await collect(session);

        await session.close();

        return events;
    };

    test('a pause for a person (`requires_action`) is not the end of the turn: it goes on when the agent says `running`', async () => {
        const events = await run('say before\npause 150\nsay after');

        expect(textOf(events)).toBe('beforeafter');
        expect(types(events).filter(type => type === 'done')).toHaveLength(1);
        expect(events.at(-1)).toEqual({ type: 'done', result: 'after' });
    });

    test('an `idle` before the turn has begun is a snapshot of the session and not its end, with a stop reason (a repeated one carries the last) or without', async () => {
        for (const snapshot of ['1', 'reason']) {
            const events = await run('say hi', { agentEnv: { FAKE_ACP_SNAPSHOT: snapshot } });

            expect(events.at(-1)).toEqual({ type: 'done', result: 'hi' });
            expect(types(events).filter(type => type === 'done')).toHaveLength(1);
        }
    });

    test('a prompt the agent refuses ends the turn with its error and no `done`, whatever the agent was doing', async () => {
        const events = await run('say hi', { agentEnv: { FAKE_ACP_REJECT: '1' } });

        expect(types(events)).toEqual(['process', 'session', 'error']);
        expect(events.at(-1)).toMatchObject({ type: 'error', code: 'not_logged_in' });
    });

    test('work that starts blocked on a person (`requires_action` with no `running` before it) is a turn, and its `idle` ends it', async () => {
        const events = await run('say hi', { agentEnv: { FAKE_ACP_BLOCKED: '1' } });

        expect(events.at(-1)).toEqual({ type: 'done', result: 'hi' });
    });

    test('a message the agent sends whole, again and again with more of its text, is shown as it grows', async () => {
        const events = await run('say hello world', { agentEnv: { FAKE_ACP_WHOLE: '1' } });

        expect(events.filter(event => event.type === 'text').map(event => event.type === 'text' && [event.delta, event.done])).toEqual([['hello ', false], ['world', false], ['', true]]);
        expect(events.at(-1)).toEqual({ type: 'done', result: 'hello world' });
    });

    test('a turn that stops for a reason that is no answer fails with what the reason says', async () => {
        expect((await run('say partial\nstop max_tokens')).at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('limit on the length of an answer') });
        expect((await run('stop max_turn_requests')).at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('limit on steps') });
        expect((await run('stop refusal')).at(-1)).toMatchObject({ type: 'error', code: 'invalid_request' });
    });

    test('what the agent reports on the `idle` that ends the turn is the turn\'s usage, with no cost when the agent says none', async () => {
        const events = await run('usage 100 20 0');

        expect(events.filter(event => event.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 100, outputTokens: 20, costUsd: 0 }]);
    });
});

describe('an ACP v2 session that outlives its turn', () => {
    beforeEach(() => {
        speaking = 'v2';
    });
    afterEach(() => {
        speaking = 'v1';
    });

    /** Reads the session to its end in the background, so a test can send into it and watch what it says meanwhile. */
    function follow(session: EngineSession) {
        const events: EngineEvent[] = [];
        const ended = (async () => {
            for await (const event of session) {
                events.push(event);
            }
        })();
        const dones = () => events.filter(event => event.type === 'done');

        return { events, ended, dones, until: (count: number) => until(() => dones().length >= count, `${ count } done events`, 8000) };
    }

    const pidOf = (events: EngineEvent[]) => events.find(event => event.type === 'process')?.pid ?? -1;
    const backgrounds = (events: EngineEvent[]) => events.flatMap(event => event.type === 'background' ? [event.items] : []);
    /** What the agent said, message by message, with a `done:<result>` where each `done` came. */
    const turns = (events: EngineEvent[]) => {
        const told: string[] = [];
        let open = '';

        for (const event of events) {
            if (event.type === 'text') {
                open += event.delta;

                if (event.done) {
                    told.push(open);
                    open = '';
                }
            }
            else if (event.type === 'done') {
                told.push(`done:${ event.result }`);
            }
        }

        return told;
    };

    describe('background work', () => {
        test('a turn that started work says what is open before it says done, and leaves the process alive for the report that follows', async () => {
            const { session } = use({ backgroundHandoffMs: 300 }).start('say started\nbackground terminal 500 sleep 5\nreport say all done');
            const { events, ended, dones, until: untilDone } = follow(session);

            await untilDone(1);

            const pid = pidOf(events);
            const first = types(events);

            expect(first.slice(-2)).toEqual(['background', 'done']);
            expect(backgrounds(events)).toEqual([[{ id: 'term-1', kind: 'command', title: 'sleep 5' }]]);
            expect(dones()[0]).toEqual({ type: 'done', result: 'started' });
            // The turn is over and the process is not: the work it started runs on in it.
            expect(alive(pid)).toBe(true);

            await untilDone(2);

            // The list said the command ended before the report turn began, and the report is a turn of its own with its own `done`.
            expect(backgrounds(events)).toEqual([[{ id: 'term-1', kind: 'command', title: 'sleep 5' }], []]);
            expect(turns(events)).toEqual(['started', 'done:started', 'all done', 'done:all done']);
            expect(types(events).lastIndexOf('background')).toBeLessThan(types(events).lastIndexOf('text'));

            // Nothing is open and nothing runs: the session ends after the guard, and the process with it.
            await ended;
            await session.close();
            await until(() => !alive(pid), 'the agent to stop');
            // The process was told to the runtime once, at the start.
            expect(types(events).filter(type => type === 'process')).toHaveLength(1);
        });

        test('the report turn is a turn like any: its text, tools, usage and window map as a turn\'s do, and its cost is its own', async () => {
            const { session } = use({ backgroundHandoffMs: 200 }).start('usage 10 2 0.01\nbackground terminal 100 sleep\nreport tool read {"file_path":"a"}\nreport say reported\nreport usage 30 4 0.02\nreport context 5000 200000');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(2);
            await ended;
            await session.close();

            const afterFirst = events.slice(types(events).indexOf('done') + 1);

            expect(afterFirst.filter(event => event.type === 'tool').map(event => event.type === 'tool' && [event.name, event.state])).toEqual([['Read', 'running'], ['Read', 'done']]);
            expect(afterFirst.filter(event => event.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 30, outputTokens: 4, costUsd: expect.closeTo(0.02, 6) }]);
            // The `usage` directive reports a window of its own first (34 tokens), then the directive that follows it says 5000.
            expect(afterFirst.filter(event => event.type === 'context')).toEqual([{ type: 'context', used: 34, size: 200000 }, { type: 'context', used: 5000, size: 200000 }]);
            expect(events.filter(event => event.type === 'usage')[0]).toEqual({ type: 'usage', inputTokens: 10, outputTokens: 2, costUsd: 0.01 });
            expect(afterFirst.at(-1)).toEqual({ type: 'done', result: 'reported' });
        });

        test('what a turn with no work open does is unchanged: the iterator is the reader\'s to stop at its `done`', async () => {
            const { session } = use().start('say plain');
            const events = await collect(session);

            await session.close();

            expect(types(events)).toEqual(['process', 'session', 'text', 'text', 'text', 'done']);
            expect(events.at(-1)).toEqual({ type: 'done', result: 'plain' });
        });

        test('an agent that has nothing open when its turn ends is ended by the guard, after the `done`, when the reader goes on', async () => {
            const { session } = use({ backgroundHandoffMs: 200 }).start('say plain');
            const started = Date.now();
            const { events, ended } = follow(session);

            await ended;
            await session.close();

            expect(events.at(-1)).toEqual({ type: 'done', result: 'plain' });
            expect(Date.now() - started).toBeGreaterThanOrEqual(200);
            await until(() => !alive(pidOf(events)), 'the agent to stop');
        });

        /** The id of the item of the first sub-agent the fake agent starts: the id of the call that started it. */
        const CALL_OF_CHILD_1 = 'toolu-child-1';

        test('a sub-agent is a `subagent` item named by its title and by the call that started it, and what it says on its own session is not the turn\'s', async () => {
            const { session } = use({ backgroundHandoffMs: 300 }).start('say started\nbackground subagent 300 Map the docs\nreport say mapped');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(2);
            await ended;
            await session.close();

            expect(backgrounds(events)).toEqual([[{ id: CALL_OF_CHILD_1, kind: 'subagent', title: 'Map the docs' }], []]);
            expect(turns(events.filter(event => !('agentId' in event)))).toEqual(['started', 'done:started', 'mapped', 'done:mapped']);
            expect(textOf(events.filter(event => !('agentId' in event)))).not.toContain('Looking into');
        });

        test('a workflow is a `task` item named by its call, and the call goes on after the turn and ends with the work', async () => {
            const { session } = use({ backgroundHandoffMs: 300 }).start('say started\nbackground workflow 300 Verify the docs\nreport say verified');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(2);
            await ended;
            await session.close();

            expect(backgrounds(events)).toEqual([[{ id: 'wf-1', kind: 'task', title: 'Workflow: Verify the docs' }], []]);

            const calls = events.flatMap(event => event.type === 'tool' && event.toolCallId === 'wf-1' ? [event.state] : []);

            expect(calls).toEqual(['running', 'done']);
            // The call is still running when the first turn says `done`, and finished by the time of the report.
            expect(types(events).indexOf('done')).toBeLessThan(events.findIndex(event => event.type === 'tool' && event.state === 'done' && event.toolCallId === 'wf-1'));
        });

        test('a name that changes while the work is open is told again, though the list did not change', async () => {
            const { session } = use({ backgroundHandoffMs: 300 }).start('say started\nbackground workflow 700 Verify\nretitle 300 Workflow: step 2\nreport say verified');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(2);
            await ended;
            await session.close();

            expect(backgrounds(events).map(items => items.map(item => item.title))).toEqual([['Workflow: Verify'], ['Workflow: step 2'], []]);
        });

        test('the list is told again whenever it changes, and the session lives until the last item is gone', async () => {
            const { session } = use({ backgroundHandoffMs: 300 }).start('say started\nbackground terminal 200 first\nbackground subagent 600 second\nreport say reported');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(3);
            await ended;
            await session.close();

            const first: BackgroundItem = { id: 'term-1', kind: 'command', title: 'first' };
            const second: BackgroundItem = { id: 'toolu-child-2', kind: 'subagent', title: 'second' };

            expect(backgrounds(events)).toEqual([[first], [first, second], [second], []]);
            // The report of the first is a turn that goes by while the second is still open.
            expect(turns(events.filter(event => !('agentId' in event)))).toEqual(['started', 'done:started', 'reported', 'done:reported', 'second finished', 'done:second finished']);
        });

        test('a report turn that says what the turn before it said is a message of its own: only a landed steer makes a repeat', async () => {
            const { session } = use({ backgroundHandoffMs: 200 }).start('say same\nbackground terminal 100 sleep\nreport say same');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(2);
            await ended;
            await session.close();

            expect(turns(events)).toEqual(['same', 'done:same', 'same', 'done:same']);
        });

        test('a title and a command are one line and cut, and a name that is missing is the kind of work', async () => {
            const long = 'x'.repeat(300);
            const { session } = use({ backgroundHandoffMs: 200 }).start(`background terminal 100 echo   one   two ${ long }\nreport none`);
            const { events, ended } = follow(session);

            await ended;
            await session.close();

            const [[item]] = backgrounds(events);

            expect(item.title.startsWith('echo one two xxx')).toBe(true);
            expect(item.title).toHaveLength(200);
            expect(item.title.endsWith('…')).toBe(true);
        });
    });

    describe('the handoff guard', () => {
        test('a `running` that comes inside the guard cancels it: the report turn is read', async () => {
            // The report begins 250 ms after the work ended, inside the 400 ms guard.
            const { session } = use({ backgroundHandoffMs: 400 }).start('say started\nbackground terminal 100 sleep\ngap 250\nreport say in time');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(2);
            await ended;
            await session.close();

            expect(turns(events)).toEqual(['started', 'done:started', 'in time', 'done:in time']);
        });

        test('a session with nothing open that hears nothing within the guard ends, and a report that comes later is not read', async () => {
            const { session } = use({ backgroundHandoffMs: 150 }).start('say started\nbackground terminal 100 sleep\ngap 800\nreport say too late');
            const started = Date.now();
            const { events, ended } = follow(session);

            await ended;
            await session.close();

            expect(turns(events)).toEqual(['started', 'done:started']);
            // The work ended at 100 ms, and the guard ran from there: nothing ended the session before it.
            expect(Date.now() - started).toBeGreaterThanOrEqual(250);
            await until(() => !alive(pidOf(events)), 'the agent to stop');
        });

        test('the last work ending owes a report, which gets the longer wait: a report turn that begins after the guard is read, and the short guard runs after it', async () => {
            // The report begins 700 ms after the work ended, as the model's first output does: late for the 150 ms guard, inside the 3 s report wait.
            const { session } = use({ backgroundHandoffMs: 150, backgroundReportMs: 3000 }).start('say started\nbackground terminal 100 sleep\ngap 700\nreport say late but read');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(2);

            const reported = Date.now();

            await ended;
            await session.close();

            expect(turns(events)).toEqual(['started', 'done:started', 'late but read', 'done:late but read']);
            // After the report nothing is owed any more: the session ended by the short guard, not by waiting out the report wait again.
            expect(Date.now() - reported).toBeLessThan(1500);
        });

        test('an agent that never reports ends after the report wait, and not before it', async () => {
            const { session } = use({ backgroundHandoffMs: 100, backgroundReportMs: 700 }).start('say started\nbackground terminal 100 sleep\nreport none');
            const started = Date.now();
            const { events, ended } = follow(session);

            await ended;
            await session.close();

            expect(turns(events)).toEqual(['started', 'done:started']);
            // The work ended at about 100 ms and the report wait ran from there.
            expect(Date.now() - started).toBeGreaterThanOrEqual(750);
            await until(() => !alive(pidOf(events)), 'the agent to stop');
        });

        test('a message sent while the report is owed does not spend it: the report that follows the answer still gets the long wait', async () => {
            // The work ends at 100 ms; the message goes in at 150 ms and is answered at once; the report begins at 900 ms, after the short guard that follows the answer.
            const { session } = use({ backgroundHandoffMs: 200, backgroundReportMs: 3000 }).start('say started\nbackground terminal 100 sleep\ngap 900\nreport say late but read');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);
            await Bun.sleep(150);
            expect(await session.send?.('say answered')).toBe(true);
            await untilDone(3);
            await ended;
            await session.close();

            expect(turns(events)).toEqual(['started', 'done:started', 'answered', 'done:answered', 'late but read', 'done:late but read']);
        });

        test('the guard does not run while work is open: a session waits as long as the agent says', async () => {
            const { session } = use({ backgroundHandoffMs: 100 }).start('say started\nbackground terminal 700 long\nreport say finally');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);
            // Well beyond the guard, and the session is open.
            await Bun.sleep(400);
            expect(alive(pidOf(events))).toBe(true);

            await untilDone(2);
            await ended;
            await session.close();
            expect(turns(events)).toEqual(['started', 'done:started', 'finally', 'done:finally']);
        });

        test('a report turn that starts new work keeps the session open for it', async () => {
            const { session } = use({ backgroundHandoffMs: 250 }).start('say one\nbackground terminal 100 first\nreport say two\nreport background terminal 300 second');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(3);
            await ended;
            await session.close();

            expect(turns(events)).toEqual(['one', 'done:one', 'two', 'done:two', 'second finished', 'done:second finished']);
            expect(backgrounds(events).map(items => items.map(item => item.title))).toEqual([['first'], [], ['second'], []]);
        });
    });

    describe('timers inside the agent (a Monitor, a wakeup)', () => {
        const MONITOR = 'toolu-monitor-1';
        const monitor = (title: string, id = MONITOR): BackgroundItem => ({ id, kind: 'task', title: `Monitor · ${ title }` });
        const wakeup = (title: string, id = 'toolu-wakeup-1'): BackgroundItem => ({ id, kind: 'task', title: `Wakeup · ${ title }` });
        const indexOfBackground = (events: EngineEvent[], items: BackgroundItem[]) => events.findIndex(event => event.type === 'background' && JSON.stringify(event.items) === JSON.stringify(items));
        const gap = 'gap 300';

        /**
         * Records the timers started with the length `ms`, and whether each was cleared or went off: how a test tells that a deadline does not outlive the session
         * (its handle is unref'd either way, so only the clear says it was let go).
         */
        function watchTimers(ms: number) {
            const started: ReturnType<typeof setTimeout>[] = [];
            const cleared = new Set<unknown>();
            const set = globalThis.setTimeout;
            const clear = globalThis.clearTimeout;
            const setSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, delay?: number, ...rest: unknown[]) => {
                const handle = (set as (...args: unknown[]) => ReturnType<typeof setTimeout>)(handler, delay, ...rest);

                if (delay === ms) {
                    started.push(handle);
                }

                return handle;
            }) as unknown as typeof setTimeout);
            const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: ReturnType<typeof setTimeout>) => {
                cleared.add(handle);
                clear(handle);
            }) as unknown as typeof clearTimeout);

            return { started, cleared, stop: () => {
                setSpy.mockRestore();
                clearSpy.mockRestore();
            } };
        }

        test('a completed Monitor is a task item before the turn says done, its ticks are turns of the agent, and the item leaves at its time, which owes the notice', async () => {
            const { session } = use({ backgroundHandoffMs: 200, backgroundReportMs: 3000 }).start(`say watching\n${ gap }\nmonitor 1200 400 watch the build`);
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);

            const pid = pidOf(events);

            // Told before the `done`, which is what keeps the session open past the turn.
            expect(indexOfBackground(events, [monitor('watch the build')])).toBeGreaterThan(-1);
            expect(indexOfBackground(events, [monitor('watch the build')])).toBeLessThan(types(events).indexOf('done'));
            expect(alive(pid)).toBe(true);

            await ended;
            await session.close();

            expect(turns(events)).toEqual(['watching', 'done:watching', 'tick 1', 'done:tick 1', 'tick 2', 'done:tick 2', 'Monitor watch the build ended', 'done:Monitor watch the build ended']);
            expect(backgrounds(events)).toEqual([[monitor('watch the build')], []]);
            // The time came before the agent said anything of it, and the notice that follows is read.
            expect(indexOfBackground(events, [])).toBeLessThan(events.findIndex(event => event.type === 'text' && event.delta.includes('ended')));
            // Each tick, and the notice, is told by a `done` of its own, in a turn the agent started.
            expect(events.filter(event => event.type === 'done')).toHaveLength(4);
            await until(() => !alive(pid), 'the agent to stop');
        });

        test('the item is told as soon as the call completes, whatever the turn says after it', async () => {
            const { session, abort } = use({ backgroundHandoffMs: 200 }).start('monitor 30000 0 early\nsay after the call');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);

            const told = indexOfBackground(events, [monitor('early')]);

            expect(told).toBeGreaterThan(-1);
            expect(told).toBeLessThan(events.findIndex(event => event.type === 'text' && event.delta.startsWith('after')));

            abort.abort();
            await ended;
            await session.close();
        });

        test('the session is held until the time the call named, not the guard: nothing ends it before, and it ends after the notice', async () => {
            const { session } = use({ backgroundHandoffMs: 100, backgroundReportMs: 3000 }).start(`say watching\n${ gap }\nmonitor 1500 0 quiet`);
            const started = Date.now();
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);
            // Well past the guard, with no tick and nothing open in the agent's own list.
            await Bun.sleep(600);
            expect(alive(pidOf(events))).toBe(true);
            expect(backgrounds(events)).toEqual([[monitor('quiet')]]);

            await ended;
            await session.close();

            expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
            expect(turns(events)).toEqual(['watching', 'done:watching', 'Monitor quiet ended', 'done:Monitor quiet ended']);
        });

        test('a ScheduleWakeup is a task item until the wakeup the call says is due, and the turn it starts is read', async () => {
            const { session } = use({ backgroundHandoffMs: 200, backgroundReportMs: 3000 }).start(`say armed\n${ gap }\nwakeup 1 check the deploy`);
            const started = Date.now();
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);
            expect(indexOfBackground(events, [wakeup('check the deploy')])).toBeLessThan(types(events).indexOf('done'));

            await ended;
            await session.close();

            expect(turns(events)).toEqual(['armed', 'done:armed', 'woke: check the deploy', 'done:woke: check the deploy']);
            expect(backgrounds(events)).toEqual([[wakeup('check the deploy')], []]);
            expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
        });

        test('a wakeup whose turn schedules the next one keeps the session open: the new item is told before that turn says idle', async () => {
            const { session } = use({ backgroundHandoffMs: 200, backgroundReportMs: 3000 }).start(`say armed\n${ gap }\nonwake say woke first\nonwake wakeup 1 second\nwakeup 1 first`);
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(3);
            await ended;
            await session.close();

            expect(turns(events)).toEqual(['armed', 'done:armed', 'woke first', 'done:woke first', 'woke: second', 'done:woke: second']);
            expect(backgrounds(events)).toEqual([
                [wakeup('first')],
                [],
                [wakeup('second', 'toolu-wakeup-2')],
                [],
            ]);
            // The second is told in the first wake turn, before its `done`.
            const second = indexOfBackground(events, [wakeup('second', 'toolu-wakeup-2')]);

            expect(second).toBeGreaterThan(events.findIndex(event => event.type === 'text' && event.delta === 'woke first'));
            expect(second).toBeLessThan(events.findIndex((event, index) => event.type === 'done' && index > second));
        });

        test('a time that comes while a turn runs waits for the turn: the item stays until its `done`, and the notice that follows is read', async () => {
            // The monitor ends after 500 ms, in the middle of the turn that started it, which goes on for 800 ms more.
            const { session } = use({ backgroundHandoffMs: 200, backgroundReportMs: 3000 }).start('monitor 500 0 slow\nsleep 800\nsay still here');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);
            await ended;
            await session.close();

            expect(turns(events)).toEqual(['still here', 'done:still here', 'Monitor slow ended', 'done:Monitor slow ended']);
            expect(backgrounds(events)).toEqual([[monitor('slow')], []]);
            // The list lost the item after the turn's `done`, not under it: the runtime saw the item at `done` and kept the session.
            expect(indexOfBackground(events, [])).toBeGreaterThan(types(events).indexOf('done'));
        });

        test('a time that comes while the answer to a message is on its way waits for it too', async () => {
            // The agent takes the message 1.2 s after it is sent; the monitor's time comes 0.4 s after it started, and the notice turn begins after the answer.
            const { session } = use({ backgroundHandoffMs: 200, backgroundReportMs: 4000, agentEnv: { FAKE_ACP_SLOW: '1200' } }).start('say watching\ngap 2000\nmonitor 400 0 slowed');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);
            expect(await session.send?.('say answered')).toBe(true);
            await ended;
            await session.close();

            expect(turns(events)).toEqual(['watching', 'done:watching', 'answered', 'done:answered', 'Monitor slowed ended', 'done:Monitor slowed ended']);
            // The list lost the item after the `done` of that answer, not before it.
            expect(indexOfBackground(events, [])).toBeGreaterThan(events.findIndex(event => event.type === 'done' && event.result === 'answered'));
        });

        test('a time that comes while the `done` waits for a steer the agent folded into the turn waits for it too', async () => {
            // The steer lands in a turn that says no more, so its `done` waits the guard (500 ms) for a second turn that never comes; the monitor's time comes in that wait.
            const { session } = use({ backgroundHandoffMs: 500, backgroundReportMs: 3000 }).start('gap 400\nmonitor 500 0 folded\nsay first\nsleep 200\nsay last');
            const { events, ended, until: untilDone } = follow(session);

            await until(() => textOf(events).includes('first'), 'the agent to say first');
            expect(await session.steer?.('say steered')).toBe(true);
            await untilDone(1);
            await ended;
            await session.close();

            expect(turns(events)).toEqual(['first', 'steered', 'last', 'done:last', 'Monitor folded ended', 'done:Monitor folded ended']);
            expect(backgrounds(events)).toEqual([[monitor('folded')], []]);
            // The runtime saw the item at the `done` and kept the session: the list lost it after.
            expect(indexOfBackground(events, [])).toBeGreaterThan(types(events).indexOf('done'));
        });

        test('two items hold the session until the last one: the first to lapse leaves the other', async () => {
            const { session } = use({ backgroundHandoffMs: 200, backgroundReportMs: 3000 }).start(`say armed\n${ gap }\nmonitor 600 0 short\nmonitor 1400 0 long`);
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);
            await ended;
            await session.close();

            const short = monitor('short');
            const long = monitor('long', 'toolu-monitor-2');

            expect(backgrounds(events)).toEqual([[short], [short, long], [long], []]);
            expect(turns(events)).toEqual(['armed', 'done:armed', 'Monitor short ended', 'done:Monitor short ended', 'Monitor long ended', 'done:Monitor long ended']);
        });

        test('a call that failed, was cancelled or names no end holds nothing: the session ends at its guard', async () => {
            for (const script of ['ending failed\nmonitor 5000 0 refused', 'ending cancelled\nwakeup 5 refused', 'monitor persistent forever']) {
                const { session } = use({ backgroundHandoffMs: 200, backgroundReportMs: 3000 }).start(`say asked\n${ script }`);
                const started = Date.now();
                const { events, ended } = follow(session);

                await ended;
                await session.close();
                current?.stop();

                expect(backgrounds(events)).toEqual([]);
                expect(turns(events)).toEqual(['asked', 'done:asked']);
                expect(Date.now() - started).toBeLessThan(3000);
                await until(() => !alive(pidOf(events)), 'the agent to stop');
            }
        });

        test('a wakeup whose result does not say when is held for the delay it asked for and the minute the tool rounds it up by', async () => {
            const { session, abort } = use({ backgroundHandoffMs: 200 }).start('say asked\nending plain\nwakeup 5 vague');
            const { events, until: untilDone } = follow(session);

            await untilDone(1);
            expect(backgrounds(events)).toEqual([[wakeup('vague')]]);

            abort.abort();
            await session.close();
        });

        test('the agent listing the call itself is the one that knows: its entry stands for the call, the item the mapper held is gone, and it does not come back', async () => {
            const { session } = use({ backgroundHandoffMs: 200, backgroundReportMs: 3000 }).start(`say watching\n${ gap }\nlisted\nmonitor 800 0 listed`);
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);
            await ended;
            await session.close();

            // One item, the call's own, with the name the mapper gave it, until the agent's list loses it.
            expect(backgrounds(events)).toEqual([[monitor('listed')], []]);
            expect(turns(events)).toEqual(['watching', 'done:watching', 'listed finished', 'done:listed finished']);
        });

        test('cancelling the run, closing the session and the process leaving let every deadline go', async () => {
            const watch = watchTimers(31_000);

            try {
                // Cancel.
                const first = use({ backgroundHandoffMs: 200 }).start('say asked\nmonitor 31000 0 cancelled\nwakeup 31 also');
                const one = follow(first.session);

                await one.until(1);
                expect(watch.started).toHaveLength(2);
                // They never keep the daemon alive: a session whose process was killed with the daemon leaves no timer behind.
                expect(watch.started.every(handle => !(handle as unknown as { hasRef(): boolean }).hasRef())).toBe(true);
                first.abort.abort();
                await one.ended;
                await first.session.close();
                expect(watch.started.every(handle => watch.cleared.has(handle))).toBe(true);
                expect(types(one.events)).not.toContain('error');
                expect(one.dones()).toHaveLength(1);
                current?.stop();

                // Close.
                watch.started.length = 0;
                watch.cleared.clear();

                const second = use({ backgroundHandoffMs: 200 }).start('say asked\nmonitor 31000 0 closed');
                const two = follow(second.session);

                await two.until(1);
                expect(watch.started).toHaveLength(1);
                await second.session.close();
                await two.ended;
                expect(watch.started.every(handle => watch.cleared.has(handle))).toBe(true);
                current?.stop();

                // The process leaves: a failure, and the deadline goes with it.
                watch.started.length = 0;
                watch.cleared.clear();

                const third = use({ backgroundHandoffMs: 200 }).start('say asked\nmonitor 31000 0 dies\ndie 200');
                const three = follow(third.session);

                await three.ended;
                await third.session.close();
                expect(watch.started).toHaveLength(1);
                expect(watch.started.every(handle => watch.cleared.has(handle))).toBe(true);
                expect(three.events.at(-1)).toMatchObject({ type: 'error', code: 'process_crashed' });
                expect(three.dones()).toHaveLength(1);
            }
            finally {
                watch.stop();
            }
        });

        test('a message while the session is held is answered, and the item stays', async () => {
            const { session, abort } = use({ backgroundHandoffMs: 200, backgroundReportMs: 3000 }).start(`say watching\n${ gap }\nmonitor 20000 0 long`);
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);
            expect(await session.send?.('say answered')).toBe(true);
            await untilDone(2);

            expect(turns(events)).toEqual(['watching', 'done:watching', 'answered', 'done:answered']);
            expect(backgrounds(events)).toEqual([[monitor('long')]]);
            expect(alive(pidOf(events))).toBe(true);

            abort.abort();
            await ended;
            await session.close();
        });
    });

    describe('sub-agents', () => {
        const CALL = 'toolu-child-1';
        const own = (events: EngineEvent[], agentId = 'child-1') => events.filter(event => 'agentId' in event && event.agentId === agentId);
        /** The card of the call that started a sub-agent, as the parent's stream shows it, by the state it passed through. */
        const card = (events: EngineEvent[], id = CALL) => events.flatMap(event => event.type === 'tool' && event.toolCallId === id && event.agentId === undefined ? [event] : []);
        const subagents = (events: EngineEvent[]) => events.filter(event => event.type === 'subagent');

        test('a foreground sub-agent has a card and a child run with its calls, and both end with its report, while the turn goes on around it', async () => {
            const { session } = use().start('say before\nsubagent 200 Map the docs\nsay after');
            const events = await collect(session);

            await session.close();

            // The parent is never shown the call: the card is made from the announcement and the prompt, and names the call by the prompt's message.
            expect(card(events)).toEqual([
                { type: 'tool', toolCallId: CALL, name: 'Agent', input: { subagent_type: 'general-purpose', description: 'Map the docs', prompt: 'Do this: Map the docs' }, state: 'running' },
                { type: 'tool', toolCallId: CALL, name: 'Agent', input: { subagent_type: 'general-purpose', description: 'Map the docs', prompt: 'Do this: Map the docs' }, state: 'done', output: 'Map the docs finished' },
            ]);
            expect(subagents(events)).toEqual([
                { type: 'subagent', agentId: 'child-1', parentToolCallId: CALL, name: 'general-purpose', description: 'Map the docs', state: 'running', stoppable: true },
                { type: 'subagent', agentId: 'child-1', parentToolCallId: CALL, name: 'general-purpose', state: 'done', summary: 'Map the docs finished' },
            ]);
            // What the child says, calls and reports is its own, in the order it came; the parent's own words are around it.
            expect(own(events).map(event => event.type === 'text' ? ['text', event.delta, event.done] : event.type === 'tool' ? ['tool', event.name, event.state] : [event.type])).toEqual([
                ['subagent'],
                ['text', 'Looking into Map the docs', false],
                ['text', '', true],
                ['tool', 'Bash', 'running'],
                ['tool', 'Bash', 'done'],
                ['text', 'Map the docs finished', false],
                ['text', '', true],
                ['subagent'],
            ]);
            expect(own(events).find(event => event.type === 'tool' && event.state === 'done')).toMatchObject({ output: 'Map the docs\n' });
            expect(turns(events.filter(event => !('agentId' in event)))).toEqual(['before', 'after', 'done:after']);
            expect(backgrounds(events)).toEqual([]);
        });

        test('a foreground sub-agent that was cancelled or failed ends its run and its card so, and sends no report', async () => {
            const { session } = use().start('outcome cancelled\nsubagent 100 First\noutcome error\nsubagent 100 Second\nsay after');
            const events = await collect(session);

            await session.close();

            expect(subagents(events).map(event => event.type === 'subagent' && [event.agentId, event.state, event.summary])).toEqual([
                ['child-1', 'running', undefined],
                ['child-1', 'cancelled', undefined],
                ['child-2', 'running', undefined],
                ['child-2', 'error', 'The sub-agent failed'],
            ]);
            expect(card(events).map(event => event.state === 'running' ? 'running' : event.error)).toEqual(['running', STOPPED_TOOL]);
            expect(card(events, 'toolu-child-2').at(-1)).toMatchObject({ state: 'error', error: 'The sub-agent failed' });
            // Nothing was reported, so nothing is said as the report.
            expect(own(events).filter(event => event.type === 'text').map(event => event.type === 'text' && event.delta)).toEqual(['Looking into First', '']);
        });

        test('a background sub-agent keeps its card running after the turn, takes its calls and report after it, and the list ends it', async () => {
            const { session } = use({ backgroundHandoffMs: 300 }).start('say started\nbackground subagent 400 Map the docs\nreport say mapped');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);

            const afterFirst = events.length;

            await untilDone(2);
            await ended;
            await session.close();

            // The turn was over when its child's calls were made: they come after the first `done`, with the child's id.
            expect(events.slice(afterFirst).filter(event => event.type === 'tool' && event.agentId === 'child-1').map(event => event.type === 'tool' && [event.name, event.state])).toEqual([['Bash', 'running'], ['Bash', 'done']]);
            expect(events.slice(0, afterFirst).filter(event => event.type === 'tool').map(event => event.type === 'tool' && event.state)).toEqual(['running']);
            // The layer does not end the child run: the runtime does, when the list loses the sub-agent (a sub-agent can be woken a moment after it stops).
            expect(subagents(events).map(event => event.type === 'subagent' && event.state)).toEqual(['running']);
            expect(card(events).map(event => event.state)).toEqual(['running', 'done']);
            expect(card(events).at(-1)).toMatchObject({ output: 'Map the docs finished' });
            expect(backgrounds(events)).toEqual([[{ id: CALL, kind: 'subagent', title: 'Map the docs' }], []]);
            // The card says it is done before the list says nothing is open.
            expect(events.findIndex(event => event.type === 'tool' && event.state === 'done' && event.toolCallId === CALL)).toBeLessThan(events.findIndex(event => event.type === 'background' && event.items.length === 0));
        });

        test('two sub-agents at once each have their own card, child run and calls', async () => {
            const { session } = use({ backgroundHandoffMs: 300 }).start('say started\nbackground subagent 300 First\nbackground subagent 600 Second\nreport say reported');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(2);
            await ended;
            await session.close();

            expect(subagents(events).map(event => event.type === 'subagent' && [event.agentId, event.parentToolCallId, event.description])).toEqual([['child-1', 'toolu-child-1', 'First'], ['child-2', 'toolu-child-2', 'Second']]);
            expect(own(events, 'child-1').filter(event => event.type === 'tool')).toHaveLength(2);
            expect(own(events, 'child-2').filter(event => event.type === 'tool')).toHaveLength(2);
            expect(card(events, 'toolu-child-1').map(event => event.state)).toEqual(['running', 'done']);
            expect(card(events, 'toolu-child-2').map(event => event.state)).toEqual(['running', 'done']);
            expect(backgrounds(events).map(items => items.map(item => item.id))).toEqual([['toolu-child-1'], ['toolu-child-1', 'toolu-child-2'], ['toolu-child-2'], []]);
        });

        test('a sub-agent that is woken at once after it stopped shows its card done and running again, and is out of the list and back in it', async () => {
            const { session } = use({ backgroundHandoffMs: 300 }).start('say started\nflap\nbackground subagent 300 Waits for its command\nreport say reported');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(2);
            await ended;
            await session.close();

            const ids = backgrounds(events).map(items => items.map(item => item.id));

            // Listed, then out and in again, then out for good.
            expect(ids).toEqual([[CALL], [], [CALL], []]);
            expect(card(events).map(event => event.state)).toEqual(['running', 'done', 'running', 'done']);
            expect(subagents(events).map(event => event.type === 'subagent' && event.state)).toEqual(['running']);
        });

        test('what a session says that no `subagent_update` announced is not read', async () => {
            const { session } = use().start('stray hello\nsay own words');
            const events = await collect(session);

            await session.close();

            expect(textOf(events)).toBe('own words');
        });

        test('a message sent while a background sub-agent works is answered, and the sub-agent goes on', async () => {
            const { session } = use({ backgroundHandoffMs: 300 }).start('say started\nbackground subagent 700 Slow work\nreport say reported');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);
            expect(await session.send!('say answered')).toBe(true);
            await untilDone(2);

            expect(turns(events.filter(event => !('agentId' in event)))).toEqual(['started', 'done:started', 'answered', 'done:answered']);
            // The child was not told anything by it and has not ended.
            expect(subagents(events).map(event => event.type === 'subagent' && event.state)).toEqual(['running']);

            await untilDone(3);
            await ended;
            await session.close();
            expect(own(events).filter(event => event.type === 'tool' && event.state === 'done')).toHaveLength(1);
        });
    });

    describe('stopping one sub-agent', () => {
        const own = (events: EngineEvent[], agentId: string) => events.filter(event => 'agentId' in event && event.agentId === agentId);
        const card = (events: EngineEvent[], id: string) => events.flatMap(event => event.type === 'tool' && event.toolCallId === id && event.agentId === undefined ? [event] : []);
        const states = (events: EngineEvent[], agentId: string) => own(events, agentId).flatMap(event => event.type === 'subagent' ? [event.state] : []);
        const sessionTurns = (events: EngineEvent[]) => turns(events.filter(event => !('agentId' in event)));

        /** A file the fake agent writes the `session/cancel`s it gets to, with what it says. */
        function cancels() {
            const dir = mkdtempSync(join(tmpdir(), 'clowdy-stop-'));
            const log = join(dir, 'cancels');

            return { log, lines: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []), clean: () => rmSync(dir, { recursive: true, force: true }) };
        }

        test('asks the agent to cancel that sub-agent\'s session alone: it ends cancelled with its card stopped and its call cancelled, the list loses it, and its sibling and the session go on', async () => {
            const { log, lines, clean } = cancels();
            const { session } = use({ backgroundHandoffMs: 300, agentEnv: { FAKE_ACP_LOG: log } }).start('say started\nbackground subagent 5000 First\nbackground subagent 1200 Second\nreport say reported');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);
            await until(() => backgrounds(events).at(-1)?.length === 2, 'both sub-agents to be listed');
            await until(() => own(events, 'child-1').some(event => event.type === 'tool'), 'the sub-agent to make its call');
            expect(await session.stopItem!('child-1')).toBe(true);
            await until(() => states(events, 'child-1').includes('cancelled'), 'the sub-agent to end');

            // The first is over (it did not wait for its 5 s), the second is not touched.
            expect(states(events, 'child-1')).toEqual(['running', 'cancelled']);
            expect(states(events, 'child-2')).toEqual(['running']);
            expect(card(events, 'toolu-child-1').map(event => event.state === 'error' ? event.error : event.state)).toEqual(['running', STOPPED_TOOL]);
            expect(own(events, 'child-1').filter(event => event.type === 'tool').at(-1)).toMatchObject({ name: 'Bash', state: 'error', error: STOPPED_TOOL });
            await until(() => backgrounds(events).at(-1)?.length === 1, 'the list to lose it');
            expect(backgrounds(events).at(-1)).toEqual([{ id: 'toolu-child-2', kind: 'subagent', title: 'Second' }]);
            // Only its session was cancelled, not the parent's.
            expect(lines()).toEqual(['cancel child-1']);

            // The agent owes the report of what stopped like any work that ended; the session lives on for the other, and its own report follows.
            await untilDone(3);
            await ended;
            await session.close();

            expect(sessionTurns(events)).toEqual(['started', 'done:started', 'reported', 'done:reported', 'Second finished', 'done:Second finished']);
            expect(states(events, 'child-2')).toEqual(['running']);
            expect(card(events, 'toolu-child-2').map(event => event.state)).toEqual(['running', 'done']);
            expect(lines()).toEqual(['cancel child-1']);
            clean();
        });

        test('answers false for a sub-agent that has ended, and sends nothing a second time', async () => {
            const { log, lines, clean } = cancels();
            const { session } = use({ backgroundHandoffMs: 300, agentEnv: { FAKE_ACP_LOG: log } }).start('say started\nbackground subagent 5000 First\nbackground subagent 900 Second\nreport say reported');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);
            await until(() => backgrounds(events).at(-1)?.length === 2, 'both sub-agents to be listed');
            expect(await session.stopItem!('child-1')).toBe(true);
            await until(() => states(events, 'child-1').includes('cancelled'), 'the sub-agent to end');
            expect(await session.stopItem!('child-1')).toBe(false);
            expect(lines()).toEqual(['cancel child-1']);

            // One that finished by itself is no more open than one that was stopped: its parent's list lost it.
            await until(() => card(events, 'toolu-child-2').at(-1)?.state === 'done', 'the sibling to finish');
            expect(await session.stopItem!('child-2')).toBe(false);
            expect(lines()).toEqual(['cancel child-1']);
            await untilDone(3);
            await ended;
            await session.close();
            clean();
        });

        test('sends nothing for a sub-agent nobody announced, nor for one its parent did not let the client cancel', async () => {
            const { log, lines, clean } = cancels();
            const { session } = use({ backgroundHandoffMs: 300, agentEnv: { FAKE_ACP_LOG: log } }).start('say started\nlocked\nbackground subagent 700 Locked\nreport say reported');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);
            await until(() => backgrounds(events).at(-1)?.length === 1, 'the sub-agent to be listed');

            expect(await session.stopItem!('child-1')).toBe(false);
            expect(await session.stopItem!('fake-1')).toBe(false);
            expect(await session.stopItem!('nobody')).toBe(false);
            expect(lines()).toEqual([]);
            // The runtime was told it cannot be stopped alone: its `running` event does not say it can.
            expect(own(events, 'child-1').find(event => event.type === 'subagent')).toEqual({ type: 'subagent', agentId: 'child-1', parentToolCallId: 'toolu-child-1', name: 'general-purpose', description: 'Locked', state: 'running' });

            await untilDone(2);
            await ended;
            await session.close();
            expect(states(events, 'child-1')).toEqual(['running']);
            clean();
        });

        test('stops a foreground sub-agent alone: the turn it was in goes on and ends with an answer, not a cancel', async () => {
            const { log, lines, clean } = cancels();
            const { session } = use({ agentEnv: { FAKE_ACP_LOG: log } }).start('say before\nsubagent 3000 Map the docs\nsay after');
            const { events, ended, until: untilDone } = follow(session);

            await until(() => states(events, 'child-1').includes('running'), 'the sub-agent to start');
            expect(await session.stopItem!('child-1')).toBe(true);
            await untilDone(1);
            await ended;
            await session.close();

            expect(states(events, 'child-1')).toEqual(['running', 'cancelled']);
            expect(card(events, 'toolu-child-1').at(-1)).toMatchObject({ state: 'error', error: STOPPED_TOOL });
            expect(events.at(-1)).toEqual({ type: 'done', result: 'after' });
            expect(types(events)).not.toContain('error');
            expect(lines()).toEqual(['cancel child-1']);
            clean();
        });

        test('answers false once the session is over, and for a session that never started its agent', async () => {
            const { session } = use().start('say plain');
            const never = use().start('say plain');

            expect(await never.session.stopItem!('child-1')).toBe(false);
            await collect(session);
            await session.close();
            expect(await session.stopItem!('child-1')).toBe(false);
            await never.session.close();
        });
    });

    /** A file the fake agent writes what it is asked to do to (`session/cancel`, `terminal/cancel`, a steer, a held prompt), a line each. */
    function agentLog() {
        const dir = mkdtempSync(join(tmpdir(), 'clowdy-agent-log-'));
        const log = join(dir, 'log');

        return { log, lines: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []), clean: () => rmSync(dir, { recursive: true, force: true }) };
    }

    describe('stopping one background command', () => {
        const cancelling = { FAKE_ACP_TERMINAL_CANCEL: '1' };

        test('asks the agent to cancel that terminal alone: the list loses it, the session and the other command go on, and no report is owed for it', async () => {
            const { log, lines, clean } = agentLog();
            const { session } = use({ backgroundHandoffMs: 300, backgroundReportMs: 4000, agentEnv: { ...cancelling, FAKE_ACP_LOG: log } }).start('say started\nbackground terminal 5000 first\nbackground terminal 900 second\nreport say reported');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);
            await until(() => backgrounds(events).at(-1)?.length === 2, 'both commands to be listed');

            // The agent said it can cancel them, and the runtime was told: that is what a row's Stop is offered for.
            expect(backgrounds(events).at(-1)).toEqual([{ id: 'term-1', kind: 'command', title: 'first', canStopAlone: true }, { id: 'term-2', kind: 'command', title: 'second', canStopAlone: true }]);
            expect(await session.stopItem!('term-1')).toBe(true);
            await until(() => backgrounds(events).at(-1)?.length === 1, 'the list to lose it');
            expect(backgrounds(events).at(-1)).toEqual([{ id: 'term-2', kind: 'command', title: 'second', canStopAlone: true }]);
            expect(lines()).toEqual(['terminal-cancel term-1']);
            expect(alive(pidOf(events))).toBe(true);

            // The other one ends on its own and is reported as usual; the one that was stopped is not part of that report.
            await untilDone(2);
            await ended;
            await session.close();
            expect(turns(events)).toEqual(['started', 'done:started', 'reported', 'done:reported']);
            clean();
        });

        test('the last command stopped owes the agent no report: the session ends after the short guard, not after the wait for a report', async () => {
            const { session } = use({ backgroundHandoffMs: 200, backgroundReportMs: 6000, agentEnv: cancelling }).start('say started\nbackground terminal 8000 first\nreport say reported');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);
            await until(() => backgrounds(events).at(-1)?.length === 1, 'the command to be listed');

            const stopped = Date.now();

            expect(await session.stopItem!('term-1')).toBe(true);
            await ended;
            await session.close();

            expect(backgrounds(events).at(-1)).toEqual([]);
            expect(turns(events)).toEqual(['started', 'done:started']);
            expect(Date.now() - stopped).toBeLessThan(3000);
        });

        test('a terminal the agent did not say it can cancel is not asked about, and the item does not say it can be stopped alone', async () => {
            const { log, lines, clean } = agentLog();
            const { session } = use({ backgroundHandoffMs: 300, agentEnv: { FAKE_ACP_LOG: log } }).start('say started\nbackground terminal 600 plain\nreport say reported');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);
            await until(() => backgrounds(events).at(-1)?.length === 1, 'the command to be listed');
            expect(backgrounds(events).at(-1)).toEqual([{ id: 'term-1', kind: 'command', title: 'plain' }]);
            expect(await session.stopItem!('term-1')).toBe(false);
            expect(lines()).toEqual([]);
            await untilDone(2);
            await ended;
            await session.close();
            clean();
        });

        test('a terminal the agent says is gone answers false, with the item still listed and nothing thrown', async () => {
            const { log, lines, clean } = agentLog();
            const { session } = use({ backgroundHandoffMs: 300, agentEnv: { FAKE_ACP_TERMINAL_CANCEL: 'refuse', FAKE_ACP_LOG: log } }).start('say started\nbackground terminal 700 plain\nreport say reported');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);
            await until(() => backgrounds(events).at(-1)?.length === 1, 'the command to be listed');
            expect(await session.stopItem!('term-1')).toBe(false);
            expect(lines()).toEqual(['terminal-cancel term-1']);
            expect(backgrounds(events).at(-1)).toHaveLength(1);
            await untilDone(2);
            await ended;
            await session.close();
            clean();
        });

        test('answers false for a command that ended, and for one nobody listed, without asking the agent', async () => {
            const { log, lines, clean } = agentLog();
            const { session } = use({ backgroundHandoffMs: 300, agentEnv: { ...cancelling, FAKE_ACP_LOG: log } }).start('say started\nbackground terminal 150 short\nreport say reported');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);
            await until(() => backgrounds(events).at(-1)?.length === 0, 'the command to end');
            expect(await session.stopItem!('term-1')).toBe(false);
            expect(await session.stopItem!('nobody')).toBe(false);
            expect(lines()).toEqual([]);
            await untilDone(2);
            await ended;
            await session.close();
            clean();
        });

        test('stops a background task alone the same way, with `tool_call/cancel` for the call that stands for it: the call ends cancelled, the list loses it, and no report is owed', async () => {
            const { log, lines, clean } = agentLog();
            const { session } = use({ backgroundHandoffMs: 200, backgroundReportMs: 6000, agentEnv: { ...cancelling, FAKE_ACP_LOG: log } }).start('say started\nbackground workflow 8000 verify\nreport say reported');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);
            await until(() => backgrounds(events).at(-1)?.length === 1, 'the task to be listed');
            expect(backgrounds(events).at(-1)).toEqual([{ id: 'wf-1', kind: 'task', title: 'Workflow: verify', canStopAlone: true }]);

            const stopped = Date.now();

            expect(await session.stopItem!('wf-1')).toBe(true);
            await ended;
            await session.close();

            expect(lines()).toEqual(['tool-call-cancel wf-1']);
            expect(backgrounds(events).at(-1)).toEqual([]);
            expect(events.filter(event => event.type === 'tool' && event.toolCallId === 'wf-1').at(-1)).toMatchObject({ state: 'error' });
            expect(turns(events)).toEqual(['started', 'done:started']);
            expect(Date.now() - stopped).toBeLessThan(3000);
            clean();
        });

        test('a task whose call did not say it can be cancelled is not asked about', async () => {
            const { log, lines, clean } = agentLog();
            const { session } = use({ backgroundHandoffMs: 300, agentEnv: { FAKE_ACP_LOG: log } }).start('say started\nbackground workflow 600 verify\nreport say reported');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);
            await until(() => backgrounds(events).at(-1)?.length === 1, 'the task to be listed');
            expect(backgrounds(events).at(-1)).toEqual([{ id: 'wf-1', kind: 'task', title: 'Workflow: verify' }]);
            expect(await session.stopItem!('wf-1')).toBe(false);
            expect(lines()).toEqual([]);
            await untilDone(2);
            await ended;
            await session.close();
            clean();
        });

        test('answers false once the session is over', async () => {
            const { session } = use({ agentEnv: cancelling }).start('say plain');

            await collect(session);
            await session.close();
            expect(await session.stopItem!('term-1')).toBe(false);
        });
    });

    describe('an agent that starts no turn to report work that ended', () => {
        test('does not wait for a report that never comes: it ends after the short guard, not the report wait', async () => {
            const { session } = use({ wakesOnBackgroundEnd: true, backgroundHandoffMs: 100, backgroundReportMs: 6000 }).start('say started\nbackground terminal 100 sleep\nreport none');
            const started = Date.now();
            const { events, ended } = follow(session);

            await ended;
            await session.close();

            expect(turns(events)).toEqual(['started', 'done:started']);
            expect(Date.now() - started).toBeLessThan(3000);
            await until(() => !alive(pidOf(events)), 'the agent to stop');
        });

        test('is told by a prompt sent when the work ended: one `done` for its answer, with the session held for it while it is on its way', async () => {
            const { session } = use({ wakesOnBackgroundEnd: true, backgroundHandoffMs: 150, backgroundReportMs: 6000 }).start('say started\nbackground terminal 200 sleep\nreport none');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);
            await until(() => backgrounds(events).at(-1)?.length === 0, 'the work to end');

            // What the runtime does on the empty list (`RunDriver`): hand the agent a note, from inside the guard.
            expect(await session.send!('Background command finished: sleep')).toBe(true);
            await untilDone(2);
            await ended;
            await session.close();

            expect(turns(events)).toEqual(['started', 'done:started', 'ok', 'done:ok']);
        });

        test('a prompt sent while idle is answered by the turn it begins, whether the agent echoes it before or after `running`', async () => {
            for (const echo of [{}, { FAKE_ACP_ECHO_LATE: '1' }] as Record<string, string>[]) {
                const guard = 600;
                const { session } = use({ backgroundHandoffMs: guard, agentEnv: echo }).start('say first\nbackground terminal 100 sleep\nreport say reported');
                const { events, ended, until: untilDone } = follow(session);

                await untilDone(2);
                await until(() => backgrounds(events).at(-1)?.length === 0, 'the work to end');

                const sentAt = Date.now();

                expect(await session.send!('say answer')).toBe(true);
                await untilDone(3);

                // The turn that the prompt began is its own: its `done` came when it ended, not a guard later (the guard is 600 ms).
                expect(Date.now() - sentAt).toBeLessThan(guard);
                await ended;
                await session.close();
                expect(turns(events).slice(-2)).toEqual(['answer', 'done:answer']);
            }
        });
    });

    describe('send', () => {
        test('a prompt sent while the work runs is taken at once and answered by one `done`, and the work goes on', async () => {
            const { session } = use({ backgroundHandoffMs: 300 }).start('say started\nbackground terminal 1000 long\nreport say all done');
            const { events, ended, dones, until: untilDone } = follow(session);

            await untilDone(1);

            expect(await session.send!('say hello from the person')).toBe(true);
            await untilDone(2);
            expect(dones()[1]).toEqual({ type: 'done', result: 'hello from the person' });
            // The answer came while the work was open, and the list did not change for it.
            expect(backgrounds(events)).toHaveLength(1);
            expect(alive(pidOf(events))).toBe(true);

            await untilDone(3);
            await ended;
            await session.close();
            expect(turns(events)).toEqual(['started', 'done:started', 'hello from the person', 'done:hello from the person', 'all done', 'done:all done']);
        });

        test('send does not wait for the iterator to be read, and a prompt sent before the first turn has ended is taken into it', async () => {
            const { session } = use({ backgroundHandoffMs: 300 }).start('say started\nbackground terminal 300 x\nreport none');
            const iterator = session[Symbol.asyncIterator]();
            const events: EngineEvent[] = [];

            // Read up to the first `done`, then leave the iterator alone: the agent talks, and nobody reads.
            for (let event = await iterator.next(); !event.done; event = await iterator.next()) {
                events.push(event.value);

                if (event.value.type === 'done') {
                    break;
                }
            }

            const accepted = await Promise.race([session.send!('say unread').then(taken => ({ taken })), Bun.sleep(3000).then(() => 'hung' as const)]);

            expect(accepted).toEqual({ taken: true });
            await session.close();
        });

        test('a prompt sent during a report turn that the agent holds until the turn ends is answered by one `done` for the report and the prompt together', async () => {
            const log = join(mkdtempSync(join(tmpdir(), 'clowdy-send-')), 'requests');
            const { session } = use({ backgroundHandoffMs: 300, agentEnv: { FAKE_ACP_QUEUE: '1', FAKE_ACP_LOG: log } }).start('say started\nbackground terminal 100 sleep\nreport say reporting\nreport sleep 500');
            const { events, ended, dones, until: untilDone } = follow(session);

            await until(() => textOf(events).includes('reporting'), 'the report turn');

            const taken = session.send!('say answered');

            await untilDone(2);

            // The agent answered the prompt after the report turn ended: the `done` of the report waited for it.
            expect(await taken).toBe(true);
            expect(readFileSync(log, 'utf8')).toContain('queued say answered');
            expect(dones()).toEqual([{ type: 'done', result: 'started' }, { type: 'done', result: 'answered' }]);
            expect(turns(events)).toEqual(['started', 'done:started', 'reporting', 'answered', 'done:answered']);

            await ended;
            await session.close();
            // Nothing was owed after it: the session ended with the guard, and said no `done` more.
            expect(dones()).toHaveLength(2);
            rmSync(dirname(log), { recursive: true, force: true });
        });

        test('a prompt the agent inserts into a report turn is answered by that turn\'s `done`, which waits the guard for the turn the agent may give the prompt', async () => {
            const { session } = use({ backgroundHandoffMs: 250 }).start('say started\nbackground terminal 100 sleep\nreport say reporting\nreport sleep 500');
            const { events, ended, dones, until: untilDone } = follow(session);

            await until(() => textOf(events).includes('reporting'), 'the report turn');
            expect(await session.send!('say inserted')).toBe(true);
            await untilDone(2);
            await ended;
            await session.close();

            // The agent folded the prompt into the turn it was in: that turn's `idle` was the answer, and one `done` says so.
            expect(dones()).toHaveLength(2);
            expect(turns(events)).toEqual(['started', 'done:started', 'reporting', 'inserted', 'done:inserted']);
        });

        test('a prompt Claude\'s adapter queues behind a report turn comes back as two turns, and they are one `done`: their usage is one, and the answer is not written twice', async () => {
            const { session } = use({ backgroundHandoffMs: 800 }).start('say started\nbackground terminal 100 sleep\nreport say reporting\nreport sleep 400\nreport usage 100 20 0\nreport twice\ngap 60');
            const { events, ended, dones, until: untilDone } = follow(session);

            await until(() => textOf(events).includes('reporting'), 'the report turn');
            expect(await session.send!('say inserted')).toBe(true);
            await untilDone(2);

            const started = Date.now();

            await ended;
            await session.close();

            // The guard ran from the `done` only: the second turn began within it, so the first `idle` was no end.
            expect(Date.now() - started).toBeGreaterThanOrEqual(700);
            expect(dones()).toEqual([{ type: 'done', result: 'started' }, { type: 'done', result: 'inserted' }]);
            expect(turns(events)).toEqual(['started', 'done:started', 'reporting', 'inserted', 'done:inserted']);
            expect(events.filter(event => event.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 100, outputTokens: 20, costUsd: 0 }]);
        });

        test('the usage of the turns that one `done` ends is summed into one reading', async () => {
            const { session } = use({ backgroundHandoffMs: 300, agentEnv: { FAKE_ACP_QUEUE: '1' } }).start('say started\nbackground terminal 100 sleep\nreport say reporting\nreport usage 30 4 0\nreport sleep 600');
            const { events, ended, dones, until: untilDone } = follow(session);

            await until(() => textOf(events).includes('reporting'), 'the report turn');
            expect(await session.send!('say answered\nusage 5 1 0')).toBe(true);
            await untilDone(2);
            await ended;
            await session.close();

            expect(dones()).toHaveLength(2);
            expect(events.filter(event => event.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 35, outputTokens: 5, costUsd: 0 }]);
        });

        test('a prompt the agent holds behind a turn and then refuses leaves that turn\'s `done` to be said, and the prompt owes none', async () => {
            const { session } = use({ backgroundHandoffMs: 300, agentEnv: { FAKE_ACP_QUEUE: 'refuse' } }).start('say started\nbackground terminal 100 sleep\nreport say reporting\nreport sleep 600');
            const { events, ended, dones, until: untilDone } = follow(session);

            await until(() => textOf(events).includes('reporting'), 'the report turn');

            const taken = await session.send!('say refused');

            await untilDone(2);
            await ended;
            await session.close();

            expect(taken).toBe(false);
            expect(dones()).toEqual([{ type: 'done', result: 'started' }, { type: 'done', result: 'reporting' }]);
            expect(turns(events)).toEqual(['started', 'done:started', 'reporting', 'done:reporting']);
        });

        test('a prompt on its way keeps the guard from ending the session, and its answer is read', async () => {
            const { session } = use({ backgroundHandoffMs: 150, agentEnv: { FAKE_ACP_SLOW: '500' } }).start('say started');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);
            // Nothing is open and the guard runs; the agent takes longer to answer than the guard lasts.
            expect(await session.send!('say answered')).toBe(true);
            await untilDone(2);
            await ended;
            await session.close();

            expect(turns(events)).toEqual(['started', 'done:started', 'answered', 'done:answered']);
        });

        test('send says false when the session is over: closed, ended by the guard, or cancelled', async () => {
            const closed = use({ backgroundHandoffMs: 300 }).start('say started\nbackground terminal 5000 x');
            const reading = follow(closed.session);

            await reading.until(1);
            await closed.session.close();
            expect(await closed.session.send!('say late')).toBe(false);
            await reading.ended;
            current?.stop();

            const guarded = use({ backgroundHandoffMs: 100 }).start('say started');
            const guard = follow(guarded.session);

            await guard.ended;
            expect(await guarded.session.send!('say late')).toBe(false);
            await guarded.session.close();
            current?.stop();

            const cancelled = use({ backgroundHandoffMs: 300 }).start('say started\nbackground terminal 5000 x');
            const cancelling = follow(cancelled.session);

            await cancelling.until(1);
            cancelled.abort.abort();
            expect(await cancelled.session.send!('say late')).toBe(false);
            await cancelling.ended;
            await cancelled.session.close();
        });

        test('a send the agent never echoes is answered all the same, by one `done`', async () => {
            const { session } = use({ backgroundHandoffMs: 200, agentEnv: { FAKE_ACP_NOECHO: '1' } }).start('say started\nbackground terminal 800 x\nreport none');
            const { events, ended, dones, until: untilDone } = follow(session);

            await untilDone(1);
            expect(await session.send!('say hello')).toBe(true);
            await untilDone(2);
            await ended;
            await session.close();

            expect(dones()).toEqual([{ type: 'done', result: 'started' }, { type: 'done', result: 'hello' }]);
            expect(turns(events)).toEqual(['started', 'done:started', 'hello', 'done:hello']);
        });

        test('a prompt on its way when the run is cancelled settles false, and the held `done` is not waited for', async () => {
            const { session, abort } = use({ backgroundHandoffMs: 300, agentEnv: { FAKE_ACP_QUEUE: '1' } }).start('say started\nbackground terminal 100 sleep\nreport say reporting\nreport sleep 3000');
            const { events, ended } = follow(session);

            await until(() => textOf(events).includes('reporting'), 'the report turn');

            // The agent holds the prompt until the report turn ends, which is three seconds away.
            const taken = session.send!('say answered');

            await Bun.sleep(100);
            abort.abort();

            expect(await Promise.race([taken, Bun.sleep(3000).then(() => 'hung')])).toBe(false);
            await ended;
            await session.close();
            expect(types(events).filter(type => type === 'done')).toHaveLength(1);
            await until(() => !alive(pidOf(events)), 'the agent to stop');
        });

        test('a session that was never started takes no prompt', async () => {
            const { session } = use().start('say hi');

            expect(await session.send!('say early')).toBe(false);
            await session.close();
        });

        test('a prompt the agent refuses is not taken, owes no `done`, and the session goes on waiting for the work', async () => {
            const { session } = use({ backgroundHandoffMs: 200, agentEnv: { FAKE_ACP_REJECT: 'later' } }).start('say started\nbackground terminal 600 x\nreport say reported');
            const { events, ended, dones, until: untilDone } = follow(session);

            await untilDone(1);
            expect(await session.send!('say refused')).toBe(false);
            await untilDone(2);
            await ended;
            await session.close();

            expect(dones()).toHaveLength(2);
            expect(turns(events)).toEqual(['started', 'done:started', 'reported', 'done:reported']);
        });
    });

    describe('ending the wait', () => {
        test('cancelling the run while the session waits for work ends it at once, without an error, and leaves no process', async () => {
            const log = join(mkdtempSync(join(tmpdir(), 'clowdy-cancel-')), 'cancels');
            const { session, abort } = use({ backgroundHandoffMs: 300, agentEnv: { FAKE_ACP_LOG: log } }).start('say started\nbackground terminal 30000 long');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);

            const pid = pidOf(events);
            const started = Date.now();

            abort.abort();
            await ended;
            await session.close();

            expect(Date.now() - started).toBeLessThan(4000);
            expect(types(events)).not.toContain('error');
            expect(types(events).filter(type => type === 'done')).toHaveLength(1);
            await until(() => !alive(pid), 'the agent to stop');
            // The agent heard of it before its input closed.
            expect(readFileSync(log, 'utf8')).toBe('cancel fake-1\n');
            rmSync(dirname(log), { recursive: true, force: true });
        });

        test('closing the session while it waits ends it, and a process that was killed meanwhile does not hold the close', async () => {
            const { session } = use({ backgroundHandoffMs: 300 }).start('say started\nbackground terminal 30000 long');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);

            const started = Date.now();

            await session.close();
            await ended;

            expect(Date.now() - started).toBeLessThan(4000);
            await until(() => !alive(pidOf(events)), 'the agent to stop');
        });

        test('the process leaving while work is open is the failure a process that leaves in a turn is', async () => {
            const { session } = use({ backgroundHandoffMs: 300 }).start('say started\nbackground terminal 30000 long\ndie 200');
            const { events, ended } = follow(session);

            await ended;
            await session.close();

            expect(events.at(-1)).toMatchObject({ type: 'error', code: 'process_crashed', message: expect.stringContaining('boom: the fake agent was told to die') });
            expect(types(events).filter(type => type === 'done')).toHaveLength(1);
        });

        test('the process leaving while a `done` is held back for the turn of a steer is a failure, and that `done` is not said', async () => {
            const { session } = use({ backgroundHandoffMs: 1500 }).start('say started\nbackground terminal 100 sleep\nreport say reporting\nreport sleep 600\nreport twice\nreport gap 3000\nreport die 600');
            const { events, ended, dones, until: untilDone } = follow(session);

            await untilDone(1);
            await until(() => textOf(events).includes('reporting'), 'the report turn');
            expect(await session.steer!('say inserted')).toBe(true);
            await ended;
            await session.close();

            expect(events.at(-1)).toMatchObject({ type: 'error', code: 'process_crashed', message: expect.stringContaining('boom: the fake agent was told to die') });
            expect(dones()).toHaveLength(1);
        });

        test('the process leaving after the last `done`, with nothing open, loses nothing and is no failure', async () => {
            const { session } = use({ backgroundHandoffMs: 2000 }).start('say plain\ndie 100');
            const { events, ended } = follow(session);

            await ended;
            await session.close();

            expect(types(events)).not.toContain('error');
            expect(events.at(-1)).toEqual({ type: 'done', result: 'plain' });
        });
    });

    describe('a steer that lands in a turn', () => {
        /** Starts `prompt`, steers `text` once the agent has said `after`, and reads on until the session ends. */
        async function steered(prompt: string, after: string, text: string, options?: Parameters<typeof rig>[0]) {
            const { session } = use(options).start(prompt);
            const { events, ended, until: untilDone } = follow(session);

            await until(() => textOf(events).includes(after), `the agent to say ${ after }`);

            const taken = await session.steer!(text);

            await untilDone(1);
            await ended;
            await session.close();

            return { events, taken };
        }

        test('is answered by a turn of its own, whose usage is the turn\'s, and the answer it gives again is not written twice', async () => {
            const { events, taken } = await steered('usage 100 20 0\nsay first\nsleep 200\nsay last\ntwice\ngap 60', 'first', 'say steered', { backgroundHandoffMs: 800 });

            expect(taken).toBe(true);
            // One `done` ends the turn and the turn of the steer, and the answer that the second turn says again is not shown again.
            expect(turns(events)).toEqual(['first', 'steered', 'last', 'done:last']);
            expect(events.filter(event => event.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 100, outputTokens: 20, costUsd: 0 }]);
        });

        test('is answered by a turn of its own that says the answer again as a whole message, and that is not written twice either', async () => {
            const { events, taken } = await steered('usage 100 20 0\nsay first\nsleep 200\nsay last\ntwice whole\ngap 60', 'first', 'say steered', { backgroundHandoffMs: 800 });

            expect(taken).toBe(true);
            expect(turns(events)).toEqual(['first', 'steered', 'last', 'done:last']);
            expect(events.filter(event => event.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 100, outputTokens: 20, costUsd: 0 }]);
        });

        test('is answered by one `done` when the agent folded it into the turn it landed in and no second turn comes', async () => {
            const started = Date.now();
            const { events, taken } = await steered('usage 100 20 0\nsay first\nsleep 200\nsay last', 'first', 'say steered', { backgroundHandoffMs: 300 });

            expect(taken).toBe(true);
            expect(turns(events)).toEqual(['first', 'steered', 'last', 'done:last']);
            expect(events.filter(event => event.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 100, outputTokens: 20, costUsd: 0 }]);
            // The `done` waited the guard for the turn that never came.
            expect(Date.now() - started).toBeGreaterThanOrEqual(500);
        });

        test('is no end of the turn at the first `idle`: the `done` comes after the second turn has begun and ended', async () => {
            const { session } = use({ backgroundHandoffMs: 800 }).start('say first\nsleep 200\nsay last\ntwice\ngap 300');
            const iterator = session[Symbol.asyncIterator]();
            const events: EngineEvent[] = [];
            let steer: Promise<boolean> | undefined;
            let lastAt = 0;

            for (let event = await iterator.next(); !event.done; event = await iterator.next()) {
                events.push(event.value);

                if (!steer && textOf(events).includes('first')) {
                    steer = session.steer!('say steered');
                }

                if (!lastAt && textOf(events).endsWith('last')) {
                    lastAt = Date.now();
                }

                if (event.value.type === 'done') {
                    break;
                }
            }

            const doneAt = Date.now();

            await session.close();
            expect(await steer).toBe(true);
            // The agent said `idle` right after `last`, and `running` again 300 ms on: the `done` was not said at the first `idle`.
            expect(doneAt - lastAt).toBeGreaterThanOrEqual(250);
            expect(types(events).filter(type => type === 'done')).toHaveLength(1);
        });

        test('does not make a message that is said twice with no steer between its turns a repeat', async () => {
            const { session } = use().start('say same\nsay same');
            const events = await collect(session);

            await session.close();
            expect(textOf(events)).toBe('samesame');
        });

        test('a steer that comes after the turn is refused, and is the runtime\'s to send again', async () => {
            const { session } = use({ backgroundHandoffMs: 100 }).start('say first');
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(1);
            expect(await session.steer!('say late')).toBe(false);
            await ended;
            await session.close();
            expect(textOf(events)).toBe('first');
        });
    });

    describe('steering through the extension', () => {
        /** A turn of two lines the agent says slowly, with the steer sent once it has said the first. */
        async function steeredWith(env: Record<string, string>, canSteer?: boolean) {
            const { log, lines, clean } = agentLog();
            const { session } = use({ agentEnv: { ...env, FAKE_ACP_LOG: log } }).start('say first\nsleep 300\nsay last');
            const { events, ended, until: untilDone } = follow(session);

            await until(() => textOf(events).includes('first'), 'the agent to say first');

            const taken = await session.steer!('say steered');

            if (canSteer !== undefined) {
                expect(session.canSteer).toBe(canSteer);
            }

            await untilDone(1);
            await ended;
            await session.close();

            const result = { events, taken, lines: lines() };

            clean();

            return result;
        }

        test('an agent that advertises it is asked with `_session/steering`, and what it answers `injected` is part of the turn that runs: one `done`, no second turn', async () => {
            const { events, taken, lines } = await steeredWith({ FAKE_ACP_STEERING: '1', FAKE_ACP_QUEUE: '1' }, true);

            expect(taken).toBe(true);
            expect(lines).toEqual(['steering say steered']);
            // The steer's lines ran in the turn it landed in, after the line that was running, and the agent held no prompt for a turn of its own.
            expect(turns(events)).toEqual(['first', 'steered', 'last', 'done:last']);
            expect(types(events).filter(type => type === 'done')).toHaveLength(1);
        });

        test('it does not wait the guard for a turn that never comes: the `done` follows the turn\'s own `idle`', async () => {
            const started = Date.now();
            const { events } = await steeredWith({ FAKE_ACP_STEERING: '1', FAKE_ACP_QUEUE: '1' });

            expect(events.at(-1)).toEqual({ type: 'done', result: 'last' });
            // Turn: first, 300 ms, steered, last. A hold of a 400 ms guard would put the end past 700 ms.
            expect(Date.now() - started).toBeLessThan(1500);
        });

        test('an agent that does not advertise it is sent a plain prompt, which it inserts into the turn: the extension is never asked', async () => {
            const { events, taken, lines } = await steeredWith({}, true);

            expect(taken).toBe(true);
            expect(lines).toEqual(['steer say steered']);
            expect(turns(events).filter(told => told.startsWith('done:'))).toHaveLength(1);
            expect(textOf(events)).toContain('steered');
        });

        test('a steer after the turn is over is refused without a request, and with no turn running the agent\'s `promptRequired` is a refusal too', async () => {
            const { log, lines, clean } = agentLog();
            const { session } = use({ backgroundHandoffMs: 100, agentEnv: { FAKE_ACP_STEERING: '1', FAKE_ACP_LOG: log } }).start('say first');
            const { ended, until: untilDone } = follow(session);

            await untilDone(1);
            expect(await session.steer!('say late')).toBe(false);
            expect(lines()).toEqual([]);
            await ended;
            await session.close();
            clean();
        });

        test('an agent that steers by the extension and holds a plain prompt does not need one: the held prompt is the runtime\'s, sent later', async () => {
            // The control: a plain prompt to an agent that queues it is not part of the turn, which is why the extension is used.
            const { log, lines, clean } = agentLog();
            const { session } = use({ agentEnv: { FAKE_ACP_QUEUE: '1', FAKE_ACP_LOG: log } }).start('say first\nsleep 400\nsay last');
            const { events, ended, until: untilDone } = follow(session);

            await until(() => textOf(events).includes('first'), 'the agent to say first');

            const steering = session.steer!('say steered');

            await untilDone(1);
            expect(lines()).toEqual(['queued say steered']);
            expect(await steering).toBe(false);
            await ended;
            await session.close();
            clean();
        });
    });

    describe('the chat title', () => {
        const named = { FAKE_ACP_TITLES: '1' };

        test('a session that ends after its work still keeps running for the name of a new session, and the process is not recorded again', async () => {
            const message = 'echo\nbackground terminal 100 sleep\nreport say reported\nlate 600 Dark mode toggle';
            const given: string[] = [];
            const title = { onTitle: (text: string) => given.push(text) > 0 && text !== message.replace(/\s+/g, ' ') };
            const { session } = use({ agentEnv: named, backgroundHandoffMs: 100 }).start(message, { title });
            const { events, ended, until: untilDone } = follow(session);

            await untilDone(2);
            await ended;

            const pid = pidOf(events);

            // The iterator ended with the work, and the agent runs on for its name; it was not told to the runtime again.
            await session.close();
            expect(alive(pid)).toBe(true);
            expect(types(events).filter(type => type === 'process')).toHaveLength(1);
            await until(() => given.includes('Dark mode toggle'), 'the name');
            await until(() => !alive(pid), 'the agent to stop');
        });

        test('a title that comes while the session waits for work is taken then', async () => {
            const given: string[] = [];
            const title = { onTitle: (text: string) => given.push(text) > 0 };
            const { session } = use({ agentEnv: named, backgroundHandoffMs: 100 }).start('background terminal 500 sleep\nreport say reported\nlate 100 Named while waiting\nsay started', { title });
            const { events, ended } = follow(session);

            await until(() => given.includes('Named while waiting'), 'the name');
            // The wait went on after the name came: the report is still to be read.
            expect(alive(pidOf(events))).toBe(true);
            await ended;
            await session.close();
            expect(turns(events)).toEqual(['started', 'done:started', 'reported', 'done:reported']);
        });
    });
});

describe('an ACP v1 session', () => {
    test('has no background work to wait for: it ends at its `done` and takes no prompt after it', async () => {
        const { session } = use().start('say plain');
        const events = await collect(session);

        expect(events.at(-1)).toEqual({ type: 'done', result: 'plain' });
        expect(await session.send!('say again')).toBe(false);
        await session.close();
    });

    test('cannot end one sub-agent alone: v1 has no such request', async () => {
        const { session } = use().start('say plain');

        await collect(session);
        expect(await session.stopItem!('agent-1')).toBe(false);
        await session.close();
    });
});
