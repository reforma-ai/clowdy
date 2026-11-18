import type { AgentAccount, AgentUsage, SignInStatus } from '@clowdy/protocol';

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

/** How the daemon talks to one provider. */
export interface Provider {
    id: string;
    /** Who is signed in and how much of the plan is used. Never throws: a failure is a status and a detail. */
    read(context: ProbeContext): Promise<ProviderRead>;
    /** The vendor's login, run for the person; the program is the agent's own. */
    login?: { args: string[] };
}
