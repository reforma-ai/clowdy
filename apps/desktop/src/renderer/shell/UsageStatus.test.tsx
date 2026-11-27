// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData } from '../daemon/fixtureData';
import { FixtureTransport } from '../daemon/fixtureTransport';
import { overrideTransport } from '../daemon/testing';
import { RootStore, RootStoreProvider } from '../stores';
import { UsageStatus } from './UsageStatus';

import type { AgentInfo, AgentUsageWindow } from '@clowdy/protocol';
import type { Transport } from '../daemon/transport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toasts = vi.hoisted(() => ({ error: vi.fn<(options: { message: string }) => void>() }));

vi.mock('@clowdy/components/Toast', () => ({ toast: toasts }));

/*
 * The usage status of the window header on the fixture daemon. The test build has no MobX observer plugin, so the status is
 * drawn again by hand after the store changes, as the observer does in the app.
 */

const MINUTE = 60_000;
const storage = { getItem: () => null, setItem: () => undefined };

type Providers = Record<'claude' | 'codex' | 'cursor', AgentInfo>;

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;

const draw = () =>
    act(async () => {
        reactRoot.render(
            <RootStoreProvider value={store}>
                <UsageStatus />
            </RootStoreProvider>
        );
    });

/** Starts the store on `transport` and waits until the agents are in. */
async function start(transport: Transport) {
    store = new RootStore(transport, { storage });
    await store.load();
    await vi.waitFor(() => expect(store.agentsStatus).not.toBe('loading'));
    await draw();
}

/** A moment `minutes` from now, a few seconds past it so the rounding down of the time to reset never loses a whole minute. */
const inMinutes = (minutes: number) => Date.now() + minutes * MINUTE + 5_000;

const meter = (id: string, usedPercent: number, minutes?: number): AgentUsageWindow => ({
    id,
    label:
        {
            session: 'Session',
            weekly: 'Week',
            'weekly:fable': 'Fable',
            'codex:primary': 'Session',
            'codex:secondary': 'Week',
            'spark:secondary': 'Codex Spark',
            plan: 'Plan usage',
        }[id] ?? id,
    usedPercent,
    resetsAt: minutes === undefined ? undefined : inMinutes(minutes),
});

/**
 * The fixture's three agents with `change` applied, after they were given usage that tells the headline rule apart: Claude's
 * weekly window is its most used primary one (78%) while its Fable window is at 99%, Codex is at 85% and Cursor at 40%. The windows
 * carry the ids the daemon gives them, Codex's among them (`codex:primary`), which all have a colon.
 */
function agentsWith(change: (providers: Providers) => void = () => undefined) {
    const data = createFixtureData();
    const providers = Object.fromEntries(data.agents.map(agent => [agent.id, agent])) as Providers;
    const usage = (windows: AgentUsageWindow[]) => ({ state: 'ok' as const, fetchedAt: Date.now(), windows });

    providers.claude.usage = usage([meter('session', 8, 28), meter('weekly', 78, 92), meter('weekly:fable', 99, 92)]);
    providers.claude.signIn = {
        status: 'signed-in',
        checkedAt: Date.now(),
        account: { email: 'claude@example.com', plan: 'Max' },
    };
    providers.codex.usage = usage([meter('codex:primary', 85, 45), meter('codex:secondary', 17, 24 * 60)]);
    providers.codex.signIn = {
        status: 'signed-in',
        checkedAt: Date.now(),
        account: { email: 'codex@example.com', plan: 'Plus' },
    };
    providers.cursor.usage = usage([meter('plan', 40, 3 * 24 * 60)]);
    providers.cursor.signIn = {
        status: 'signed-in',
        checkedAt: Date.now(),
        account: { email: 'cursor@example.com', plan: 'Pro+' },
    };
    change(providers);

    return new FixtureTransport({ data });
}

const badges = () => [...container.querySelectorAll<HTMLElement>('[role="group"] button')];
const badge = (name: string) => badges().find(element => element.getAttribute('aria-label')?.startsWith(name))!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const section = (name: string) => dialog()!.querySelector<HTMLElement>(`section[aria-label="${name}"]`)!;
const button = (within: ParentNode, label: string) =>
    [...within.querySelectorAll<HTMLElement>('button')].find(
        element => element.textContent?.trim() === label || element.getAttribute('aria-label') === label
    );
const press = (element: HTMLElement | undefined) => act(async () => element!.click());
const bars = (within: ParentNode) => [...within.querySelectorAll('[role="progressbar"]')];

/** Opens the popover from `name`'s badge and waits for it to place itself. */
async function openPopover(name = 'Claude Code') {
    await press(badge(name));
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 30));
    });
}

/** Closes the popover with Escape and waits until it is gone. */
async function close() {
    await act(async () => {
        dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await vi.waitFor(() => expect(dialog()).toBeNull());
}

beforeEach(() => {
    toasts.error.mockClear();
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
});

afterEach(() => {
    act(() => reactRoot.unmount());
    container.remove();
    store.dispose();
});

describe('the badges', () => {
    it('has one badge for each provider that is switched on and installed, in the fixed order', async () => {
        await start(agentsWith());

        expect(badges().map(element => element.getAttribute('aria-label'))).toEqual([
            'Claude Code usage 8%, resets in 28 minutes, Week 78%, Fable 99%',
            'Codex usage 85%, resets in 45 minutes',
            'Cursor usage 40%, resets in 3 days',
        ]);
    });

    it('shows the mark, the percent used and the time to reset of the nearest limit, not of the fullest', async () => {
        await start(agentsWith());

        const claude = badge('Claude Code');

        // The Session window (8%) is the nearest one, though the Week one (78%) and the Fable one (99%) are fuller.
        expect(claude.textContent).toBe('8%28m');
        expect(claude.querySelector('svg')).not.toBeNull();
        // The week is a line under the text, as wide as its percent, and Fable at 99% is a dot. Neither replaces the number.
        expect(claude.querySelector('[data-week]')?.getAttribute('style')).toContain('width: 78%');
        expect(claude.querySelector('[data-week]')?.hasAttribute('data-tone')).toBe(false);
        expect(claude.querySelector('[data-hot]')).not.toBeNull();
        expect(claude.getAttribute('data-color')).toBe('secondary');
        expect(badge('Codex').textContent).toBe('85%45m');
        expect(badge('Codex').querySelector('[data-week]')).toBeNull();
        expect(badge('Cursor').textContent).toBe('40%3d');
        expect(badge('Cursor').querySelector('[data-week]')).toBeNull();
    });

    it('shows a session that is at zero, as the nearest limit, whatever the fuller ones say', async () => {
        await start(
            agentsWith(providers => {
                providers.claude.usage!.windows = [
                    meter('session', 0, 300),
                    meter('weekly', 90, 60),
                    meter('weekly:fable', 99, 60),
                ];
            })
        );

        const claude = badge('Claude Code');

        expect(claude.textContent).toBe('0%5h');
        // The week at 90% is the line, in the danger tone. The chip stays plain: a red chip would read as the session. Fable adds no dot, the plan is already there.
        expect(claude.querySelector('[data-week]')?.getAttribute('data-tone')).toBe('danger');
        expect(claude.querySelector('[data-hot]')).toBeNull();
        expect(claude.getAttribute('data-color')).toBe('secondary');
    });

    it('does not let the limit of a single model decide the badge, for Codex as for Claude', async () => {
        await start(
            agentsWith(providers => {
                providers.codex.usage!.windows = [
                    meter('spark:secondary', 99, 60),
                    meter('codex:primary', 12, 45),
                    meter('codex:secondary', 30, 24 * 60),
                ];
            })
        );

        const codex = badge('Codex');

        expect(codex.textContent).toBe('12%45m');
        // The week at 30% is too quiet for a line. Spark at 99% is the dot, since neither plan window is at 90%.
        expect(codex.querySelector('[data-week]')).toBeNull();
        expect(codex.querySelector('[data-hot]')).not.toBeNull();
        expect(codex.getAttribute('aria-label')).toBe('Codex usage 12%, resets in 45 minutes, Codex Spark 99%');

        await openPopover('Codex');

        // The bars of the popover do show it, in the order the daemon gave.
        expect(bars(section('Codex')).map(bar => bar.getAttribute('aria-label'))).toEqual([
            'Codex Spark used',
            'Session used',
            'Week used',
        ]);
    });

    it('shows the mark alone when every window of a provider is the limit of a single model', async () => {
        await start(
            agentsWith(providers => {
                providers.claude.usage!.windows = [meter('weekly:fable', 99, 60)];
            })
        );

        const claude = badge('Claude Code');

        // No plan window, so no percent. A model limit at 99% is still the dot, and the chip is not faded while that dot shows.
        expect(claude.hasAttribute('data-muted')).toBe(false);
        expect(claude.textContent).toBe('');
        expect(claude.querySelector('[data-hot]')).not.toBeNull();
        expect(claude.getAttribute('aria-label')).toBe('Claude Code usage: Fable 99%');
    });

    it("shows the mark alone, muted, when a single model's limit is under the danger tone", async () => {
        await start(
            agentsWith(providers => {
                providers.claude.usage!.windows = [meter('weekly:fable', 40, 60)];
            })
        );

        expect(badge('Claude Code').hasAttribute('data-muted')).toBe(true);
        expect(badge('Claude Code').textContent).toBe('');
        expect(badge('Claude Code').querySelector('[data-hot]')).toBeNull();
    });

    it('leaves the time out when the window has no reset', async () => {
        await start(
            agentsWith(providers => {
                providers.cursor.usage!.windows = [meter('plan', 40)];
            })
        );

        expect(badge('Cursor').textContent).toBe('40%');
        expect(badge('Cursor').getAttribute('aria-label')).toBe('Cursor usage 40%');
    });

    it('turns red from 90% and is never orange: the warning tone is for the bars', async () => {
        await start(
            agentsWith(providers => {
                providers.claude.usage!.windows = [meter('weekly', 79, 60)];
                providers.codex.usage!.windows = [meter('codex:secondary', 89, 60)];
                providers.cursor.usage!.windows = [meter('plan', 90, 60)];
            })
        );

        expect(badges().map(element => element.getAttribute('data-color'))).toEqual([
            'secondary',
            'secondary',
            'danger',
        ]);
    });

    it('keeps the week line terracotta through 89% and red from 90%, without turning the chip red', async () => {
        await start(
            agentsWith(providers => {
                providers.claude.usage!.windows = [meter('session', 8, 28), meter('weekly', 89, 92)];
                providers.codex.usage!.windows = [meter('codex:primary', 8, 45), meter('codex:secondary', 90, 24 * 60)];
            })
        );

        const claude = badge('Claude Code');

        expect(claude.getAttribute('data-color')).toBe('secondary');
        expect(claude.querySelector('[data-week]')?.hasAttribute('data-tone')).toBe(false);
        expect(claude.querySelector('[data-week]')?.getAttribute('style')).toContain('width: 89%');
        expect(badge('Codex').getAttribute('data-color')).toBe('secondary');
        expect(badge('Codex').querySelector('[data-week]')?.getAttribute('data-tone')).toBe('danger');
    });

    it('leaves the week line off while the week is under 60% or not ahead of the session', async () => {
        await start(
            agentsWith(providers => {
                providers.claude.usage!.windows = [meter('session', 70, 28), meter('weekly', 59, 92)];
                providers.codex.usage!.windows = [
                    meter('codex:primary', 80, 45),
                    meter('codex:secondary', 60, 24 * 60),
                ];
            })
        );

        expect(badge('Claude Code').querySelector('[data-week]')).toBeNull();
        expect(badge('Codex').querySelector('[data-week]')).toBeNull();
    });

    it('shows the mark alone, muted, for a provider with no reading', async () => {
        await start(
            agentsWith(providers => {
                // Nobody signed in, the usage is unavailable and the last read failed: none of them is a number to show.
                providers.claude.signIn = { status: 'signed-out', checkedAt: Date.now() };
                delete providers.claude.usage;
                providers.codex.usage = {
                    state: 'unavailable',
                    windows: [],
                    detail: 'Signed in with an API key: there are no plan limits.',
                };
                providers.cursor.usage = {
                    ...providers.cursor.usage!,
                    state: 'error',
                    detail: 'The usage endpoint answered 429.',
                };
            })
        );

        expect(badges()).toHaveLength(3);

        for (const element of badges()) {
            expect(element.hasAttribute('data-muted')).toBe(true);
            expect(element.textContent).toBe('');
            expect(element.querySelector('svg')).not.toBeNull();
        }

        expect(badges().map(element => element.getAttribute('aria-label'))).toEqual([
            'Claude Code usage: not signed in',
            'Codex usage: not available',
            'Cursor usage: not available',
        ]);
    });

    it('shows the mark alone while the usage has not been read yet', async () => {
        await start(
            agentsWith(providers => {
                delete providers.claude.usage;
                delete providers.claude.signIn;
            })
        );

        expect(badge('Claude Code').hasAttribute('data-muted')).toBe(true);
        expect(badge('Claude Code').getAttribute('aria-label')).toBe('Claude Code usage: being checked');
        expect(badge('Codex').hasAttribute('data-muted')).toBe(false);
    });

    it('leaves out a provider that is switched off, not installed or needs a runtime', async () => {
        await start(
            agentsWith(providers => {
                providers.claude.enabled = false;
                providers.claude.status = 'disabled';
                providers.codex.status = 'missing';
                providers.cursor.status = 'needs-runtime';
            })
        );

        expect(badges()).toHaveLength(0);
    });

    it('draws nothing at all when no provider is usable, and a badge when one is switched on', async () => {
        const transport = agentsWith(providers => {
            for (const agent of Object.values(providers)) {
                agent.enabled = false;
                agent.status = 'disabled';
            }
        });

        await start(transport);

        expect(container.innerHTML).toBe('');

        await act(async () => {
            await transport.command({ type: 'agent.update', id: 'codex', enabled: true });
            await vi.waitFor(() => expect(store.agents.find(agent => agent.id === 'codex')?.enabled).toBe(true));
        });
        await draw();

        expect(badges().map(element => element.getAttribute('aria-label')?.split(' usage')[0])).toEqual(['Codex']);
    });

    it('draws nothing before the agents are known', async () => {
        await start(overrideTransport(agentsWith(), { getAgents: async () => [] }));

        expect(container.innerHTML).toBe('');
    });

    it("is made of real buttons, which the window's drag region leaves alone (base.css gives every button no-drag)", async () => {
        await start(agentsWith());

        expect(badges().map(element => element.tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON']);
        expect(container.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe(
            'Plan usage of the providers'
        );
    });
});

describe('the popover', () => {
    it('opens from any badge, names itself, and marks only the badge that opened it as expanded', async () => {
        await start(agentsWith());

        expect(dialog()).toBeNull();
        expect(badges().map(element => element.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'false']);

        await openPopover('Cursor');

        expect(dialog()).not.toBeNull();
        expect(dialog()!.getAttribute('aria-label')).toBe('Cursor plan usage');
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
        expect(badges().map(element => element.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'true']);
    });

    it('closes with Escape', async () => {
        await start(agentsWith());
        await openPopover();
        await act(async () => {
            dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        await vi.waitFor(() => expect(dialog()).toBeNull());

        expect(badge('Claude Code').getAttribute('aria-expanded')).toBe('false');
    });

    it('opens from the keyboard, takes the focus in, and gives it back to the badge it came from on Escape', async () => {
        await start(agentsWith());

        const codex = badge('Codex');

        codex.focus();
        await act(async () => {
            codex.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            codex.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        });
        await vi.waitFor(() => expect(dialog()).not.toBeNull());
        await vi.waitFor(() => expect(dialog()!.contains(document.activeElement)).toBe(true));

        expect(badge('Codex').getAttribute('aria-expanded')).toBe('true');

        await act(async () => {
            dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        await vi.waitFor(() => expect(dialog()).toBeNull());
        await vi.waitFor(() => expect(document.activeElement).toBe(codex));
    });

    it('shows the provider of the badge that was pressed, and no other', async () => {
        await start(agentsWith());

        for (const [name, shown] of [
            ['Codex', 'Codex'],
            ['Cursor', 'Cursor'],
            ['Claude Code', 'Claude Code'],
        ]) {
            await openPopover(name);

            expect(
                [...dialog()!.querySelectorAll('section[aria-label]')].map(element =>
                    element.getAttribute('aria-label')
                )
            ).toEqual([shown]);

            await close();
        }
    });

    it('shows the account and its plan, and a bar for every window, scoped ones too, the nearest first', async () => {
        await start(agentsWith());
        await openPopover();

        const claude = section('Claude Code');

        expect(claude.textContent).toContain('claude@example.com');
        expect(claude.textContent).toContain('Max');
        expect(bars(claude).map(bar => bar.getAttribute('aria-label'))).toEqual([
            'Session used',
            'Week used',
            'Fable used',
        ]);
        expect(bars(claude).map(bar => bar.getAttribute('aria-valuenow'))).toEqual(['8', '78', '99']);
        expect([...claude.querySelectorAll('li')].map(row => row.textContent)).toEqual([
            'Session8% usedResets in 28m',
            'Week78% usedResets in 1h 32m',
            'Fable99% usedResets in 1h 32m',
        ]);

        await close();
        await openPopover('Codex');

        expect(section('Codex').textContent).toContain('codex@example.com');
        expect(section('Codex').textContent).toContain('Plus');

        await close();
        await openPopover('Cursor');

        expect(section('Cursor').textContent).toContain('Plan usage');
    });

    it('puts the label, how much is used and when it resets on one line over the bar, and says so when the time has come or is not known', async () => {
        await start(
            agentsWith(providers => {
                providers.claude.usage!.windows = [
                    meter('session', 35, 11),
                    { ...meter('weekly', 10), resetsAt: Date.now() - 1_000 },
                    meter('weekly:fable', 0),
                ];
            })
        );
        await openPopover();

        const rows = [...section('Claude Code').querySelectorAll('li')];

        // The label and the figures share the line before the bar.
        expect(rows.map(row => [...row.children].map(child => child.textContent))).toEqual([
            ['Session35% usedResets in 11m', ''],
            ['Week10% usedResets now', ''],
            ['Fable0% used', ''],
        ]);
    });

    it('uses the same tones as the badges for its bars: warning from 80%, danger from 90%', async () => {
        await start(agentsWith());

        const tone = (name: string) => bars(section(name)).map(bar => bar.getAttribute('data-tone'));

        await openPopover();

        expect(tone('Claude Code')).toEqual(['primary', 'primary', 'danger']);

        await close();
        await openPopover('Codex');

        expect(tone('Codex')).toEqual(['warning', 'primary']);
    });

    it('says a provider is being checked while its usage has not been read', async () => {
        await start(
            agentsWith(providers => {
                delete providers.claude.usage;
                delete providers.claude.signIn;
            })
        );
        await openPopover();

        expect(section('Claude Code').textContent).toContain('Checking…');
        expect(bars(section('Claude Code'))).toHaveLength(0);
        // The account line falls back to the provider's own name when nobody is known.
        expect(section('Claude Code').textContent).toContain('Claude Code');
    });

    it('says a provider is signed out, and opens Settings on Providers from there', async () => {
        await start(
            agentsWith(providers => {
                providers.claude.signIn = { status: 'signed-out', checkedAt: Date.now() };
                delete providers.claude.usage;
            })
        );
        await openPopover();

        expect(section('Claude Code').textContent).toContain('Not signed in');

        await press(button(section('Claude Code'), 'Open Providers'));
        await vi.waitFor(() => expect(dialog()).toBeNull());

        expect(store.ui.settingsOpen).toBe(true);
        expect(store.ui.settingsPage).toBe('providers');
    });

    it("shows the daemon's reason when the usage is unavailable, and when the last read failed along with the last good bars", async () => {
        await start(
            agentsWith(providers => {
                providers.codex.usage = {
                    state: 'unavailable',
                    windows: [],
                    detail: 'Signed in with an API key: there are no plan limits.',
                };
                providers.claude.usage = {
                    ...providers.claude.usage!,
                    state: 'error',
                    detail: 'The usage endpoint answered 429.',
                };
            })
        );
        await openPopover('Codex');

        expect(section('Codex').textContent).toContain('there are no plan limits');
        expect(bars(section('Codex'))).toHaveLength(0);

        await close();
        await openPopover();

        expect(section('Claude Code').textContent).toContain('The usage endpoint answered 429.');
        expect(bars(section('Claude Code'))).toHaveLength(3);
    });

    it('counts the time to reset down while it is open', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            await start(agentsWith());
            await press(badge('Codex'));

            const reset = () => badge('Codex').textContent;
            const row = () => section('Codex').querySelector('li')!.textContent;
            const before = [reset(), row()];

            await act(async () => {
                await vi.advanceTimersByTimeAsync(2 * MINUTE);
            });

            expect(before).toEqual(['85%45m', 'Session85% usedResets in 45m']);
            expect([reset(), row()]).toEqual(['85%43m', 'Session85% usedResets in 43m']);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('the refresh action', () => {
    it('sends agents.refresh', async () => {
        await start(agentsWith());
        await openPopover();

        const command = vi.spyOn(store, 'command');

        await press(button(dialog()!, 'Refresh usage'));

        expect(command).toHaveBeenCalledWith({ type: 'agents.refresh' });
    });

    it('tells the person when the daemon refuses, and stops spinning', async () => {
        const refused = {
            ok: false,
            requestId: 'r',
            error: { code: 'unavailable', message: 'The daemon is busy.' },
        } as const;

        await start(overrideTransport(agentsWith(), { command: async () => refused }));
        await openPopover();
        await press(button(dialog()!, 'Refresh usage'));
        await vi.waitFor(() => expect(toasts.error).toHaveBeenCalledWith({ message: 'The daemon is busy.' }));

        expect(button(dialog()!, 'Refresh usage')!.hasAttribute('data-pending')).toBe(false);
    });

    describe('while it waits', () => {
        /** The agents as they were at one moment, with Claude's last read moved on once `reads.newer` is set: the daemon answers before it has read. */
        async function reading() {
            const reads = { newer: false };
            const snapshot = await agentsWith().getAgents();
            const getAgents = vi.fn<() => Promise<AgentInfo[]>>(async () =>
                snapshot.map(agent =>
                    agent.id === 'claude' && reads.newer
                        ? { ...agent, signIn: { ...agent.signIn!, checkedAt: agent.signIn!.checkedAt + 1_000 } }
                        : agent
                )
            );

            return { reads, getAgents };
        }

        const spins = () => button(dialog()!, 'Refresh usage')!.hasAttribute('data-pending');
        // The icon itself turns (the button shows no spinner of its own in its place).
        const iconTurns = () =>
            /spin/i.test(button(dialog()!, 'Refresh usage')!.querySelector('svg')?.getAttribute('class') ?? '');
        const later = (ms: number) =>
            act(async () => {
                await vi.advanceTimersByTimeAsync(ms);
            });

        beforeEach(() => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('spins until a provider was read again, and keeps spinning when the popover is closed and opened', async () => {
            const { reads, getAgents } = await reading();

            await start(overrideTransport(agentsWith(), { getAgents }));
            await press(badge('Claude Code'));
            await press(button(dialog()!, 'Refresh usage'));

            expect(spins()).toBe(true);
            expect(iconTurns()).toBe(true);
            expect(button(dialog()!, 'Refresh usage')!.querySelector('[class*="pinner"]')).toBeNull();

            await act(async () => {
                dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            });
            await vi.waitFor(() => expect(dialog()).toBeNull());
            await later(1_000);
            await press(badge('Codex'));

            expect(spins()).toBe(true);

            await later(2_000);

            expect(spins()).toBe(true);

            reads.newer = true;
            await later(1_500);

            expect(spins()).toBe(false);
            expect(iconTurns()).toBe(false);
        });

        it('keeps spinning when the provider that was read last is switched off meanwhile', async () => {
            const off = { claude: false };
            const snapshot = await agentsWith(providers => {
                providers.claude.signIn = { ...providers.claude.signIn!, checkedAt: Date.now() + 60_000 };
            }).getAgents();
            const getAgents = vi.fn<() => Promise<AgentInfo[]>>(async () =>
                snapshot.map(agent =>
                    agent.id === 'claude' && off.claude
                        ? { ...agent, enabled: false, status: 'disabled' as const }
                        : agent
                )
            );

            await start(overrideTransport(agentsWith(), { getAgents }));
            await press(badge('Codex'));
            await press(button(dialog()!, 'Refresh usage'));

            off.claude = true;
            await later(3_000);
            await draw();

            // Claude's badge is gone, and with it the newest last read of the three: that is not a new read.
            expect(badges().map(element => element.getAttribute('aria-label')?.split(' usage')[0])).toEqual([
                'Codex',
                'Cursor',
            ]);
            expect(spins()).toBe(true);
        });

        it('stops asking for the agents when the status goes away', async () => {
            const { getAgents } = await reading();

            await start(overrideTransport(agentsWith(), { getAgents }));
            await press(badge('Claude Code'));
            await press(button(dialog()!, 'Refresh usage'));
            await later(2_000);
            act(() => reactRoot.unmount());
            reactRoot = createRoot(container);

            const asked = getAgents.mock.calls.length;

            await later(25_000);

            // The fetch that was already waiting for its turn may still happen, then the wait ends.
            expect(getAgents.mock.calls.length).toBeLessThanOrEqual(asked + 1);
        });

        it('gives up after a while when no new read ever shows', async () => {
            const { getAgents } = await reading();

            await start(overrideTransport(agentsWith(), { getAgents }));
            await press(badge('Claude Code'));
            await press(button(dialog()!, 'Refresh usage'));
            await later(20_000);

            expect(spins()).toBe(true);

            await later(15_000);

            expect(spins()).toBe(false);
        });
    });
});

describe('reading the agents again', () => {
    const FIVE_MINUTES = 5 * MINUTE;
    let getAgents: ReturnType<typeof vi.fn<() => Promise<AgentInfo[]>>>;

    const setHidden = (hidden: boolean) => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    };
    const later = (ms: number) =>
        act(async () => {
            await vi.advanceTimersByTimeAsync(ms);
        });

    /** Starts on a transport that counts the fetches of the agents, and returns the count so far. */
    async function startCounting(transport: Transport = agentsWith()) {
        getAgents = vi.fn<() => Promise<AgentInfo[]>>(() => transport.getAgents());
        await start(overrideTransport(transport, { getAgents }));

        return getAgents.mock.calls.length;
    }

    beforeEach(() => {
        // The clock is faked too: the status reads at most once for triggers that come within a second of each other.
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    });

    afterEach(() => {
        Reflect.deleteProperty(document, 'hidden');
        vi.useRealTimers();
    });

    it('every five minutes', async () => {
        const asked = await startCounting();

        await later(FIVE_MINUTES - 1);

        expect(getAgents.mock.calls.length).toBe(asked);

        await later(1);

        expect(getAgents.mock.calls.length).toBe(asked + 1);

        await later(FIVE_MINUTES);

        expect(getAgents.mock.calls.length).toBe(asked + 2);
    });

    it('skips the tick while the window is hidden and goes on when it is back', async () => {
        const asked = await startCounting();

        setHidden(true);
        await later(FIVE_MINUTES);
        await later(FIVE_MINUTES);

        expect(getAgents.mock.calls.length).toBe(asked);

        setHidden(false);
        await later(FIVE_MINUTES);

        expect(getAgents.mock.calls.length).toBe(asked + 1);
    });

    it('when the window gains focus', async () => {
        const asked = await startCounting();

        await act(async () => {
            window.dispatchEvent(new Event('focus'));
        });

        expect(getAgents.mock.calls.length).toBe(asked + 1);
    });

    it('when the window becomes visible, and not when it becomes hidden', async () => {
        const asked = await startCounting();

        setHidden(true);
        await act(async () => {
            document.dispatchEvent(new Event('visibilitychange'));
        });

        expect(getAgents.mock.calls.length).toBe(asked);

        setHidden(false);
        await act(async () => {
            document.dispatchEvent(new Event('visibilitychange'));
        });

        expect(getAgents.mock.calls.length).toBe(asked + 1);
    });

    it('reads once when a restored window gets its focus and its visibility together, and again for a later one', async () => {
        const asked = await startCounting();
        const comeBack = () =>
            act(async () => {
                window.dispatchEvent(new Event('focus'));
                document.dispatchEvent(new Event('visibilitychange'));
            });

        await comeBack();

        expect(getAgents.mock.calls.length).toBe(asked + 1);

        await later(5_000);
        await comeBack();

        expect(getAgents.mock.calls.length).toBe(asked + 2);
    });

    it('does not read again for a tick that follows a read by a second or less', async () => {
        const asked = await startCounting();

        await later(FIVE_MINUTES - 500);
        await act(async () => {
            window.dispatchEvent(new Event('focus'));
        });

        expect(getAgents.mock.calls.length).toBe(asked + 1);

        await later(500);

        expect(getAgents.mock.calls.length).toBe(asked + 1);

        await later(FIVE_MINUTES);

        expect(getAgents.mock.calls.length).toBe(asked + 2);
    });

    it('keeps reading while no provider is usable, so one that is switched on later shows up', async () => {
        const transport = agentsWith(providers => {
            for (const agent of Object.values(providers)) agent.enabled = false;
        });
        const asked = await startCounting(transport);

        expect(container.innerHTML).toBe('');

        await later(FIVE_MINUTES);

        expect(getAgents.mock.calls.length).toBe(asked + 1);
    });

    it('stops with the status: no timer, and no read on focus', async () => {
        const asked = await startCounting();

        act(() => reactRoot.unmount());
        reactRoot = createRoot(container);

        expect(vi.getTimerCount()).toBe(0);

        await later(FIVE_MINUTES);
        await act(async () => {
            window.dispatchEvent(new Event('focus'));
            document.dispatchEvent(new Event('visibilitychange'));
        });

        expect(getAgents.mock.calls.length).toBe(asked);
    });
});
