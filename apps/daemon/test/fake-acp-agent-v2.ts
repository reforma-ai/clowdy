import { agent, McpServer, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk/experimental/v2/unstable';
/**
 * A scripted ACP v2 agent for tests: `bun test/fake-acp-agent-v2.ts`. It speaks the draft protocol: `session/prompt` only says the message was inserted
 * (`{ messageId }`), and the turn is `state_update` `running` until `idle` with a `stopReason` and the turn's `usage`. It takes the directives of
 * `fake-acp-agent.ts` that apply, each line of a prompt run in order (read its header for them):
 *
 *   say, tool, call, perm, usage, context, /compact, limit, info, capabilities, choice, prompt, env, fail, sleep, crash, title, echo, late
 *
 * `fail` ends the turn with `idle` and `stopReason: error` (the failure rides on the update, as v2 reports one after the message went in). `subagent` is not
 * spoken: a sub-agent is a session of its own in v2. Directives only v2 has:
 *
 *   pause <ms>                  `requires_action` for that long, then `running` again, as an agent waiting for a person does
 *   stop <reason>               ends the turn at once with that stop reason (`max_tokens`, `max_turn_requests`, `refusal`, ...)
 *
 * FAKE_ACP_LOG is a file that gets a line for every `session/cancel`, `steer <text>` for every prompt that comes while a turn runs (v2 has no steering
 * method: a prompt is inserted into the turn), and `title <session> <title>` for every `session/set_title`. A prompt during a turn is always taken:
 * FAKE_ACP_STEERING means nothing here. FAKE_ACP_RESUME is `resume` (default) or `none` (`session/resume` is answered as an unknown method; FAKE_ACP_LOST=1
 * refuses it with "Session not found"). A resume replays two messages and `replay_complete` only when it asks for it (`replayFrom`);
 * FAKE_ACP_REPLAY=always replays whether asked or not, with a stale `idle` among them, as an agent that does not wait to be asked. FAKE_ACP_SNAPSHOT=1 starts every
 * turn with an `idle` that carries no stop reason, before `running`, as a snapshot of the state the session was in (`FAKE_ACP_SNAPSHOT=reason`: one
 * that carries the last stop reason, which a repeated snapshot may). FAKE_ACP_BLOCKED=1 starts every turn with `requires_action` instead of `running`, as
 * foreground work that begins blocked does. FAKE_ACP_REJECT=1 refuses every prompt with an error response, as an agent does that cannot take the message in. FAKE_ACP_QUEUE=1 holds a prompt that comes while a turn runs until that turn's `idle`, then runs it as a turn
 * of its own and only then answers it, as Codex does (a prompt answered after the `idle` that came before it). FAKE_ACP_WHOLE=1 says every message
 * as two whole-message upserts, the second with all the text. FAKE_ACP_SYSTEM_PROMPT=0 drops the system prompt capability; FAKE_ACP_DIRECTORIES=1 advertises
 * `session.additionalDirectories` (the `info` directive shows the list a session got either way); FAKE_ACP_TITLES=1 gives the agent `session.title` and
 * `session/set_title`; FAKE_ACP_AUTH=1 makes `session/new` ask for authentication; FAKE_ACP_EFFORT is `1` (a reasoning option that follows the model)
 * or `thinking` (the same, behind an option of another kind); FAKE_ACP_RESUME_WARNING=1 makes a resumed session warn, at the start of its first turn,
 * that it was recorded with another model, as Codex does.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';

import type { AgentContext, SessionUpdate } from '@agentclientprotocol/sdk/experimental/v2/unstable';

interface FakeSession {
    cwd: string;
    /** The `additionalDirectories` of the request that opened the session, absent when it had none. */
    directories?: string[];
    mcpServers: McpServer[];
    systemPrompt?: string;
    meta?: unknown;
    /** The `replayFrom` the session was resumed with. */
    replayFrom?: unknown;
    /** The session was resumed, not new. */
    resumed: boolean;
    model: string;
    /** The reasoning level, when `FAKE_ACP_EFFORT` gives the agent a reasoning option. */
    effort: string;
    /** How many `session/set_config_option` requests the session took. */
    sets: number;
    cancel: AbortController;
    count: number;
    cost: number;
    /** A turn is running, so a prompt is inserted into it. */
    prompting: boolean;
    /** Prompts inserted into the running turn and not yet run, as text. */
    steers: string[];
    /** Prompts held until the turn ends (`FAKE_ACP_QUEUE`), each waiting for its turn to come. */
    queue: (() => void)[];
    /** The title the client gave with `session/set_title`; the agent names the session only while it has none. */
    title?: string;
}

const sessions = new Map<string, FakeSession>();
/** What the client said it can do in `initialize`, for the `capabilities` directive. */
let clientCapabilities: unknown;
let counter = 0;
const resumeMode = process.env.FAKE_ACP_RESUME ?? 'resume';

/** FAKE_ACP_LOST=1: the agent no longer has any session it is asked to resume, as Cursor does with a folder it has not seen. */
function lose(): void {
    if (process.env.FAKE_ACP_LOST === '1') {
        throw new RequestError(-32002, 'Session not found');
    }
}

function systemText(content: unknown): string | undefined {
    return Array.isArray(content) ? content.map(block => (block as { text?: string }).text ?? '').join('') : undefined;
}

function open(id: string, params: { cwd: string; additionalDirectories?: string[]; mcpServers?: McpServer[]; systemPrompt?: { content?: unknown } | null; replayFrom?: unknown; _meta?: unknown }, resumed: boolean): FakeSession {
    const session: FakeSession = { cwd: params.cwd, directories: params.additionalDirectories, mcpServers: params.mcpServers ?? [], systemPrompt: systemText(params.systemPrompt?.content), meta: params._meta, replayFrom: params.replayFrom ?? undefined, resumed, model: 'fast', effort: 'high', sets: 0, cancel: new AbortController(), count: 0, cost: 0, prompting: false, steers: [], queue: [] };

    sessions.set(id, session);

    return session;
}

/** The levels a model offers: `smart` has more than `fast`, so a level that is valid for one is not for the other. */
const LEVELS: Record<string, string[]> = { fast: ['low', 'high'], smart: ['low', 'medium', 'high', 'xhigh', 'max'] };

/** A level the agent shows under another name than its value (Claude's `xhigh` is "Extra high"). */
const LEVEL_NAMES: Record<string, string> = { xhigh: 'Extra high' };

/** The options an agent reports: the model, and with `FAKE_ACP_EFFORT=1` a reasoning level that follows the model (as Claude's and Codex's do). */
const modelOptions = (model: string, effort = 'high') => [
    {
        configId: 'model',
        name: 'Model',
        category: 'model',
        type: 'select' as const,
        currentValue: model,
        options: [{ value: 'fast', name: 'Fast' }, { value: 'smart', name: 'Smart' }],
    },
    ...(process.env.FAKE_ACP_EFFORT === 'thinking'
        ? [{
            configId: 'thinking',
            name: 'Thinking',
            category: 'thought_level',
            type: 'select' as const,
            currentValue: 'on',
            options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }],
        }]
        : []),
    ...(process.env.FAKE_ACP_EFFORT === '1' || process.env.FAKE_ACP_EFFORT === 'thinking'
        ? [{
            configId: 'effort',
            name: 'Effort',
            category: 'thought_level',
            type: 'select' as const,
            currentValue: effort,
            options: (LEVELS[model] ?? LEVELS.fast).map(value => ({ value, name: LEVEL_NAMES[value] ?? value })),
        }]
        : []),
];

const log = (line: string) => {
    if (process.env.FAKE_ACP_LOG) {
        appendFileSync(process.env.FAKE_ACP_LOG, `${ line }\n`);
    }
};

/** What the agent says of a resume: its history, as the updates it keeps. */
async function replay(client: AgentContext, sessionId: string): Promise<void> {
    const send = (update: SessionUpdate) => client.notify(methods.client.session.update, { sessionId, update });

    for (const text of ['replayed one', 'replayed two']) {
        await send({ sessionUpdate: 'agent_message', messageId: `replayed-${ text }`, content: [{ type: 'text', text }] });
    }

    // A stale end of an earlier turn, among the history.
    await send({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
    await send({ sessionUpdate: 'replay_complete' });
}

/** Runs one turn of a prompt: the directives of its text, and those of every prompt inserted into it. Ends with the `idle` that says why. */
async function turn(session: FakeSession, sessionId: string, text: string, client: AgentContext): Promise<void> {
    // A client that has gone (a cancelled turn closes the agent's input) is not an error of the turn.
    const send = (update: SessionUpdate) => client.notify(methods.client.session.update, { sessionId, update }).catch(() => undefined);
    const say = async (what: string) => {
        const middle = Math.ceil(what.length / 2);
        const messageId = crypto.randomUUID();

        if (process.env.FAKE_ACP_WHOLE === '1') {
            await send({ sessionUpdate: 'agent_message', messageId, content: [{ type: 'text', text: what.slice(0, middle) }] });
            await send({ sessionUpdate: 'agent_message', messageId, content: [{ type: 'text', text: what }] });

            return;
        }

        for (const part of [what.slice(0, middle), what.slice(middle)]) {
            if (part) {
                await send({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: part } });
            }
        }
    };
    let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
    let calls = 0;
    let echoed = false;
    let stopReason = 'end_turn';
    let error: { code: number; message: string } | undefined;
    const later: { ms: number; title: string }[] = [];
    const lines = text.split('\n');

    session.cancel = new AbortController();
    session.count += 1;

    if (process.env.FAKE_ACP_SNAPSHOT) {
        await send({ sessionUpdate: 'state_update', state: 'idle', ...(process.env.FAKE_ACP_SNAPSHOT === 'reason' && { stopReason: 'end_turn' }) } as SessionUpdate);
    }

    await send(process.env.FAKE_ACP_BLOCKED === '1' ? { sessionUpdate: 'state_update', state: 'requires_action' } : { sessionUpdate: 'state_update', state: 'running' });

    if (session.resumed && session.count === 1 && process.env.FAKE_ACP_RESUME_WARNING === '1') {
        await send({ sessionUpdate: 'agent_message_chunk', messageId: crypto.randomUUID(), content: { type: 'text', text: 'Warning: This session was recorded with model `gpt-5.6-luna` but is resuming with `gpt-6-sol`.\n\n' } });
    }

    try {
        for (let index = 0; ; index++) {
            // A prompt inserted into the turn runs where the agent took it: after the line that was running, before the rest of the prompt.
            // One that came before the first line began waits for the first to end.
            if (index > 0) {
                lines.splice(index, 0, ...session.steers.splice(0).flatMap(steer => steer.split('\n')));
            }

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

                    // There is no `tool_call` in v2: the first update of an id creates the call.
                    await send({ sessionUpdate: 'tool_call_update', toolCallId, title: name, kind: 'read', status: 'in_progress', rawInput: input });
                    await send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: { output: `${ name } finished` } });
                    break;
                }
                case 'call': {
                    const [tool, ...json] = rest;
                    const server = session.mcpServers[0];

                    if (!server || !McpServer.isStdio(server)) {
                        await say('no mcp server');
                        break;
                    }

                    const toolCallId = `c${ session.count }-${ ++calls }`;
                    const input = json.length > 0 ? JSON.parse(json.join(' ')) : {};
                    const mcp = new Client({ name: 'fake-agent', version: '1' });

                    await send({ sessionUpdate: 'tool_call_update', toolCallId, title: `Tool: ${ server.name }/${ tool }`, kind: 'other', status: 'in_progress', rawInput: input });
                    await mcp.connect(new StdioClientTransport({ command: server.command, args: server.args, env: Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value])) }));

                    const result = await mcp.callTool({ name: tool, arguments: input });
                    const content = result.content as { type: string; text?: string }[];

                    await mcp.close();
                    await send({ sessionUpdate: 'tool_call_update', toolCallId, status: result.isError ? 'failed' : 'completed', rawOutput: content.map(block => block.text).join('') });
                    await say(`${ result.isError ? 'error' : 'result' }: ${ content.map(block => block.text).join('') }`);
                    break;
                }
                case 'perm': {
                    // The foreground work waits on a person until the client answers.
                    await send({ sessionUpdate: 'state_update', state: 'requires_action' });

                    const answer = await client.request(methods.client.session.requestPermission, {
                        sessionId,
                        title: 'Run a command',
                        subject: { type: 'tool_call', toolCall: { toolCallId: `p${ ++calls }`, title: 'Run a command' } },
                        options: [
                            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
                            { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
                            { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
                        ],
                    });

                    await send({ sessionUpdate: 'state_update', state: 'running' });
                    await say(`permission: ${ answer.outcome.outcome === 'selected' ? answer.outcome.optionId : answer.outcome.outcome }`);
                    break;
                }
                case 'pause':
                    await send({ sessionUpdate: 'state_update', state: 'requires_action' });
                    await Bun.sleep(Number(argument));
                    await send({ sessionUpdate: 'state_update', state: 'running' });
                    break;
                case 'stop':
                    stopReason = argument;

                    return;
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

                    await send({ sessionUpdate: 'tool_call_update', toolCallId, title: 'Compact conversation', kind: 'think', status: 'in_progress', _meta: { claudeCode: { toolName: 'compact' } } });
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
                    await say(JSON.stringify({ title: session.title, cwd: session.cwd, directories: session.directories, servers: session.mcpServers.map(server => server.name), systemPrompt: session.systemPrompt, meta: session.meta, replayFrom: session.replayFrom, model: session.model, prompts: session.count }));
                    break;
                case 'capabilities':
                    await say(JSON.stringify(clientCapabilities));
                    break;
                case 'choice':
                    await say(JSON.stringify({ model: session.model, effort: session.effort, sets: session.sets }));
                    break;
                case 'prompt':
                    await say(JSON.stringify(text));
                    break;
                case 'env':
                    await say(`${ argument }=${ process.env[argument] ?? '' }`);
                    break;
                case 'fail': {
                    const [code, ...message] = rest;

                    error = { code: Number(code), message: message.join(' ') };
                    stopReason = 'error';

                    return;
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
                        stopReason = 'cancelled';

                        return;
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
        await send({ sessionUpdate: 'state_update', state: 'idle', stopReason, ...(error && { error }), ...(usage && { usage }) } as SessionUpdate);
        // A prompt held for this turn's end (`FAKE_ACP_QUEUE`) runs next.
        session.queue.shift()?.();

        // What an agent gives once the turn is over: its first message as the title, then a name of its own a moment later.
        if (session.title === undefined) {
            if (echoed) {
                setTimeout(() => void send({ sessionUpdate: 'session_info_update', title: text.replace(/\s+/g, ' ').trim() }), 5);
            }

            for (const { ms, title } of later) {
                setTimeout(() => void send({ sessionUpdate: 'session_info_update', title }), ms);
            }
        }
    }
}

const app = agent({ name: 'fake-acp-agent-v2' })
    .onRequest(methods.agent.initialize, ({ params }) => {
        clientCapabilities = params.capabilities;

        return {
            protocolVersion: PROTOCOL_VERSION,
            info: { name: 'fake-acp-agent-v2', version: '1.0.0' },
            capabilities: {
                session: {
                    mcp: { stdio: {} },
                    ...(process.env.FAKE_ACP_SYSTEM_PROMPT !== '0' && { systemPrompt: {} }),
                    ...(process.env.FAKE_ACP_DIRECTORIES === '1' && { additionalDirectories: {} }),
                    ...(process.env.FAKE_ACP_TITLES === '1' && { title: {} }),
                },
            },
        };
    })
    .onRequest(methods.agent.session.new, ({ params }) => {
        if (process.env.FAKE_ACP_AUTH === '1') {
            throw new RequestError(-32000, 'Authentication required');
        }

        const id = `fake-${ ++counter }`;

        open(id, params, false);

        return { sessionId: id, configOptions: modelOptions('fast') };
    })
    .onRequest(methods.agent.session.resume, async ({ params, client }) => {
        if (resumeMode === 'none') {
            throw RequestError.methodNotFound(methods.agent.session.resume);
        }

        lose();
        open(params.sessionId, params, true);

        if (params.replayFrom || process.env.FAKE_ACP_REPLAY === 'always') {
            await replay(client, params.sessionId);
        }

        // The agent says what state the session is in before it answers, with or without a replay.
        await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' } });

        return { configOptions: modelOptions('fast') };
    })
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
        const session = sessions.get(params.sessionId);

        if (session && params.type === 'id' && typeof params.value === 'string') {
            session.sets++;

            if (params.configId === 'effort') {
                session.effort = params.value;
            }
            else if (params.configId === 'model') {
                session.model = params.value;
                // A model keeps the level when it has it, and goes back to its own default when it has not.
                session.effort = (LEVELS[session.model] ?? LEVELS.fast).includes(session.effort) ? session.effort : 'high';
            }
        }

        return { configOptions: modelOptions(session?.model ?? 'fast', session?.effort) };
    })
    .onRequest(methods.agent.session.setTitle, async ({ params, client }) => {
        const session = sessions.get(params.sessionId);

        if (!session) {
            throw RequestError.sessionNotFound(params.sessionId);
        }

        log(`title ${ params.sessionId } ${ params.title }`);
        session.title = params.title;
        await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'session_info_update', title: params.title } });

        return { title: params.title };
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
        log(`cancel ${ params.sessionId }`);
        sessions.get(params.sessionId)?.cancel.abort();
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
        const session = sessions.get(params.sessionId);

        if (!session) {
            throw RequestError.sessionNotFound(params.sessionId);
        }

        if (process.env.FAKE_ACP_REJECT === '1') {
            throw new RequestError(-32000, 'Authentication required');
        }

        const text = params.prompt.map(block => (block.type === 'text' ? block.text : '')).join('\n');
        const messageId = crypto.randomUUID();
        let starting = !session.prompting;

        if (starting) {
            session.prompting = true;
        }
        else if (process.env.FAKE_ACP_QUEUE === '1') {
            // Held, answered and echoed only when the turn before it is over, and run as a turn of its own.
            log(`queued ${ text.replaceAll('\n', ' | ') }`);
            await new Promise<void>(resolve => session.queue.push(resolve));
            session.prompting = true;
            starting = true;
        }
        else {
            // Inserted into the running turn: its lines run as directives of that same turn, after the line in progress.
            log(`steer ${ text.replaceAll('\n', ' | ') }`);
            session.steers.push(text);
        }

        await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'user_message', messageId, content: [{ type: 'text', text }] } });

        if (starting) {
            // The turn goes on after the answer: the message is inserted, nothing more.
            setImmediate(() => void turn(session, params.sessionId, text, client));
        }

        return { messageId };
    });

app.connect(ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
