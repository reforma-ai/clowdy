import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk/unstable';
/**
 * A scripted ACP agent for tests: `bun test/fake-acp-agent.ts`. Each line of a prompt is one directive, run in order:
 *
 *   say <text>                  an assistant message (in two chunks)
 *   tool <name> <json>          a tool call that completes with the JSON as its raw output
 *   call <tool> <json>          calls a tool of the first MCP server the session was given, and says what came back
 *   perm                        asks for permission and says which option the client chose
 *   usage <in> <out> <cost>     token usage for the prompt and a cumulative cost update
 *   limit <status> <resetsAt>   a rate limit signal in Claude's adapter format
 *   info                        says what the session was created with, as JSON
 *   prompt                      says the whole text of the prompt, as JSON
 *   env <NAME>                  says the value of an environment variable
 *   fail <code> <message>       fails the prompt with a JSON-RPC error
 *   sleep <ms>                  waits; a cancel ends the prompt with `cancelled`
 *   crash                       writes to stderr and exits with code 3
 *
 * FAKE_ACP_LOG is a file that gets a line for every `session/cancel` the agent receives.
 * FAKE_ACP_RESUME is `resume` (default), `load` (replays two messages first) or `none`; FAKE_ACP_SYSTEM_PROMPT=0 drops
 * the system prompt capability; FAKE_ACP_AUTH=1 makes `session/new` ask for authentication.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';

import type { McpServer, SessionUpdate } from '@agentclientprotocol/sdk/unstable';

interface FakeSession {
    cwd: string;
    mcpServers: McpServer[];
    systemPrompt?: string;
    model: string;
    cancel: AbortController;
    count: number;
    cost: number;
}

const sessions = new Map<string, FakeSession>();
let counter = 0;
const resumeMode = process.env.FAKE_ACP_RESUME ?? 'resume';

function systemText(content: unknown): string | undefined {
    return Array.isArray(content) ? content.map(block => (block as { text?: string }).text ?? '').join('') : undefined;
}

function open(id: string, params: { cwd: string; mcpServers?: McpServer[]; systemPrompt?: { content?: unknown } | null }): FakeSession {
    const session: FakeSession = { cwd: params.cwd, mcpServers: params.mcpServers ?? [], systemPrompt: systemText(params.systemPrompt?.content), model: 'fast', cancel: new AbortController(), count: 0, cost: 0 };

    sessions.set(id, session);

    return session;
}

const modelOptions = (current: string) => [{
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select' as const,
    currentValue: current,
    options: [{ value: 'fast', name: 'Fast' }, { value: 'smart', name: 'Smart' }],
}];

const app = agent({ name: 'fake-acp-agent' })
    .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'fake-acp-agent', version: '1.0.0' },
        agentCapabilities: {
            loadSession: resumeMode === 'load',
            sessionCapabilities: {
                ...(resumeMode === 'resume' && { resume: {} }),
                ...(process.env.FAKE_ACP_SYSTEM_PROMPT !== '0' && { systemPrompt: {} }),
            },
        },
    }))
    .onRequest(methods.agent.session.new, ({ params }) => {
        if (process.env.FAKE_ACP_AUTH === '1') {
            throw new RequestError(-32000, 'Authentication required');
        }

        const id = `fake-${ ++counter }`;

        open(id, params);

        return { sessionId: id, configOptions: modelOptions('fast') };
    })
    .onRequest(methods.agent.session.resume, ({ params }) => {
        open(params.sessionId, params);

        return { configOptions: modelOptions('fast') };
    })
    .onRequest(methods.agent.session.load, async ({ params, client }) => {
        open(params.sessionId, params);

        for (const text of ['replayed one', 'replayed two']) {
            await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
        }

        return { configOptions: modelOptions('fast') };
    })
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
        const session = sessions.get(params.sessionId);

        if (session && 'value' in params && typeof params.value === 'string') {
            session.model = params.value;
        }

        return { configOptions: modelOptions(session?.model ?? 'fast') };
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

        for (const line of text.split('\n')) {
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
                    const answer = await client.request(methods.client.session.requestPermission, {
                        sessionId,
                        toolCall: { toolCallId: `p${ ++calls }`, title: 'Run a command' },
                        options: [
                            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
                            { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
                            { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
                        ],
                    });

                    await say(`permission: ${ answer.outcome.outcome === 'selected' ? answer.outcome.optionId : answer.outcome.outcome }`);
                    break;
                }
                case 'usage': {
                    const [input, output, cost] = rest.map(Number);

                    usage = { inputTokens: (usage?.inputTokens ?? 0) + input, outputTokens: (usage?.outputTokens ?? 0) + output, totalTokens: (usage?.totalTokens ?? 0) + input + output };
                    session.cost += cost;
                    await send({ sessionUpdate: 'usage_update', used: input + output, size: 200_000, cost: { amount: session.cost, currency: 'USD' } });
                    break;
                }
                case 'limit': {
                    const [status, resetsAt] = rest;

                    await send({ sessionUpdate: 'usage_update', used: 1, size: 200_000, _meta: { '_claude/rateLimit': { status, rateLimitType: 'five_hour', utilization: 0.95, resetsAt: Number(resetsAt) } } });
                    break;
                }
                case 'info':
                    await say(JSON.stringify({ cwd: session.cwd, servers: session.mcpServers.map(server => server.name), systemPrompt: session.systemPrompt, model: session.model, prompts: session.count }));
                    break;
                case 'prompt':
                    await say(JSON.stringify(text));
                    break;
                case 'env':
                    await say(`${ argument }=${ process.env[argument] ?? '' }`);
                    break;
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

        return { stopReason: 'end_turn' as const, ...(usage && { usage }) };
    });

app.connect(ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
