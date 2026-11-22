import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runProgram } from '../exec';

import type { AgentAccount, AgentUsage, AgentUsageWindow } from '@clowdy/protocol';
import type { ProbeContext, Provider, ProviderRead } from '../types';

const API = 'https://api2.cursor.sh/aiserver.v1.DashboardService';
const REQUEST_TIMEOUT_MS = 15_000;
const KEYCHAIN_TIMEOUT_MS = 10_000;

/**
 * The folders Cursor's command line keeps its files in, most likely first: the one the person's own `CURSOR_CONFIG_DIR` names
 * (in the read's environment, which has their `env` override of the agent; never the folder a run keeps apart), then the usual ones.
 */
export function cursorConfigDirs({ platform, home, env }: Pick<ProbeContext, 'platform' | 'home' | 'env'>): string[] {
    const own = env.CURSOR_CONFIG_DIR ? [env.CURSOR_CONFIG_DIR] : [];

    if (platform === 'win32') {
        return [...own, ...(env.APPDATA ? [join(env.APPDATA, 'Cursor')] : []), join(home, '.cursor')];
    }

    return [...own, join(home, '.cursor'), join(env.XDG_CONFIG_HOME || join(home, '.config'), 'cursor')];
}

function readJson(path: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(readFileSync(path, 'utf8'));

        return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    }
    catch {
        return undefined;
    }
}

/** Who the command line says is signed in: `cli-config.json` keeps the e-mail and name beside the login, not the token. */
export function readCursorIdentity(context: Pick<ProbeContext, 'platform' | 'home' | 'env'>): { email?: string; name?: string } {
    for (const dir of cursorConfigDirs(context)) {
        const info = readJson(join(dir, 'cli-config.json'))?.authInfo as { email?: unknown; displayName?: unknown } | undefined;
        const email = typeof info?.email === 'string' && info.email ? info.email : undefined;
        const name = typeof info?.displayName === 'string' && info.displayName ? info.displayName : undefined;

        if (email || name) {
            return { ...(email && { email }), ...(name && { name }) };
        }
    }

    return {};
}

/** A token is a run of visible characters. Anything else is not one, and a header built from it would put its value into the error that says why it is refused. */
const TOKEN = /^[\u0021-\u007E]{1,8192}$/;

/**
 * The access token Cursor's command line stored: the macOS Keychain item `cursor-access-token` first, then `auth.json`.
 * It is the one credential the daemon reads for a provider, because Cursor offers no other way to see the plan's usage;
 * it goes to Cursor's own dashboard and nowhere else, and is never kept.
 */
export async function readCursorToken(context: ProbeContext): Promise<string | undefined> {
    if (context.platform === 'darwin') {
        const run = await runProgram('/usr/bin/security', ['find-generic-password', '-s', 'cursor-access-token', '-a', 'cursor-user', '-w'], { env: context.env, cwd: context.cwd, timeoutMs: KEYCHAIN_TIMEOUT_MS, signal: context.signal });
        const token = run.stdout.trim();

        if (run.code === 0 && TOKEN.test(token)) {
            return token;
        }
    }

    for (const dir of cursorConfigDirs(context)) {
        const token = readJson(join(dir, 'auth.json'))?.accessToken;

        if (typeof token === 'string' && TOKEN.test(token)) {
            return token;
        }
    }

    return undefined;
}

class RejectedError extends Error {}

async function dashboard(context: ProbeContext, token: string, method: string): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await context.fetch(`${ API }/${ method }`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${ token }`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'x-cursor-client-type': 'cli',
            'x-cursor-client-version': 'clowdy',
        },
        body: '{}',
        // The token goes to this address and no other: an answer that sends it elsewhere is an error.
        redirect: 'error',
        signal: context.signal ? AbortSignal.any([timeout, context.signal]) : timeout,
    });

    if (response.status === 401 || response.status === 403) {
        throw new RejectedError('Cursor rejected the login: sign in again');
    }

    if (!response.ok) {
        throw new Error(`Cursor answered ${ response.status }`);
    }

    return await response.json() as Record<string, unknown>;
}

const number = (value: unknown): number | undefined => {
    const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
};

/** The dashboard mixes epoch seconds and milliseconds: anything below a trillion is seconds. */
const epochMs = (value: unknown): number | undefined => {
    const parsed = number(value);

    return parsed === undefined ? undefined : parsed < 1e12 ? parsed * 1000 : parsed;
};

/** `GetCurrentPeriodUsage` as windows: the plan's percent used until the billing cycle ends, and on-demand spend when a limit is set. */
export function cursorWindows(usage: Record<string, unknown>): AgentUsageWindow[] {
    const windows: AgentUsageWindow[] = [];
    const resetsAt = epochMs(usage.billingCycleEnd);
    const percent = number((usage.planUsage as { totalPercentUsed?: unknown } | undefined)?.totalPercentUsed);

    if (percent !== undefined) {
        windows.push({ id: 'plan', label: 'Plan usage', usedPercent: Math.min(100, Math.max(0, percent)), ...(resetsAt !== undefined && { resetsAt }) });
    }

    const spend = usage.spendLimitUsage as Record<string, unknown> | undefined;
    const [limit, used] = [number(spend?.individualLimit) ?? 0, number(spend?.individualUsed) ?? 0];
    const [overall, overallUsed] = [number(spend?.overallLimit) ?? 0, number(spend?.overallUsed) ?? 0];
    const [cap, spent] = limit > 0 ? [limit, used] : [overall, overallUsed];

    if (cap > 0) {
        windows.push({ id: 'on-demand', label: 'On-demand', usedPercent: Math.min(100, Math.max(0, spent / cap * 100)), ...(resetsAt !== undefined && { resetsAt }) });
    }

    return windows;
}

/** What the daemon reads of the account Cursor is signed in with, and the vendor's own login. */
export const cursorAccount = {
    login: { args: ['login'] },
    // Each read asks the Keychain for the token, which can ask the person for access: the plan is billed by the month, so not often.
    freshMs: 5 * 60_000,
    async read(context): Promise<ProviderRead> {
        const identity = readCursorIdentity(context);
        const token = await readCursorToken(context);
        const account: AgentAccount = { method: 'subscription', ...(identity.email && { email: identity.email }), ...(identity.name && !identity.email && { name: identity.name }) };

        if (!token && !identity.email && !identity.name) {
            return { signIn: { status: 'signed-out' }, usage: { state: 'unavailable', windows: [] } };
        }

        if (!token) {
            return { signIn: { status: 'signed-in', account }, usage: { state: 'unavailable', windows: [], detail: 'Clowdy could not read the Cursor login, so the limits are not shown' } };
        }

        try {
            const [period, plan] = await Promise.all([dashboard(context, token, 'GetCurrentPeriodUsage'), dashboard(context, token, 'GetPlanInfo').catch(() => undefined)]);
            const planName = (plan?.planInfo as { planName?: unknown } | undefined)?.planName;
            const windows = cursorWindows(period);

            return {
                signIn: { status: 'signed-in', account: { ...account, ...(typeof planName === 'string' && planName.trim() && { plan: planName.trim() }) } },
                usage: windows.length > 0 ? { state: 'ok', windows, fetchedAt: context.now() } : { state: 'unavailable', windows: [], detail: 'Cursor reported no limits for this plan' },
            };
        }
        catch (error) {
            const rejected = error instanceof RejectedError;
            // The token is never part of what a person or a client is told, whatever an error says.
            const detail = (error instanceof Error ? error.message : String(error)).split(token).join('…');

            return {
                signIn: rejected && !identity.email ? { status: 'signed-out', detail: 'The Cursor login has expired' } : { status: 'signed-in', account },
                usage: { state: 'error', windows: [], detail },
            };
        }
    },
} satisfies Pick<Provider, 'login' | 'freshMs' | 'read'>;
