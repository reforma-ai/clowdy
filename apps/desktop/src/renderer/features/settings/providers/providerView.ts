import type { AgentInfo, AgentSignInSession } from '@clowdy/protocol';

/** The agents the page has a card for, in this order. Others the daemon knows are not shown yet. */
export const PROVIDER_IDS = ['claude', 'codex', 'cursor'] as const;

/** The agents that have a card, in the card order. */
export function providerAgents(agents: readonly AgentInfo[]): AgentInfo[] {
    return PROVIDER_IDS.flatMap(id => agents.find(agent => agent.id === id) ?? []);
}

/** What the line under a card's title says: who is signed in, or why there is nobody to show. */
export interface AccountLine {
    text: string;
    /** The plan badge, for an account. */
    plan?: string;
    tone: 'default' | 'muted' | 'warning';
    /** A second, muted line: why, or what to do. */
    detail?: string;
}

/** Who is signed in to `agent`, or what is wrong, as one line for a person. */
export function accountLine(agent: AgentInfo): AccountLine {
    if (agent.status === 'missing') {
        return { text: 'Not installed', tone: 'warning', detail: agent.detail };
    }

    if (agent.status === 'needs-runtime') {
        return { text: 'Needs Bun to start', tone: 'warning', detail: agent.detail };
    }

    const { signIn } = agent;

    if (signIn?.status === 'signed-in') {
        const { account } = signIn;
        const text = account?.email ?? account?.name ?? (account?.method === 'api-key' ? 'Signed in with an API key' : 'Signed in');

        return { text, plan: account?.plan, tone: 'default', detail: signIn.detail };
    }

    if (agent.status === 'disabled') {
        return { text: 'Turned off in Clowdy', tone: 'muted' };
    }

    if (!signIn) {
        return { text: 'Checking who is signed in…', tone: 'muted' };
    }

    if (signIn.status === 'signed-out') {
        return { text: 'Not signed in', tone: 'warning', detail: signIn.detail };
    }

    return { text: 'Could not tell who is signed in', tone: 'muted', detail: signIn.detail };
}

/** A sign-in the daemon is still running. */
export function isSignInRunning(session: AgentSignInSession | undefined): session is AgentSignInSession & { step: 'starting' | 'waiting' } {
    return session?.step === 'starting' || session?.step === 'waiting';
}

/** The environment as the editor shows it: `KEY=VALUE`, one per line, in key order. */
export function formatEnv(env: Record<string, string>): string {
    return Object.entries(env).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${ key }=${ value }`).join('\n');
}

export type ParsedEnv = { ok: true; env: Record<string, string> } | { ok: false; message: string };

/** `KEY=VALUE` lines to an environment. Blank lines and `#` comments are skipped; the value is everything after the first `=`. */
export function parseEnv(text: string): ParsedEnv {
    const env: Record<string, string> = {};
    const lines = text.split(/\r?\n/);

    for (const [index, raw] of lines.entries()) {
        const line = raw.trim();

        if (!line || line.startsWith('#')) continue;

        const equals = line.indexOf('=');
        const key = equals === -1 ? '' : line.slice(0, equals).trim();

        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            return { ok: false, message: `Line ${ index + 1 } is not KEY=VALUE` };
        }

        env[key] = line.slice(equals + 1).trim();
    }

    return { ok: true, env };
}
