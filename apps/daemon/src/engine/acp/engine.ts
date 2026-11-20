import { AcpSession } from './session';

import type { Shim } from '../../cli/shim';
import type { AgentEngine, EngineSession, EngineStartOptions } from '../types';
import type { ToolBridge } from './bridge';
import type { AgentRegistry } from './registry';
import type { PermissionPolicy } from './session';

export interface AcpEngineDeps {
    registry: AgentRegistry;
    bridge: ToolBridge;
    /** Where the `clowdy` command is; see `SessionDeps.shim`. */
    shim?: Shim;
    /** The environment agents are built from; the daemon's own by default. */
    env?: Record<string, string | undefined>;
    permissions?: PermissionPolicy;
    clientVersion?: string;
    /** How long to wait for an agent's answer to `initialize`; see `SessionDeps`. */
    initializeTimeoutMs?: number;
    /** How long an agent that has not named its session by the end of the turn keeps running for the name; see `SessionDeps`. */
    titleWaitMs?: number;
    /** How long a session with nothing open waits for the agent to begin a turn before it ends; see `SessionDeps`. */
    backgroundHandoffMs?: number;
    /** How long it waits for the report of work that just ended; see `SessionDeps`. */
    backgroundReportMs?: number;
    debug?: boolean;
}

/** Runs one agent, by id, through ACP. The agent is found and started when a run starts, so one installed later works without a restart. */
export class AcpEngine implements AgentEngine {
    /** What each session has cost so far, by session id: agents report running totals, the runtime wants each turn's share. */
    private costs = new Map<string, number>();
    /** The launches that were asked for ACP v2 and speak v1; every session of this agent shares it (see `SessionDeps.downgraded`). */
    private downgraded = new Set<string>();

    constructor(readonly id: string, private deps: AcpEngineDeps) {}

    start(options: EngineStartOptions): EngineSession {
        const { deps } = this;

        return new AcpSession(options, {
            agentId: this.id,
            registry: deps.registry,
            bridge: deps.bridge,
            shim: deps.shim,
            env: deps.env ?? process.env,
            permissions: deps.permissions ?? 'allow',
            costs: this.costs,
            downgraded: this.downgraded,
            clientVersion: deps.clientVersion ?? '0.0.0',
            initializeTimeoutMs: deps.initializeTimeoutMs,
            titleWaitMs: deps.titleWaitMs,
            backgroundHandoffMs: deps.backgroundHandoffMs,
            backgroundReportMs: deps.backgroundReportMs,
            log: deps.debug ? line => console.debug(`[clowdy] ${ this.id }: ${ line }`) : undefined,
        });
    }
}
