// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID, type FixtureData } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { ChatView } from './ChatView';

import type { KeyValueStorage } from '../../stores/storage';

// `Modal` cannot load under the desktop's Vitest (decorators), and no confirmation is opened here.
vi.mock('@clowdy/components/modals', () => ({ openConfirmModal: vi.fn() }));
// Streamdown highlights code with Shiki, whose WebAssembly cannot load under happy-dom and fails after the test that drew a fence; the messages' words are what is checked here.
vi.mock('../../stream/Markdown', () => ({ Markdown: ({ text }: { text: string }) => <div>{ text }</div> }));
vi.mock('@clowdy/components/Toast', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn(), show: vi.fn() } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * ChatView on the fixture project: c-1 ran on Claude Code (orchestrator r-orch-1), c-4 has no orchestrator yet. The test build has no
 * MobX observer plugin, so the view is drawn again by hand after a change, as the observer does in the app.
 */

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;
let data: FixtureData;
let transport: FixtureTransport;

const ui = () => store.ui.forProject(FIXTURE_PROJECT_ID);
const chatOf = (id: string) => store.selectedProject!.chats.get(id)!;

const render = (chatId: string) => act(async () => {
    reactRoot.render(<RootStoreProvider value={ store }><ChatView key={ chatId } chat={ chatOf(chatId) } /></RootStoreProvider>);
});

/** Draws the chat, then again once its messages have been fetched. */
async function draw(chatId: string) {
    await render(chatId);
    await render(chatId);
}

const field = () => container.querySelector('[contenteditable="true"]');
const notice = () => container.querySelector<HTMLElement>('[aria-label="This chat is read only"]');
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent === label);
// The notice's own buttons: the strip of the chat's working agents above it has a Stop per agent.
const noticeButton = (label: string) => [...notice()?.querySelectorAll<HTMLButtonElement>('button') ?? []].find(candidate => candidate.textContent === label);

/** Starts the store on the fixtures, with the agents read, after `change` has had its say about them. */
async function start(change?: (agents: FixtureData['agents']) => void, tweak?: (data: FixtureData) => void) {
    data = createFixtureData();
    change?.(data.agents);
    tweak?.(data);
    transport = new FixtureTransport({ data });
    store = new RootStore(transport, { storage: memoryStorage() });
    await store.load();
    await store.refreshAgents();
}

/** Switches Claude Code off the way the daemon reports it. */
const claudeOff = (agents: FixtureData['agents']) => {
    const claude = agents.find(agent => agent.id === 'claude')!;

    claude.enabled = false;
    claude.status = 'disabled';
};

/** An event the way a browser makes it while files are dragged: the transfer lists `Files`. */
function dragEvent(type: string, files: File[] = []) {
    const event = new Event(type, { bubbles: true, cancelable: true });

    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files, items: [], dropEffect: 'none' } });

    return event;
}

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
});

afterEach(() => {
    act(() => reactRoot.unmount());
    container.remove();
    store.dispose();
});

describe('a chat on a provider that cannot run', () => {
    it('shows the notice in place of the message box and keeps the conversation readable', async () => {
        await start(claudeOff);
        await draw('c-1');

        expect(notice()).not.toBeNull();
        expect(notice()!.textContent).toContain('Claude Code is turned off in Clowdy');
        expect(notice()!.textContent).toContain('The conversation stays readable');
        expect(field()).toBeNull();
        expect(button('Hand off to a new chat')).toBeDefined();
        expect(button('Open Providers')).toBeDefined();

        // The messages are still there, above the notice.
        expect(container.textContent).toContain('Simplify the booking flow: one form instead of three steps');
        expect(container.textContent).toContain('Executor 07 is on the form');
    });

    it('says why for each reason', async () => {
        await start((agents) => {
            agents.find(agent => agent.id === 'claude')!.signIn = { status: 'signed-out', checkedAt: 1 };
        });
        await draw('c-1');

        expect(notice()!.textContent).toContain('Claude Code is not signed in');
    });

    it('opens Settings on Providers from Open Providers', async () => {
        await start(claudeOff);
        await draw('c-1');

        expect(store.ui.settingsOpen).toBe(false);

        await act(async () => button('Open Providers')!.click());

        expect(store.ui.settingsOpen).toBe(true);
        expect(store.ui.settingsPage).toBe('providers');
    });

    it('opens the new-chat page with the conversation attached from Hand off to a new chat', async () => {
        await start(claudeOff);
        await draw('c-1');

        expect(ui().draft).toBe(false);

        await act(async () => button('Hand off to a new chat')!.click());

        expect(ui().draft).toBe(true);
        expect(ui().pendingFiles.map(file => file.name)).toEqual(['simplify-booking-conversation.md']);
    });

    it('takes no files: no veil while files are dragged over, and a drop or a paste adds nothing', async () => {
        await start(claudeOff);
        await draw('c-1');

        const zone = notice()!.closest('[class*="zone"]')!;
        const file = new File(['a'], 'a.txt');

        await act(async () => void zone.dispatchEvent(dragEvent('dragenter')));

        expect(container.textContent).not.toContain('Drop files');

        const drop = dragEvent('drop', [file]);

        await act(async () => void zone.dispatchEvent(drop));

        expect(container.textContent).not.toContain('a.txt');
        expect(drop.defaultPrevented).toBe(false);
    });

    it('is a named region whose message is announced and whose buttons come in the order of their weight', async () => {
        await start(claudeOff);
        await draw('c-1');

        expect(notice()!.tagName).toBe('SECTION');

        // Only the words are the live part: a button that starts to spin or a Stop that comes and goes is not read out again.
        const announced = notice()!.querySelector('[role="status"]')!;

        expect(announced.textContent).toContain('Claude Code is turned off in Clowdy');
        expect(announced.querySelector('button')).toBeNull();

        // The buttons are named by their words, and the first one to reach with the keyboard is the way on the owner asked for.
        expect([...notice()!.querySelectorAll('button')].map(candidate => candidate.textContent)).toEqual(['Hand off to a new chat', 'Open Providers', 'Stop']);
    });

    it('offers Stop while the orchestrator still works, and sends the same command as the message box', async () => {
        await start(claudeOff);
        await draw('c-1');

        const command = vi.spyOn(store, 'command');

        expect(store.selectedProject!.runs.get('r-orch-1')!.status).toBe('running');

        await act(async () => noticeButton('Stop')!.click());

        expect(command).toHaveBeenCalledWith({ type: 'run.cancel', runId: 'r-orch-1' });

        // The run ends, and the way to stop it goes with it.
        await draw('c-1');

        expect(noticeButton('Stop')).toBeUndefined();
        expect(button('Hand off to a new chat')).toBeDefined();
    });

    it('has no Stop when the orchestrator is not working', async () => {
        await start(claudeOff, (fixtures) => {
            fixtures.runs.find(run => run.id === 'r-orch-1')!.status = 'succeeded';
        });
        await draw('c-1');

        expect(notice()).not.toBeNull();
        expect(noticeButton('Stop')).toBeUndefined();
    });

    it('does not take the person to the new-chat page when they left the chat while the hand-off was loading', async () => {
        await start(claudeOff);

        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        // Only the chat's own stream is held: the strip above the notice reads the streams of the agents at work.
        vi.spyOn(transport, 'getItems').mockImplementation(async (...args) => {
            if ('runId' in args[0] && args[0].runId === 'r-orch-1') await gate;

            return FixtureTransport.prototype.getItems.apply(transport, args);
        });

        await render('c-1');
        await act(async () => button('Hand off to a new chat')!.click());
        // On to another chat before the conversation has come.
        await render('c-3');
        await act(async () => release());

        expect(ui().draft).toBe(false);
        expect(ui().pendingFiles).toEqual([]);
    });

    it('brings the message box back when the person has signed in again, on the next reading of the agents', async () => {
        await start((agents) => {
            agents.find(agent => agent.id === 'claude')!.signIn = { status: 'signed-out', checkedAt: 1 };
        });
        await draw('c-1');

        expect(notice()!.textContent).toContain('Claude Code is not signed in');

        data.agents.find(agent => agent.id === 'claude')!.signIn = { status: 'signed-in', account: { email: 'dev@example.com' }, checkedAt: 2 };
        await act(async () => store.refreshAgents());
        await draw('c-1');

        expect(notice()).toBeNull();
        expect(field()).not.toBeNull();
    });

    it('brings the message box back when the provider is switched on again', async () => {
        await start(claudeOff);
        await draw('c-1');

        expect(field()).toBeNull();

        await act(async () => {
            await store.command({ type: 'agent.update', id: 'claude', enabled: true });
            await store.refreshAgents();
        });
        await draw('c-1');

        expect(notice()).toBeNull();
        expect(field()).not.toBeNull();
    });
});

describe('a chat that can be written to', () => {
    it('shows the message box and no notice when the provider is ready', async () => {
        await start();
        await draw('c-1');

        expect(notice()).toBeNull();
        expect(field()).not.toBeNull();
    });

    it('does not flash the notice while the agents are still loading', async () => {
        await start(claudeOff);
        store.agentsStatus = 'loading';
        await draw('c-1');

        expect(notice()).toBeNull();
        expect(field()).not.toBeNull();
    });

    it('keeps the message box for a chat with no orchestrator yet, whatever its provider', async () => {
        await start((agents) => {
            claudeOff(agents);
            agents.find(agent => agent.id === 'codex')!.status = 'missing';
        });
        await draw('c-4');

        expect(notice()).toBeNull();
        expect(field()).not.toBeNull();
    });
});

describe('a chat whose conversation outgrew the context window', () => {
    const OVERFLOW = 'The conversation no longer fits the model\'s context window. Start a new chat.';

    /** The second fixture chat's orchestrator failed its last turn with `failure`, and its stream ends on the error. */
    const failed = (failure?: string) => (fixture: FixtureData) => {
        const run = fixture.runs.find(candidate => candidate.id === 'r-orch-2')!;
        const items = fixture.items['r-orch-2']!;

        run.status = 'failed';
        run.error = OVERFLOW;

        if (failure) run.failureCode = failure;

        items.push({ id: 'r-orch-2-overflow', runId: 'r-orch-2', seq: items.length + 1, at: Date.now(), body: { kind: 'error', text: OVERFLOW } });
    };
    const alertOf = () => [...container.querySelectorAll<HTMLElement>('[role="alert"]')].find(candidate => candidate.textContent?.includes('no longer fits'));

    it('offers Compact on the failure, which compacts the chat', async () => {
        await start(undefined, failed('context_too_long'));
        await draw('c-2');

        const compact = [...alertOf()!.querySelectorAll('button')].find(candidate => candidate.textContent === 'Compact');
        const command = vi.spyOn(store, 'command');

        await act(async () => compact!.click());

        expect(command).toHaveBeenCalledWith({ type: 'chat.compact', chatId: 'c-2' });

        // The compact turn starts, and the failure no longer offers it.
        await draw('c-2');

        expect(alertOf()?.querySelector('button')).toBeFalsy();
    });

    it('offers nothing for another failure, or for an agent that cannot compact', async () => {
        await start(undefined, failed());
        await draw('c-2');

        expect(alertOf()).toBeDefined();
        expect(alertOf()!.querySelector('button')).toBeNull();

        await start((agents) => {
            delete agents.find(agent => agent.id === 'claude')!.canCompact;
        }, failed('context_too_long'));
        await draw('c-2');

        expect(alertOf()!.querySelector('button')).toBeNull();
    });
});
