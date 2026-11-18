import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk/unstable';
import { Readable, Writable } from 'node:stream';
import { z } from 'zod';

import { errorMessage } from '../../errors';
import { spawnInOwnGroup } from '../process';
import { buildAgentEnv } from './env';

import type { AgentCapabilities } from '@agentclientprotocol/sdk/unstable';
import type { ToolBridge } from './bridge';
import type { AgentRegistry } from './registry';

/** What an agent said when Clowdy started it and opened a session, without sending a prompt (so without calling a model). */
export interface Probe {
    id: string;
    command: string;
    startedInMs: number;
    protocolVersion: number;
    agentInfo?: { name: string; version?: string };
    capabilities: AgentCapabilities;
    authMethods: string[];
    sessionId: string;
    modes: string[];
    options: string[];
}

export interface ProbeOptions {
    cwd: string;
    /** How long the agent has to answer each request. */
    timeoutMs?: number;
    env?: Record<string, string | undefined>;
}

/**
 * Starts an agent the way a run does, performs `initialize` and `session/new` with the runtime's tool bridge in
 * `mcpServers`, and stops it. Shows whether the agent speaks ACP, which capabilities it has, and that it accepts the bridge.
 * Rejects with a message that says what failed, with the end of the agent's stderr.
 */
export async function probeAgent(registry: AgentRegistry, bridge: ToolBridge, id: string, { cwd, timeoutMs = 120_000, env = process.env }: ProbeOptions): Promise<Probe> {
    const resolution = await registry.resolve(id);

    if (!resolution.ok) {
        throw new Error(resolution.message);
    }

    const { agent } = resolution;

    const started = Date.now();
    const proc = await spawnInOwnGroup({ command: agent.command, args: agent.args, cwd, env: buildAgentEnv({ daemonEnv: env, path: await registry.path(), scrub: agent.scrub, set: agent.env }) });
    const connection = client({ name: 'clowdy-probe' }).connect(ndJsonStream(Writable.toWeb(proc.child.stdin as Writable) as WritableStream<Uint8Array>, Readable.toWeb(proc.child.stdout as Readable) as ReadableStream<Uint8Array>));
    const access = bridge.register([{ name: 'probe', description: 'A tool that does nothing.', inputSchema: { type: 'object', properties: {} }, schema: z.object({}), execute: async () => 'ok' }], new AbortController().signal);
    const within = <T>(call: Promise<T>): Promise<T> => {
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`no answer in ${ timeoutMs / 1000 } s`)), timeoutMs);
        });
        const exited = proc.exited.then(() => Promise.reject(new Error('the agent exited')));

        return Promise.race([call, timeout, exited]).finally(() => clearTimeout(timer));
    };

    try {
        const init = await within(connection.agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: 'clowdy', title: 'Clowdy', version: '0' },
        }));
        const startedInMs = Date.now() - started;
        const session = await within(connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [access.server] }));

        return {
            id,
            command: [agent.command, ...agent.args].join(' '),
            startedInMs,
            protocolVersion: init.protocolVersion,
            ...(init.agentInfo && { agentInfo: { name: init.agentInfo.name, ...(init.agentInfo.version && { version: init.agentInfo.version }) } }),
            capabilities: init.agentCapabilities ?? {},
            authMethods: (init.authMethods ?? []).map(method => method.id),
            sessionId: session.sessionId,
            modes: (session.modes?.availableModes ?? []).map(mode => mode.id),
            options: (session.configOptions ?? []).map(option => `${ option.id }${ option.category ? ` (${ option.category })` : '' }`),
        };
    }
    catch (error) {
        const tail = proc.stderr().trim().slice(-500);

        throw new Error(`${ errorMessage(error) }${ tail ? `\nThe agent wrote: ${ tail }` : '' }`);
    }
    finally {
        access.dispose();
        connection.close();
        proc.stop();
        await proc.exited;
    }
}
