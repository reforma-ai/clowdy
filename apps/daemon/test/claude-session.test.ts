import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { z } from 'zod';

import { ClaudeEngine } from '../src/engine/claude';
import { DEFAULT_SYSTEM_SKILLS_DIR } from '../src/engine/claude/config';
import { BUILT_IN_TOOLS } from '../src/engine/claude/session';
import { assistant, claudeConfig, delta, fakeQuery, init, message, result, sleep, streamEvent, types, until } from './claude-fakes';

import type { ClaudeConfig } from '../src/engine/claude/config';
import type { EngineEvent, EngineSession, EngineStartOptions, ToolDefinition } from '../src/engine/types';
import type { FakeQuery } from './claude-fakes';

const posix = test.skipIf(process.platform === 'win32');

const echo: ToolDefinition = {
    name: 'echo',
    description: 'Repeats the text',
    inputSchema: {},
    schema: z.object({ text: z.string() }),
    execute: async input => input,
};

const daemonEnv = { HOME: '/home/user', PATH: '/usr/bin', CLAUDECODE: '1', ANTHROPIC_API_KEY: 'sk-ant-from-terminal' };

function build(fake: FakeQuery, config: ClaudeConfig = claudeConfig, skills: ConstructorParameters<typeof ClaudeEngine>[1] = {}) {
    return new ClaudeEngine(config, skills, { env: daemonEnv, query: fake.query });
}

const startOptions = (overrides: Partial<EngineStartOptions> = {}): EngineStartOptions => ({
    cwd: '/work/project',
    prompt: 'Do the thing',
    tools: [],
    signal: new AbortController().signal,
    ...overrides,
});

async function collect(session: EngineSession): Promise<EngineEvent[]> {
    const events: EngineEvent[] = [];

    for await (const event of session) {
        events.push(event);
    }

    return events;
}

const simple = (...messages: ReturnType<typeof message>[]) => fakeQuery(async function* () {
    yield* messages;
});

const warnings: ReturnType<typeof spyOn>[] = [];

afterEach(() => {
    for (const spy of warnings.splice(0)) {
        spy.mockRestore();
    }
});

function captureWarnings(): string[] {
    const lines: string[] = [];

    warnings.push(spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        lines.push(args.join(' '));
    }));

    return lines;
}

describe('what a session asks the SDK for', () => {
    test('prompt exactly as given, working directory, model, resume, tools and skills', async () => {
        const fake = simple(init('s1'), result());
        const engine = build(fake, claudeConfig, { systemSkillsDir: '/data/system-skills/abc', extraPluginDirs: ['/data/user-skills'] });
        const session = engine.start(startOptions({ prompt: '/clowdy:orchestrate Fix the login bug', model: 'haiku', resumeSessionId: 'earlier', systemPrompt: 'You run inside Clowdy.', tools: [echo] }));

        await collect(session);

        const { options } = fake.calls[0];

        expect(fake.received[0]).toEqual(['/clowdy:orchestrate Fix the login bug']);
        expect(options).toMatchObject({
            cwd: '/work/project',
            model: 'haiku',
            resume: 'earlier',
            systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You run inside Clowdy.' },
            plugins: [{ type: 'local', path: '/data/system-skills/abc' }, { type: 'local', path: '/data/user-skills' }],
            settingSources: ['project'],
            tools: BUILT_IN_TOOLS,
            allowedTools: [...BUILT_IN_TOOLS, 'mcp__clowdy__echo'],
            includePartialMessages: true,
            forwardSubagentText: true,
            agentProgressSummaries: true,
        });
        expect(options?.mcpServers?.clowdy).toMatchObject({ type: 'sdk', name: 'clowdy' });
        expect(options?.spawnClaudeCodeProcess).toBeFunction();
    });

    test('unattended by default: permissions are bypassed on purpose, and only the built-in tools the product wants exist', async () => {
        const fake = simple(init(), result());

        await collect(build(fake).start(startOptions()));

        expect(fake.calls[0].options).toMatchObject({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true });
        expect(BUILT_IN_TOOLS).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'Agent', 'Skill', 'TodoWrite', 'NotebookEdit']));
        // These wait for a person at a terminal, and there is none.
        expect(BUILT_IN_TOOLS).not.toContain('AskUserQuestion');
        expect(BUILT_IN_TOOLS).not.toContain('ExitPlanMode');
    });

    test('a stricter permission mode drops the bypass flag', async () => {
        const fake = simple(init(), result());

        await collect(build(fake, { ...claudeConfig, permissionMode: 'acceptEdits' }).start(startOptions()));

        expect(fake.calls[0].options?.permissionMode).toBe('acceptEdits');
        expect(fake.calls[0].options).not.toHaveProperty('allowDangerouslySkipPermissions');
    });

    test('without runtime tools there is no MCP server, and without a system prompt nothing is appended', async () => {
        const fake = simple(init(), result());

        await collect(build(fake).start(startOptions()));

        expect(fake.calls[0].options).not.toHaveProperty('mcpServers');
        expect(fake.calls[0].options?.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
    });

    test('the agent\'s environment is built, not inherited, and carries the sub-agent caps', async () => {
        const fake = simple(init(), result());

        await collect(build(fake).start(startOptions()));

        const env = fake.calls[0].options?.env;

        expect(env).toMatchObject({ HOME: '/home/user', PATH: '/usr/bin', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '3', CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '20' });
        expect(env).not.toHaveProperty('CLAUDECODE');
        expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    });

    test('a chosen binary is used instead of the bundled one', async () => {
        const fake = simple(init(), result());

        await collect(build(fake, { ...claudeConfig, executable: '/opt/claude' }).start(startOptions()));

        expect(fake.calls[0].options?.pathToClaudeCodeExecutable).toBe('/opt/claude');
    });

    test('the skill folders are read when each run starts: the daemon keeps them current', async () => {
        const fake = simple(init(), result());
        const skills: { systemSkillsDir?: string; extraPluginDirs?: string[] } = {};
        const engine = build(fake, claudeConfig, skills);

        await collect(engine.start(startOptions()));
        skills.systemSkillsDir = '/data/system-skills/v2';
        skills.extraPluginDirs = ['/data/user-skills/v1'];
        await collect(engine.start(startOptions()));

        expect(fake.calls.map(call => call.options?.plugins)).toEqual([
            [{ type: 'local', path: DEFAULT_SYSTEM_SKILLS_DIR }],
            [{ type: 'local', path: '/data/system-skills/v2' }, { type: 'local', path: '/data/user-skills/v1' }],
        ]);
    });
});

describe('talking to a session', () => {
    test('messages sent before the session starts, and while it runs, reach it in order after the prompt', async () => {
        const fake = fakeQuery(async function* (_params, received) {
            yield init();
            await until(() => received.length === 3);
            yield result();
        });
        const session = build(fake).start(startOptions({ prompt: 'first' }));

        session.send('second');

        const running = collect(session);

        await until(() => fake.received[0]?.length === 2);
        session.send('third');

        await running;

        expect(fake.received[0]).toEqual(['first', 'second', 'third']);
    });

    test('a message after the turn ended is dropped with a warning, not sent to a closed process', async () => {
        const lines = captureWarnings();
        const fake = simple(init(), result());
        const session = build(fake).start(startOptions());

        await collect(session);
        session.send('too late');
        await sleep(20);

        expect(fake.received[0]).toEqual(['Do the thing']);
        expect(lines.join('\n')).toContain('dropped');
    });

    test('the turn\'s end closes the SDK query', async () => {
        const fake = simple(init(), result());

        await collect(build(fake).start(startOptions()));

        expect(fake.closed()).toBe(1);
    });
});

describe('events', () => {
    test('a turn: session, text, usage, done; and nothing is read after done', async () => {
        const fake = simple(
            init('s1'),
            streamEvent({ type: 'message_start', message: { id: 'm1' } }),
            streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
            delta('Hi'),
            streamEvent({ type: 'content_block_stop', index: 0 }),
            result({ result: 'Hi' }),
            message({ type: 'system', subtype: 'task_notification', task_id: 'late' })
        );
        const events = await collect(build(fake).start(startOptions()));

        expect(types(events)).toEqual(['session', 'text', 'text', 'usage', 'done']);
    });

    test('a queued message gets its own turn: the session goes on until the last one', async () => {
        const fake = simple(init(), result({ result: 'one', queued_turn_count: 1 }), assistant('m2', [{ type: 'text', text: 'two' }]), result({ result: 'two' }));
        const events = await collect(build(fake).start(startOptions()));

        expect(types(events)).toEqual(['session', 'usage', 'text', 'usage', 'done']);
        expect(events.at(-1)).toEqual({ type: 'done', result: 'two' });
    });

    test('a background sub-agent keeps the session open until it has ended and the parent has reported it', async () => {
        const fake = simple(
            init(),
            message({ type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 't1', description: 'Look around', subagent_type: 'Explore', task_type: 'local_agent' }),
            result({ result: 'I started an agent and wait for it' }),
            message({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed', summary: 'Found it' }),
            init(),
            result({ result: 'The agent found it' })
        );
        const events = await collect(build(fake).start(startOptions()));

        expect(events.filter(event => event.type === 'done')).toEqual([{ type: 'done', result: 'The agent found it' }]);
        expect(events.filter(event => event.type === 'subagent').map(event => event.state)).toEqual(['running', 'done']);
    });

    test('an error result ends the turn with a classified error', async () => {
        const fake = simple(
            init(),
            assistant('m1', [{ type: 'text', text: 'Not logged in · Please run /login' }], { error: 'authentication_failed' }),
            result({ is_error: true, result: 'Not logged in · Please run /login' })
        );
        const events = await collect(build(fake).start(startOptions()));

        expect(events.at(-1)).toMatchObject({ type: 'error', code: 'not_logged_in', retryable: false });
    });

    test('a query that ends without any result is an error, so a run cannot hang on a dead process', async () => {
        const events = await collect(build(simple(init())).start(startOptions()));

        expect(events.at(-1)).toMatchObject({ type: 'error', code: 'process_crashed', retryable: true });
    });

    test('an error thrown by the SDK is classified', async () => {
        const fake = fakeQuery(async function* () {
            yield init();
            throw new Error('API Error: 529 {"error":{"message":"Overloaded"}}');
        });
        const events = await collect(build(fake).start(startOptions()));

        expect(events.at(-1)).toMatchObject({ type: 'error', code: 'overloaded', retryable: true });
    });

    test('the initialization reports who pays and what the account is, and warns when the subscription is not what pays', async () => {
        const lines = captureWarnings();
        const fake = simple(message({ type: 'system', subtype: 'init', session_id: 's1', apiKeySource: 'ANTHROPIC_API_KEY', model: 'sonnet', claude_code_version: '2.1.325' }), result());
        const engine = build(fake);

        await collect(engine.start(startOptions()));
        await until(() => engine.diagnostics !== undefined);

        expect(engine.diagnostics).toEqual({ apiKeySource: 'ANTHROPIC_API_KEY', claudeCodeVersion: '2.1.325', model: 'sonnet', subscriptionType: 'Test plan', apiProvider: 'firstParty' });
        expect(lines.filter(line => line.includes('not the subscription login'))).toHaveLength(1);

        // The same finding is not repeated for every run.
        await collect(engine.start(startOptions()));
        await sleep(20);
        expect(lines.filter(line => line.includes('not the subscription login'))).toHaveLength(1);
    });

    test('no warning when the login is what pays, or when an API key was chosen on purpose', async () => {
        const lines = captureWarnings();
        const engine = build(simple(init(), result()));
        const chosen = build(simple(message({ type: 'system', subtype: 'init', session_id: 's1', apiKeySource: 'ANTHROPIC_API_KEY', model: 'm', claude_code_version: '1' }), result()), { ...claudeConfig, auth: 'api-key' });

        await collect(engine.start(startOptions()));
        await collect(chosen.start(startOptions()));
        await sleep(20);

        expect(lines.filter(line => line.includes('subscription login'))).toEqual([]);
        expect(engine.diagnostics?.apiKeySource).toBe('none');
    });

    test('a system skills plugin that failed to load is reported, because the SDK stays silent about it', async () => {
        const lines = captureWarnings();
        const fake = simple(message({ type: 'system', subtype: 'init', session_id: 's1', apiKeySource: 'none', model: 'm', claude_code_version: '1', plugin_errors: [{ plugin: 'inline[0]', type: 'path-not-found', message: 'Plugin directory does not exist', path: '/nope' }] }), result());

        await collect(build(fake).start(startOptions()));

        expect(lines.join('\n')).toContain('plugin /nope did not load: Plugin directory does not exist');
    });
});

describe('cancelling', () => {
    test('aborting the run ends the iteration quietly, aborts the SDK and closes the query', async () => {
        const controller = new AbortController();
        const fake = fakeQuery(async function* (params) {
            const { signal } = params.options!.abortController!;
            const aborted = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve()));

            yield init();
            await aborted;
            // What the CLI writes while it is being stopped.
            yield result({ subtype: 'error_during_execution', is_error: true, errors: ['Request was aborted'] });
        });
        const session = build(fake).start(startOptions({ signal: controller.signal }));
        const events: EngineEvent[] = [];
        const running = (async () => {
            for await (const event of session) {
                events.push(event);

                if (event.type === 'session') {
                    controller.abort();
                }
            }
        })();

        await running;

        expect(types(events)).toEqual(['session']);
        expect(fake.calls[0].options?.abortController?.signal.aborted).toBe(true);
        expect(fake.closed()).toBe(1);
    });

    test('close() stops a session as well, and a session closed before it started never starts the SDK', async () => {
        const fake = simple(init(), result());
        const session = build(fake).start(startOptions());

        await session.close();

        expect(await collect(session)).toEqual([]);
        expect(fake.calls).toHaveLength(0);
    });

    test('an error thrown while the run is being cancelled is not reported', async () => {
        const controller = new AbortController();
        const fake = fakeQuery(async function* () {
            yield init();
            controller.abort();
            throw new Error('Operation aborted');
        });
        const events = await collect(build(fake).start(startOptions({ signal: controller.signal })));

        expect(types(events)).toEqual(['session']);
    });
});

describe('the claude process', () => {
    /** A fake `query` whose "claude" is a real shell process started the way the SDK would start it. */
    function withProcess(script: string, after: (child: { pid: number }) => AsyncGenerator<ReturnType<typeof message>>) {
        let pid = 0;
        const fake = fakeQuery(async function* (params) {
            const child = params.options!.spawnClaudeCodeProcess!({ command: 'sh', args: ['-c', script], env: { PATH: process.env.PATH }, signal: params.options!.abortController!.signal });

            pid = (child as unknown as { pid: number }).pid;
            yield* after({ pid });
        });

        return { fake, pid: () => pid };
    }

    const alive = (pgid: number) => {
        try {
            process.kill(-pgid, 0);

            return true;
        }
        catch {
            return false;
        }
    };

    posix('its pid and group are reported before the first message, so the runtime can kill the group later', async () => {
        const { fake, pid } = withProcess('sleep 30', async function* () {
            yield init();
            yield result();
        });
        const session = build(fake).start(startOptions());
        const events = await collect(session);

        expect(events[0]).toEqual({ type: 'process', pid: pid(), pgid: pid(), startedAt: expect.any(Number) });
        expect(types(events).slice(0, 2)).toEqual(['process', 'session']);

        // The real SDK stops the process when the query closes; this fake does not, so close() has to.
        await session.close();
        expect(alive(pid())).toBe(false);
    });

    posix('close() returns only when the process is gone', async () => {
        const controller = new AbortController();
        const { fake, pid } = withProcess('sleep 30 & wait', async function* () {
            yield init();
            await new Promise(() => undefined);
        });
        const session = build(fake).start(startOptions({ signal: controller.signal }));
        const running = collect(session);

        await until(() => pid() > 0 && alive(pid()));
        controller.abort();
        await running;
        await session.close();

        expect(alive(pid())).toBe(false);
    });

    posix('a process that dies takes its last words into the error, and "not logged in" is recognized from them', async () => {
        const { fake } = withProcess('echo "Not logged in · Please run /login" 1>&2; exit 1', async function* () {
            yield init();
            await sleep(300);
            throw new Error('Claude Code process exited with code 1');
        });
        const events = await collect(build(fake).start(startOptions()));

        expect(events.at(-1)).toMatchObject({ type: 'error', code: 'not_logged_in', retryable: false });
    });

    posix('a crash with nothing recognizable is a retryable crash that quotes the process', async () => {
        const { fake } = withProcess('echo "segfault in module x" 1>&2; exit 139', async function* () {
            yield init();
            await sleep(300);
            throw new Error('Claude Code process exited with code 139');
        });
        const events = await collect(build(fake).start(startOptions()));
        const error = events.at(-1);

        expect(error).toMatchObject({ type: 'error', code: 'process_crashed', retryable: true });
        expect(error?.type === 'error' && error.message).toContain('segfault in module x');
    });
});
