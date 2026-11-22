import { randomBytes } from 'node:crypto';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { errorMessage } from '../../errors';

import type { McpServerStdio } from '@agentclientprotocol/sdk/unstable';
import type { ToolDefinition } from '../types';

/** The name the runtime's tools go by in an agent's tool list. */
export const BRIDGE_SERVER_NAME = 'clowdy';

/**
 * The program an agent starts as an MCP server: it speaks MCP on stdio and forwards every call to the daemon (`mcp-stdio.ts`).
 * It sits beside the module that runs this line: `mcp-stdio.ts` next to this file in the sources, `mcp-stdio.js` next to
 * `main.js` in a bundle (`scripts/bundle.ts`), so its extension is this module's.
 */
const MCP_ENTRY = fileURLToPath(new URL(`./mcp-stdio${ extname(fileURLToPath(import.meta.url)) }`, import.meta.url));

interface Registration {
    tools: Map<string, ToolDefinition>;
    signal: AbortSignal;
}

/** What the model reads of a tool's result: strings as they are, no result as "ok", anything else as JSON. */
function resultText(result: unknown): string {
    if (result === undefined) {
        return 'ok';
    }

    return typeof result === 'string' ? result : JSON.stringify(result);
}

/** Where the `clowdy` command of one session reaches its tools: the listener and the session's credential, which the agent process gets in its environment. */
export interface CliAccess {
    url: string;
    auth: string;
}

/** What `register` hands back: the MCP server entry for `session/new`, the CLI's way in, and the end of this session's access. */
export interface BridgeAccess {
    /** Absent when every tool of the session is a shell command: then there is no MCP server to name. */
    server?: McpServerStdio;
    /** Absent when the session has no shell command. */
    cli?: CliAccess;
    dispose(): void;
}

/** A tool as `GET /cli/tools` lists it for the `clowdy` command (`cli/args.ts` reads it). */
const cliEntry = ({ name, description, inputSchema, cli }: ToolDefinition) => ({ name, description, inputSchema, positional: [...cli?.positional ?? []], ...(cli?.stdin && { stdin: cli.stdin }) });

/**
 * How an agent calls the runtime's tools. ACP has no way to register a tool, only to name MCP servers, and stdio is the
 * one transport every agent must support. So the agent starts a small MCP server (`mcp-stdio.ts`) that calls back here,
 * over a loopback listener, with a token that belongs to one session and stops working when the session ends.
 *
 * A tool marked as a shell command (`ToolDefinition.cli`) is not an MCP tool: the agent runs `clowdy <group> <command>` in its shell (`cli/clowdy.ts`),
 * which lists those tools at `GET /cli/tools` and calls them at `POST /call`, with the same token, given to the agent process as `CLOWDY_CLI_AUTH`.
 */
export class ToolBridge {
    private server?: ReturnType<typeof Bun.serve>;
    private registrations = new Map<string, Registration>();

    /** Gives `tools` to one session. `signal` ends every call still running for it. */
    register(tools: ToolDefinition[], signal: AbortSignal): BridgeAccess {
        const token = randomBytes(32).toString('hex');
        const url = `http://127.0.0.1:${ this.listener().port }`;
        const ended = new AbortController();

        this.registrations.set(token, { tools: new Map(tools.map(tool => [tool.name, tool])), signal: AbortSignal.any([signal, ended.signal]) });

        return {
            ...(tools.some(tool => !tool.cli) && {
                server: {
                    name: BRIDGE_SERVER_NAME,
                    command: process.execPath,
                    args: [MCP_ENTRY],
                    env: [
                        { name: 'CLOWDY_BRIDGE_URL', value: url },
                        { name: 'CLOWDY_BRIDGE_TOKEN', value: token },
                    ],
                },
            }),
            ...(tools.some(tool => tool.cli) && { cli: { url, auth: token } }),
            // The end of the session also ends the calls it still has running.
            dispose: () => {
                ended.abort();
                this.registrations.delete(token);
            },
        };
    }

    stop(): void {
        void this.server?.stop(true);
        this.server = undefined;
        this.registrations.clear();
    }

    private listener(): ReturnType<typeof Bun.serve> {
        // A call can wait on a person (`ask_user`) for as long as they take, so the connection has no idle timeout.
        this.server ??= Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: request => this.handle(request) });

        return this.server;
    }

    private async handle(request: Request): Promise<Response> {
        const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
        const registration = token ? this.registrations.get(token) : undefined;

        if (!registration) {
            return new Response('unauthorized', { status: 401 });
        }

        const { pathname } = new URL(request.url);

        // The MCP server lists the model's tools, the CLI its commands; a call runs either.
        if (pathname === '/tools' && request.method === 'GET') {
            return Response.json({ tools: [...registration.tools.values()].filter(tool => !tool.cli).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        }

        if (pathname === '/cli/tools' && request.method === 'GET') {
            return Response.json({ tools: [...registration.tools.values()].filter(tool => tool.cli).map(cliEntry) });
        }

        if (pathname !== '/call' || request.method !== 'POST') {
            return new Response('not found', { status: 404 });
        }

        const body = await request.json().catch(() => undefined) as { name?: unknown; arguments?: unknown } | null | undefined;

        if (typeof body?.name !== 'string') {
            return new Response('a call needs a JSON body with the name of a tool', { status: 400 });
        }

        const tool = registration.tools.get(body.name);

        if (!tool) {
            return Response.json({ isError: true, text: `Unknown tool ${ body.name }` });
        }

        try {
            const result = await tool.execute(body.arguments ?? {}, AbortSignal.any([registration.signal, request.signal]));

            return Response.json({ isError: false, text: resultText(result) });
        }
        catch (error) {
            return Response.json({ isError: true, text: errorMessage(error) });
        }
    }
}
