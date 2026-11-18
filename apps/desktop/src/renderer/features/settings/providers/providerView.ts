import type { AgentInfo, AgentSignInSession, AgentUsageWindow } from '@clowdy/protocol';

/** The agents the page has a card for, in this order. Others the daemon knows are not shown yet. */
export const PROVIDER_IDS = ['claude', 'codex', 'cursor'] as const;

/** The agents that have a card, in the card order. */
export function providerAgents(agents: readonly AgentInfo[]): AgentInfo[] {
    return PROVIDER_IDS.flatMap(id => agents.find(agent => agent.id === id) ?? []);
}

/** A provider the person can use now: switched on in Clowdy and installed. The window header shows only these. */
export function isUsableProvider(agent: AgentInfo): boolean {
    return agent.enabled && agent.status === 'ready';
}

/** From this used percent a bar and a badge turn to the warning tone, and from the next one to the danger tone. */
export const USAGE_WARNING_PERCENT = 80;
export const USAGE_DANGER_PERCENT = 90;

export type UsageTone = 'normal' | 'warning' | 'danger';

/** How much of a window is used, as the whole percent a bar and a badge show: rounded, and kept between 0 and 100. Something that is not a number is no usage. */
export function windowPercent(window: AgentUsageWindow): number {
    return Number.isNaN(window.usedPercent) ? 0 : Math.min(100, Math.max(0, Math.round(window.usedPercent)));
}

/** The tone of a used percent, the same on the Providers page and in the window header. */
export function usageTone(percent: number): UsageTone {
    if (percent >= USAGE_DANGER_PERCENT) return 'danger';

    return percent >= USAGE_WARNING_PERCENT ? 'warning' : 'normal';
}

/**
 * Whether a window is one model's limit, not the plan's: Claude's `weekly:fable` (`Fable`) and Codex's `spark:secondary`.
 * The plan's own windows have no `:` in their id (`session`, `weekly`, `plan`), except Codex's, which are named after its main
 * limit, `codex:primary` and `codex:secondary`: an id that starts with the agent's own id.
 */
function isScopedWindow(agent: AgentInfo, window: AgentUsageWindow): boolean {
    return window.id.includes(':') && !window.id.startsWith(`${ agent.id }:`);
}

/**
 * The window a provider is summed up by: its nearest limit, the first of the plan's own windows (not a scoped one, see `isScopedWindow`).
 * The daemon lists a plan's windows shortest first, so this is the session of Claude and the 5-hour window of Codex, shown whatever its
 * percent: a session at zero is still the limit that comes next, and a weekly one that happens to be fuller is not.
 * One model's limit says little about the plan, so a scoped window is left out.
 * Nothing when there is no reading to trust: the usage is not `ok` (a failed read keeps the last windows, which are not
 * news), nobody is signed in, or it has no window of the plan.
 */
export function headlineWindow(agent: AgentInfo): AgentUsageWindow | undefined {
    if (agent.usage?.state !== 'ok' || agent.signIn?.status === 'signed-out') return undefined;

    return agent.usage.windows.find(window => !isScopedWindow(agent, window));
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
