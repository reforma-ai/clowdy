// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData } from '../../../daemon/fixtureData';
import { FixtureTransport } from '../../../daemon/fixtureTransport';
import { overrideTransport } from '../../../daemon/testing';
import { RootStore, RootStoreProvider } from '../../../stores';
import { ProvidersPage } from './ProvidersPage';

import type { AgentInfo } from '@clowdy/protocol';
import type { Transport } from '../../../daemon/transport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The Providers page on the fixture daemon. The test build has no MobX observer plugin, so the page is drawn again by hand
 * after the store changes, as the observer does in the app.
 */

const storage = { getItem: () => null, setItem: () => undefined };

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;
let transport: FixtureTransport;

const draw = () => act(async () => {
    reactRoot.render(<RootStoreProvider value={ store }><ProvidersPage /></RootStoreProvider>);
});

/** Starts the store on `transport` and waits until the agents are in. */
async function start(base: Transport = transport) {
    store = new RootStore(base, { storage });
    await store.load();
    await vi.waitFor(() => expect(store.agentsStatus).not.toBe('loading'));
    await draw();
}

const card = (name: string) => container.querySelector<HTMLElement>(`section[aria-label="${ name }"]`)!;
const button = (within: ParentNode, label: string) => [...within.querySelectorAll<HTMLElement>('button, a')].find(element => element.textContent?.trim() === label || element.getAttribute('aria-label') === label);
const press = (element: HTMLElement | undefined) => act(async () => element!.click());
const switchOf = (within: ParentNode, label: string) => within.querySelector<HTMLInputElement>(`input[aria-label="${ label }"]`)!;

/** The agents of the fixture with `change` applied to the one called `id`. */
function withAgent(id: string, change: (agent: AgentInfo) => void) {
    const data = createFixtureData();

    change(data.agents.find(agent => agent.id === id)!);

    return new FixtureTransport({ data });
}

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
    transport = new FixtureTransport();
});

afterEach(() => {
    act(() => reactRoot.unmount());
    container.remove();
    store.dispose();
});

describe('the cards', () => {
    it('has one card each for Claude, Codex and Cursor, with who is signed in and the plan', async () => {
        await start();

        expect([...container.querySelectorAll('section[aria-label]')].map(section => section.getAttribute('aria-label')).filter(label => ['Claude Code', 'Codex', 'Cursor'].includes(label!))).toEqual(['Claude Code', 'Codex', 'Cursor']);
        expect(card('Claude Code').textContent).toContain('dev@example.com');
        expect(card('Claude Code').textContent).toContain('Max');
        expect(card('Codex').textContent).toContain('Plus');
        expect(card('Cursor').textContent).toContain('Pro+');
    });

    it('draws a bar for every window of the usage, with the percent used and the time to reset', async () => {
        await start();

        const bars = [...card('Claude Code').querySelectorAll('[role="progressbar"]')];

        expect(bars.map(bar => bar.getAttribute('aria-label'))).toEqual(['5h used', '7d used', '7d · Fable used']);
        expect(bars.map(bar => bar.getAttribute('aria-valuenow'))).toEqual(['8', '20', '0']);
        expect(card('Claude Code').textContent).toMatch(/8%.*?2\dm/);
        expect(card('Cursor').textContent).toContain('Plan usage');
        expect(card('Cursor').textContent).toMatch(/25d 2\dh|26d/);
    });

    it('lists the settings of an agent that has some, and none for one that has none', async () => {
        await start();

        expect(switchOf(card('Claude Code'), 'Memory').checked).toBe(false);
        expect(switchOf(card('Claude Code'), '1M context window').checked).toBe(true);
        expect(card('Codex').querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    });

    it('shows a note, and no usage or sign-in, for a program that is not installed', async () => {
        await start(withAgent('cursor', (agent) => {
            agent.status = 'missing';
            agent.detail = 'Cursor is not installed: no `cursor-agent` command was found.';
            delete agent.signIn;
            delete agent.usage;
        }));

        const cursor = card('Cursor');

        expect(cursor.textContent).toContain('Not installed');
        expect(cursor.textContent).toContain('no `cursor-agent` command was found');
        expect(cursor.querySelector('[role="progressbar"]')).toBeNull();
        expect(button(cursor, 'Sign in')).toBeUndefined();
        expect(switchOf(cursor, 'Use Cursor in Clowdy').disabled).toBe(true);
    });
});

describe('the switch of a provider', () => {
    it('turns it off through the daemon, and then its usage is gone and the card says it is off', async () => {
        await start();

        const command = vi.spyOn(store, 'command');

        await press(switchOf(card('Codex'), 'Use Codex in Clowdy'));
        await vi.waitFor(() => expect(store.agents.find(agent => agent.id === 'codex')?.enabled).toBe(false));
        await draw();

        expect(command).toHaveBeenCalledWith({ type: 'agent.update', id: 'codex', enabled: false });
        expect(card('Codex').querySelector('[role="progressbar"]')).toBeNull();
        expect(switchOf(card('Codex'), 'Use Codex in Clowdy').checked).toBe(false);
        // Who was signed in stays on the card, so turning it back on is a known thing.
        expect(card('Codex').textContent).toContain('dev@example.com');
    });

    it('sends a setting by its id and shows the new value', async () => {
        await start();

        const command = vi.spyOn(store, 'command');

        await press(switchOf(card('Claude Code'), 'Memory'));
        await vi.waitFor(() => expect(store.agents.find(agent => agent.id === 'claude')?.settings?.find(setting => setting.id === 'memory')?.value).toBe(true));
        await draw();

        expect(command).toHaveBeenCalledWith({ type: 'agent.update', id: 'claude', settings: { memory: true } });
        expect(switchOf(card('Claude Code'), 'Memory').checked).toBe(true);
    });
});

describe('signing in', () => {
    const signedOut = () => withAgent('codex', (agent) => {
        agent.signIn = { status: 'signed-out', checkedAt: Date.now() };
        delete agent.usage;
    });

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('offers Sign in when nobody is, and Sign in again when somebody is', async () => {
        await start(signedOut());

        expect(card('Codex').textContent).toContain('Not signed in');
        expect(button(card('Codex'), 'Sign in')).toBeDefined();
        expect(button(card('Claude Code'), 'Sign in again')).toBeDefined();
        expect(button(card('Claude Code'), 'Sign in')).toBeUndefined();
    });

    it('follows the daemon\'s sign-in: the link to copy or open, then the account', async () => {
        await start(signedOut());
        await press(button(card('Codex'), 'Sign in'));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(500);
        });
        await vi.waitFor(() => expect(store.agents.find(agent => agent.id === 'codex')?.signInSession?.step).toBe('waiting'));
        await draw();

        const codex = card('Codex');
        const open = button(codex, 'Open') as HTMLAnchorElement;

        expect(codex.textContent).toContain('Finish signing in in your browser');
        expect(codex.textContent).toContain('https://auth.openai.com/oauth/authorize');
        expect(button(codex, 'Copy link')).toBeDefined();
        expect(open.getAttribute('href')).toContain('https://auth.openai.com/oauth/authorize');
        expect(open.getAttribute('target')).toBe('_blank');
        expect(button(codex, 'Sign in')).toBeUndefined();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(5000);
        });
        await vi.waitFor(() => expect(store.agents.find(agent => agent.id === 'codex')?.signIn?.status).toBe('signed-in'));
        await draw();

        expect(card('Codex').textContent).toContain('dev@example.com');
        expect(card('Codex').textContent).toContain('Signed in');
        expect(button(card('Codex'), 'Sign in again')).toBeDefined();
    });

    it('cancels a sign-in that is running and says so', async () => {
        await start(signedOut());
        await press(button(card('Codex'), 'Sign in'));
        await vi.waitFor(() => expect(store.agents.find(agent => agent.id === 'codex')?.signInSession).toBeDefined());
        await draw();
        await press(button(card('Codex'), 'Cancel'));
        await vi.waitFor(() => expect(store.agents.find(agent => agent.id === 'codex')?.signInSession?.step).toBe('cancelled'));
        await draw();

        expect(card('Codex').textContent).toContain('The sign-in was cancelled.');
        expect(button(card('Codex'), 'Sign in')).toBeDefined();
    });

    it('shows why a sign-in failed, and offers it again', async () => {
        await start(withAgent('codex', (agent) => {
            agent.signIn = { status: 'signed-out', checkedAt: 1 };
            agent.signInSession = { step: 'failed', startedAt: 1, message: 'codex login ended without signing in.' };
        }));

        expect(card('Codex').textContent).toContain('codex login ended without signing in.');
        expect(button(card('Codex'), 'Sign in')).toBeDefined();
    });

    it('shows a one-time code to enter on the page when the sign-in has one', async () => {
        await start(withAgent('codex', (agent) => {
            agent.signIn = { status: 'signed-out', checkedAt: 1 };
            agent.signInSession = { step: 'waiting', startedAt: Date.now(), url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234' };
        }));

        expect(card('Codex').textContent).toContain('Enter this code on the page');
        expect(card('Codex').textContent).toContain('ABCD-1234');
    });

    it('shows the vendor\'s command when the daemon cannot run the sign-in', async () => {
        await start(withAgent('cursor', (agent) => {
            agent.canSignIn = false;
            agent.signIn = { status: 'signed-out', checkedAt: 1 };
        }));

        expect(button(card('Cursor'), 'Sign in')).toBeUndefined();
        expect(card('Cursor').textContent).toContain('Run `cursor-agent login` in a terminal');
    });
});

describe('the usage', () => {
    it('reads it again from the refresh button', async () => {
        await start();

        const command = vi.spyOn(store, 'command');

        await press(button(card('Claude Code'), 'Read the usage again'));

        expect(command).toHaveBeenCalledWith({ type: 'agents.refresh' });
    });

    it('says why there is nothing to show, and shows the last reading when a new one failed', async () => {
        await start(withAgent('codex', (agent) => {
            agent.usage = { state: 'unavailable', windows: [], detail: 'Signed in with an API key: there are no plan limits.' };
        }));

        expect(card('Codex').textContent).toContain('there are no plan limits');
        expect(card('Codex').querySelector('[role="progressbar"]')).toBeNull();

        act(() => reactRoot.unmount());
        reactRoot = createRoot(container);
        store.dispose();
        await start(withAgent('claude', (agent) => {
            agent.usage = { ...agent.usage!, state: 'error', detail: 'The usage endpoint answered 429.' };
        }));

        expect(card('Claude Code').querySelectorAll('[role="progressbar"]')).toHaveLength(3);
        expect(card('Claude Code').textContent).toContain('The usage endpoint answered 429.');
    });
});

describe('before and without the agents', () => {
    it('says the agents could not be loaded, and tries again', async () => {
        const getAgents = vi.fn<() => Promise<AgentInfo[]>>().mockRejectedValueOnce(new Error('offline'));

        await start(overrideTransport(transport, { getAgents }));

        expect(container.textContent).toContain('The agents could not be loaded.');
        expect(container.textContent).toContain('offline');

        getAgents.mockResolvedValueOnce(await transport.getAgents());
        await press(button(container, 'Try again'));
        await vi.waitFor(() => expect(store.agentsStatus).toBe('ready'));
        await draw();

        expect(card('Codex')).not.toBeNull();
    });

    it('says so when the daemon lists none of the three', async () => {
        await start(overrideTransport(transport, { getAgents: async () => [] }));

        expect(container.textContent).toContain('lists none of Claude Code, Codex or Cursor');
    });
});

describe('the advanced settings', () => {
    it('keeps the program path and the environment out of sight until asked, and checks the environment before it sends it', async () => {
        await start();

        const claude = card('Claude Code');

        expect(claude.querySelector('textarea')).toBeNull();

        await press(button(claude, 'Advanced'));
        await vi.waitFor(() => expect(card('Claude Code').querySelector('textarea')).not.toBeNull());

        const area = card('Claude Code').querySelector('textarea')!;
        const type = async (text: string) => act(async () => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, text);
            area.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const command = vi.spyOn(store, 'command');

        expect(card('Claude Code').textContent).toContain('Found at /Users/dev/.local/bin/claude');

        await type('nonsense');

        expect(card('Claude Code').textContent).toContain('Line 1 is not KEY=VALUE');
        expect(button(card('Claude Code'), 'Save the environment')!.hasAttribute('disabled')).toBe(true);

        await type('HTTPS_PROXY=http://proxy:3128');
        await press(button(card('Claude Code'), 'Save the environment'));

        expect(command).toHaveBeenCalledWith({ type: 'agent.update', id: 'claude', env: { HTTPS_PROXY: 'http://proxy:3128' } });
    });
});
