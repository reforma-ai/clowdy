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
 * The Agents screen on the fixture project. Chats by activity: c-1 (Simplify booking, orchestrator r-orch-1), c-4 (empty), c-3, c-2.
 * Below r-orch-1: Executor 07 (r-ex-07), with Verifier 02 (r-ver-02) under it, and more. The test build has no MobX observer plugin,
 * so the screen is drawn again by hand after a change, as the observer does in the app.
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
    it('starts with the new-chat row, then the chats, and nests the runs of a chat below it', () => {
        const keys = rowKeys();

        expect(keys[0]).toBe('@new-chat');
        expect(keys.filter(key => key?.startsWith('c-'))).toEqual(['c-1', 'c-4', 'c-5', 'c-3', 'c-2']);

        // The orchestrator is the chat, so it has no row; its runs follow the chat, and a run's own runs follow it.
        const below = keys.slice(keys.indexOf('c-1') + 1, keys.indexOf('c-4'));

        expect(keys).not.toContain('r-orch-1');
        expect(below).toContain('r-ex-07');
        // Native sub-agents are cards on the calls that started them, not rows.
        expect(keys).not.toContain('r-na-01');
        expect(keys).not.toContain('r-na-02');
        expect(below.indexOf('r-ver-02')).toBe(below.indexOf('r-ex-07') + 1);
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

        expect(chatKeys()).toEqual(['c-1', 'c-4', 'c-5', 'c-3', 'c-2']);

        await press(container.querySelector<HTMLElement>('button[aria-label="Filters"]')!);

        // The menu has the two groups: what to show, and the order.
        expect(document.body.textContent).toContain('Show');
        expect(document.body.textContent).toContain('Sort by');
        expect(menuItem('Last activity').getAttribute('aria-checked')).toBe('true');
        expect(menuItem('Created').getAttribute('aria-checked')).toBe('false');

        await press(menuItem('Created'));
        expect(ui().chatSort).toBe('created');
        await draw();
        expect(chatKeys()).toEqual(['c-4', 'c-5', 'c-3', 'c-1', 'c-2']);

        // A message in a chat does not move it now.
        await draw(() => {
            project().chats.set('c-2', { ...project().chats.get('c-2')!, updatedAt: Date.now() });
        });
        expect(chatKeys()).toEqual(['c-4', 'c-5', 'c-3', 'c-1', 'c-2']);
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

    it('folds the runs of a chat away and brings them back', async () => {
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Collapse Simplify booking"]')!.click());

        expect(rowKeys()).not.toContain('r-ex-07');
        expect(rowKeys()).toContain('c-1');

        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Expand Simplify booking"]')!.click());

        expect(rowKeys()).toContain('r-ex-07');
    });

    it('shows no runs at all when subthreads are switched off, and no finished ones when only those are', async () => {
        const all = rowKeys().filter(key => key?.startsWith('r-'));

        await draw(() => ui().setShowFinished(false));

        const active = rowKeys().filter(key => key?.startsWith('r-'));

        expect(active.length).toBeLessThan(all.length);
        expect(active).toContain('r-ex-07');

        await draw(() => ui().setShowSubthreads(false));

        expect(rowKeys().filter(key => key?.startsWith('r-'))).toEqual([]);
        expect(rowKeys().filter(key => key?.startsWith('c-'))).toEqual(['c-1', 'c-4', 'c-5', 'c-3', 'c-2']);
    });
});

describe('what is open', () => {
    it('opens a run below its chat: the run is selected and its page shows, whichever chat was open', async () => {
        await draw(() => {
            ui().openChat('c-3');
            ui().openRun('r-ver-02');
        });

        expect(container.querySelector('[data-testid="run"]')?.getAttribute('data-run-id')).toBe('r-ver-02');
        expect(container.querySelector('[data-testid="chat"]')).toBeNull();
        expect(isSelected('r-ver-02')).toBe(true);
        expect(isSelected('c-1')).toBe(false);
    });

    it('takes the orchestrator for its chat', async () => {
        await draw(() => ui().openRun('r-orch-1'));

        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe('c-1');
        expect(isSelected('c-1')).toBe(true);
    });

    it('unfolds the chat of a run that is opened from elsewhere', async () => {
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Collapse Simplify booking"]')!.click());

        expect(rowKeys()).not.toContain('r-ex-07');

        await draw(() => ui().openRun('r-ver-02'));

        expect(rowKeys()).toContain('r-ver-02');
        expect(isSelected('r-ver-02')).toBe(true);
    });

    it('opens a native sub-agent beside its chat, which stays selected since the sub-agent has no row', async () => {
        await draw(() => ui().openRun('r-na-02'));

        expect(container.querySelector('[data-testid="run"]')?.getAttribute('data-run-id')).toBe('r-na-02');
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

    it('takes a chat out of the list, with its subthreads, and lists it, last put away first, with how long ago', async () => {
        await archive('c-2', true);
        await archive('c-4', true);

        expect(rowKeys()).toEqual(expect.not.arrayContaining(['c-2', 'c-4', 'r-ex-15']));
        expect(rowKeys().filter(key => key?.startsWith('c-'))).toEqual(['c-1', 'c-5', 'c-3']);

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
