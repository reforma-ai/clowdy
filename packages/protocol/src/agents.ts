import type { EngineId } from './domain';

/**
 * Whether the daemon can start an agent now.
 * `ready`: its program is installed and, when it runs through an adapter, so is what fetches the adapter.
 * `missing`: the program is not on this machine. `needs-runtime`: the program is there but the package runner that
 * fetches its adapter (`bun x`) is not. `disabled`: switched off by the user.
 */
export type AgentStatus = 'ready' | 'missing' | 'needs-runtime' | 'disabled';

/** An agent the daemon knows about: a built-in entry, found or not, or one the user added. */
export interface AgentInfo {
    /** The id runs, project settings and `run_spawn` use (`claude`, `cursor`, `my-agent`). */
    id: EngineId;
    name: string;
    /** Added by the user rather than built in. */
    custom: boolean;
    enabled: boolean;
    status: AgentStatus;
    /** For a person: why the agent is not ready and what to install, or a note on how it starts. */
    detail?: string;
    /** The agent's program, as found on this machine. */
    path?: string;
    version?: string;
    /** How the daemon starts it, as a command line: `cursor-agent acp`, `bun x --bun @agentclientprotocol/codex-acp@2.6.0`. */
    launch: string;
    /** The package fetched on first start (an adapter), when there is one. Needs network once. */
    fetches?: string;
    /** The command a person runs in a terminal to sign in; shown when a run fails for lack of a login. */
    login?: string;
}
