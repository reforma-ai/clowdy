import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { createToolServer, MCP_SERVER, mcpToolName, runtimeToolName } from '../src/engine/claude/tools';

import type { ToolDefinition } from '../src/engine/types';

function define(name: string, schema: z.ZodType, execute: ToolDefinition['execute']): ToolDefinition {
    return { name, description: `The ${ name } tool`, inputSchema: z.toJSONSchema(schema) as Record<string, unknown>, schema, execute };
}

/** Connects a real MCP client to the server the session would hand the SDK, the way the `claude` process does. */
async function connect(definitions: ToolDefinition[], signal = new AbortController().signal) {
    const server = createToolServer(definitions, signal);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });

    await server.instance.connect(serverSide);
    await client.connect(clientSide);

    return { server, client };
}

const echo = define('echo', z.object({ text: z.string().describe('What to repeat'), times: z.number().optional() }), async input => ({ echoed: (input as { text: string }).text }));

describe('the in-process MCP bridge', () => {
    test('the runtime\'s tools are a server called "clowdy" and the model sees them as mcp__clowdy__<name>', async () => {
        const { server, client } = await connect([echo]);
        const { tools } = await client.listTools();

        expect(server.name).toBe(MCP_SERVER);
        expect(tools.map(tool => [tool.name, tool.description])).toEqual([['echo', 'The echo tool']]);
        expect(mcpToolName('echo')).toBe('mcp__clowdy__echo');
        expect(runtimeToolName('mcp__clowdy__echo')).toBe('echo');
        expect(runtimeToolName('Bash')).toBe('Bash');
    });

    test('the zod schema of each tool reaches the model as its input schema', async () => {
        const { client } = await connect([echo]);
        const { tools } = await client.listTools();

        expect(tools[0].inputSchema).toMatchObject({ type: 'object', required: ['text'], properties: { text: { type: 'string', description: 'What to repeat' }, times: { type: 'number' } } });
    });

    test('a result goes to the model as text: strings as they are, anything else as JSON', async () => {
        const { client } = await connect([echo, define('plain', z.object({}), async () => 'just words'), define('nothing', z.object({}), async () => undefined)]);

        expect(await client.callTool({ name: 'echo', arguments: { text: 'hi' } })).toEqual({ content: [{ type: 'text', text: '{"echoed":"hi"}' }] });
        expect(await client.callTool({ name: 'plain', arguments: {} })).toEqual({ content: [{ type: 'text', text: 'just words' }] });
        expect(await client.callTool({ name: 'nothing', arguments: {} })).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    });

    test('a failing tool is an error result the model can read', async () => {
        const failing = define('fail', z.object({}), async () => {
            throw new Error('Task CLW-9 does not exist');
        });
        const { client } = await connect([failing]);

        expect(await client.callTool({ name: 'fail', arguments: {} })).toEqual({ content: [{ type: 'text', text: 'Task CLW-9 does not exist' }], isError: true });
    });

    test('input that does not fit the schema is refused with an error result', async () => {
        const { client } = await connect([echo]);
        const response = await client.callTool({ name: 'echo', arguments: { text: 42 } });

        expect(response.isError).toBe(true);
    });

    test('the tool runs with the session\'s signal, so a cancelled run can stop it', async () => {
        const controller = new AbortController();
        let seen: AbortSignal | undefined;
        const { client } = await connect([define('watch', z.object({}), async (_input, signal) => {
            seen = signal;

            return 'ok';
        })], controller.signal);

        await client.callTool({ name: 'watch', arguments: {} });
        controller.abort();

        expect(seen?.aborted).toBe(true);
    });

    test('a tool whose input is not an object cannot be exposed', () => {
        expect(() => createToolServer([define('bad', z.string(), async () => 'x')], new AbortController().signal)).toThrow(/object schema/);
    });
});
