import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { errorMessage } from '../../errors';

import type { ToolDefinition } from '../types';

type CallToolResult = Awaited<ReturnType<Parameters<typeof tool>[3]>>;

/** The in-process MCP server that carries the runtime's tools; the model sees them as `mcp__clowdy__<name>`. */
export const MCP_SERVER = 'clowdy';

const PREFIX = `mcp__${ MCP_SERVER }__`;

export const mcpToolName = (name: string): string => `${ PREFIX }${ name }`;

/** The runtime's own name of a tool (`task_create`); other tools keep the name the engine gave them. */
export const runtimeToolName = (name: string): string => name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;

/** What the model reads of a tool's result: strings as they are, no result as "ok", anything else as JSON. */
function resultText(result: unknown): string {
    if (result === undefined) {
        return 'ok';
    }

    return typeof result === 'string' ? result : JSON.stringify(result);
}

async function callTool(definition: ToolDefinition, input: unknown, signal: AbortSignal): Promise<CallToolResult> {
    try {
        return { content: [{ type: 'text', text: resultText(await definition.execute(input, signal)) }] };
    }
    catch (error) {
        return { content: [{ type: 'text', text: errorMessage(error) }], isError: true };
    }
}

/** Exposes the runtime's tools to a session. Results go to the model as text; a failure becomes an error result with its message. */
export function createToolServer(definitions: ToolDefinition[], signal: AbortSignal) {
    return createSdkMcpServer({
        name: MCP_SERVER,
        tools: definitions.map((definition) => {
            if (!(definition.schema instanceof z.ZodObject)) {
                throw new Error(`The input of tool ${ definition.name } must be an object schema`);
            }

            return tool(definition.name, definition.description, definition.schema.shape, input => callTool(definition, input, signal));
        }),
    });
}
