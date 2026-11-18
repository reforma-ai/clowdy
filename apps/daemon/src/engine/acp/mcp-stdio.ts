/**
 * The MCP server an agent starts to reach the runtime's tools: MCP over stdio (one JSON message per line), with the
 * list and every call forwarded to the daemon's `ToolBridge`. It runs in the agent's process tree, not in the daemon,
 * and only does `initialize`, `ping`, `tools/list` and `tools/call`, which is all a tools-only server needs.
 */

interface Message {
    jsonrpc?: string;
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
}

interface BridgeEnv {
    CLOWDY_BRIDGE_URL?: string;
    CLOWDY_BRIDGE_TOKEN?: string;
}

const FALLBACK_PROTOCOL = '2025-06-18';

export interface McpBridgeIo {
    input: AsyncIterable<string | Uint8Array>;
    write(line: string): void;
    env: BridgeEnv;
    fetch: typeof fetch;
}

/** Serves MCP until `input` ends. */
export async function runMcpBridge(io: McpBridgeIo): Promise<void> {
    const base = io.env.CLOWDY_BRIDGE_URL;
    const headers = { authorization: `Bearer ${ io.env.CLOWDY_BRIDGE_TOKEN }`, 'content-type': 'application/json' };
    const calls = new Map<number | string, AbortController>();
    const send = (message: object) => io.write(`${ JSON.stringify({ jsonrpc: '2.0', ...message }) }\n`);
    const reply = (id: number | string, result: object) => send({ id, result });
    const fail = (id: number | string, code: number, message: string) => send({ id, error: { code, message } });

    async function handle(message: Message): Promise<void> {
        const { id, method, params = {} } = message;

        if (method === 'notifications/cancelled') {
            calls.get(params.requestId as number | string)?.abort();

            return;
        }

        if (id === undefined || method === undefined) {
            return;
        }

        if (!base) {
            fail(id, -32603, 'CLOWDY_BRIDGE_URL is not set');

            return;
        }

        switch (method) {
            case 'initialize':
                reply(id, {
                    protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : FALLBACK_PROTOCOL,
                    capabilities: { tools: {} },
                    serverInfo: { name: 'clowdy', version: '1' },
                });
                break;
            case 'ping':
                reply(id, {});
                break;
            case 'tools/list': {
                const response = await io.fetch(`${ base }/tools`, { headers });

                if (!response.ok) {
                    fail(id, -32603, `The daemon refused the tool list (${ response.status })`);

                    return;
                }

                reply(id, await response.json() as object);
                break;
            }
            case 'tools/call': {
                const controller = new AbortController();

                calls.set(id, controller);

                try {
                    const response = await io.fetch(`${ base }/call`, { method: 'POST', headers, body: JSON.stringify({ name: params.name, arguments: params.arguments }), signal: controller.signal });

                    if (!response.ok) {
                        fail(id, -32603, `The daemon refused the call (${ response.status })`);

                        return;
                    }

                    const { isError, text } = await response.json() as { isError: boolean; text: string };

                    reply(id, { content: [{ type: 'text', text }], ...(isError && { isError: true }) });
                }
                catch (error) {
                    if (!controller.signal.aborted) {
                        reply(id, { content: [{ type: 'text', text: `The daemon could not be reached: ${ (error as Error).message }` }], isError: true });
                    }
                }
                finally {
                    calls.delete(id);
                }

                break;
            }
            default:
                fail(id, -32601, `Method not found: ${ method }`);
        }
    }

    const decoder = new TextDecoder();
    let buffer = '';
    const pending = new Set<Promise<void>>();

    for await (const chunk of io.input) {
        buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });

        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
            const line = buffer.slice(0, end).trim();

            buffer = buffer.slice(end + 1);

            if (!line) {
                continue;
            }

            let message: Message;

            try {
                message = JSON.parse(line) as Message;
            }
            catch {
                continue;
            }

            const task = handle(message).catch(error => message.id !== undefined && fail(message.id, -32603, (error as Error).message)).then(() => undefined).finally(() => pending.delete(task));

            pending.add(task);
        }
    }

    await Promise.allSettled(pending);
}

if (import.meta.main) {
    await runMcpBridge({
        input: process.stdin,
        write: line => void process.stdout.write(line),
        env: process.env as BridgeEnv,
        fetch,
    });
}
