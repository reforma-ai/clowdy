import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk/unstable';
/**
 * A scripted ACP agent for tests: `bun test/fake-acp-agent.ts`. Each line of a prompt is one directive, run in order:
 *
 *   say <text>                  an assistant message (in two chunks)
 *   tool <name> <json>          a tool call that completes with the JSON as its raw output
 *   subagent <type> <brief>     an `Agent` call whose sub-agent says something and reads a file, reported as Claude's adapter does without
 *                               child sessions (stamped with `parentToolUseId`, one update without the stamp); the call's result is its report
 *   call <tool> <json>          calls a tool of the first MCP server the session was given, and says what came back
 *   perm                        asks for permission and says which option the client chose
 *   usage <in> <out> <cost>     token usage for the prompt and a cumulative cost update
 *   limit <status> <resetsAt>   a rate limit signal in Claude's adapter format
 *   info                        says what the session was created with, as JSON
 *   capabilities                says what the client told the agent it can do in `initialize`, as JSON
 *   choice                      says the model and reasoning level the session ended up on and how many options it was asked to set, as JSON
 *   prompt                      says the whole text of the prompt, as JSON
 *   env <NAME>                  says the value of an environment variable
 *   shell <command>             runs the command with `sh -c` in the session's folder and its own environment, as an agent's shell tool does, and
 *                               says `{ code, stdout, stderr }` as JSON
 *   tools                       says the names of the tools the first MCP server the session was given lists, as JSON
 *   fail <code> <message>       fails the prompt with a JSON-RPC error
 *   sleep <ms>                  waits; a cancel ends the prompt with `cancelled`
 *   crash                       writes to stderr and exits with code 3
 *   title <text>                a `session_info_update` that names the session (FAKE_ACP_TITLES=1 gives the agent `sessionCapabilities.title` and `session/set_title`)
 *   echo                        at the end of the prompt, a title that is the whole text of the prompt, as Codex gives until its own is ready
 *   late <ms> <text>            a title <ms> after the prompt is answered, as Codex names a session when its turn is over
 *
 * FAKE_ACP_LOG is a file that gets a line for every `session/cancel` the agent receives, one for every `_session/steering` request, and `title <session> <title>` for every `session/set_title`.
 * FAKE_ACP_STEERING=1 says in `initialize` that the agent can steer (`_meta.steering.supported`, where both pinned adapters put it): a steer that comes
 * while a prompt runs is `injected`, and its lines run as directives of that same prompt, after the line in progress; with no prompt running it is
 * `promptRequired`. Without the switch the agent still answers the method, so a test can see that the client did not ask.
 * FAKE_ACP_RESUME is `resume` (default), `load` (replays two messages first) or `none` (FAKE_ACP_LOST=1 refuses either with "Session not found"); FAKE_ACP_SYSTEM_PROMPT=0 drops
 * the system prompt capability; FAKE_ACP_REFUSE_V2=1 answers an `initialize` that asks for a version above 1 with an error, as a strict v1 agent may, instead of with version 1; FAKE_ACP_DIRECTORIES=1 advertises `sessionCapabilities.additionalDirectories` (the `info` directive shows the list a
 * session got either way, so a test sees what was sent unasked); FAKE_ACP_AUTH=1 makes `session/new` ask for authentication; FAKE_ACP_EFFORT is `1` (a reasoning
 * option that follows the model) or `thinking` (the same, behind an option of another kind); FAKE_ACP_ECHO_CLIENT=1 puts what the client
 * said in `initialize` into the agent's own capabilities (`_meta.client`), for a caller that sends no prompt, such as the probe.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';

import type { McpServer, SessionUpdate } from '@agentclientprotocol/sdk/unstable';

interface FakeSession {
    cwd: string;
    /** The `additionalDirectories` of the request that opened the session, absent when it had none. */
    directories?: string[];
    mcpServers: McpServer[];
    systemPrompt?: string;
    meta?: unknown;
    model: string;
    /** The reasoning level, when `FAKE_ACP_EFFORT` gives the agent a reasoning option. */
    effort: string;
    /** The permission mode `session/set_config_option` set (`FAKE_ACP_MODES=1`); absent until one was. */
    mode?: string;
    /** How many `session/set_config_option` requests the session took. */
    sets: number;
    cancel: AbortController;
    count: number;
    cost: number;
    /** A prompt is running, so a steer is taken by it. */
    prompting: boolean;
    /** Steers taken and not yet run, as the text of their prompts. */
    steers: string[];
    /** The title the client gave with `session/set_title`; the agent names the session only while it has none. */
    title?: string;
}

const sessions = new Map<string, FakeSession>();
/** What the client said it can do in `initialize`, for the `capabilities` directive. */
let clientCapabilities: unknown;
let counter = 0;
const resumeMode = process.env.FAKE_ACP_RESUME ?? 'resume';

/** FAKE_ACP_LOST=1: the agent no longer has any session it is asked to resume or load, as Cursor does with a folder it has not seen. */
function lose(): void {
    if (process.env.FAKE_ACP_LOST === '1') {
        throw new RequestError(-32002, 'Session not found');
    }
}

function systemText(content: unknown): string | undefined {
    return Array.isArray(content) ? content.map(block => (block as { text?: string }).text ?? '').join('') : undefined;
}

function open(id: string, params: { cwd: string; additionalDirectories?: string[]; mcpServers?: McpServer[]; systemPrompt?: { content?: unknown } | null; _meta?: unknown }): FakeSession {
    const session: FakeSession = { cwd: params.cwd, directories: params.additionalDirectories, mcpServers: params.mcpServers ?? [], systemPrompt: systemText(params.systemPrompt?.content), meta: params._meta, model: 'fast', effort: 'high', sets: 0, cancel: new AbortController(), count: 0, cost: 0, prompting: false, steers: [] };

    sessions.set(id, session);

    return session;
}

/** The levels a model offers: `smart` has more than `fast`, so a level that is valid for one is not for the other. */
const LEVELS: Record<string, string[]> = { fast: ['low', 'high'], smart: ['low', 'medium', 'high', 'xhigh', 'max'] };

/** A level the agent shows under another name than its value (Claude's `xhigh` is "Extra high"). */
const LEVEL_NAMES: Record<string, string> = { xhigh: 'Extra high' };

/**
 * The options an agent reports: the model, and with `FAKE_ACP_EFFORT=1` a reasoning level that follows the model (as Claude's and Codex's do).
 * `FAKE_ACP_EFFORT=thinking` puts another `thought_level` option, with values of its own, in front of it (as Cursor's `thinking` is).
 */
const modelOptions = (model: string, effort = 'high', mode = 'default') => [
    {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select' as const,
        currentValue: model,
        options: [{ value: 'fast', name: 'Fast' }, { value: 'smart', name: 'Smart' }],
    },
    ...(process.env.FAKE_ACP_EFFORT === 'thinking'
        ? [{
            id: 'thinking',
            name: 'Thinking',
            category: 'thought_level',
            type: 'select' as const,
            currentValue: 'on',
            options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }],
        }]
        : []),
    ...(process.env.FAKE_ACP_EFFORT === '1' || process.env.FAKE_ACP_EFFORT === 'thinking'
        ? [{
            id: 'effort',
            name: 'Effort',
            category: 'thought_level',
            type: 'select' as const,
            currentValue: effort,
            options: (LEVELS[model] ?? LEVELS.fast).map(value => ({ value, name: LEVEL_NAMES[value] ?? value })),
        }]
        : []),
    // `FAKE_ACP_MODES=1`: the permission modes Claude's adapter offers, as one option of category `mode`.
    ...(process.env.FAKE_ACP_MODES === '1'
        ? [{
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            type: 'select' as const,
            currentValue: mode,
            options: ['default', 'acceptEdits', 'auto', 'bypassPermissions'].map(value => ({ value, name: value })),
        }]
        : []),
];

const app = agent({ name: 'fake-acp-agent' })
    .onRequest(methods.agent.initialize, ({ params }) => {
        if (process.env.FAKE_ACP_REFUSE_V2 === '1' && params.protocolVersion > PROTOCOL_VERSION) {
            throw new RequestError(-32602, `Unsupported protocol version ${ params.protocolVersion }`);
        }

        clientCapabilities = params.clientCapabilities;

        return {
            protocolVersion: PROTOCOL_VERSION,
            agentInfo: { name: 'fake-acp-agent', version: '1.0.0' },
            agentCapabilities: {
                loadSession: resumeMode === 'load',
                sessionCapabilities: {
                    ...(resumeMode === 'resume' && { resume: {} }),
                    ...(process.env.FAKE_ACP_SYSTEM_PROMPT !== '0' && { systemPrompt: {} }),
                    ...(process.env.FAKE_ACP_DIRECTORIES === '1' && { additionalDirectories: {} }),
                    ...(process.env.FAKE_ACP_TITLES === '1' && { title: {} }),
                },
                ...(process.env.FAKE_ACP_ECHO_CLIENT === '1' && { _meta: { client: params.clientCapabilities } }),
            },
            ...(process.env.FAKE_ACP_STEERING === '1' && { _meta: { steering: { supported: true } } }),
        };
    })
    .onRequest('_session/steering', params => params as { sessionId: string; prompt: { type: string; text?: string }[] }, ({ params }) => {
        const session = sessions.get(params.sessionId);
        const text = params.prompt.map(block => block.text ?? '').join('\n');

        if (process.env.FAKE_ACP_LOG) {
            appendFileSync(process.env.FAKE_ACP_LOG, `steer ${ text.replaceAll('\n', ' | ') }\n`);
        }

        if (!session?.prompting) {
            return { outcome: 'promptRequired', reason: 'noRunningTurn' };
        }

        session.steers.push(text);

        return { outcome: 'injected' };
    })
    .onRequest(methods.agent.session.new, ({ params }) => {
        if (process.env.FAKE_ACP_AUTH === '1') {
            throw new RequestError(-32000, 'Authentication required');
        }

        const id = `fake-${ ++counter }`;

        open(id, params);

        return { sessionId: id, configOptions: modelOptions('fast') };
    })
    .onRequest(methods.agent.session.resume, ({ params, client }) => {
        lose();
        open(params.sessionId, params);

        // Codex's adapter warns right after the response when the session was recorded with another model.
        if (process.env.FAKE_ACP_RESUME_WARNING === '1') {
            setImmediate(() => void client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Warning: This session was recorded with model `gpt-5.6-luna` but is resuming with `gpt-6-sol`.\n\n' } } }));
        }

        return { configOptions: modelOptions('fast') };
    })
    .onRequest(methods.agent.session.load, async ({ params, client }) => {
        lose();
        open(params.sessionId, params);

        for (const text of ['replayed one', 'replayed two']) {
            await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
        }

        return { configOptions: modelOptions('fast') };
    })
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
        const session = sessions.get(params.sessionId);

        if (session && 'value' in params && typeof params.value === 'string') {
            session.sets++;

            if (params.configId === 'effort') {
                session.effort = params.value;
            }
            else if (params.configId === 'model') {
                session.model = params.value;
                // A model keeps the level when it has it, and goes back to its own default when it has not.
                session.effort = (LEVELS[session.model] ?? LEVELS.fast).includes(session.effort) ? session.effort : 'high';
            }
            else if (params.configId === 'mode') {
                session.mode = params.value;
            }
        }

        return { configOptions: modelOptions(session?.model ?? 'fast', session?.effort, session?.mode) };
    })
    .onRequest(methods.agent.session.setTitle, async ({ params, client }) => {
        const session = sessions.get(params.sessionId);

        if (!session) {
            throw new RequestError(-32002, 'Resource not found');
        }

        if (process.env.FAKE_ACP_LOG) {
            appendFileSync(process.env.FAKE_ACP_LOG, `title ${ params.sessionId } ${ params.title }\n`);
        }

        session.title = params.title;
        await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'session_info_update', title: params.title } });

        return { title: params.title };
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
        if (process.env.FAKE_ACP_LOG) {
            appendFileSync(process.env.FAKE_ACP_LOG, `cancel ${ params.sessionId }\n`);
        }

        sessions.get(params.sessionId)?.cancel.abort();
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
        const session = sessions.get(params.sessionId);

        if (!session) {
            throw new RequestError(-32002, 'Resource not found');
        }

        session.cancel = new AbortController();
        session.count += 1;

        const sessionId = params.sessionId;
        const send = (update: SessionUpdate) => client.notify(methods.client.session.update, { sessionId, update });
        const say = async (text: string) => {
            const middle = Math.ceil(text.length / 2);
            const messageId = crypto.randomUUID();

            for (const part of [text.slice(0, middle), text.slice(middle)]) {
                if (part) {
                    await send({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: part } });
                }
            }
        };
        const text = params.prompt.map(block => (block.type === 'text' ? block.text : '')).join('\n');
        let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
        let calls = 0;
        let echoed = false;
        const later: { ms: number; title: string }[] = [];
        const lines = text.split('\n');

        session.prompting = true;

        try {
            for (let index = 0; ; index++) {
                // A steer runs where the agent took it: after the line that was running, before the rest of the prompt.
                lines.splice(index, 0, ...session.steers.splice(0).flatMap(steer => steer.split('\n')));

                if (index >= lines.length) {
                    break;
                }

                const line = lines[index];
                const [command, ...rest] = line.trim().split(' ');
                const argument = rest.join(' ');

                switch (command) {
                    case 'say':
                        await say(argument);
                        break;
                    case 'tool': {
                        const [name, ...json] = rest;
                        const toolCallId = `t${ session.count }-${ ++calls }`;
                        const input = json.length > 0 ? JSON.parse(json.join(' ')) : {};

                        await send({ sessionUpdate: 'tool_call', toolCallId, title: name, kind: 'read', status: 'in_progress', rawInput: input });
                        await send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: { output: `${ name } finished` } });
                        break;
                    }
                    case 'subagent': {
                        const [type, ...brief] = rest;
                        const agentId = `a${ session.count }-${ ++calls }`;
                        const readId = `${ agentId }-read`;
                        const child = { claudeCode: { parentToolUseId: agentId } };

                        await send({ sessionUpdate: 'tool_call', toolCallId: agentId, title: brief.join(' '), kind: 'think', status: 'in_progress', rawInput: { subagent_type: type, description: brief.join(' '), prompt: 'Look around' }, _meta: { claudeCode: { toolName: 'Agent' } } });
                        await send({ sessionUpdate: 'agent_message_chunk', messageId: crypto.randomUUID(), content: { type: 'text', text: 'Looking around.' }, _meta: child });
                        await send({ sessionUpdate: 'tool_call', toolCallId: readId, title: 'Read README.md', kind: 'read', status: 'in_progress', rawInput: { file_path: 'README.md' }, _meta: { claudeCode: { toolName: 'Read', parentToolUseId: agentId } } });
                        // A later update of the sub-agent's call can lose the stamp.
                        await send({ sessionUpdate: 'tool_call_update', toolCallId: readId, status: 'completed', rawOutput: '# Readme' });
                        await send({ sessionUpdate: 'tool_call_update', toolCallId: agentId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: `${ type } found the readme.` } }], _meta: { claudeCode: { toolName: 'Agent' } } });
                        break;
                    }
                    case 'call': {
                        const [tool, ...json] = rest;
                        const server = session.mcpServers[0];

                        if (!server || !('command' in server)) {
                            await say('no mcp server');
                            break;
                        }

                        const toolCallId = `c${ session.count }-${ ++calls }`;
                        const input = json.length > 0 ? JSON.parse(json.join(' ')) : {};
                        const mcp = new Client({ name: 'fake-agent', version: '1' });

                        await send({ sessionUpdate: 'tool_call', toolCallId, title: `Tool: ${ server.name }/${ tool }`, kind: 'other', status: 'in_progress', rawInput: input });
                        await mcp.connect(new StdioClientTransport({ command: server.command, args: server.args, env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])) }));

                        const result = await mcp.callTool({ name: tool, arguments: input });
                        const content = result.content as { type: string; text?: string }[];

                        await mcp.close();
                        await send({ sessionUpdate: 'tool_call_update', toolCallId, status: result.isError ? 'failed' : 'completed', rawOutput: content.map(block => block.text).join('') });
                        await say(`${ result.isError ? 'error' : 'result' }: ${ content.map(block => block.text).join('') }`);
                        break;
                    }
                    case 'perm': {
                        // `perm [kind [json]]`: the optional kind of the call it asks about, and extra fields of it (title, rawInput, locations, content) as JSON.
                        const [kind, ...extra] = rest;
                        const answer = await client.request(methods.client.session.requestPermission, {
                            sessionId,
                            toolCall: { toolCallId: `p${ ++calls }`, title: 'Run a command', ...(kind && { kind: kind as 'execute' }), ...(extra.length > 0 ? JSON.parse(extra.join(' ')) as Record<string, unknown> : {}) },
                            options: [
                                { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
                                { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
                                { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
                            ],
                        });

                        await say(`permission: ${ answer.outcome.outcome === 'selected' ? answer.outcome.optionId : answer.outcome.outcome }`);
                        break;
                    }
                    case 'perm2': {
                        // Two requests at once, as an agent that runs two tools in parallel sends them.
                        const ask = (title: string) => client.request(methods.client.session.requestPermission, {
                            sessionId,
                            toolCall: { toolCallId: `p${ ++calls }`, title, kind: 'execute', rawInput: { command: title } },
                            options: [
                                { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
                                { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
                            ],
                        });
                        const answers = await Promise.all([ask('first'), ask('second')]) as { outcome: { outcome: string; optionId?: string } }[];

                        await say(`permissions: ${ answers.map(answer => (answer.outcome.outcome === 'selected' ? answer.outcome.optionId : answer.outcome.outcome)).join(',') }`);
                        break;
                    }
                    case 'usage': {
                        const [input, output, cost] = rest.map(Number);

                        usage = { inputTokens: (usage?.inputTokens ?? 0) + input, outputTokens: (usage?.outputTokens ?? 0) + output, totalTokens: (usage?.totalTokens ?? 0) + input + output };
                        session.cost += cost;
                        await send({ sessionUpdate: 'usage_update', used: input + output, size: 200_000, cost: { amount: session.cost, currency: 'USD' } });
                        break;
                    }
                    case 'context': {
                        const [used, size] = rest;

                        await send({ sessionUpdate: 'usage_update', used: Number(used), size: Number(size) });
                        break;
                    }
                    case '/compact': {
                    // What Claude's adapter reports for its own command: a tool call with the counts, a smaller window, and no words.
                        const toolCallId = `k${ session.count }`;
                        const rawOutput = { trigger: 'manual', preTokens: 22_062, postTokens: 6111, durationMs: 4200 };

                        await send({ sessionUpdate: 'tool_call', toolCallId, title: 'Compact conversation', kind: 'think', status: 'in_progress', _meta: { claudeCode: { toolName: 'compact' } } });
                        await send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput, _meta: { claudeCode: { toolName: 'compact' } } });
                        await send({ sessionUpdate: 'usage_update', used: 6111, size: 1_000_000 });
                        break;
                    }
                    case 'limit': {
                        const [status, resetsAt] = rest;

                        await send({ sessionUpdate: 'usage_update', used: 1, size: 200_000, _meta: { '_claude/rateLimit': { status, rateLimitType: 'five_hour', utilization: 0.95, resetsAt: Number(resetsAt) } } });
                        break;
                    }
                    case 'title':
                        // An agent names a session only when the client has not.
                        if (session.title === undefined) {
                            await send({ sessionUpdate: 'session_info_update', title: argument });
                        }

                        break;
                    case 'echo':
                        echoed = true;
                        break;
                    case 'late':
                        later.push({ ms: Number(rest[0]), title: rest.slice(1).join(' ') });
                        break;
                    case 'info':
                        await say(JSON.stringify({ title: session.title, cwd: session.cwd, directories: session.directories, servers: session.mcpServers.map(server => server.name), systemPrompt: session.systemPrompt, meta: session.meta, model: session.model, prompts: session.count }));
                        break;
                    case 'capabilities':
                        await say(JSON.stringify(clientCapabilities));
                        break;
                    case 'choice':
                        await say(JSON.stringify({ model: session.model, effort: session.effort, sets: session.sets, ...(session.mode && { mode: session.mode }) }));
                        break;
                    case 'prompt':
                        await say(JSON.stringify(text));
                        break;
                    case 'env':
                        await say(`${ argument }=${ process.env[argument] ?? '' }`);
                        break;
                    case 'shell': {
                        const child = Bun.spawn(['sh', '-c', argument], { cwd: session.cwd, env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
                        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

                        await say(JSON.stringify({ code, stdout, stderr }));
                        break;
                    }
                    case 'tools': {
                        const server = session.mcpServers[0];

                        if (!server || !('command' in server)) {
                            await say('no mcp server');
                            break;
                        }

                        const mcp = new Client({ name: 'fake-agent', version: '1' });

                        await mcp.connect(new StdioClientTransport({ command: server.command, args: server.args, env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])) }));
                        await say(JSON.stringify((await mcp.listTools()).tools.map(entry => entry.name)));
                        await mcp.close();
                        break;
                    }
                    case 'fail': {
                        const [code, ...message] = rest;

                        throw new RequestError(Number(code), message.join(' '));
                    }
                    case 'sleep': {
                        const { signal } = session.cancel;

                        await new Promise<void>((resolve) => {
                            const timer = setTimeout(resolve, Number(argument));

                            signal.addEventListener('abort', () => {
                                clearTimeout(timer);
                                resolve();
                            }, { once: true });
                        });

                        if (signal.aborted) {
                            return { stopReason: 'cancelled' as const };
                        }

                        break;
                    }
                    case 'crash':
                        process.stderr.write('boom: the fake agent crashed\n');
                        process.exit(3);
                        break;
                    default:
                        if (line.trim()) {
                            await say('ok');
                        }
                }
            }
        }
        finally {
            session.prompting = false;
        }

        // What an agent gives once the prompt is answered: its first message as the title, then a name of its own a moment later.
        if (session.title === undefined) {
            if (echoed) {
                setTimeout(() => void send({ sessionUpdate: 'session_info_update', title: text.replace(/\s+/g, ' ').trim() }), 5);
            }

            for (const { ms, title } of later) {
                setTimeout(() => void send({ sessionUpdate: 'session_info_update', title }), ms);
            }
        }

        return { stopReason: 'end_turn' as const, ...(usage && { usage }) };
    });

app.connect(ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
