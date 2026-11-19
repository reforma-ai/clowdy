import { z } from 'zod';

import { ToolBridge } from '../src/engine/acp/bridge';
import { Discovery } from '../src/engine/acp/discovery';
import { AcpEngine } from '../src/engine/acp/engine';
import { AgentRegistry } from '../src/engine/acp/registry';

import type { PermissionPolicy } from '../src/engine/acp/session';
import type { EngineEvent, EngineSession, EngineStartOptions, ToolDefinition } from '../src/engine/types';

export const FAKE_AGENT = new URL('./fake-acp-agent.ts', import.meta.url).pathname;

/** A discovery that never starts a login shell: tests must not depend on the machine's own setup. */
export const quietDiscovery = (env: Record<string, string | undefined> = process.env) => new Discovery({ env, loginPath: async () => undefined });

export interface Rig {
    engine: AcpEngine;
    registry: AgentRegistry;
    bridge: ToolBridge;
    /** Starts a session of the fake agent in `cwd`. */
    start(prompt: string, options?: Partial<EngineStartOptions>): { session: EngineSession; abort: AbortController };
    stop(): void;
}

export interface RigOptions {
    /** Variables the fake agent starts with (its own knobs). */
    agentEnv?: Record<string, string>;
    /** The daemon's environment, from which the agent's is built. */
    env?: Record<string, string | undefined>;
    permissions?: PermissionPolicy;
    command?: string;
    args?: string[];
    initializeTimeoutMs?: number;
    /** How long an agent that has not named its session by the end of the turn keeps running for the name. */
    titleWaitMs?: number;
    /** The options an adapter reads, as the built-in catalog gives them to Claude Code. */
    sessionMeta?: Record<string, unknown>;
    /** What the agent is told it can do in `initialize`, as the built-in catalog gives it to Cursor. */
    clientMeta?: Record<string, unknown>;
}

export function rig(options: RigOptions = {}): Rig {
    const env = options.env ?? process.env;
    const registry = new AgentRegistry({ discovery: quietDiscovery(env) });
    const bridge = new ToolBridge();

    if (options.sessionMeta || options.clientMeta) {
        const resolve = registry.resolve.bind(registry);

        registry.resolve = async (id) => {
            const found = await resolve(id);

            return found.ok ? { ok: true, agent: { ...found.agent, ...(options.sessionMeta && { sessionMeta: options.sessionMeta }), ...(options.clientMeta && { clientMeta: options.clientMeta }) } } : found;
        };
    }

    registry.add({ id: 'fake-acp', name: 'Fake ACP', command: options.command ?? process.execPath, args: options.args ?? [FAKE_AGENT], env: options.agentEnv });

    const engine = new AcpEngine('fake-acp', { registry, bridge, env, permissions: options.permissions, initializeTimeoutMs: options.initializeTimeoutMs, titleWaitMs: options.titleWaitMs });

    return {
        engine,
        registry,
        bridge,
        start(prompt, overrides = {}) {
            const abort = new AbortController();
            const session = engine.start({ cwd: process.cwd(), prompt, tools: [], signal: abort.signal, ...overrides });

            return { session, abort };
        },
        stop: () => bridge.stop(),
    };
}

/** Reads a session's events to its end (`done`, `error`, or the end of the stream). */
export async function collect(session: EngineSession): Promise<EngineEvent[]> {
    const events: EngineEvent[] = [];

    for await (const event of session) {
        events.push(event);

        if (event.type === 'done' || event.type === 'error') {
            break;
        }
    }

    return events;
}

export const types = (events: EngineEvent[]) => events.map(event => event.type);

/** The text of every assistant message, joined. */
export const textOf = (events: EngineEvent[]): string => events.flatMap(event => event.type === 'text' ? [event.delta] : []).join('');

export function tool(name: string, execute: ToolDefinition['execute']): ToolDefinition {
    return { name, description: `The ${ name } tool`, inputSchema: { type: 'object', properties: {} }, schema: z.object({}), execute };
}

/** Whether a process with this id is still there. */
export function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);

        return true;
    }
    catch {
        return false;
    }
}

export async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (!check()) {
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${ what }`);
        }

        await Bun.sleep(10);
    }
}
