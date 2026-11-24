import { afterEach, describe, expect, test } from 'bun:test';

import { ToolBridge } from '../src/engine/acp/bridge';
import { runMcpBridge } from '../src/engine/acp/mcp-stdio';
import { tool, until } from './acp-helpers';

const bridge = new ToolBridge();

afterEach(() => bridge.stop());

/** Runs the MCP server over an in-memory pipe: `send` writes a line to it, `received` is what it wrote back. */
function pipe(access: ReturnType<ToolBridge['register']>) {
    const env = Object.fromEntries((access.server?.env ?? []).map(({ name, value }) => [name, value]));
    const lines: string[] = [];
    let push: (line: string) => void = () => undefined;
    let end: () => void = () => undefined;
    const input = (async function* () {
        const queue: string[] = [];
        let wake: (() => void) | undefined;

        push = line => {
            queue.push(line);
            wake?.();
        };
        end = () => push('\u0000end');

        for (;;) {
            while (queue.length === 0) {
                await new Promise<void>(resolve => {
                    wake = resolve;
                });
            }

            const next = queue.shift() as string;

            if (next === '\u0000end') {
                return;
            }

            yield `${next}\n`;
        }
    })();
    const done = runMcpBridge({ input, write: line => void lines.push(line), env, fetch });

    return {
        send: (message: object) => push(JSON.stringify({ jsonrpc: '2.0', ...message })),
        received: () =>
            lines.map(
                line => JSON.parse(line) as { id?: number; result?: any; error?: { code: number; message: string } }
            ),
        finish: async () => {
            end();
            await done;
        },
    };
}

describe('the MCP server an agent starts', () => {
    test('forwards a question as an elicitation and returns the answer', async () => {
        const access = bridge.register([tool('ask_user', async () => 'unused')], new AbortController().signal, true);
        const mcp = pipe(access);
        mcp.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
        mcp.send({
            id: 2,
            method: 'tools/call',
            params: { name: 'ask_user', arguments: { question: 'Choose?', options: [{ id: 'a', label: 'A' }] } },
        });
        await until(() => mcp.received().length === 2, 'elicitation request');
        const request = mcp.received()[1] as any;
        expect(request.method).toBe('elicitation/create');
        expect(JSON.parse(request.params.requestedSchema.properties.clowdy_answer.description).question).toBe(
            'Choose?'
        );
        mcp.send({ id: request.id, result: { action: 'accept', content: { clowdy_answer: 'A' } } });
        await until(() => mcp.received().length === 3, 'tool answer');
        expect(mcp.received()[2].result.content[0].text).toBe('{"answer":"A"}');
        await mcp.finish();
        access.dispose();
    });

    test('ends a pending elicitation when the agent disconnects', async () => {
        const access = bridge.register([tool('ask_user', async () => 'unused')], new AbortController().signal, true);
        const mcp = pipe(access);
        mcp.send({
            id: 1,
            method: 'tools/call',
            params: { name: 'ask_user', arguments: { question: 'Choose?', options: [{ id: 'a', label: 'A' }] } },
        });
        await until(() => mcp.received().length === 1, 'elicitation request');
        await mcp.finish();
        expect(mcp.received()).toHaveLength(2);
        access.dispose();
    });

    test("answers initialize, ping and tools/list with the session's tools", async () => {
        const access = bridge.register(
            [tool('task_list', async () => 'ok'), tool('task_get', async () => 'ok')],
            new AbortController().signal
        );
        const mcp = pipe(access);

        mcp.send({
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
        });
        mcp.send({ method: 'notifications/initialized' });
        mcp.send({ id: 2, method: 'ping' });
        mcp.send({ id: 3, method: 'tools/list' });
        await until(() => mcp.received().length === 3, 'three answers');
        await mcp.finish();

        const [initialize, ping, list] = mcp.received();

        expect(initialize.result).toMatchObject({
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'clowdy' },
        });
        expect(ping.result).toEqual({});
        expect(list.result.tools.map((entry: { name: string }) => entry.name)).toEqual(['task_list', 'task_get']);
        expect(list.result.tools[0]).toMatchObject({
            description: 'The task_list tool',
            inputSchema: { type: 'object' },
        });
    });

    test('runs a call in the daemon: a result is text, a throw is an error result, an unknown tool says so', async () => {
        const access = bridge.register(
            [
                tool('echo', async input => ({ got: input })),
                tool('nothing', async () => undefined),
                tool('boom', async () => {
                    throw new Error('It broke');
                }),
            ],
            new AbortController().signal
        );
        const mcp = pipe(access);

        mcp.send({ id: 1, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } });
        mcp.send({ id: 2, method: 'tools/call', params: { name: 'nothing' } });
        mcp.send({ id: 3, method: 'tools/call', params: { name: 'boom', arguments: {} } });
        mcp.send({ id: 4, method: 'tools/call', params: { name: 'nope' } });
        mcp.send({ id: 5, method: 'resources/list' });
        await until(() => mcp.received().length === 5, 'five answers');
        await mcp.finish();

        const byId = Object.fromEntries(mcp.received().map(message => [message.id, message]));

        expect(byId[1].result).toEqual({ content: [{ type: 'text', text: '{"got":{"a":1}}' }] });
        expect(byId[2].result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
        expect(byId[3].result).toEqual({ content: [{ type: 'text', text: 'It broke' }], isError: true });
        expect(byId[4].result).toMatchObject({ isError: true, content: [{ text: 'Unknown tool nope' }] });
        expect(byId[5].error).toMatchObject({ code: -32601 });
    });

    test('a cancel notification stops the call that is running', async () => {
        let entered = false;
        let aborted = false;
        const access = bridge.register(
            [
                tool(
                    'slow',
                    (_input, signal) =>
                        new Promise((_resolve, reject) => {
                            entered = true;
                            signal.addEventListener('abort', () => {
                                aborted = true;
                                reject(new Error('stopped'));
                            });
                        })
                ),
            ],
            new AbortController().signal
        );
        const mcp = pipe(access);

        mcp.send({ id: 7, method: 'tools/call', params: { name: 'slow' } });
        await until(() => entered, 'the call to reach the tool');
        mcp.send({ method: 'notifications/cancelled', params: { requestId: 7 } });
        await until(() => aborted, 'the tool to be aborted');
        await mcp.finish();

        expect(mcp.received()).toEqual([]);
    });
});

describe('the bridge listener', () => {
    test("refuses a caller without the session's token, and stops answering when the session ends", async () => {
        const access = bridge.register([tool('echo', async () => 'hi')], new AbortController().signal);
        const url = access.server?.env.find(entry => entry.name === 'CLOWDY_BRIDGE_URL')?.value as string;
        const token = access.server?.env.find(entry => entry.name === 'CLOWDY_BRIDGE_TOKEN')?.value as string;
        const headers = { authorization: `Bearer ${token}` };

        expect((await fetch(`${url}/tools`)).status).toBe(401);
        expect((await fetch(`${url}/tools`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
        expect((await fetch(`${url}/tools`, { headers })).status).toBe(200);

        access.dispose();

        expect((await fetch(`${url}/tools`, { headers })).status).toBe(401);
    });

    test('a call without a usable body is refused as a bad request', async () => {
        const access = bridge.register([tool('echo', async () => 'hi')], new AbortController().signal);
        const url = access.server?.env.find(entry => entry.name === 'CLOWDY_BRIDGE_URL')?.value as string;
        const token = access.server?.env.find(entry => entry.name === 'CLOWDY_BRIDGE_TOKEN')?.value as string;
        const post = (body?: string) =>
            fetch(`${url}/call`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body });

        expect((await post()).status).toBe(400);
        expect((await post('{ nope')).status).toBe(400);
        expect((await post('null')).status).toBe(400);
        expect((await post('{"arguments":{}}')).status).toBe(400);
        expect((await post('{"name":"echo"}')).status).toBe(200);
    });

    test('ending the session also ends a call still in flight', async () => {
        let entered = false;
        let aborted = false;
        const access = bridge.register(
            [
                tool(
                    'slow',
                    (_input, signal) =>
                        new Promise((_resolve, reject) => {
                            entered = true;
                            signal.addEventListener('abort', () => {
                                aborted = true;
                                reject(new Error('session over'));
                            });
                        })
                ),
            ],
            new AbortController().signal
        );
        const url = access.server?.env.find(entry => entry.name === 'CLOWDY_BRIDGE_URL')?.value as string;
        const token = access.server?.env.find(entry => entry.name === 'CLOWDY_BRIDGE_TOKEN')?.value as string;
        const call = fetch(`${url}/call`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body: '{"name":"slow"}',
        });

        await until(() => entered, 'the call to reach the tool');
        access.dispose();

        expect(await (await call).json()).toEqual({ isError: true, text: 'session over' });
        expect(aborted).toBe(true);
    });

    test("the daemon's own abort ends a call in flight", async () => {
        const controller = new AbortController();
        let entered = false;
        let aborted = false;
        const access = bridge.register(
            [
                tool(
                    'slow',
                    (_input, signal) =>
                        new Promise((_resolve, reject) => {
                            entered = true;
                            signal.addEventListener('abort', () => {
                                aborted = true;
                                reject(new Error('run cancelled'));
                            });
                        })
                ),
            ],
            controller.signal
        );
        const mcp = pipe(access);

        mcp.send({ id: 1, method: 'tools/call', params: { name: 'slow' } });
        await until(() => entered, 'the call to reach the tool');
        controller.abort();
        await until(() => mcp.received().length === 1, 'the answer');
        await mcp.finish();

        expect(aborted).toBe(true);
        expect(mcp.received()[0].result).toEqual({ content: [{ type: 'text', text: 'run cancelled' }], isError: true });
    });
});

describe('the shell commands of a session', () => {
    /** A tool that is also a shell command (`ToolDefinition.cli`). */
    const command = (name: string, positional?: string[]) => ({
        ...tool(name, async input => ({ ran: name, input })),
        cli: positional ? { positional } : {},
    });

    test('are left out of the MCP list, listed for the CLI with their positional fields, and run by the same call with the same credential', async () => {
        const access = bridge.register(
            [
                tool('task_list', async () => 'tasks'),
                command('thread_tell', ['thread', 'message']),
                command('thread_list'),
            ],
            new AbortController().signal
        );
        const mcp = pipe(access);

        mcp.send({ id: 1, method: 'tools/list' });
        await until(() => mcp.received().length === 1, 'the MCP list');
        await mcp.finish();

        expect(mcp.received()[0].result.tools.map((entry: { name: string }) => entry.name)).toEqual(['task_list']);

        const { url, auth } = access.cli as { url: string; auth: string };
        const headers = { authorization: `Bearer ${auth}` };

        // The CLI's credential is the session's one token, on the same listener.
        expect(url).toBe(access.server?.env.find(entry => entry.name === 'CLOWDY_BRIDGE_URL')?.value as string);
        expect(auth).toBe(access.server?.env.find(entry => entry.name === 'CLOWDY_BRIDGE_TOKEN')?.value as string);
        expect(await (await fetch(`${url}/cli/tools`, { headers })).json()).toEqual({
            tools: [
                {
                    name: 'thread_tell',
                    description: 'The thread_tell tool',
                    inputSchema: { type: 'object', properties: {} },
                    positional: ['thread', 'message'],
                },
                {
                    name: 'thread_list',
                    description: 'The thread_list tool',
                    inputSchema: { type: 'object', properties: {} },
                    positional: [],
                },
            ],
        });

        const call = async (name: string) =>
            (
                await fetch(`${url}/call`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ name, arguments: { a: 1 } }),
                })
            ).json();

        expect(await call('thread_tell')).toEqual({ isError: false, text: '{"ran":"thread_tell","input":{"a":1}}' });
        expect(await call('task_list')).toEqual({ isError: false, text: 'tasks' });
    });

    test('a session of shell commands only names no MCP server, one without them gets no CLI access, and the CLI listing needs the credential', async () => {
        const commands = bridge.register([command('thread_list')], new AbortController().signal);
        const tools = bridge.register([tool('task_list', async () => 'tasks')], new AbortController().signal);

        expect(commands.server).toBeUndefined();
        expect(commands.cli).toEqual({
            url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
            auth: expect.stringMatching(/^[0-9a-f]{64}$/),
        });
        expect(tools.server).toBeDefined();
        expect(tools.cli).toBeUndefined();

        const { url, auth } = commands.cli as { url: string; auth: string };

        expect((await fetch(`${url}/cli/tools`)).status).toBe(401);
        expect((await fetch(`${url}/cli/tools`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
        expect((await fetch(`${url}/tools`, { headers: { authorization: `Bearer ${auth}` } })).status).toBe(200);
        expect(await (await fetch(`${url}/tools`, { headers: { authorization: `Bearer ${auth}` } })).json()).toEqual({
            tools: [],
        });

        commands.dispose();

        expect((await fetch(`${url}/cli/tools`, { headers: { authorization: `Bearer ${auth}` } })).status).toBe(401);
        expect(
            (
                await fetch(`${url}/call`, {
                    method: 'POST',
                    headers: { authorization: `Bearer ${auth}` },
                    body: '{"name":"thread_list"}',
                })
            ).status
        ).toBe(401);
    });
});
