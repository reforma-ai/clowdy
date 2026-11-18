import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { probeAgent } from '../src/engine/acp/probe';
import { alive, collect, rig, textOf, tool, types, until } from './acp-helpers';

import type { EngineEvent } from '../src/engine/types';
import type { Rig } from './acp-helpers';

let current: Rig | undefined;

const use = (options?: Parameters<typeof rig>[0]) => (current = rig(options));

afterEach(() => {
    current?.stop();
    current = undefined;
});

describe('a turn on an ACP agent', () => {
    test('streams the message and ends with done carrying its text', async () => {
        const { session } = use().start('say hello world');
        const events = await collect(session);

        await session.close();

        expect(types(events)).toEqual(['process', 'session', 'text', 'text', 'text', 'done']);
        expect(events[1]).toMatchObject({ type: 'session', sessionId: 'fake-1' });
        expect(textOf(events)).toBe('hello world');
        expect(events.at(-2)).toEqual({ type: 'text', delta: '', done: true });
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
        const { session, abort } = use().start('usage 100 20 0.25');

        session.send('usage 10 5 0.5');

        const events = await collect(session);

        await session.close();
        abort.abort();

        // Both messages were waiting before the first prompt went out, so they are one prompt; the cost is the session's total.
        expect(events.filter(event => event.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 110, outputTokens: 25, costUsd: 0.75 }]);
    });

    test('a message sent while the turn runs waits, then goes out as the next prompt of the same session', async () => {
        const { session } = use().start('say first\nsleep 200\nusage 1 1 0.1');
        const iterator = session[Symbol.asyncIterator]();
        const events: EngineEvent[] = [];

        // Sent after the first prompt started.
        for (let event = await iterator.next(); !event.done; event = await iterator.next()) {
            events.push(event.value);

            if (event.value.type === 'text' && events.length === 3) {
                session.send('say second\nusage 2 2 0.2');
            }

            if (event.value.type === 'done' || event.value.type === 'error') {
                break;
            }
        }

        await session.close();

        expect(types(events).filter(type => type === 'done')).toHaveLength(1);
        expect(textOf(events)).toBe('firstsecond');
        const usage = events.filter(event => event.type === 'usage');

        expect(usage).toMatchObject([{ inputTokens: 1, outputTokens: 1 }, { inputTokens: 2, outputTokens: 2 }]);
        // Each prompt reports its own share of the session's running cost.
        expect(usage.map(event => event.type === 'usage' && event.costUsd)).toEqual([expect.closeTo(0.1), expect.closeTo(0.2)]);
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

        expect(await heard({ clientMeta: meta })).toMatchObject({ terminal: false, _meta: meta });
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

describe('resuming', () => {
    test('session/resume continues the earlier session id', async () => {
        const { session } = use().start('info', { resumeSessionId: 'earlier-7' });
        const events = await collect(session);

        await session.close();

        expect(events.find(event => event.type === 'session')).toEqual({ type: 'session', sessionId: 'earlier-7' });
        expect(JSON.parse(textOf(events))).toMatchObject({ prompts: 1 });
    });

    test('session/load replays the conversation, which is swallowed', async () => {
        const { session } = use({ agentEnv: { FAKE_ACP_RESUME: 'load' } }).start('say fresh', { resumeSessionId: 'earlier-7' });
        const events = await collect(session);

        await session.close();

        expect(events.find(event => event.type === 'session')).toEqual({ type: 'session', sessionId: 'earlier-7' });
        expect(textOf(events)).toBe('fresh');
    });

    test('an agent that cannot resume starts a new session, which the runtime stores instead', async () => {
        const { session } = use({ agentEnv: { FAKE_ACP_RESUME: 'none' } }).start('say fresh', { resumeSessionId: 'earlier-7' });
        const events = await collect(session);

        await session.close();

        expect(events.find(event => event.type === 'session')).toEqual({ type: 'session', sessionId: 'fake-1' });
    });
});

describe('a session that cannot be continued', () => {
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

describe('failures', () => {
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

describe('cancelling', () => {
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

        const spawned = events.find(event => event.type === 'process');

        await until(() => spawned === undefined || !alive(spawned.pid), 'the process to be gone');
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

        const spawned = events.find(event => event.type === 'process');

        await until(() => spawned === undefined || !alive(spawned.pid), 'the agent to be gone');
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

describe('the runtime\'s tools', () => {
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
        const tools = [tool('run_wait', (_input, signal) => new Promise((_resolve, reject) => {
            entered = true;
            signal.addEventListener('abort', () => {
                aborted = true;
                reject(new Error('cancelled'));
            });
        }))];

        const { session, abort } = use().start('call run_wait {}', { tools });
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
