import type { AgentAccount, AgentModels, AgentUsage, PermissionPresetId, SignInStatus } from '@clowdy/protocol';
import type { AgentSpec, SettingEffect } from '../engine/acp/catalog';

/** What a probe needs to look at one agent: the user's program and the environment a run of it would get. */
export interface ProbeContext {
    /** The agent's program as found on this machine. */
    program: string;
    /** The environment a run of the agent starts with, so a probe sees the account a run would use. */
    env: Record<string, string>;
    /** A neutral working folder: a probe must not load the settings of a project. */
    cwd: string;
    fetch: typeof fetch;
    now: () => number;
    platform: NodeJS.Platform;
    home: string;
    /** Fires when the daemon stops: programs a probe started are ended and a read in flight gives up. */
    signal?: AbortSignal;
}

/** The account half of a read, before the service stamps it with the time. */
export interface SignInRead {
    status: SignInStatus;
    account?: AgentAccount;
    detail?: string;
}

/** What one read of a provider found: who is signed in, and the usage when there is a plan to read. */
export interface ProviderRead {
    signIn: SignInRead;
    usage: AgentUsage;
}

/** What choosing a preset does to one agent. */
export interface PermissionPlan {
    /** The value to set on the agent's `mode` config option (category `mode`) when the preset is a mode of the agent. Absent when the agent has no mode for it. */
    mode?: string;
    /** What the agent is started with for the preset: environment, tools it is given or refused, Codex config, the same shape a setting's effect has. */
    effect?: SettingEffect;
    /** What Clowdy does with the agent's permission requests: `ask` puts them to the person, `allow` answers every one with its allow option. */
    answer: 'ask' | 'allow';
}

/**
 * The permission presets a provider can honour and what each does to its agent. The core never branches on an agent id: it reads this. An agent
 * whose provider has no `permissions` gets the generic pair (`providers/permissions.ts`).
 */
export interface PermissionSupport {
    /** In menu order; each with this agent's own words for what the preset does. */
    presets: readonly { id: PermissionPresetId; description: string }[];
    /** The preset the agent runs on when the person has not chosen. */
    default: PermissionPresetId;
    apply(preset: PermissionPresetId): PermissionPlan;
}

/**
 * Everything the daemon knows about one agent and everything it asks of the agent's vendor, in one object in one module (`providers/<id>.ts`, or
 * `providers/<id>/index.ts` when it has parts), named in `PROVIDERS` (`builtin.ts`), the only registration. An agent whose vendor has nothing to
 * ask is just a `spec`; each method is optional, and the daemon does without the ones a provider does not have.
 */
export interface Provider {
    /** What is known of the agent without asking it: what finds it, how it starts, its settings and flags. */
    spec: AgentSpec;
    /** Who is signed in and how much of the plan is used. Never throws: a failure is a status and a detail. */
    read?(context: ProbeContext): Promise<ProviderRead>;
    /** The vendor's login, run for the person; the program is the agent's own. */
    login?: { args: string[] };
    /** How long a read is reused when it did not fail; the service's own default when absent. */
    freshMs?: number;
    /** The models the agent offers on this machine and account. An agent without it has no list Clowdy can read. */
    models?(context: ProbeContext): Promise<AgentModels>;
    /** The permission presets of the agent. Without it the agent offers the generic pair (`ask`, `full`). */
    permissions?: PermissionSupport;
}
