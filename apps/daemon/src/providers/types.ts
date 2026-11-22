import type { AgentAccount, AgentModels, AgentUsage, SignInStatus } from '@clowdy/protocol';
import type { AgentSpec } from '../engine/acp/catalog';

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
}
