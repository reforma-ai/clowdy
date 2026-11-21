// @vitest-environment happy-dom
import { emptyComposerDoc } from '@clowdy/components/RichInput';
import { toast } from '@clowdy/components/Toast';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_FORK_CHAT_ID, FIXTURE_PROJECT_ID, withFixtureFork, type FixtureData } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { ChatView } from './ChatView';
import { saveDraft } from './composerDrafts';

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
        expect(container.textContent).toContain('A sub-agent is on the form');
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
    const OVERFLOW = 'The conversation no longer fits the model\'s context window. Compact it or start a new chat.';

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

describe('a chat whose orchestrator waits for background work', () => {
    it('counts what is open above the message box, says what it waits for at the end of the stream, and leaves the message box to use', async () => {
        await start();
        await draw('c-5');

        // The first command can be stopped alone and has a row of its own; the other is counted.
        expect([...container.querySelectorAll('[aria-label="Work in progress"] > div')].map(row => row.textContent)).toEqual(['Command · bun run testStop', 'Background task runningStop']);
        expect(container.textContent).toContain('Waiting for background work…');
        expect(notice()).toBeNull();
        expect(field()).not.toBeNull();
    });

    it('draws neither once the run has been stopped', async () => {
        await start();
        await draw('c-5');
        await act(async () => {
            await store.command({ type: 'run.cancel', runId: 'r-orch-5' });
        });
        await vi.waitFor(() => expect(store.selectedProject!.runs.get('r-orch-5')?.status).toBe('cancelled'));
        await draw('c-5');

        expect(container.querySelector('[aria-label="Work in progress"]')).toBeNull();
        expect(container.textContent).not.toContain('Waiting for background work…');
    });
});

describe('a thread', () => {
    const crumb = () => container.querySelector<HTMLElement>('nav[aria-label="Parent chat"]');

    it('has a line over its stream that names the chat it belongs to, whose title opens that chat', async () => {
        await start();
        await draw('c-6a1');

        expect(crumb()?.textContent).toBe('Thread of Fix the price rounding');

        await act(async () => [...crumb()!.querySelectorAll('button')].find(candidate => candidate.textContent === 'Fix the price rounding')!.click());

        await vi.waitFor(() => expect(ui().chatId).toBe('c-6a'));
    });

    it('is a chat like any other: a message box, and the cards of the messages its parent sent', async () => {
        await start();
        await draw('c-6b');

        expect(field()).not.toBeNull();
        expect(container.querySelector('[data-slot="thread-message"]')?.textContent).toContain('Message from Ship the checkout');
    });

    it('sends what the person writes to the thread itself', async () => {
        await start();
        await draw('c-6b');

        const command = vi.spyOn(store, 'command');

        await act(async () => {
            (container.querySelector('[contenteditable="true"]') as HTMLElement & { editor: { commands: { insertContent: (text: string) => void } } }).editor.commands.insertContent('One more case');
        });
        await act(async () => {
            field()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        });

        expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.send', chatId: 'c-6b', text: 'One more case' }));
    });

    it('has no such line on a chat the person made', async () => {
        await start();
        await draw('c-6');

        expect(crumb()).toBeNull();
        // Its threads at work are rows above the message box.
        expect(container.querySelector('[aria-label="Work in progress"]')?.textContent).toContain('Fix the price rounding');
    });
});

describe('the messages of a chat', () => {
    // The row under a message: the time it was written beside Copy.
    const rows = () => [...container.querySelectorAll<HTMLElement>('time')].map(time => time.parentElement as HTMLElement);
    const rowOf = (words: string) => rows().find(row => row.parentElement?.textContent?.includes(words));

    it('have a row under what the person wrote and under the answer of a finished turn, the last one always showing', async () => {
        await start();
        await draw('c-2');

        const asked = rowOf('Build the first version');
        const answered = rowOf('The booking page, the fleet list and the price calculation are in.');

        expect(asked?.dataset.align).toBe('end');
        expect(answered?.dataset.align).toBe('start');
        expect(rows()).toHaveLength(2);
        expect(asked?.dataset.show).toBe('hover');
        expect(answered?.dataset.show).toBe('always');
        // Days old: the day is in the time, not the clock alone (the year too in the first days of January, `Sept` in September).
        expect(answered?.querySelector('time')?.textContent).toMatch(/^\d{1,2} \p{L}{3,4}( \d{4})?, \d{2}:\d{2}$/u);
        // Copy is on the row.
        expect(asked?.querySelector('[aria-label="Copy message"]')).not.toBeNull();
    });

    it('have no row under what a thread wrote to the chat or under the notice of threads that stopped', async () => {
        await start();
        await draw('c-6');

        // The chat's own message has its row, and the answer that ends each of the three turns has one: the thread's words and the notice have none.
        expect(rowOf('Ship the new checkout')?.dataset.align).toBe('end');
        expect(rowOf('The rounding helper is shared with the invoices')).toBeUndefined();
        expect(rowOf('Write the refund tests')).toBeUndefined();
        expect(rowOf('Four threads are working.')?.dataset.align).toBe('start');
        expect(rowOf('The refund tests are in.')?.dataset.align).toBe('start');
        expect(rowOf('I told the rounding thread')?.dataset.show).toBe('always');
        expect(rows()).toHaveLength(4);
    });
});

describe('Reply in a chat', () => {
    const reply = (words: string) => [...container.querySelectorAll<HTMLElement>('time')]
        .map(time => time.parentElement as HTMLElement)
        .find(row => row.parentElement?.textContent?.includes(words))
        ?.querySelector<HTMLButtonElement>('button[aria-label="Reply"]');
    const editor = () => (field() as HTMLElement & { editor: { getText: (options?: { blockSeparator?: string }) => string } }).editor;
    const written = () => editor().getText({ blockSeparator: '\n' });

    // What is typed and not sent is kept per chat for the whole session.
    beforeEach(() => saveDraft('c-2', emptyComposerDoc()));

    it('puts the message under Reply into the message box as a quote, the caret on the line below it', async () => {
        await start();
        await draw('c-2');
        await act(async () => reply('Build the first version')!.click());

        expect(written()).toMatch(/^> Build the first version/);
        expect(document.activeElement).toBe(field());
    });

    it('quotes an answer as it was written too, under what is already typed', async () => {
        await start();
        await draw('c-2');
        await act(async () => {
            (field() as HTMLElement & { editor: { commands: { insertContent: (text: string) => void } } }).editor.commands.insertContent('See this');
        });
        await act(async () => reply('The booking page, the fleet list and the price calculation are in.')!.click());

        expect(written()).toMatch(/^See this\n> The booking page, the fleet list and the price calculation are in\./);
    });

    it('has no Reply in a chat that is read only, where the message box is gone: Copy stays', async () => {
        await start(claudeOff);
        await draw('c-2');

        expect(field()).toBeNull();
        expect(container.querySelector('button[aria-label="Reply"]')).toBeNull();
        expect(container.querySelector('button[aria-label="Copy message"]')).not.toBeNull();
    });

    it('quotes the words selected inside one message from the toolbar, and collapses the selection', async () => {
        const frames: FrameRequestCallback[] = [];

        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
        vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(() => [{ left: 10, right: 90, top: 100, bottom: 120, width: 80, height: 20 }] as unknown as DOMRectList);
        vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(() => ({ left: 10, right: 90, top: 100, bottom: 120, width: 80, height: 20 }) as DOMRect);

        try {
            await start();
            await draw('c-2');

            const walker = document.createTreeWalker(container.querySelector('[data-message]')!, NodeFilter.SHOW_TEXT);
            let node = walker.nextNode()!;

            while (!node.textContent?.includes('Build the first version')) node = walker.nextNode()!;

            const range = document.createRange();

            range.setStart(node, 6);
            range.setEnd(node, 15);
            window.getSelection()!.removeAllRanges();
            window.getSelection()!.addRange(range);
            document.dispatchEvent(new Event('selectionchange'));
            await act(async () => frames.splice(0).forEach(callback => callback(0)));
            await act(async () => document.body.querySelector<HTMLButtonElement>('[role="toolbar"] button')!.click());
            // The editor takes the focus on a frame of its own.
            await act(async () => frames.splice(0).forEach(callback => callback(0)));

            expect(written()).toBe(`> ${ node.textContent!.slice(6, 15) }\n`);
            expect(window.getSelection()!.isCollapsed).toBe(true);
            expect(document.activeElement).toBe(field());
            expect(document.body.querySelector('[role="toolbar"]')).toBeNull();
        }
        finally {
            window.getSelection()!.removeAllRanges();
            vi.unstubAllGlobals();
            vi.restoreAllMocks();
        }
    });
});

describe('Fork in a chat', () => {
    // The fork chat of the fixtures (c-7) is a fork of First version (c-2) at its final answer, which is the one answer that can be forked.
    const withFork = (fixtures: FixtureData) => void withFixtureFork(fixtures);
    const forkButtons = () => [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Fork into new chat"]')];
    const divider = () => container.querySelector<HTMLElement>('[data-slot="fork-divider"]');
    const ANSWER = 'The booking page, the fleet list and the price calculation are in.';
    const refusal = { ok: false as const, requestId: 'x', error: { code: 'unavailable' as const, message: 'Claude Code is switched off' } };

    /** Holds the answer to `chat.fork` until `release`, and lets every other command through. */
    function holdFork(result?: Awaited<ReturnType<RootStore['command']>>) {
        const command = store.command.bind(store);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const spy = vi.spyOn(store, 'command').mockImplementation(async (input) => {
            if (input.type !== 'chat.fork') return command(input);

            await gate;

            return result ?? command(input);
        });

        return { spy, release, forks: () => spy.mock.calls.filter(([input]) => input.type === 'chat.fork') };
    }

    beforeEach(() => vi.mocked(toast.error).mockClear());

    it('draws a Fork under the answer the daemon marked and nowhere else', async () => {
        await start(undefined, withFork);
        await draw('c-2');

        expect(forkButtons()).toHaveLength(1);

        const row = forkButtons()[0].closest('[data-message]')!;

        expect(row.textContent).toContain(ANSWER);
        // Reply stays before it.
        expect([...row.querySelectorAll('button')].map(node => node.getAttribute('aria-label'))).toEqual(['Copy message', 'Reply', 'Fork into new chat']);
    });

    it('draws none in a chat whose answers carry no flag', async () => {
        await start(undefined, withFork);
        await draw('c-1');

        expect(container.querySelectorAll('[data-message]').length).toBeGreaterThan(0);
        expect(forkButtons()).toHaveLength(0);
    });

    it('draws none in a chat that is read only, where a fork could not be gone on in', async () => {
        await start(claudeOff, withFork);
        await draw('c-2');

        expect(container.querySelector('button[aria-label="Copy message"]')).not.toBeNull();
        expect(forkButtons()).toHaveLength(0);
    });

    it('sends chat.fork with the chat and the answer, and opens the new chat', async () => {
        await start(undefined, withFork);
        await draw('c-2');

        const command = vi.spyOn(store, 'command');
        const answer = data.items['r-orch-2'][5];

        await act(async () => forkButtons()[0].click());

        expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.fork', chatId: 'c-2', itemId: answer.id }));

        const opened = ui().chatId!;

        // Not the fork the fixtures hold (c-7): the one the press made.
        expect(opened).not.toBe('c-2');
        expect(opened).not.toBe(FIXTURE_FORK_CHAT_ID);
        expect(chatOf(opened)).toMatchObject({ title: '(1) First version', forkedFrom: { chatId: 'c-2', atSeq: answer.seq } });
        expect(ui().section).toBe('agents');
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('shows the daemon\'s words when it refuses, and stays on the chat', async () => {
        await start(undefined, withFork);
        await draw('c-2');
        holdFork(refusal).release();

        const before = ui().chatId;

        await act(async () => forkButtons()[0].click());

        expect(toast.error).toHaveBeenCalledExactlyOnceWith({ message: 'Claude Code is switched off' });
        expect(ui().chatId).toBe(before);
        expect(forkButtons()[0].hasAttribute('data-pending')).toBe(false);
    });

    it('says it could not fork when the refusal has no words', async () => {
        await start(undefined, withFork);
        await draw('c-2');
        holdFork({ ...refusal, error: { ...refusal.error, message: '' } }).release();
        await act(async () => forkButtons()[0].click());

        expect(toast.error).toHaveBeenCalledExactlyOnceWith({ message: 'Couldn\'t fork the chat' });
    });

    it('spins while the command runs, takes no second press, and lets the person fork again afterwards', async () => {
        await start(undefined, withFork);
        await draw('c-2');

        const held = holdFork(refusal);

        await act(async () => forkButtons()[0].click());

        expect(forkButtons()[0].hasAttribute('data-pending')).toBe(true);

        await act(async () => forkButtons()[0].click());

        expect(held.forks()).toHaveLength(1);

        await act(async () => held.release());

        expect(forkButtons()[0].hasAttribute('data-pending')).toBe(false);

        await act(async () => forkButtons()[0].click());

        expect(held.forks()).toHaveLength(2);
    });

    it('waits for the store to know the new chat before it opens it', async () => {
        await start(undefined, withFork);
        await draw('c-2');

        // The answer to the command comes before the event that adds the chat to the store.
        const late = { ...chatOf(FIXTURE_FORK_CHAT_ID), id: 'c-late' };

        holdFork({ ok: true, requestId: 'x', data: { chat: late } }).release();

        const before = ui().chatId;

        await act(async () => forkButtons()[0].click());

        expect(ui().chatId).toBe(before);

        const project = store.selectedProject!;

        await act(async () => project.applyEvent({ cursor: project.cursor + 1, at: 1, projectId: FIXTURE_PROJECT_ID, data: { type: 'chat.upserted', chat: late } }));

        await vi.waitFor(() => expect(ui().chatId).toBe('c-late'));
    });

    it('sends one fork for two presses made before the button has drawn its spinner', async () => {
        await start(undefined, withFork);
        await draw('c-2');

        const held = holdFork(refusal);

        // Both clicks land in one batch of updates, so the second sees a button that does not yet know a fork has started.
        await act(async () => {
            forkButtons()[0].click();
            forkButtons()[0].click();
        });

        expect(held.forks()).toHaveLength(1);

        await act(async () => held.release());
    });

    it('opens the new chat anyway when the event feed has not brought it after five seconds', async () => {
        await start(undefined, withFork);
        await draw('c-2');

        const late = { ...chatOf(FIXTURE_FORK_CHAT_ID), id: 'c-late' };

        holdFork({ ok: true, requestId: 'x', data: { chat: late } }).release();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        try {
            await act(async () => forkButtons()[0].click());
            await act(async () => vi.advanceTimersByTimeAsync(4900));

            expect(ui().chatId).not.toBe('c-late');

            await act(async () => vi.advanceTimersByTimeAsync(200));

            expect(ui().chatId).toBe('c-late');
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('does not take the person to the new chat when they left the chat while it was being made', async () => {
        await start(undefined, withFork);
        await draw('c-2');

        const held = holdFork();

        await act(async () => forkButtons()[0].click());
        await render('c-3');

        const before = ui().chatId;

        await act(async () => held.release());

        expect(ui().chatId).toBe(before);
        // The chat was made all the same.
        expect([...store.selectedProject!.chats.values()].some(chat => chat.forkedFrom?.chatId === 'c-2' && chat.id !== FIXTURE_FORK_CHAT_ID)).toBe(true);
    });

    describe('the divider', () => {
        it('stands where the inherited history ends, after the answer the chat was forked at and before its own first message', async () => {
            await start(undefined, withFork);
            await draw(FIXTURE_FORK_CHAT_ID);

            expect(divider()?.textContent).toBe('Forked from First version');
            expect(divider()?.previousElementSibling?.textContent).toContain(ANSWER);
            expect(divider()?.nextElementSibling?.textContent).toContain('Add the weekend surcharge to the price.');
        });

        it('opens the source chat from its title', async () => {
            await start(undefined, withFork);
            await draw(FIXTURE_FORK_CHAT_ID);
            await act(async () => divider()!.querySelector('button')!.click());

            await vi.waitFor(() => expect(ui().chatId).toBe('c-2'));
        });

        it('names a source that is in the archive without opening it', async () => {
            await start(undefined, (fixtures) => {
                withFixtureFork(fixtures);
                fixtures.chats.find(chat => chat.id === 'c-2')!.archivedAt = 1;
            });
            await draw(FIXTURE_FORK_CHAT_ID);

            expect(divider()?.textContent).toBe('Forked from First version');
            expect(divider()?.querySelector('button')).toBeNull();
        });

        it('says only Forked once the source is gone', async () => {
            await start(undefined, (fixtures) => {
                withFixtureFork(fixtures);
                fixtures.chats.splice(fixtures.chats.findIndex(chat => chat.id === 'c-2'), 1);
            });
            await draw(FIXTURE_FORK_CHAT_ID);

            expect(divider()?.textContent).toBe('Forked');
            expect(divider()?.querySelector('button')).toBeNull();
        });

        it('is drawn in a chat that is read only too', async () => {
            await start(claudeOff, withFork);
            await draw(FIXTURE_FORK_CHAT_ID);

            expect(divider()?.textContent).toBe('Forked from First version');
            expect(forkButtons()).toHaveLength(0);
        });

        it('is not drawn in a chat that was not forked, the source of a fork included', async () => {
            await start(undefined, withFork);
            await draw('c-2');

            expect(divider()).toBeNull();
        });

        it('shows the fork the person just made, with the divider after the answer they forked at', async () => {
            await start(undefined, withFork);
            await draw('c-2');
            await act(async () => forkButtons()[0].click());

            const made = ui().chatId!;

            await draw(made);

            expect(divider()?.textContent).toBe('Forked from First version');
            expect(divider()?.previousElementSibling?.textContent).toContain(ANSWER);
            // Nothing of its own yet: the divider is the end of the list.
            expect(divider()?.nextElementSibling).toBeNull();
        });
    });
});
