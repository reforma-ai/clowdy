import { runProgram } from './exec';

import type { AgentAccount, AgentUsage, AgentUsageWindow } from '@clowdy/protocol';
import type { ProbeContext, Provider, ProviderRead, SignInRead } from './types';

const STATUS_TIMEOUT_MS = 15_000;
const USAGE_TIMEOUT_MS = 40_000;

/** The plan as a badge: `max` is `Max`, `team` is `Team`. */
export function planLabel(plan: string | null | undefined): string | undefined {
    if (!plan) {
        return undefined;
    }

    return plan
        .split(/[_\s-]+/)
        .filter(Boolean)
        .map(word => word[0]!.toUpperCase() + word.slice(1))
        .join(' ');
}

/** The first JSON object in a program's output, which may have a line or two around it. */
export function jsonObject(text: string): Record<string, unknown> | undefined {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');

    if (start < 0 || end < start) {
        return undefined;
    }

    try {
        const value: unknown = JSON.parse(text.slice(start, end + 1));

        return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    }
    catch {
        return undefined;
    }
}

const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * What `claude auth status --json` says: `loggedIn`, `authMethod` (`claude.ai`, `oauth_token`, `api_key`, `api_key_helper`,
 * `third_party`, `none`), `email`, `orgName`, `subscriptionType`. It exits 1 when nobody is signed in, and still prints JSON.
 */
export function parseClaudeStatus(output: { stdout: string; stderr: string; error?: string; timedOut: boolean }): SignInRead {
    if (output.error) {
        return { status: 'unknown', detail: `Could not start Claude Code: ${ output.error }` };
    }

    if (output.timedOut) {
        return { status: 'unknown', detail: 'Claude Code did not say who is signed in in time' };
    }

    const status = jsonObject(output.stdout);

    if (!status || typeof status.loggedIn !== 'boolean') {
        const line = (output.stderr || output.stdout).split('\n').map(part => part.trim()).find(Boolean);

        return { status: 'unknown', detail: line ? `Claude Code answered: ${ line.slice(0, 160) }` : 'Claude Code did not answer with its status' };
    }

    if (!status.loggedIn) {
        return { status: 'signed-out' };
    }

    const authMethod = text(status.authMethod);
    const method: AgentAccount['method'] = authMethod === 'claude.ai' ? 'subscription' : authMethod === 'api_key' || authMethod === 'api_key_helper' ? 'api-key' : 'other';
    const plan = method === 'subscription' ? planLabel(text(status.subscriptionType)) : undefined;
    const account: AgentAccount = {
        method,
        ...(text(status.email) && { email: text(status.email) }),
        // A personal account is "<email>'s Organization": no news to a person.
        ...(text(status.orgName) && !/'s organization$/i.test(text(status.orgName)!) && { organization: text(status.orgName) }),
        ...(plan && { plan }),
    };

    return {
        status: 'signed-in',
        account,
        ...(method === 'api-key' && { detail: 'Signed in with an API key' }),
    };
}

interface LimitRow {
    kind?: unknown;
    group?: unknown;
    percent?: unknown;
    resets_at?: unknown;
    scope?: { model?: { display_name?: unknown } | null } | null;
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The rows of a `usage_report` (`rate_limits.limits`) as windows. The server's rows are the truth; a kind this code does not know is shown under its own name. */
export function claudeWindows(limits: unknown): AgentUsageWindow[] {
    if (!Array.isArray(limits)) {
        return [];
    }

    const windows: AgentUsageWindow[] = [];

    for (const row of limits as LimitRow[]) {
        if (typeof row?.percent !== 'number' || !Number.isFinite(row.percent)) {
            continue;
        }

        const model = text(row.scope?.model?.display_name);
        const kind = text(row.kind) ?? 'limit';
        // The server's reset times drift by a few hundred milliseconds from read to read: to the minute, so an unchanged window reads as unchanged.
        const resetsAt = typeof row.resets_at === 'string' ? Math.round(Date.parse(row.resets_at) / 60_000) * 60_000 : Number.NaN;
        const base = kind === 'session' ? { id: 'session', label: '5h' }
            : kind === 'weekly_all' ? { id: 'weekly', label: '7d' }
                : model ? { id: `weekly:${ slug(model) }`, label: `7d · ${ model }` }
                    : { id: kind, label: kind.replace(/_/g, ' ') };

        windows.push({ ...base, usedPercent: Math.min(100, Math.max(0, row.percent)), ...(Number.isFinite(resetsAt) && { resetsAt }) });
    }

    return windows;
}

/** The lines of `claude -p "/usage" --output-format stream-json`: the report rides on the assistant line of the command. */
export function parseClaudeUsage(stdout: string): AgentUsage {
    let reportLimits: unknown;
    let message = '';

    for (const line of stdout.split('\n')) {
        const object = line.trim().startsWith('{') ? jsonObject(line) : undefined;

        if (object?.type !== 'assistant') {
            continue;
        }

        const report = object.usage_report as { rate_limits?: { limits?: unknown } | null } | undefined;

        reportLimits ??= report?.rate_limits?.limits;

        const content = (object.message as { content?: unknown } | undefined)?.content;

        if (Array.isArray(content)) {
            message += content.map(part => text((part as { text?: unknown })?.text) ?? '').join('\n');
        }
    }

    const windows = claudeWindows(reportLimits);

    if (windows.length > 0) {
        return { state: 'ok', windows };
    }

    // An older Claude Code prints the numbers only as text: `Current week (Fable): 0% used`. No reset time survives that.
    const fromText: AgentUsageWindow[] = [];

    for (const match of message.matchAll(/^\s*Current (session|week)(?: \(([^)]*)\))?:\s*(\d+(?:\.\d+)?)% used/gim)) {
        const [, kind, scope, percent] = match;
        const used = Number(percent);

        if (kind!.toLowerCase() === 'session') {
            fromText.push({ id: 'session', label: '5h', usedPercent: used });
        }
        else if (!scope || /all models/i.test(scope)) {
            fromText.push({ id: 'weekly', label: '7d', usedPercent: used });
        }
        else {
            fromText.push({ id: `weekly:${ slug(scope) }`, label: `7d · ${ scope }`, usedPercent: used });
        }
    }

    if (fromText.length > 0) {
        return { state: 'ok', windows: fromText };
    }

    const reason = message.split('\n').map(part => part.trim()).find(part => /rate limited|try again|unavailable/i.test(part));

    return { state: 'error', windows: [], detail: reason ?? 'Claude Code did not report its limits' };
}

async function readUsage(context: ProbeContext): Promise<AgentUsage> {
    // The command is local: no model is called. Hooks are off and nothing is saved, so a read leaves no trace in the user's sessions.
    const run = await runProgram(context.program, ['-p', '/usage', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--settings', '{"disableAllHooks":true}'], {
        env: context.env,
        cwd: context.cwd,
        timeoutMs: USAGE_TIMEOUT_MS,
    });

    if (run.error || run.timedOut) {
        return { state: 'error', windows: [], detail: run.error ? `Could not start Claude Code: ${ run.error }` : 'Claude Code did not report its limits in time' };
    }

    return parseClaudeUsage(run.stdout);
}

export const claude: Provider = {
    id: 'claude',
    login: { args: ['auth', 'login', '--claudeai'] },
    async read(context): Promise<ProviderRead> {
        const status = await runProgram(context.program, ['auth', 'status', '--json'], { env: context.env, cwd: context.cwd, timeoutMs: STATUS_TIMEOUT_MS });
        const signIn = parseClaudeStatus(status);

        if (signIn.status !== 'signed-in') {
            return { signIn, usage: { state: 'unavailable', windows: [] } };
        }

        if (signIn.account?.method !== 'subscription') {
            return { signIn, usage: { state: 'unavailable', windows: [], detail: 'There are no plan limits: Claude Code is not signed in with a subscription' } };
        }

        const usage = await readUsage(context);

        return { signIn, usage: usage.state === 'ok' ? { ...usage, fetchedAt: context.now() } : usage };
    },
};
