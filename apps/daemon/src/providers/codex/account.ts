import { withAppServer } from '../appserver';
import { planLabel } from '../parse';

import type { AgentAccount, AgentUsage, AgentUsageWindow } from '@clowdy/protocol';
import type { Provider, ProviderRead, SignInRead } from '../types';

const APP_SERVER_TIMEOUT_MS = 30_000;

/** Codex's plan types as a badge: `plus` is `Plus`, `prolite` is `Pro Lite`, anything business or enterprise is that. */
export function codexPlan(plan: unknown): string | undefined {
    if (typeof plan !== 'string' || !plan || plan === 'unknown') {
        return undefined;
    }

    if (plan === 'prolite') {
        return 'Pro Lite';
    }

    if (plan === 'promax') {
        return 'Pro Max';
    }

    if (plan.startsWith('self_serve_business') || plan === 'business') {
        return 'Business';
    }

    if (plan.startsWith('enterprise') || plan.startsWith('ent')) {
        return 'Enterprise';
    }

    return planLabel(plan);
}

interface AccountResponse {
    account?: { type?: string; email?: string | null; planType?: unknown; workspaceName?: string | null } | null;
    requiresOpenaiAuth?: boolean;
}

/** `account/read`: a ChatGPT login, an API key, another model provider, or nobody. */
export function parseCodexAccount(response: AccountResponse): SignInRead {
    const { account } = response;

    if (!account) {
        return response.requiresOpenaiAuth === false
            ? {
                  status: 'signed-in',
                  account: { method: 'other' },
                  detail: 'Codex uses a model provider that needs no sign-in',
              }
            : { status: 'signed-out' };
    }

    if (account.type === 'chatgpt') {
        const plan = codexPlan(account.planType);
        const result: AgentAccount = {
            method: 'subscription',
            ...(account.email && { email: account.email }),
            ...(account.workspaceName && { organization: account.workspaceName }),
            ...(plan && { plan }),
        };

        return { status: 'signed-in', account: result };
    }

    return account.type === 'apiKey'
        ? { status: 'signed-in', account: { method: 'api-key' }, detail: 'Signed in with an API key' }
        : { status: 'signed-in', account: { method: 'other' } };
}

interface Window {
    usedPercent?: unknown;
    windowDurationMins?: unknown;
    resetsAt?: unknown;
}

interface Snapshot {
    limitId?: string | null;
    limitName?: string | null;
    primary?: Window | null;
    secondary?: Window | null;
}

const SESSION_MINUTES = 5 * 60;
const WEEK_MINUTES = 7 * 24 * 60;

/** 300 minutes is the `Session`, a week is the `Week`: the windows say how long they are, and nothing says which one is which. Another length is told as it is (`1d`, `3h`, `90m`). */
export function windowLabel(minutes: unknown, fallback: string): string {
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
        return fallback;
    }

    if (minutes === SESSION_MINUTES) {
        return 'Session';
    }

    if (minutes === WEEK_MINUTES) {
        return 'Week';
    }

    if (minutes % 1440 === 0) {
        return `${minutes / 1440}d`;
    }

    return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

/** The weekly limit of one model is named for the model, as Claude's is (`Fable`); another window of it says which one it is (`Session (Codex Spark)`). */
function modelWindowLabel(window: string, model: string | undefined): string {
    if (model === undefined) {
        return window;
    }

    return window === 'Week' ? model : `${window} (${model})`;
}

/** `account/rateLimits/read` as windows: the main bucket first, then the buckets of single models. Every window is optional. */
export function codexWindows(response: {
    rateLimits?: Snapshot | null;
    rateLimitsByLimitId?: Record<string, Snapshot> | null;
}): AgentUsageWindow[] {
    const buckets =
        response.rateLimitsByLimitId && Object.keys(response.rateLimitsByLimitId).length > 0
            ? Object.entries(response.rateLimitsByLimitId)
            : response.rateLimits
              ? [[response.rateLimits.limitId ?? 'codex', response.rateLimits] as const]
              : [];
    const ordered = [...buckets].sort(([a], [b]) => (a === 'codex' ? -1 : 0) - (b === 'codex' ? -1 : 0));
    const windows: AgentUsageWindow[] = [];

    for (const [limitId, snapshot] of ordered) {
        const model = limitId === 'codex' ? undefined : (snapshot.limitName ?? limitId);

        for (const [slot, window, fallback] of [
            ['primary', snapshot.primary, 'Session'],
            ['secondary', snapshot.secondary, 'Week'],
        ] as const) {
            if (typeof window?.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) {
                continue;
            }

            windows.push({
                id: `${limitId}:${slot}`,
                label: modelWindowLabel(windowLabel(window.windowDurationMins, fallback), model),
                usedPercent: Math.min(100, Math.max(0, window.usedPercent)),
                ...(typeof window.resetsAt === 'number' && { resetsAt: window.resetsAt * 1000 }),
            });
        }
    }

    return windows;
}

/** What the daemon reads of the account Codex is signed in with, and the vendor's own login. */
export const codexAccount = {
    login: { args: ['login'] },
    async read(context): Promise<ProviderRead> {
        try {
            return await withAppServer(
                context,
                async rpc => {
                    await rpc.call('initialize', {
                        clientInfo: { name: 'clowdy', title: 'Clowdy', version: '0' },
                        capabilities: null,
                    });
                    rpc.notify('initialized');

                    const signIn = parseCodexAccount(
                        (await rpc.call('account/read', { refreshToken: false })) as AccountResponse
                    );

                    if (signIn.account?.method !== 'subscription') {
                        return {
                            signIn,
                            usage:
                                signIn.status === 'signed-in'
                                    ? ({
                                          state: 'unavailable',
                                          windows: [],
                                          detail: 'There are no plan limits: Codex is not signed in with ChatGPT',
                                      } satisfies AgentUsage)
                                    : ({ state: 'unavailable', windows: [] } satisfies AgentUsage),
                        };
                    }

                    try {
                        const windows = codexWindows(
                            (await rpc.call('account/rateLimits/read')) as Parameters<typeof codexWindows>[0]
                        );

                        return {
                            signIn,
                            usage:
                                windows.length > 0
                                    ? { state: 'ok', windows, fetchedAt: context.now() }
                                    : {
                                          state: 'unavailable',
                                          windows: [],
                                          detail: 'Codex reported no limits for this plan',
                                      },
                        };
                    } catch (error) {
                        return {
                            signIn,
                            usage: {
                                state: 'error',
                                windows: [],
                                detail: `Codex could not read its limits: ${error instanceof Error ? error.message : String(error)}`,
                            },
                        };
                    }
                },
                APP_SERVER_TIMEOUT_MS
            );
        } catch (error) {
            const detail = `Codex did not say who is signed in: ${error instanceof Error ? error.message : String(error)}`;

            return { signIn: { status: 'unknown', detail }, usage: { state: 'unavailable', windows: [] } };
        }
    },
} satisfies Pick<Provider, 'login' | 'read'>;
