// @vitest-environment happy-dom
import { emptyComposerDoc } from '@clowdy/components/RichInput';
import { toast } from '@clowdy/components/Toast';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_APPROVALS_CHAT_ID, FIXTURE_FORK_CHAT_ID, FIXTURE_PROJECT_ID, withFixtureApprovals, withFixtureFork, type FixtureData } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { SWIPE } from '../../stream/swipeReply';
import { ChatView } from './ChatView';
import { draftOf, editDraftKey, messageOf, saveDraft } from './composerDrafts';
import { filesOf } from './composerFiles';
import { dropReplyQuote } from './composerQuotes';
import { swipeToReply } from './swipeReplyPreference';

import type { Attachment, CommandResult, StreamItem, StreamItemBody } from '@clowdy/protocol';
import type { Editor } from '@tiptap/core';
import type { ReactNode } from 'react';
import type { CommandInput } from '../../daemon/transport';
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

const render = (chatId: string, controls?: ReactNode) => act(async () => {
    reactRoot.render(<RootStoreProvider value={ store }><ChatView key={ chatId } chat={ chatOf(chatId) } controls={ controls } /></RootStoreProvider>);
});

/** Draws the chat, then again once its messages have been fetched. */
async function draw(chatId: string, controls?: ReactNode) {
    await render(chatId, controls);
    await render(chatId, controls);
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

describe('the line under the message box', () => {
    const line = () => container.querySelector<HTMLElement>('[data-testid="line"]');

    it('holds what the caller gives it, below the message box', async () => {
        await start();
        await draw('c-1', <span data-testid="line">Where it works</span>);

        expect(line()?.textContent).toBe('Where it works');
        expect(field()!.compareDocumentPosition(line()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('is there under the notice of a chat that is read only, and not there when the caller gives nothing', async () => {
        await start(claudeOff);
        await draw('c-1', <span data-testid="line">Where it works</span>);

        expect(notice()).not.toBeNull();
        expect(notice()!.compareDocumentPosition(line()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        await draw('c-1');

        expect(line()).toBeNull();
    });
});

describe('the strip of git over the message box', () => {
    const strip = () => container.querySelector<HTMLElement>('[aria-label="Pull request and changes"]');
    const withPullRequest = (data: FixtureData) => {
        data.pullRequests['/Users/dev/car-rental'] = { checkout: 'open' };
    };

    it('stands over the message box, under the agents at work', async () => {
        await start(undefined, withPullRequest);
        await draw('c-1');
        await render('c-1');

        expect(strip()?.textContent).toContain('PR #128Open');
        expect(strip()!.compareDocumentPosition(field()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(container.querySelector('[aria-label="Work in progress"]')!.compareDocumentPosition(strip()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('is there over the notice of a chat that is read only, as the line under it is', async () => {
        await start(claudeOff, withPullRequest);
        await draw('c-1');
        await render('c-1');

        expect(notice()).not.toBeNull();
        expect(strip()?.textContent).toContain('PR #128Open');
        expect(strip()!.compareDocumentPosition(notice()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('is not there when the branch has nothing to say', async () => {
        await start();
        await draw('c-1');
        await render('c-1');

        expect(strip()).toBeNull();
    });
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
    it('counts what is open above the message box, shows no live line at the end of the stream, and leaves the message box to use', async () => {
        await start();
        await draw('c-5');

        // The first command can be stopped alone and has a row of its own; the other is counted.
        expect([...container.querySelectorAll('[aria-label="Work in progress"] > div')].map(row => row.textContent)).toEqual(['Command · bun run testStop', 'Background task runningStop']);
        expect(container.textContent).not.toContain('Waiting for background work…');
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

    const card = () => container.querySelector<HTMLElement>('[role="group"][aria-label^="Replying to"]');
    const wheel = (target: Element, deltaX: number) => target.dispatchEvent(new WheelEvent('wheel', { deltaX, deltaY: 0, bubbles: true, cancelable: true }));
    // A swipe replies when it is over, once the wheel has been quiet for a while.
    const quiet = () => act(async () => {
        await new Promise(resolve => setTimeout(resolve, SWIPE.idleMs + 50));
    });

    // What is typed and not sent, and the message replied to, are kept per chat for the whole session.
    beforeEach(() => {
        saveDraft('c-2', emptyComposerDoc());
        dropReplyQuote('c-2');
        swipeToReply.setEnabled(true);
    });

    afterEach(() => {
        dropReplyQuote('c-2');
        swipeToReply.setEnabled(true);
    });

    it('puts the message under Reply above the message box as a card, with the focus in the box and nothing in the draft', async () => {
        await start();
        await draw('c-2');
        await act(async () => reply('Build the first version')!.click());

        expect(card()?.textContent).toContain('You');
        expect(card()?.textContent).toContain('Build the first version');
        expect(written()).toBe('');
        expect(messageOf(draftOf('c-2'))).toBe('');
        expect(document.activeElement).toBe(field());
    });

    it('replies to an answer as it was written too, named by its agent, in place of the first card and beside what is already typed', async () => {
        await start();
        await draw('c-2');
        await act(async () => reply('Build the first version')!.click());
        await act(async () => {
            (field() as HTMLElement & { editor: { commands: { insertContent: (text: string) => void } } }).editor.commands.insertContent('See this');
        });
        await act(async () => reply('The booking page, the fleet list and the price calculation are in.')!.click());

        expect(container.querySelectorAll('[role="group"][aria-label^="Replying to"]')).toHaveLength(1);
        expect(card()?.getAttribute('aria-label')).toBe('Replying to Claude Code');
        expect(card()?.textContent).toContain('The booking page, the fleet list and the price calculation are in.');
        expect(written()).toBe('See this');
    });

    it('sends the card as a quote in front of what was typed', async () => {
        await start();
        await draw('c-2');

        const send = vi.spyOn(store, 'command');

        await act(async () => reply('The booking page, the fleet list and the price calculation are in.')!.click());
        await act(async () => {
            (field() as HTMLElement & { editor: { commands: { insertContent: (text: string) => void } } }).editor.commands.insertContent('Now the invoices');
        });
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click());

        expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.send', chatId: 'c-2', text: '> The booking page, the fleet list and the price calculation are in.\n\nNow the invoices' }));
        expect(card()).toBeNull();
    });

    it('takes a long swipe to the left, let go, for a press on its Reply: the card of that message, and none for a swipe to the right', async () => {
        await start();
        await draw('c-2');

        const message = [...container.querySelectorAll<HTMLElement>('[data-message]')].find(node => node.textContent?.includes('Build the first version'))!;

        for (let i = 0; i < 30; i++) wheel(message, -10);

        await quiet();

        expect(card()).toBeNull();

        for (let i = 0; i < 30; i++) wheel(message, 10);

        // Not yet: the fingers may still be moving.
        expect(card()).toBeNull();

        await quiet();

        expect(card()?.textContent).toContain('You');
        expect(card()?.textContent).toContain('Build the first version');
        expect(message.style.translate).toBe('');
    });

    it('has no swipe once the setting is off: the message stays where it is, the wheel is not taken and no card comes', async () => {
        swipeToReply.setEnabled(false);
        await start();
        await draw('c-2');

        const message = container.querySelector<HTMLElement>('[data-message]')!;
        const events = Array.from({ length: 30 }, () => wheel(message, 10));

        // Long enough for a swipe that was taken to have replied.
        await quiet();

        expect(events.every(taken => taken)).toBe(true);
        expect(card()).toBeNull();
        expect(message.style.translate).toBe('');
        // The button still replies.
        await act(async () => reply('Build the first version')!.click());

        expect(card()).not.toBeNull();
    });

    it('has no Reply in a chat that is read only, where the message box is gone: Copy stays', async () => {
        await start(claudeOff);
        await draw('c-2');

        expect(field()).toBeNull();
        expect(container.querySelector('button[aria-label="Reply"]')).toBeNull();
        expect(container.querySelector('button[aria-label="Copy message"]')).not.toBeNull();

        // No swipe either: there is no box to reply into.
        const message = container.querySelector<HTMLElement>('[data-message]')!;
        const events = Array.from({ length: 30 }, () => wheel(message, 10));

        await quiet();

        expect(events.some(event => !event)).toBe(false);
        expect(message.style.translate).toBe('');
        expect(card()).toBeNull();
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
    const forkButtons = () => [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Fork"]')];
    const menuItems = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const menuItem = (name: string) => menuItems().find(row => row.textContent?.startsWith(name))!;
    /** A press with a mouse: what React Aria opens a menu on and picks an item with. */
    const press = (target: HTMLElement) => act(async () => {
        target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        target.click();
    });
    /** Opens the Fork menu of the first answer that can be forked and presses Fork in it. */
    const fork = async () => {
        await press(forkButtons()[0]);
        await press(menuItem('Fork'));
    };
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
        // Reply and Copy stay before it.
        expect([...row.querySelectorAll('button')].map(node => node.getAttribute('aria-label'))).toEqual(['Reply', 'Copy message', 'Fork']);
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

        await fork();

        expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.fork', chatId: 'c-2', itemId: answer.id }));

        const opened = ui().chatId!;

        // Not the fork the fixtures hold (c-7): the one the press made.
        expect(opened).not.toBe('c-2');
        expect(opened).not.toBe(FIXTURE_FORK_CHAT_ID);
        expect(chatOf(opened)).toMatchObject({ title: '(1) First version', forkedFrom: { chatId: 'c-2', atSeq: answer.seq } });
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('shows the daemon\'s words when it refuses, and stays on the chat', async () => {
        await start(undefined, withFork);
        await draw('c-2');
        holdFork(refusal).release();

        const before = ui().chatId;

        await fork();

        expect(toast.error).toHaveBeenCalledExactlyOnceWith({ message: 'Claude Code is switched off' });
        expect(ui().chatId).toBe(before);
        expect(forkButtons()[0].hasAttribute('data-pending')).toBe(false);
    });

    it('says it could not fork when the refusal has no words', async () => {
        await start(undefined, withFork);
        await draw('c-2');
        holdFork({ ...refusal, error: { ...refusal.error, message: '' } }).release();
        await fork();

        expect(toast.error).toHaveBeenCalledExactlyOnceWith({ message: 'Couldn\'t fork the chat' });
    });

    it('spins while the command runs, takes no second press, and lets the person fork again afterwards', async () => {
        await start(undefined, withFork);
        await draw('c-2');

        const held = holdFork(refusal);

        await fork();

        expect(forkButtons()[0].hasAttribute('data-pending')).toBe(true);

        // The button that spins opens no menu, so there is no second fork to press.
        await press(forkButtons()[0]);

        expect(menuItems()).toEqual([]);
        expect(held.forks()).toHaveLength(1);

        await act(async () => held.release());

        expect(forkButtons()[0].hasAttribute('data-pending')).toBe(false);

        await fork();

        expect(held.forks()).toHaveLength(2);
    });

    it('waits for the store to know the new chat before it opens it', async () => {
        await start(undefined, withFork);
        await draw('c-2');

        // The answer to the command comes before the event that adds the chat to the store.
        const late = { ...chatOf(FIXTURE_FORK_CHAT_ID), id: 'c-late' };

        holdFork({ ok: true, requestId: 'x', data: { chat: late } }).release();

        const before = ui().chatId;

        await fork();

        expect(ui().chatId).toBe(before);

        const project = store.selectedProject!;

        await act(async () => project.applyEvent({ cursor: project.cursor + 1, at: 1, projectId: FIXTURE_PROJECT_ID, data: { type: 'chat.upserted', chat: late } }));

        await vi.waitFor(() => expect(ui().chatId).toBe('c-late'));
    });

    it('sends one fork for two presses of Fork made before the button has drawn its spinner', async () => {
        await start(undefined, withFork);
        await draw('c-2');

        const held = holdFork(refusal);

        await press(forkButtons()[0]);

        const item = menuItem('Fork');

        // Both presses land in one batch of updates, so the second sees a button that does not yet know a fork has started.
        await act(async () => {
            item.click();
            item.click();
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
            await fork();
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

        await fork();
        await render('c-3');

        const before = ui().chatId;

        await act(async () => held.release());

        expect(ui().chatId).toBe(before);
        // The chat was made all the same.
        expect([...store.selectedProject!.chats.values()].some(chat => chat.forkedFrom?.chatId === 'c-2' && chat.id !== FIXTURE_FORK_CHAT_ID)).toBe(true);
    });

    describe('to another agent', () => {
        const agentRows = () => [...document.body.querySelectorAll<HTMLElement>('[role="menu"][aria-label="Hand off to another agent"] [role="menuitem"]')].map(row => row.textContent);
        const openAgents = async (index = 0) => {
            await press(forkButtons()[index]);
            await press(menuItem('Hand off to another agent'));
        };
        const change = (id: string, edit: (agent: FixtureData['agents'][number]) => void) => (agents: FixtureData['agents']) => edit(agents.find(agent => agent.id === id)!);
        const files = () => ui().pendingFiles;

        it('lists the signed-in agents other than the chat\'s own, with their marks', async () => {
            await start(undefined, withFork);
            await draw('c-2');
            await openAgents();

            expect(agentRows()).toEqual(['Codex', 'Cursor']);
            expect(document.body.querySelectorAll('[role="menu"][aria-label="Hand off to another agent"] svg').length).toBeGreaterThanOrEqual(2);
        });

        it('leaves out an agent that is signed out or switched off', async () => {
            await start((agents) => {
                change('codex', (codex) => {
                    codex.signIn = { status: 'signed-out', checkedAt: 0 };
                })(agents);
            }, withFork);
            await draw('c-2');
            await openAgents();

            expect(agentRows()).toEqual(['Cursor']);
        });

        it('turns the item off, with the reason under it, when no other agent is ready', async () => {
            await start((agents) => {
                for (const id of ['codex', 'cursor']) {
                    change(id, (agent) => {
                        agent.enabled = false;
                        agent.status = 'disabled';
                    })(agents);
                }
            }, withFork);
            await draw('c-2');
            await press(forkButtons()[0]);

            expect(menuItem('Hand off to another agent').getAttribute('aria-disabled')).toBe('true');
            expect(menuItem('Hand off to another agent').textContent).toContain('No other agent is ready');
        });

        it('opens the new-chat page on the agent, with the conversation up to that answer attached, and sends nothing to the daemon', async () => {
            await start(undefined, withFork);
            // The fork chat holds two answers that can be forked at: the one it inherited, and its own.
            await draw(FIXTURE_FORK_CHAT_ID);

            const command = vi.spyOn(store, 'command');

            expect(forkButtons()).toHaveLength(2);

            await openAgents(0);
            await press(menuItem('Codex'));
            await vi.waitFor(() => expect(ui().draft).toBe(true));

            expect(ui().draftEngine).toBe('codex');
            expect(files().map(file => file.name)).toEqual(['1-first-version-conversation.md']);

            const transcript = await files()[0].text();

            expect(transcript).toContain('Build the first version: fleet list, booking page, price calculation.');
            expect(transcript).toContain(ANSWER);
            // What came after the answer it was handed off at is left out.
            expect(transcript).not.toContain('Add the weekend surcharge to the price.');
            expect(command).not.toHaveBeenCalled();
        });

        it('takes the later answer\'s whole conversation when it is handed off there', async () => {
            await start(undefined, withFork);
            await draw(FIXTURE_FORK_CHAT_ID);
            await openAgents(1);
            await press(menuItem('Cursor'));
            await vi.waitFor(() => expect(ui().draft).toBe(true));

            expect(ui().draftEngine).toBe('cursor');
            expect(await files()[0].text()).toContain('The weekend surcharge is in `src/booking/price.ts`.');
        });

        it('does not fork the chat: Fork stays the one that does', async () => {
            await start(undefined, withFork);
            await draw('c-2');

            const command = vi.spyOn(store, 'command');

            await openAgents();
            await press(menuItem('Codex'));
            await vi.waitFor(() => expect(ui().draft).toBe(true));

            expect(command.mock.calls.filter(([input]) => input.type === 'chat.fork')).toEqual([]);
        });
    });

    describe('where the agent cannot cut its session', () => {
        // First version's answer loses its flag, as the answer of an agent with no `session/fork` (Cursor), one from before the rewind points or one of a stopped turn has none.
        const unflagged = (fixtures: FixtureData) => {
            const { canFork: _flag, ...answer } = fixtures.items['r-orch-2'][5];

            fixtures.items['r-orch-2'][5] = answer;
        };

        it('draws the same Fork on the answer, which opens a new-chat page on the chat\'s own agent with the conversation up to the answer attached', async () => {
            await start(undefined, unflagged);
            await draw('c-2');

            expect(forkButtons()).toHaveLength(1);

            const command = vi.spyOn(store, 'command');

            await press(forkButtons()[0]);

            expect(menuItems().map(row => row.textContent)).toEqual(['Fork', 'Hand off to another agent…']);

            await press(menuItem('Fork'));
            await vi.waitFor(() => expect(ui().draft).toBe(true));

            expect(ui().draftEngine).toBe('claude');
            expect(ui().pendingFiles.map(file => file.name)).toEqual(['first-version-conversation.md']);
            expect(await ui().pendingFiles[0].text()).toContain(ANSWER);
            // The daemon is asked for nothing: no chat exists until the first message of the page.
            expect(command).not.toHaveBeenCalled();
        });

        it('still offers the other agents', async () => {
            await start(undefined, unflagged);
            await draw('c-2');
            await press(forkButtons()[0]);
            await press(menuItem('Hand off to another agent'));

            expect([...document.body.querySelectorAll<HTMLElement>('[role="menu"][aria-label="Hand off to another agent"] [role="menuitem"]')].map(row => row.textContent)).toEqual(['Codex', 'Cursor']);
        });

        it('draws none in a chat that is read only', async () => {
            await start(claudeOff, unflagged);
            await draw('c-2');

            expect(forkButtons()).toHaveLength(0);
        });
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
            await fork();

            const made = ui().chatId!;

            await draw(made);

            expect(divider()?.textContent).toBe('Forked from First version');
            expect(divider()?.previousElementSibling?.textContent).toContain(ANSWER);
            // Nothing of its own yet: the divider is the end of the list.
            expect(divider()?.nextElementSibling).toBeNull();
        });
    });
});

describe('Edit in a chat', () => {
    const FIRST = 'Build the first version: fleet list, booking page, price calculation.';
    const SECOND = 'Now add the weekend surcharge to the price.';
    const STEER = 'And keep it on one line';
    const SURCHARGE = 'The surcharge is in `src/booking/price.ts`.';
    const ANSWER = 'The booking page, the fleet list and the price calculation are in.';
    const notes: Attachment = { id: 'a-notes', name: 'notes.txt', mediaType: 'text/plain', size: 40 };
    const build: Attachment = { id: 'a-build', name: 'build.log', mediaType: 'text/plain', size: 90 };
    const accepted: CommandResult = { ok: true, requestId: 'x', data: { chatId: 'c-2', runId: 'r-orch-2' } };
    const refusal = (message: string): CommandResult => ({ ok: false, requestId: 'x', error: { code: 'conflict', message } });

    /**
     * First version with a second turn, whose message starts it and can be edited, and an answer to it; then a message the person wrote while it ran, a
     * steer, which cannot. The first message of the chat can be edited from the seed.
     */
    const withTurns = (files: Attachment[] = []) => (fixtures: FixtureData) => {
        const items = fixtures.items['r-orch-2'];
        const now = Date.now();
        const next = (offset: number, body: StreamItemBody, flags: Pick<StreamItem, 'canEdit' | 'canFork'> = {}): StreamItem => ({ id: `r-orch-2-${ items.length + 1 }`, runId: 'r-orch-2', seq: items.length + 1, at: now - offset * 60_000, body, ...flags });

        items.push(next(500, { kind: 'user', text: SECOND, ...(files.length > 0 && { attachments: files }) }, { canEdit: true }));
        items.push(next(498, { kind: 'assistant', done: true, text: SURCHARGE }, { canFork: true }));
        items.push(next(30, { kind: 'user', text: STEER }));
    };

    const editButtons = () => [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Edit message"]')];
    const frame = () => container.querySelector<HTMLElement>('[role="group"][aria-label="Editing message"]');
    const editField = () => frame()?.querySelector<HTMLElement & { editor: Editor }>('[contenteditable="true"]');
    const bottomField = () => [...container.querySelectorAll<HTMLElement & { editor: Editor }>('[contenteditable="true"]')].find(candidate => !frame()?.contains(candidate));
    const submitButton = () => frame()?.querySelector<HTMLButtonElement>('button[aria-label="Submit edit"]');
    const tilesIn = (scope: Element | null | undefined) => [...scope?.querySelectorAll('[data-slot="attachments"] > *') ?? []];
    const itemsOf = () => data.items['r-orch-2'];
    const editsSent = (spy: { mock: { calls: Array<[CommandInput]> } }) => spy.mock.calls.filter(([input]) => input.type === 'chat.edit');

    /** Presses Edit under the message with these words, and lets the editor take the focus, which it does on a frame of its own. */
    async function openEdit(words: string) {
        const row = [...container.querySelectorAll<HTMLElement>('[data-message]')].find(message => message.textContent?.includes(words))!;

        await act(async () => row.querySelector<HTMLButtonElement>('button[aria-label="Edit message"]')!.click());
        await act(async () => new Promise(requestAnimationFrame));
    }

    const typeIn = (target: HTMLElement & { editor: Editor }, words: string) => act(async () => {
        target.editor.chain().focus('end').insertContent(words).run();
    });
    const press = (target: Element, key: string, mods: { metaKey?: boolean } = {}) => act(async () => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }));
    });

    /** Answers `chat.edit` as `answer` says, after the real command when `real`, and lets every other command through. */
    function stubEdit(answer: (run: () => Promise<CommandResult>) => Promise<CommandResult> | CommandResult) {
        const command = store.command.bind(store);

        return vi.spyOn(store, 'command').mockImplementation(async input => (input.type === 'chat.edit' ? answer(() => command(input)) : command(input)));
    }

    beforeEach(() => {
        vi.mocked(toast.error).mockClear();
        vi.mocked(toast.warning).mockClear();
        saveDraft('c-2', emptyComposerDoc());
    });

    describe('the button', () => {
        it('is drawn under the person\'s messages the daemon marked, between Reply and Copy, and under no other', async () => {
            await start(undefined, withTurns());
            await draw('c-2');

            expect(editButtons()).toHaveLength(2);

            const row = editButtons()[0].closest('[data-message]')!;

            expect(row.textContent).toContain(FIRST);
            expect([...row.querySelectorAll('button')].map(node => node.getAttribute('aria-label'))).toEqual(['Reply', 'Edit message', 'Copy message']);
            // The steer has a row and no flag.
            expect([...container.querySelectorAll('[data-message]')].find(message => message.textContent?.includes(STEER))?.querySelector('button[aria-label="Edit message"]')).toBeNull();
        });

        it('is drawn in no chat whose messages carry no flag', async () => {
            await start();
            await draw('c-6');

            expect(container.querySelectorAll('[data-message]').length).toBeGreaterThan(0);
            expect(editButtons()).toHaveLength(0);
        });

        it('is drawn in no chat that is read only, where the message cannot be sent again', async () => {
            await start(claudeOff, withTurns());
            await draw('c-2');

            expect(container.querySelector('button[aria-label="Copy message"]')).not.toBeNull();
            expect(editButtons()).toHaveLength(0);
        });

        it('is not drawn while the agent works', async () => {
            await start();
            await draw('c-1');

            expect(editButtons()).toHaveLength(0);
            expect(container.querySelector('[aria-label="Edit message"]')).toBeNull();
        });
    });

    describe('opening it', () => {
        it('puts the frame where the bubble stood, with the message\'s words in a box that has the focus, and keeps the rest of the stream', async () => {
            await start(undefined, withTurns());
            await draw('c-2');
            await openEdit(SECOND);

            const second = itemsOf()[7];

            expect(frame()).not.toBeNull();
            expect(frame()?.dataset.turn).toBe(second.id);
            expect(frame()?.textContent).toContain('Editing message');
            expect(editField()?.editor.getText()).toBe(SECOND);
            expect(document.activeElement).toBe(editField());
            // The caret is at the end of the words.
            expect(editField()?.editor.state.selection.$from.parentOffset).toBe(SECOND.length);
            // The bubble is gone from its place: the words are in the box alone. What came before and after is still drawn.
            expect([...container.querySelectorAll('[data-message]')].some(message => message.textContent?.includes(SECOND))).toBe(false);
            expect(container.textContent).toContain(ANSWER);
            expect(container.textContent).toContain(SURCHARGE);
            expect(container.textContent).toContain(STEER);
            // It stands between the first turn, which ends with the compaction line, and the answer to the second.
            expect(frame()?.previousElementSibling?.textContent).toContain('Context compacted');
            expect(frame()?.nextElementSibling?.textContent).toContain(SURCHARGE);
        });

        it('is the message box without what belongs to the chat: no queue, running agents, mode or model, and a placeholder of its own', async () => {
            await start(undefined, (fixtures) => {
                withTurns()(fixtures);
                fixtures.chats.find(chat => chat.id === 'c-2')!.queue = [{ id: 'q-1', mode: 'queue', text: 'Then the footer', content: 'Then the footer', createdAt: 0 }];
            });
            await draw('c-2');

            expect(container.textContent).toContain('Then the footer');

            await openEdit(SECOND);

            // The queue is drawn once: in the box at the bottom, not in the frame.
            expect(frame()?.textContent).not.toContain('Then the footer');
            expect(container.textContent?.split('Then the footer')).toHaveLength(2);
            expect(frame()?.textContent).not.toContain('Hands-off');
            expect(frame()?.querySelector('[aria-label="Attach files"]')).not.toBeNull();
            expect(submitButton()).toBeDefined();
            expect(editField()?.getAttribute('aria-label')).toBe('Edit message');
        });

        it('takes the Edit of every other message away while it is open, and gives it back when it is closed', async () => {
            await start(undefined, withTurns());
            await draw('c-2');
            await openEdit(SECOND);

            expect(editButtons()).toHaveLength(0);

            await act(async () => frame()!.querySelector<HTMLButtonElement>('button[aria-label="Stop editing"]')!.click());

            expect(frame()).toBeNull();
            expect(editButtons()).toHaveLength(2);
        });

        it('leaves the box at the bottom where it is, with its own words, and it goes on working', async () => {
            saveDraft('c-2', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'what I was typing' }] }] });
            await start(undefined, withTurns());
            await draw('c-2');
            await openEdit(SECOND);

            expect(bottomField()?.editor.getText()).toBe('what I was typing');
            expect(editField()?.editor.getText()).toBe(SECOND);

            // The edit's words stay out of the chat's draft, and the chat's out of the edit's.
            await typeIn(editField()!, ' in blue');
            await typeIn(bottomField()!, ' below');

            expect(messageOf(draftOf('c-2'))).toBe('what I was typing below');
            expect(messageOf(draftOf(editDraftKey('c-2', itemsOf()[7].id)))).toBe(`${ SECOND } in blue`);

            // A message from the box at the bottom is sent as always, and the frame is still open.
            const command = vi.spyOn(store, 'command');

            await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click());

            expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.send', chatId: 'c-2', text: 'what I was typing below' }));
            expect(editsSent(command)).toHaveLength(0);
            expect(frame()).not.toBeNull();
            expect(editField()?.editor.getText()).toBe(`${ SECOND } in blue`);
        });
    });

    describe('closing it without sending', () => {
        it('is what Escape does, with no command sent, and the chat\'s own draft is as it was', async () => {
            saveDraft('c-2', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'what I was typing' }] }] });
            await start(undefined, withTurns());
            await draw('c-2');

            const command = vi.spyOn(store, 'command');

            await openEdit(SECOND);
            await typeIn(editField()!, ' in blue');
            await press(editField()!, 'Escape');

            expect(frame()).toBeNull();
            expect(editButtons()).toHaveLength(2);
            expect(command).not.toHaveBeenCalled();
            expect(container.textContent).toContain(SECOND);
            expect(bottomField()?.editor.getText()).toBe('what I was typing');
            expect(messageOf(draftOf('c-2'))).toBe('what I was typing');
        });

        it('is what the X of the frame does too, and what was typed does not come back when the message is edited again', async () => {
            await start(undefined, withTurns());
            await draw('c-2');
            await openEdit(SECOND);

            const key = editDraftKey('c-2', itemsOf()[7].id);

            await typeIn(editField()!, ' in blue');
            await act(async () => frame()!.querySelector<HTMLButtonElement>('button[aria-label="Stop editing"]')!.click());

            expect(frame()).toBeNull();
            // The session's draft and files are released.
            expect(messageOf(draftOf(key))).toBe('');
            expect(filesOf(key)).toEqual([]);

            await openEdit(SECOND);

            expect(editField()?.editor.getText()).toBe(SECOND);
        });

        it('is what leaving the chat does: nothing of the session is left behind', async () => {
            await start(undefined, withTurns());
            await draw('c-2');
            await openEdit(SECOND);

            const key = editDraftKey('c-2', itemsOf()[7].id);

            await typeIn(editField()!, ' in blue');
            await render('c-3');

            expect(messageOf(draftOf(key))).toBe('');
            expect(filesOf(key)).toEqual([]);
        });
    });

    describe('sending it', () => {
        it('sends chat.edit with the chat, the message and the words, closes the frame, and takes the later messages out when the daemon cuts the stream', async () => {
            await start(undefined, withTurns());
            await draw('c-2');

            const command = vi.spyOn(store, 'command');
            const first = itemsOf()[0].id;

            await openEdit(FIRST);
            await typeIn(editField()!, ' (the short one)');
            await press(editField()!, 'Enter');

            expect(editsSent(command).map(([input]) => input)).toEqual([{ type: 'chat.edit', chatId: 'c-2', itemId: first, text: `${ FIRST } (the short one)` }]);

            await vi.waitFor(() => expect(frame()).toBeNull());
            await render('c-2');

            // The cut: the answer, the second turn and the steer are gone; the edited message stands where the first one did, as a new one.
            expect(container.textContent).not.toContain(ANSWER);
            expect(container.textContent).not.toContain(SECOND);
            expect(container.textContent).not.toContain(SURCHARGE);
            expect(container.textContent).not.toContain(STEER);
            expect(container.textContent).toContain(`${ FIRST } (the short one)`);
            expect(toast.error).not.toHaveBeenCalled();
            // Nothing says the message was lost: the edit itself removed it.
            expect(toast.warning).not.toHaveBeenCalled();
            // The agent works on the new turn, so the new message offers no Edit.
            expect(editButtons()).toHaveLength(0);
            // The session is released.
            expect(messageOf(draftOf(editDraftKey('c-2', first)))).toBe('');
        });

        it('sends on Cmd+Enter and from the send button the same way', async () => {
            await start(undefined, withTurns());
            await draw('c-2');

            const command = stubEdit(async () => accepted);

            await openEdit(SECOND);
            await press(editField()!, 'Enter', { metaKey: true });

            expect(editsSent(command)).toHaveLength(1);
            expect(frame()).toBeNull();

            await openEdit(FIRST);
            await act(async () => submitButton()!.click());

            expect(editsSent(command)).toHaveLength(2);
        });

        it('sends the files of the message that are left in the box, by their ids', async () => {
            await start(undefined, withTurns([notes, build]));
            await draw('c-2');

            const command = stubEdit(async () => accepted);

            await openEdit(SECOND);

            expect(tilesIn(frame())).toHaveLength(2);
            expect(frame()?.textContent).toContain('notes.txt');
            expect(frame()?.textContent).toContain('build.log');

            // One is taken off the message.
            await act(async () => frame()!.querySelector<HTMLButtonElement>('[data-slot="attachments"] button')!.click());
            await press(editField()!, 'Enter');

            expect(editsSent(command).map(([input]) => input)).toEqual([{ type: 'chat.edit', chatId: 'c-2', itemId: itemsOf()[7].id, text: SECOND, attachmentIds: ['a-build'] }]);
        });

        it('holds the editor open with its words and files when the daemon refuses, and says why', async () => {
            await start(undefined, withTurns([notes]));
            await draw('c-2');
            stubEdit(async () => refusal('Stop the agent to edit this message'));
            await openEdit(SECOND);
            await typeIn(editField()!, ' in blue');
            await press(editField()!, 'Enter');

            expect(toast.error).toHaveBeenCalledExactlyOnceWith({ message: 'Stop the agent to edit this message' });
            expect(frame()).not.toBeNull();
            expect(editField()?.editor.getText()).toBe(`${ SECOND } in blue`);
            expect(tilesIn(frame())).toHaveLength(1);
            expect(submitButton()?.hasAttribute('data-pending')).toBe(false);
            // The stream is as it was: nothing was cut.
            expect(container.textContent).toContain(SURCHARGE);
        });

        it('says it could not edit when the refusal has no words, and a second try can go through', async () => {
            await start(undefined, withTurns());
            await draw('c-2');

            let attempt = 0;
            const command = stubEdit(async () => (++attempt === 1 ? refusal('') : accepted));

            await openEdit(SECOND);
            await press(editField()!, 'Enter');

            expect(toast.error).toHaveBeenCalledExactlyOnceWith({ message: 'Couldn\'t edit the message' });
            expect(frame()).not.toBeNull();

            await press(editField()!, 'Enter');

            expect(editsSent(command)).toHaveLength(2);
            expect(frame()).toBeNull();
        });

        it('spins while the command is on its way, and cannot be closed meanwhile', async () => {
            await start(undefined, withTurns());
            await draw('c-2');

            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });

            stubEdit(async () => {
                await gate;

                return refusal('The agent is busy');
            });
            await openEdit(SECOND);
            await press(editField()!, 'Enter');

            expect(submitButton()?.hasAttribute('data-pending')).toBe(true);

            await press(editField()!, 'Escape');
            await act(async () => frame()!.querySelector<HTMLButtonElement>('button[aria-label="Stop editing"]')!.click());

            expect(frame()).not.toBeNull();

            await act(async () => release());

            expect(submitButton()?.hasAttribute('data-pending')).toBe(false);
            expect(frame()).not.toBeNull();
        });

        it('sends one command for two submits made before the button has drawn its spinner', async () => {
            await start(undefined, withTurns());
            await draw('c-2');

            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const command = stubEdit(async () => {
                await gate;

                return refusal('The agent is busy');
            });

            await openEdit(SECOND);
            // Both land in one batch of updates, so the second sees a box that does not yet know an edit has started.
            await act(async () => {
                editField()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
                editField()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            });

            expect(editsSent(command)).toHaveLength(1);

            await act(async () => release());
        });

        it('cannot send an empty message', async () => {
            await start(undefined, withTurns());
            await draw('c-2');

            const command = vi.spyOn(store, 'command');

            await openEdit(SECOND);
            await act(async () => editField()!.editor.commands.clearContent());

            expect(submitButton()?.disabled).toBe(true);

            await press(editField()!, 'Enter');

            expect(editsSent(command)).toHaveLength(0);
            expect(frame()).not.toBeNull();
        });
    });

    describe('the files of the message when the editor is closed', () => {
        it('are not deleted from the daemon, and the message keeps them, whether or not one was taken off in the editor', async () => {
            await start(undefined, withTurns([notes, build]));
            await draw('c-2');

            const deleted = vi.spyOn(transport, 'deleteAttachment');

            await openEdit(SECOND);
            await act(async () => frame()!.querySelector<HTMLButtonElement>('[data-slot="attachments"] button')!.click());
            await press(editField()!, 'Escape');

            expect(deleted).not.toHaveBeenCalled();
            expect(frame()).toBeNull();
            // The message still shows both, since nothing was sent.
            const message = [...container.querySelectorAll('[data-message]')].find(candidate => candidate.textContent?.includes(SECOND));

            expect(tilesIn(message)).toHaveLength(2);
        });

        it('are all there when the editor is opened again after an earlier one was closed with one taken off', async () => {
            await start(undefined, withTurns([notes, build]));
            await draw('c-2');
            await openEdit(SECOND);
            await act(async () => frame()!.querySelector<HTMLButtonElement>('[data-slot="attachments"] button')!.click());
            await press(editField()!, 'Escape');
            await openEdit(SECOND);

            expect(tilesIn(frame())).toHaveLength(2);
        });

        /** Picks a file in the open editor of the second message, which already has `notes`, and waits for it to be uploaded: the id the daemon gave it. */
        async function uploadExtra() {
            const input = frame()!.querySelector<HTMLInputElement>('input[type="file"]')!;

            Object.defineProperty(input, 'files', { value: [new File(['x'], 'extra.txt', { type: 'text/plain' })], configurable: true });
            await act(async () => {
                input.dispatchEvent(new Event('change', { bubbles: true }));
            });
            await vi.waitFor(() => expect(filesOf(editDraftKey('c-2', itemsOf()[7].id)).map(file => file.status)).toEqual(['ready', 'ready']));

            return filesOf(editDraftKey('c-2', itemsOf()[7].id)).find(file => file.name === 'extra.txt')!.attachment!.id;
        }

        it('are told from what the editor uploaded and nobody sent, which goes when the editor is closed', async () => {
            await start(undefined, withTurns([notes]));
            await draw('c-2');

            const deleted = vi.spyOn(transport, 'deleteAttachment');

            await openEdit(SECOND);

            const uploaded = await uploadExtra();

            await press(editField()!, 'Escape');

            expect(deleted).toHaveBeenCalledExactlyOnceWith(FIXTURE_PROJECT_ID, uploaded);
        });

        it('are told the same when the person leaves the chat, and what the message had is left alone', async () => {
            await start(undefined, withTurns([notes]));
            await draw('c-2');

            const deleted = vi.spyOn(transport, 'deleteAttachment');

            await openEdit(SECOND);

            const uploaded = await uploadExtra();

            await render('c-3');

            expect(deleted).toHaveBeenCalledExactlyOnceWith(FIXTURE_PROJECT_ID, uploaded);
        });

        it('are all kept when the person leaves the chat while the edit that uses them is on its way: the daemon would refuse an edit whose file was deleted', async () => {
            await start(undefined, withTurns([notes]));
            await draw('c-2');

            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const deleted = vi.spyOn(transport, 'deleteAttachment');
            const command = stubEdit(async () => {
                await gate;

                return accepted;
            });

            await openEdit(SECOND);
            await uploadExtra();
            await press(editField()!, 'Enter');
            await render('c-3');

            expect(editsSent(command)).toHaveLength(1);
            expect(deleted).not.toHaveBeenCalled();

            await act(async () => release());

            expect(deleted).not.toHaveBeenCalled();
            expect(toast.error).not.toHaveBeenCalled();
        });
    });

    describe('a message that goes while the editor is open', () => {
        it('closes the editor with a toast when the stream cuts it, someone else\'s edit or a fork', async () => {
            await start(undefined, withTurns());
            await draw('c-2');
            await openEdit(SECOND);

            const second = itemsOf()[7];

            await act(async () => store.streams.applyTruncation('r-orch-2', second.seq));
            await render('c-2');

            expect(frame()).toBeNull();
            expect(toast.warning).toHaveBeenCalledExactlyOnceWith({ message: 'The message is no longer available' });
            expect(messageOf(draftOf(editDraftKey('c-2', second.id)))).toBe('');
            expect(editButtons()).toHaveLength(1);
        });

        it('closes it too when the message can no longer be edited', async () => {
            await start(undefined, withTurns());
            await draw('c-2');
            await openEdit(SECOND);

            const { canEdit: _canEdit, ...second } = itemsOf()[7];

            await act(async () => store.streams.applyItem(second));
            await render('c-2');

            expect(frame()).toBeNull();
            expect(toast.warning).toHaveBeenCalledExactlyOnceWith({ message: 'The message is no longer available' });
        });

        it('says nothing while the edit that removes it is on its way, even when the cut comes before the answer to the command', async () => {
            await start(undefined, withTurns());
            await draw('c-2');

            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });

            // The daemon cuts the stream and tells the app, and the answer to the command comes later.
            stubEdit(async (run) => {
                const result = await run();

                await gate;

                return result;
            });
            await openEdit(FIRST);
            await press(editField()!, 'Enter');
            await render('c-2');

            expect(container.textContent).not.toContain(SECOND);
            expect(toast.warning).not.toHaveBeenCalled();

            await act(async () => release());
            await render('c-2');

            expect(frame()).toBeNull();
            expect(toast.warning).not.toHaveBeenCalled();
            expect(toast.error).not.toHaveBeenCalled();
        });

        it('closes the editor, with no word about the message, when the chat turns read only', async () => {
            await start(undefined, withTurns());
            await draw('c-2');
            await openEdit(SECOND);

            const key = editDraftKey('c-2', itemsOf()[7].id);
            const claude = store.agents.find(agent => agent.id === 'claude')!;

            await act(async () => {
                claude.enabled = false;
                claude.status = 'disabled';
            });
            await render('c-2');

            expect(frame()).toBeNull();
            expect(toast.warning).not.toHaveBeenCalled();
            expect(messageOf(draftOf(key))).toBe('');
        });
    });

    describe('an agent that starts working while the editor is open', () => {
        it('holds Submit until it stops, since the daemon would refuse the edit, and keeps the words in the box meanwhile', async () => {
            await start(undefined, withTurns());
            await draw('c-2');

            const command = vi.spyOn(store, 'command');
            const run = store.selectedProject!.runs.get('r-orch-2')!;

            await openEdit(SECOND);
            await typeIn(editField()!, ' in blue');
            await act(async () => {
                run.status = 'running';
            });
            await render('c-2');

            expect(frame()).not.toBeNull();
            expect(submitButton()?.disabled).toBe(true);

            await press(editField()!, 'Enter');

            expect(editsSent(command)).toHaveLength(0);
            expect(toast.error).not.toHaveBeenCalled();

            await act(async () => {
                run.status = 'succeeded';
            });
            await render('c-2');

            expect(submitButton()?.disabled).toBe(false);
            expect(editField()?.editor.getText()).toBe(`${ SECOND } in blue`);
        });
    });
});

describe('requests for permission', () => {
    const withApprovals = (fixtures: FixtureData) => void withFixtureApprovals(fixtures);
    /** The last card that asks for this (`Run this command`, `Change these files`, `Use <tool>`): the chat has an answered request for a command before its open one. */
    const card = (heading: string) => [...container.querySelectorAll<HTMLElement>(`div[role="group"][aria-label="${ heading }"]`)].at(-1) ?? null;
    const cardButton = (heading: string, label: string) => [...card(heading)?.querySelectorAll<HTMLButtonElement>('button') ?? []].find(candidate => candidate.textContent === label);

    it('draws each request in the stream, and a click on a decision sends it with the run and the request, and the card keeps it', async () => {
        await start(undefined, withApprovals);
        await draw(FIXTURE_APPROVALS_CHAT_ID);

        expect(card('Run this command')).not.toBeNull();
        expect(card('Change these files')).not.toBeNull();
        expect(card('Use mcp__docs__publish')).not.toBeNull();

        const command = vi.spyOn(store, 'command');

        await act(async () => cardButton('Run this command', 'Allow once')!.click());
        await render(FIXTURE_APPROVALS_CHAT_ID);

        expect(command).toHaveBeenCalledWith({ type: 'run.decide', runId: 'r-orch-8', approvalId: 'apv-2', decision: 'allow_once' });
        expect(card('Run this command')?.textContent).toContain('Allowed once');
        expect(cardButton('Run this command', 'Allow once')).toBeUndefined();
        // The other two still wait, and so does the run.
        expect(cardButton('Change these files', 'Allow once')).toBeDefined();
        expect(store.selectedProject!.runs.get('r-orch-8')?.status).toBe('waiting_user');
    });

    it('lets the person decide while the run is in another state, because the card goes by its own', async () => {
        await start(undefined, (fixtures) => {
            withFixtureApprovals(fixtures);
            fixtures.runs.find(run => run.id === 'r-orch-8')!.status = 'waiting_background';
        });
        await draw(FIXTURE_APPROVALS_CHAT_ID);

        expect(cardButton('Change these files', 'Deny')).toBeDefined();

        const command = vi.spyOn(store, 'command');

        await act(async () => cardButton('Change these files', 'Deny')!.click());

        expect(command).toHaveBeenCalledWith({ type: 'run.decide', runId: 'r-orch-8', approvalId: 'apv-3', decision: 'reject' });
    });

    it('tells the person when the daemon refuses a decision, and leaves the card open', async () => {
        await start(undefined, withApprovals);
        await draw(FIXTURE_APPROVALS_CHAT_ID);
        vi.spyOn(store, 'command').mockResolvedValue({ ok: false, error: { code: 'conflict', message: 'The agent is gone' } } as CommandResult);

        await act(async () => cardButton('Run this command', 'Deny')!.click());
        await render(FIXTURE_APPROVALS_CHAT_ID);

        expect(toast.error).toHaveBeenCalledWith({ message: 'The agent is gone' });
        expect(cardButton('Run this command', 'Deny')?.disabled).toBe(false);
    });
});

