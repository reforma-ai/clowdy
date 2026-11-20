// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { Screen } from './Screen';

import type { Editor } from '@tiptap/core';
import type { KeyValueStorage } from '../../stores/storage';

// `Modal` cannot load under the desktop's Vitest (decorators), and no confirmation is opened here.
vi.mock('@clowdy/components/modals', () => ({ openConfirmModal: vi.fn() }));

// The pages beside the list are drawn by their own tests; here they only say which one was asked for.
vi.mock('../chats/ChatView', () => ({ ChatView: ({ chat }: { chat: { id: string; title: string } }) => <div data-testid="chat" data-chat-id={ chat.id }>{ chat.title }</div> }));
vi.mock('./RunDetail', () => ({ RunDetail: ({ run }: { run: { id: string; name: string } }) => <div data-testid="run" data-run-id={ run.id }>{ run.name }</div> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The Agents screen on the fixture project. Chats by activity: c-1 (Simplify booking, orchestrator r-orch-1), c-4 (empty), c-6 (Ship the checkout,
 * at rest, with threads), c-5, c-3, c-2. The threads of c-6, oldest first: c-6a (Fix the price rounding, working, with the finished thread c-6a1),
 * c-6b (finished), c-6c (failed), c-6e (waiting for background work). Native sub-agents live in r-orch-1's session (r-na-01 to r-na-04): cards in its
 * stream, never rows. The test build has no MobX observer plugin, so the screen is drawn again by hand after a change, as the observer does in the app.
 */

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;

const ui = () => store.ui.forProject(FIXTURE_PROJECT_ID);
const project = () => store.selectedProject!;

const draw = (before?: () => void) => act(async () => {
    before?.();
    reactRoot.render(<RootStoreProvider value={ store }><Screen /></RootStoreProvider>);
});

const rowKeys = () => [...container.querySelectorAll('[role="row"]')].map(row => row.getAttribute('data-key'));
const rowOf = (key: string) => container.querySelector<HTMLElement>(`[role="row"][data-key="${ key }"]`)!;
const isSelected = (key: string) => rowOf(key).hasAttribute('data-selected');
const buttonNamed = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${ label }"]`)!;

/** A press with a mouse: what React Aria opens a menu on, and picks an item with. */
const press = async (target: HTMLElement) => act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    target.click();
});
const menuItem = (name: string) => [...document.body.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(row => row.textContent?.includes(name))!;

beforeEach(async () => {
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
    store = new RootStore(new FixtureTransport(), { storage: memoryStorage() });
    await store.load();
    await draw();
});

afterEach(() => {
    act(() => reactRoot.unmount());
    container.remove();
    store.dispose();
});

describe('the list', () => {
    it('starts with the new-chat row, then the chats, and has no row for a run', () => {
        // The orchestrator is the chat, and a native sub-agent is a card on the call that started it: neither is a row.
        expect(rowKeys()).toEqual(['@new-chat', 'c-1', 'c-4', 'c-6', 'c-5', 'c-3', 'c-2']);
    });

    it('marks a chat that started with the provider it runs on, and one that has not with the speech bubble', async () => {
        const providerOf = (key: string) => rowOf(key).querySelector('[data-provider]')?.getAttribute('data-provider');

        // c-1 has an orchestrator on Claude; c-4 never got a message.
        expect(providerOf('c-1')).toBe('claude');
        expect(providerOf('c-4')).toBeUndefined();

        // A chat on another agent shows that agent's mark: the chat's own choice, else its orchestrator's.
        await draw(() => {
            project().chats.set('c-1', { ...project().chats.get('c-1')!, engine: 'codex' });
        });
        expect(providerOf('c-1')).toBe('codex');

        // An agent with no mark of its own keeps the speech bubble.
        await draw(() => {
            project().chats.set('c-1', { ...project().chats.get('c-1')!, engine: 'fake' });
        });
        expect(providerOf('c-1')).toBeUndefined();
    });

    it('sorts the chats by last activity until the Filters menu asks for the order they were made in', async () => {
        const chatKeys = () => rowKeys().filter(key => key?.startsWith('c-'));

        expect(chatKeys()).toEqual(['c-1', 'c-4', 'c-6', 'c-5', 'c-3', 'c-2']);

        await press(container.querySelector<HTMLElement>('button[aria-label="Filters"]')!);

        expect(document.body.textContent).toContain('Sort by');
        expect(menuItem('Last activity').getAttribute('aria-checked')).toBe('true');
        expect(menuItem('Created').getAttribute('aria-checked')).toBe('false');

        await press(menuItem('Created'));
        expect(ui().chatSort).toBe('created');
        await draw();
        expect(chatKeys()).toEqual(['c-4', 'c-5', 'c-3', 'c-6', 'c-1', 'c-2']);

        // A message in a chat does not move it now.
        await draw(() => {
            project().chats.set('c-2', { ...project().chats.get('c-2')!, updatedAt: Date.now() });
        });
        expect(chatKeys()).toEqual(['c-4', 'c-5', 'c-3', 'c-6', 'c-1', 'c-2']);
    });

    it('keeps the row of an open `⋯` menu as if hovered, since the pointer is in the menu and not on the row', async () => {
        const menuButton = () => rowOf('c-4').querySelector<HTMLElement>('button[aria-label="Chat actions"]')!;

        expect(rowOf('c-4').hasAttribute('data-open')).toBe(false);

        await press(menuButton());

        expect(rowOf('c-4').hasAttribute('data-open')).toBe(true);
        expect(rowOf('c-3').hasAttribute('data-open')).toBe(false);

        await act(async () => {
            document.body.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });

        expect(rowOf('c-4').hasAttribute('data-open')).toBe(false);
    });

    it('selects the first chat when nothing was opened', () => {
        expect(isSelected('c-1')).toBe(true);
        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe('c-1');
    });
});

describe('what is open', () => {
    it('opens a sub-agent beside its chat, whichever chat was open: its page shows and its chat is the selected row', async () => {
        await draw(() => {
            ui().openChat('c-3');
            ui().openRun('r-na-04');
        });

        expect(container.querySelector('[data-testid="run"]')?.getAttribute('data-run-id')).toBe('r-na-04');
        expect(container.querySelector('[data-testid="chat"]')).toBeNull();
        expect(isSelected('c-1')).toBe(true);
        expect(isSelected('c-3')).toBe(false);
    });

    it('takes the orchestrator for its chat', async () => {
        await draw(() => ui().openRun('r-orch-1'));

        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe('c-1');
        expect(isSelected('c-1')).toBe(true);
    });

    it('falls back to a chat when the remembered run is gone', async () => {
        await draw(() => ui().openRun('r-gone'));

        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe('c-1');
    });
});

describe('the new-chat row', () => {
    const field = () => container.querySelector<HTMLElement>('[contenteditable="true"]');
    const editor = () => (field() as HTMLElement & { editor: Editor }).editor;

    function type(value: string) {
        act(() => {
            editor().commands.insertContent(value);
        });
    }

    const pressEnter = () => act(async () => {
        field()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });

    it('opens a page with a message box, and makes no chat by being opened', async () => {
        const before = project().chats.size;

        await draw(() => ui().openDraft());

        expect(isSelected('@new-chat')).toBe(true);
        expect(container.querySelector('[data-testid="chat"]')).toBeNull();
        expect(field()).not.toBeNull();
        expect(container.textContent).toContain('What should we work on?');

        await draw(() => ui().openDraft());

        expect(project().chats.size).toBe(before);
    });

    it('makes the chat and sends the message when it is sent, and then shows that chat', async () => {
        const before = new Set(project().chats.keys());

        await draw(() => ui().openDraft());
        type('Build the thing');
        await pressEnter();
        await draw();

        const made = [...project().chats.keys()].filter(id => !before.has(id));

        expect(made).toHaveLength(1);
        expect(ui().draft).toBe(false);
        expect(ui().chatId).toBe(made[0]);
        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe(made[0]);
    });

    it('sends nothing for a message of spaces, and keeps what was typed when the row is left and opened again', async () => {
        const before = project().chats.size;

        await draw(() => ui().openDraft());
        type('   ');
        await pressEnter();

        expect(project().chats.size).toBe(before);

        type('half a thought');
        await draw(() => ui().openChat('c-3'));
        await draw(() => ui().openDraft());

        expect(editor().getText()).toContain('half a thought');
    });

    it('is what shows, and the only row, when the project has no chat', async () => {
        store.selectProject(FIXTURE_EMPTY_PROJECT_ID);
        await vi.waitFor(() => expect(store.selectedProject?.status).toBe('ready'));
        await draw();

        expect(rowKeys()).toEqual(['@new-chat']);
        expect(isSelected('@new-chat')).toBe(true);
        expect(field()).not.toBeNull();
    });
});

describe('the heading', () => {
    it('has the archive, as a button, to the left of the filters', () => {
        // The rows have an Archive of their own, as a quick action: the heading's buttons are the ones outside the list.
        const buttons = [...container.querySelectorAll<HTMLElement>('button[aria-label="Archive"], button[aria-label="Filters"]')].filter(button => !button.closest('[role="grid"]'));

        expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual(['Archive', 'Filters']);
        expect(buttons[0].parentElement).toBe(buttons[1].parentElement);
    });

    it('has the new-chat page open by its row, which is selected only while it is open', async () => {
        await press(rowOf('@new-chat'));

        expect(ui().draft).toBe(true);

        // The test build has no observer, so the screen is drawn again by hand.
        await draw();

        expect(isSelected('@new-chat')).toBe(true);

        await draw(() => ui().openChat('c-3'));

        expect(isSelected('@new-chat')).toBe(false);
    });
});

describe('the archive', () => {
    async function archive(chatId: string, archived: boolean) {
        await act(async () => {
            await store.command({ type: 'chat.setArchived', chatId, archived });
        });
        // The change comes back on the event feed, a moment after the answer.
        await vi.waitFor(() => expect(project().chats.get(chatId)?.archivedAt !== undefined).toBe(archived));
        await draw();
    }

    // The rows of the archive's list, which is in a popover beside the screen and not in it.
    const archiveRows = () => [...document.body.querySelectorAll<HTMLElement>('[role="row"]')].filter(row => !container.contains(row));
    const titles = () => archiveRows().map(row => row.textContent);
    const archiveRow = (title: string) => archiveRows().find(row => row.textContent?.startsWith(title))!;

    it('takes a chat out of the list and lists it, last put away first, with how long ago', async () => {
        await archive('c-2', true);
        await archive('c-4', true);

        expect(rowKeys()).toEqual(expect.not.arrayContaining(['c-2', 'c-4']));
        expect(rowKeys().filter(key => key?.startsWith('c-'))).toEqual(['c-1', 'c-6', 'c-5', 'c-3']);

        await press(buttonNamed('Archive'));

        expect(titles()).toEqual([expect.stringMatching(/^New chat/), expect.stringMatching(/^First version/)]);
        expect(titles()[0]).toMatch(/now$/);
    });

    it('opens under the heading and is as wide as it, not wider than the column', async () => {
        await press(buttonNamed('Archive'));

        const popover = document.body.querySelector<HTMLElement>('[data-modal-clickout-layer]')!;

        expect(popover.style.width).toBe('var(--trigger-width)');
    });

    it('shows the mark of the provider each chat runs on, as the list does, and the speech bubble for a chat that never started', async () => {
        await archive('c-2', true);
        await archive('c-4', true);
        await press(buttonNamed('Archive'));

        expect(archiveRow('First version').querySelector('[data-provider]')?.getAttribute('data-provider')).toBe(project().runs.get('r-orch-2')?.engine);
        expect(archiveRow('New chat').querySelector('[data-provider]')).toBeNull();
        expect(archiveRow('New chat').querySelector('svg')).not.toBeNull();
    });

    it('says so when there is nothing in it', async () => {
        await press(buttonNamed('Archive'));

        expect(titles()).toEqual([]);
        expect(document.body.textContent).toContain('No archived chats');
    });

    it('brings a chat back into the list and opens it when it is picked', async () => {
        await archive('c-4', true);
        await press(buttonNamed('Archive'));
        await press(archiveRow('New chat'));
        await vi.waitFor(() => expect(project().chats.get('c-4')?.archivedAt).toBeUndefined());
        await draw();

        expect(rowKeys()).toContain('c-4');
        expect(ui().chatId).toBe('c-4');
        expect(isSelected('c-4')).toBe(true);
        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe('c-4');
    });

    it('keeps the row of an open menu as if hovered here too', async () => {
        await archive('c-4', true);
        await press(buttonNamed('Archive'));

        expect(archiveRow('New chat').hasAttribute('data-open')).toBe(false);

        await press(archiveRow('New chat').querySelector<HTMLElement>('button[aria-label^="Actions of"]')!);

        expect(archiveRow('New chat').hasAttribute('data-open')).toBe(true);
    });

    it('has a menu in each row, with Unarchive and Delete', async () => {
        await archive('c-4', true);
        await press(buttonNamed('Archive'));
        await press(archiveRow('New chat').querySelector<HTMLElement>('button[aria-label^="Actions of"]')!);

        expect([...document.body.querySelectorAll('[role="menuitem"]')].map(row => row.textContent)).toEqual(['Unarchive', 'Delete']);
    });

    it('puts a chat back in the list from its menu, without opening it', async () => {
        await archive('c-4', true);
        await press(buttonNamed('Archive'));
        await press(archiveRow('New chat').querySelector<HTMLElement>('button[aria-label^="Actions of"]')!);
        await press(menuItem('Unarchive'));
        await vi.waitFor(() => expect(project().chats.get('c-4')?.archivedAt).toBeUndefined());
        await draw();

        expect(rowKeys()).toContain('c-4');
        expect(ui().chatId).not.toBe('c-4');
        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe('c-1');
    });

    it('deletes an archived chat from its menu', async () => {
        await archive('c-4', true);
        await press(buttonNamed('Archive'));
        await press(archiveRow('New chat').querySelector<HTMLElement>('button[aria-label^="Actions of"]')!);
        await press(menuItem('Delete'));
        // The chat never ran, so nothing asks first.
        await vi.waitFor(() => expect(project().chats.has('c-4')).toBe(false));
        await draw();

        expect(rowKeys()).not.toContain('c-4');
    });

    it('is put away from the row, and the page moves on to the first chat that is left', async () => {
        await draw(() => ui().openChat('c-4'));
        await press(rowOf('c-4').querySelector<HTMLElement>('button[aria-label="Archive"]')!);
        await vi.waitFor(() => expect(project().chats.get('c-4')?.archivedAt).toBeDefined());
        await draw();

        expect(rowKeys()).not.toContain('c-4');
        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe('c-1');
    });

    it('is not offered from the row while an agent of the chat works', () => {
        expect(rowOf('c-1').querySelector('button[aria-label="Archive"]')?.hasAttribute('disabled')).toBe(true);
        expect(rowOf('c-4').querySelector('button[aria-label="Archive"]')?.hasAttribute('disabled')).toBe(false);
    });

    it('cannot be asked of a chat whose agents work, and the list keeps it', async () => {
        const result = await store.command({ type: 'chat.setArchived', chatId: 'c-1', archived: true });

        expect(result.ok).toBe(false);

        await draw();

        expect(rowKeys()).toContain('c-1');
    });

    it('moves the page on to the first listed chat when the one that was open is put away elsewhere', async () => {
        await draw(() => ui().openChat('c-2'));
        await archive('c-2', true);

        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe('c-1');
        expect(rowKeys()).not.toContain('c-2');
    });

    it('has the Archive icon in the row and in the menu, and the history mark on the button that opens the list', async () => {
        const rowIcon = rowOf('c-4').querySelector('button[aria-label="Archive"] svg')!;

        await press(rowOf('c-4').querySelector<HTMLElement>('button[aria-label="Chat actions"]')!);

        expect(menuItem('Archive').querySelector('svg')?.outerHTML).toBe(rowIcon.outerHTML);
        // The 16px history mark, where the others are 14px.
        expect(buttonNamed('Archive').querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 16 16');
        expect(rowIcon.getAttribute('viewBox')).toBe('0 0 14 14');
    });
});

describe('threads', () => {
    const foldOf = (key: string) => rowOf(key).querySelector<HTMLButtonElement>('button[aria-label^="Expand"], button[aria-label^="Collapse"]');
    const depthOf = (key: string) => rowOf(key).getAttribute('data-depth');
    const dotOf = (key: string) => rowOf(key).querySelector('[role="img"]')?.getAttribute('aria-label');
    const stopThreads = async () => {
        for (const runId of ['r-orch-6a', 'r-orch-6e']) await store.command({ type: 'run.cancel', runId });

        await vi.waitFor(() => expect(['r-orch-6a', 'r-orch-6e'].map(id => project().runs.get(id)?.status)).toEqual(['cancelled', 'cancelled']));
    };

    it('folds a chat\'s threads until it is opened: the chat has a fold and its threads are not rows', () => {
        expect(rowKeys()).not.toContain('c-6a');
        expect(foldOf('c-6')?.getAttribute('aria-label')).toBe('Expand Ship the checkout threads');
        expect(foldOf('c-6')?.getAttribute('aria-expanded')).toBe('false');
        expect(foldOf('c-1')).toBeNull();
    });

    it('lists the threads below their chat, one level in and in the order they were made, once the fold is opened, and at every depth', async () => {
        await act(async () => foldOf('c-6')!.click());
        expect(ui().expandedChats).toEqual(['c-6']);
        await draw();

        expect(rowKeys()).toEqual(['@new-chat', 'c-1', 'c-4', 'c-6', 'c-6a', 'c-6b', 'c-6c', 'c-6e', 'c-5', 'c-3', 'c-2']);
        expect(['c-6', 'c-6a', 'c-6e'].map(depthOf)).toEqual(['0', '1', '1']);
        expect(foldOf('c-6')?.getAttribute('aria-expanded')).toBe('true');

        await act(async () => foldOf('c-6a')!.click());
        await draw();

        expect(rowKeys().slice(3, 6)).toEqual(['c-6', 'c-6a', 'c-6a1']);
        expect(depthOf('c-6a1')).toBe('2');

        // Folding the chat hides every thread below it, the thread's own threads too.
        await act(async () => foldOf('c-6')!.click());
        await draw();

        expect(rowKeys().filter(key => key?.startsWith('c-6'))).toEqual(['c-6']);
    });

    it('opens a fold with the right arrow and closes it with the left one', async () => {
        const key = (name: string) => act(async () => {
            rowOf('c-6').dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
        });

        await key('ArrowRight');
        expect(ui().expandedChats).toEqual(['c-6']);
        await draw();
        await key('ArrowLeft');
        expect(ui().expandedChats).toEqual([]);
    });

    it('sorts only the chats the person made: threads keep the order they were made in, whatever the sort', async () => {
        await draw(() => {
            ui().toggleChatExpanded('c-6');
            ui().setChatSort('created');
            project().chats.set('c-6e', { ...project().chats.get('c-6e')!, updatedAt: Date.now() });
        });

        expect(rowKeys().filter(key => key?.startsWith('c-6'))).toEqual(['c-6', 'c-6a', 'c-6b', 'c-6c', 'c-6e']);
    });

    it('has a Show group in the Filters menu with one check, Finished threads, that hides the threads whose run is over', async () => {
        await draw(() => ['c-6', 'c-6a'].forEach(id => ui().toggleChatExpanded(id)));
        await press(container.querySelector<HTMLElement>('button[aria-label="Filters"]')!);

        expect(document.body.textContent).toContain('Show');
        expect(menuItem('Finished threads').getAttribute('aria-checked')).toBe('true');
        expect([...document.body.querySelectorAll('[role^="menuitem"]')].map(row => row.textContent)).toEqual(['Finished threads', 'Last activity', 'Created']);

        await press(menuItem('Finished threads'));
        expect(ui().showFinishedThreads).toBe(false);
        await draw();

        // The working thread and the one waiting for its background work stay; c-6a's own thread is done, so c-6a has nothing to fold.
        expect(rowKeys().filter(key => key?.startsWith('c-6'))).toEqual(['c-6', 'c-6a', 'c-6e']);
        expect(foldOf('c-6a')).toBeNull();
    });

    it('keeps a finished thread listed while it is the open chat', async () => {
        await draw(() => {
            ui().setShowFinishedThreads(false);
            ui().openChat('c-6b');
        });
        // The screen opened the fold above it: drawn again, as the observer would.
        await draw();

        expect(rowKeys()).toContain('c-6b');
        expect(isSelected('c-6b')).toBe(true);
    });

    it('opens the folds above a thread opened from elsewhere, and lets the person fold them again', async () => {
        await draw(() => ui().openChat('c-6a1'));
        await draw();

        expect(ui().expandedChats).toEqual(expect.arrayContaining(['c-6', 'c-6a']));
        expect(isSelected('c-6a1')).toBe(true);
        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe('c-6a1');

        await act(async () => foldOf('c-6')!.click());
        await draw();

        expect(rowKeys()).not.toContain('c-6a1');
        expect(ui().expandedChats).not.toContain('c-6');
    });

    it('marks a chat at rest whose threads work with the working dot, and each thread with its own state', async () => {
        await draw(() => ui().toggleChatExpanded('c-6'));

        expect(dotOf('c-6')).toBe('Threads working');
        expect(dotOf('c-6a')).toBe('Working');
        expect(dotOf('c-6c')).toBe('Failed');
        expect(dotOf('c-6b')).toBeUndefined();
        expect(rowOf('c-6e').querySelector('[data-provider]')?.getAttribute('data-provider')).toBe('codex');
    });

    it('offers no Archive on a chat whose threads work, and offers it on a finished thread', async () => {
        await draw(() => ui().toggleChatExpanded('c-6'));

        expect(rowOf('c-6').querySelector('button[aria-label="Archive"]')?.hasAttribute('disabled')).toBe(true);
        expect(rowOf('c-6b').querySelector('button[aria-label="Archive"]')?.hasAttribute('disabled')).toBe(false);

        await press(rowOf('c-6').querySelector<HTMLElement>('button[aria-label="Chat actions"]')!);

        expect(menuItem('Archive').textContent).toContain('Stop its threads first');
    });

    it('lists a thread put away alone in the archive by its title, and the threads put away with their chat nowhere on their own', async () => {
        const archiveTitles = () => [...document.body.querySelectorAll<HTMLElement>('[role="row"]')].filter(row => !container.contains(row)).map(row => row.textContent);

        await store.command({ type: 'chat.setArchived', chatId: 'c-6b', archived: true });
        await vi.waitFor(() => expect(project().chats.get('c-6b')?.archivedAt).toBeDefined());
        await draw();
        await press(buttonNamed('Archive'));

        expect(archiveTitles()).toEqual([expect.stringMatching(/^Write the refund tests/)]);

        await press(buttonNamed('Archive'));
        await stopThreads();
        await store.command({ type: 'chat.setArchived', chatId: 'c-6', archived: true });
        await vi.waitFor(() => expect(project().chats.get('c-6')?.archivedAt).toBeDefined());
        await draw();
        await press(buttonNamed('Archive'));

        expect(archiveTitles()).toEqual([expect.stringMatching(/^Ship the checkout/)]);
        expect(rowKeys().some(key => key?.startsWith('c-6'))).toBe(false);
    });

    it('asks before deleting a chat with threads, saying how many go with it', async () => {
        const { openConfirmModal } = await import('@clowdy/components/modals');

        await stopThreads();
        await draw();
        await press(rowOf('c-6').querySelector<HTMLElement>('button[aria-label="Chat actions"]')!);
        await press(menuItem('Delete'));

        expect(openConfirmModal).toHaveBeenCalledWith(expect.objectContaining({ message: '"Ship the checkout", its 5 threads and the runs of their agents are deleted for good. The tasks they made stay.' }));
    });
});
