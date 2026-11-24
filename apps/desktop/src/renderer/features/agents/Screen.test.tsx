// @vitest-environment happy-dom
import { openConfirmModal } from '@clowdy/components/modals';
import { runInAction } from 'mobx';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_EMPTY_PROJECT_ID,
    FIXTURE_PROJECT_ID,
    FIXTURE_WORKSPACE_CHAT_ID,
    type FixtureData,
    withFixtureWorkspace,
} from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { hotkeys, installDispatcher } from '../../hotkeys';
import { RootStore, RootStoreProvider } from '../../stores';
import { chatListPreferences } from './chatListPreferences';
import { Screen } from './Screen';
import { starCardPreferences } from './starCardState';

import type { ProjectInfo } from '@clowdy/protocol';
import type { Editor } from '@tiptap/core';
import type { ReactNode } from 'react';
import type { KeyValueStorage } from '../../stores/storage';

// `Modal` cannot load under the desktop's Vitest (decorators), and no confirmation is opened here.
vi.mock('@clowdy/components/modals', () => ({ openConfirmModal: vi.fn() }));

// The pages beside the list are drawn by their own tests; here they only say which one was asked for. A chat's `controls` stand beside it, as the line under its message box.
vi.mock('../chats/ChatView', () => ({
    ChatView: ({ chat, controls }: { chat: { id: string; title: string }; controls?: ReactNode }) => (
        <>
            <div data-testid="chat" data-chat-id={chat.id}>
                {chat.title}
            </div>
            {controls}
        </>
    ),
}));
vi.mock('./RunDetail', () => ({
    RunDetail: ({ run }: { run: { id: string; name: string } }) => (
        <div data-testid="run" data-run-id={run.id}>
            {run.name}
        </div>
    ),
}));

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

const draw = (before?: () => void) =>
    act(async () => {
        before?.();
        reactRoot.render(
            <RootStoreProvider value={store}>
                <Screen />
            </RootStoreProvider>
        );
    });

/** The heading of the one folder of the fixture project's group: a list is grouped by folder even for a project of one folder. */
const MAIN_GROUP = '@folder:fld_car_rental';
const rowKeys = () => [...container.querySelectorAll('[role="row"]')].map(row => row.getAttribute('data-key'));
const rowOf = (key: string) => container.querySelector<HTMLElement>(`[role="row"][data-key="${key}"]`)!;
const isSelected = (key: string) => rowOf(key).hasAttribute('data-selected');
const buttonNamed = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

/** A press with a mouse: what React Aria opens a menu on, and picks an item with. */
const press = async (target: HTMLElement) =>
    act(async () => {
        target.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true })
        );
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        target.dispatchEvent(
            new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true })
        );
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        target.click();
    });
const menuItem = (name: string) =>
    [...document.body.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(row =>
        row.textContent?.includes(name)
    )!;

beforeEach(async () => {
    chatListPreferences.setSort('activity');
    chatListPreferences.setShowFinishedThreads(true);
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
    chatListPreferences.setSort('activity');
    chatListPreferences.setShowFinishedThreads(true);
});

describe('the list', () => {
    it('starts with the new-chat row, then the chats, and has no row for a run', () => {
        // The orchestrator is the chat, and a native sub-agent is a card on the call that started it: neither is a row.
        expect(rowKeys()).toEqual(['@new-chat', MAIN_GROUP, 'c-1', 'c-4', 'c-6', 'c-5', 'c-3', 'c-2']);
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

    it('sorts the chats by when they were made, as a list starts, until the Filters menu asks for the last activity', async () => {
        const chatKeys = () => rowKeys().filter(key => key?.startsWith('c-'));

        // The list starts in the order they were made (the default of the preference); the rest of this file starts on the last activity.
        await draw(() => chatListPreferences.setSort('created'));

        expect(chatKeys()).toEqual(['c-4', 'c-5', 'c-3', 'c-6', 'c-1', 'c-2']);

        await press(container.querySelector<HTMLElement>('button[aria-label="Filters"]')!);

        expect(document.body.textContent).toContain('Sort by');
        expect(menuItem('Created').getAttribute('aria-checked')).toBe('true');
        expect(menuItem('Last activity').getAttribute('aria-checked')).toBe('false');

        // A message in a chat does not move it while the list is in the order they were made in.
        await draw(() => {
            project().chats.set('c-2', { ...project().chats.get('c-2')!, updatedAt: Date.now() });
        });
        expect(chatKeys()).toEqual(['c-4', 'c-5', 'c-3', 'c-6', 'c-1', 'c-2']);

        await press(menuItem('Last activity'));
        expect(chatListPreferences.sort).toBe('activity');
        await draw();
        // The chat that just got a message is at the top now.
        expect(chatKeys()).toEqual(['c-2', 'c-1', 'c-4', 'c-6', 'c-5', 'c-3']);
    });

    it('keeps the row of an open `⋯` menu as if hovered, since the pointer is in the menu and not on the row', async () => {
        const menuButton = () => rowOf('c-4').querySelector<HTMLElement>('button[aria-label="Chat actions"]')!;

        expect(rowOf('c-4').hasAttribute('data-open')).toBe(false);

        await press(menuButton());

        expect(rowOf('c-4').hasAttribute('data-open')).toBe(true);
        expect(rowOf('c-3').hasAttribute('data-open')).toBe(false);

        await act(async () => {
            document.body
                .querySelector('[role="menu"]')!
                .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
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

describe('a side panel that covers the chat', () => {
    const cover = async (open: () => void) => {
        await draw(() => {
            open();
            ui().openSidePanelTab('tasks');
        });

        expect(ui().sidePanelCoversChat).toBe(true);
    };
    const covering = () => ui().sidePanelCoversChat;

    it('is shut by a press on the row of the chat that is open already, which the list does not report as a selection', async () => {
        await cover(() => ui().openChat('c-3'));
        await press(rowOf('c-3'));

        expect(covering()).toBe(false);
        expect(ui().sidePanelOpen).toBe(false);
        expect(ui().chatId).toBe('c-3');
    });

    it('is shut by Enter or Space on that row, and by a press on the new-chat row while the new chat is open', async () => {
        await cover(() => ui().openChat('c-3'));
        await act(async () =>
            rowOf('c-3').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        );

        expect(covering()).toBe(false);

        await cover(() => ui().openDraft());
        await press(rowOf('@new-chat'));

        expect(covering()).toBe(false);
    });

    it('is shut by a press on another chat', async () => {
        await cover(() => ui().openChat('c-3'));
        await press(rowOf('c-5'));

        expect(covering()).toBe(false);
        expect(ui().chatId).toBe('c-5');
    });

    it("stays when a control of the open chat's row is pressed, which is not a press on the chat", async () => {
        await cover(() => ui().openChat('c-3'));
        await press(rowOf('c-3').querySelector<HTMLElement>('button[aria-label="Chat actions"]')!);

        expect(covering()).toBe(true);
    });

    it("leaves a panel beside the chat alone when the open chat's row is pressed", async () => {
        await draw(() => {
            ui().openChat('c-3');
            ui().openSidePanelTab('files');
        });
        await press(rowOf('c-3'));

        expect([ui().sidePanelOpen, ui().sidePanelTab]).toEqual([true, 'files']);
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

    const pressEnter = () =>
        act(async () => {
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

        // The new-chat row, and the folder's group with its note that it has no chat.
        expect(rowKeys()).toEqual(['@new-chat', expect.stringMatching(/^@folder:/), expect.stringMatching(/^@empty:/)]);
        expect(isSelected('@new-chat')).toBe(true);
        expect(field()).not.toBeNull();
    });
});

describe('grouped by folder', () => {
    const API = { id: 'fld_api', path: '/Users/dev/car-rental-api' };
    const MAIN = 'fld_car_rental';
    /** The name of the one folder of the fixture project. */
    const SINGLE = 'car-rental';
    const head = (folderId: string) => `@folder:${folderId}`;
    const field = () => container.querySelector<HTMLElement>('[contenteditable="true"]');
    const editor = () => (field() as HTMLElement & { editor: Editor }).editor;
    /** The select under the new-chat page's message box, and the rows of its list. */
    const folderSelect = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Folder:"]');
    /** The read only line of a chat that is made, in the place the select had. */
    const folderLine = () => container.querySelector<HTMLElement>('[role="group"][aria-label="Folder"]');
    const folderItem = (name: string) =>
        [...document.body.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(row => row.textContent === name)!;
    const filtersMenu = async () => {
        await press(container.querySelector<HTMLElement>('button[aria-label="Filters"]')!);

        return [...document.body.querySelectorAll('[role^="menuitem"]')].map(row => row.textContent);
    };

    /** The fixture project with a second folder, `car-rental-api`, where c-2 works; the switch is on unless `grouping` says otherwise, and `null` keeps no choice. */
    async function restart({
        grouping = true,
        transport = new FixtureTransport({ data: twoFolders() }),
    }: {
        grouping?: boolean | null;
        transport?: FixtureTransport;
    } = {}) {
        act(() => reactRoot.unmount());
        store.dispose();
        reactRoot = createRoot(container);
        store = new RootStore(transport, { storage: memoryStorage() });
        await store.load();
        await draw(() => {
            if (grouping !== null) ui().setGroupByFolder(grouping);
        });
    }

    function twoFolders(change?: (data: FixtureData) => void): FixtureData {
        const data = createFixtureData();

        data.projects.find(candidate => candidate.id === FIXTURE_PROJECT_ID)!.folders.push(API);
        data.chats.find(chat => chat.id === 'c-2')!.folderId = API.id;
        change?.(data);

        return data;
    }

    it('offers the switch to a project of one folder as well, on until it is turned off', async () => {
        // A project that kept no choice groups, whatever number of folders it has.
        expect(await filtersMenu()).toEqual([
            'Show finished sub-threads',
            'Group chats by folder',
            'Last activity',
            'Created',
        ]);
        expect(menuItem('Group chats by folder').getAttribute('aria-checked')).toBe('true');
        expect(rowKeys()).toContain(MAIN_GROUP);

        await restart({ grouping: null });

        expect(await filtersMenu()).toEqual([
            'Show finished sub-threads',
            'Group chats by folder',
            'Last activity',
            'Created',
        ]);
        expect(menuItem('Group chats by folder').getAttribute('aria-checked')).toBe('true');
        expect(rowKeys()).toContain(head(MAIN));

        await press(menuItem('Group chats by folder'));
        expect(ui().groupByFolder).toBe(false);
        await draw();

        expect(rowKeys()).not.toContain(head(MAIN));
    });

    it('groups a project of one folder too, and keeps the list flat once the switch is off', async () => {
        await draw(() => ui().setGroupByFolder(true));

        expect(rowKeys()).toEqual(['@new-chat', MAIN_GROUP, 'c-1', 'c-4', 'c-6', 'c-5', 'c-3', 'c-2']);

        await draw(() => ui().setGroupByFolder(false));

        expect(rowKeys()).toEqual(['@new-chat', 'c-1', 'c-4', 'c-6', 'c-5', 'c-3', 'c-2']);
    });

    it('lists a group for each folder, main first, with the chats that work in it below; a chat with no folder is in the main one', async () => {
        await restart();

        expect(rowKeys()).toEqual(['@new-chat', head(MAIN), 'c-1', 'c-4', 'c-6', 'c-5', 'c-3', head(API.id), 'c-2']);
        expect(rowOf(head(MAIN)).textContent).toContain('car-rental');
        expect(rowOf(head(API.id)).textContent).toContain('car-rental-api');
        // A group heading is no page: it is never the selected row.
        expect(isSelected(head(API.id))).toBe(false);
    });

    it('says so under a group with no chat', async () => {
        await restart({
            transport: new FixtureTransport({
                data: twoFolders(data => void delete data.chats.find(chat => chat.id === 'c-2')!.folderId),
            }),
        });

        expect(rowKeys()).toEqual([
            '@new-chat',
            head(MAIN),
            'c-1',
            'c-4',
            'c-6',
            'c-5',
            'c-3',
            'c-2',
            head(API.id),
            `@empty:${API.id}`,
        ]);
        expect(rowOf(`@empty:${API.id}`).textContent).toBe('No chats');
    });

    it('opens the menu of the folder from a press on the name of its group, with the new-chat page of that folder shown, in the desktop app only', async () => {
        const name = (folderId: string) =>
            rowOf(head(folderId)).querySelector<HTMLButtonElement>('button[aria-label^="Folder:"]');
        const menuItems = () =>
            [...document.body.querySelectorAll('[role="menu"][aria-label="Open folder"] [role="menuitem"]')].map(
                row => row.textContent
            );

        // With no desktop bridge there is nothing to open a folder in: the name is a label.
        await restart();
        expect(name(MAIN)).toBeNull();

        window.desktop = {
            getOpenApps: async () => ({ editors: [], terminals: [], fileManagers: [] }),
            openPath: vi.fn(async () => undefined),
        } as never;

        try {
            await restart();
            expect(name(MAIN)?.textContent).toBe('car-rental');
            await draw(() => ui().openChat('c-1'));

            // The press shows the new chat of the folder, which is then the folder the window works in: the menu can open it in the Files tab and the terminal.
            await press(name(API.id)!);
            expect([ui().draft, ui().draftFolderId]).toEqual([true, API.id]);
            // Manage worktrees… is the last item, there from the first frame.
            expect(menuItems()).toEqual([
                'Open in Files',
                'Open in Terminal',
                'Copy path',
                'Open in…',
                'Manage worktrees…',
            ]);

            // The main folder's new chat has no folder of its own. The menu holds the page while it is open: this one is a fresh start.
            await restart();
            await draw(() => ui().openChat('c-2'));
            await press(name(MAIN)!);
            expect([ui().draft, ui().draftFolderId]).toEqual([true, null]);
            expect(menuItems()).toEqual([
                'Open in Files',
                'Open in Terminal',
                'Copy path',
                'Open in…',
                'Manage worktrees…',
            ]);
            // It folds nothing.
            expect(ui().collapsedFolders).toEqual([]);
        } finally {
            window.desktop = undefined;
        }
    });

    it('puts right a folder that is gone from the disk from the menu of its group: Locate… moves the folder, Remove from project takes it out', async () => {
        const transport = new FixtureTransport({ data: twoFolders() });
        const info = await transport.getProjectsInfo();
        const choose = vi.fn(async () => ['/Users/dev/api-moved']);

        vi.spyOn(transport, 'getProjectsInfo').mockResolvedValue(
            info.map(entry =>
                entry.projectId === FIXTURE_PROJECT_ID
                    ? {
                          ...entry,
                          folders: entry.folders.map(folder => ({ ...folder, exists: folder.folderId !== API.id })),
                      }
                    : entry
            )
        );
        window.desktop = {
            getOpenApps: async () => ({ editors: [], terminals: [], fileManagers: [] }),
            openPath: vi.fn(async () => undefined),
            chooseDirectories: choose,
        } as never;

        try {
            const name = (folderId: string) =>
                rowOf(head(folderId)).querySelector<HTMLButtonElement>('button[aria-label^="Folder:"]')!;
            const menuItems = () =>
                [...document.body.querySelectorAll('[role="menu"][aria-label="Open folder"] [role="menuitem"]')].map(
                    row => row.textContent
                );
            const item = (text: string) =>
                [
                    ...document.body.querySelectorAll<HTMLElement>(
                        '[role="menu"][aria-label="Open folder"] [role="menuitem"]'
                    ),
                ].find(row => row.textContent === text)!;

            await restart({ transport });
            await press(name(API.id));

            // The folder is there, and the page is not taken from the chat: nothing to start in a folder that is gone.
            expect(ui().draft).toBe(false);
            expect(menuItems()).toEqual([
                'Locate…',
                'Remove from project',
                'Copy path',
                'Open in…',
                'Manage worktrees…',
            ]);

            await press(item('Locate…'));
            await vi.waitFor(() =>
                expect(store.projects.find(project => project.id === FIXTURE_PROJECT_ID)?.folders[1]).toEqual({
                    id: API.id,
                    path: '/Users/dev/api-moved',
                })
            );
            expect(store.projects.find(project => project.id === FIXTURE_PROJECT_ID)?.folders[0].id).toBe(MAIN);

            // A chat works in the folder, so taking it out asks first (it is named by its new place now).
            await restart({ transport });
            await press(name(API.id));
            await press(item('Remove from project'));

            expect(openConfirmModal).toHaveBeenCalledWith(
                expect.objectContaining({
                    title: 'Remove api-moved?',
                    message: expect.stringContaining('1 chat works in api-moved'),
                }),
                expect.anything()
            );

            // A folder that is there has none of it.
            await restart();
            await press(name(API.id));

            expect(menuItems()).not.toContain('Locate…');
        } finally {
            window.desktop = undefined;
        }
    });

    it('folds a group by the chevron after its name and by the arrows, not by a press on the heading, and remembers it', async () => {
        await restart();
        // The heading is a label: a press on its name folds nothing.
        await press(rowOf(head(API.id)));

        expect(ui().collapsedFolders).toEqual([]);
        expect(buttonNamed('Collapse car-rental-api').getAttribute('aria-expanded')).toBe('true');

        await press(buttonNamed('Collapse car-rental-api'));

        expect(ui().collapsedFolders).toEqual([API.id]);
        await draw();
        expect(rowKeys()).toEqual(['@new-chat', head(MAIN), 'c-1', 'c-4', 'c-6', 'c-5', 'c-3', head(API.id)]);
        expect(rowOf(head(API.id)).hasAttribute('data-collapsed')).toBe(true);
        expect(rowOf(head(API.id)).hasAttribute('data-plateless')).toBe(true);
        expect(buttonNamed('Expand car-rental-api').getAttribute('aria-expanded')).toBe('false');

        await press(buttonNamed('Expand car-rental-api'));
        await draw();
        expect(rowKeys()).toContain('c-2');

        const key = (name: string) =>
            act(async () => {
                rowOf(head(MAIN)).dispatchEvent(
                    new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
                );
            });

        await key('ArrowLeft');
        expect(ui().collapsedFolders).toEqual([MAIN]);
        await draw();
        expect(rowKeys()).toEqual(['@new-chat', head(MAIN), head(API.id), 'c-2']);
        await key('ArrowRight');
        expect(ui().collapsedFolders).toEqual([]);
    });

    it("steps J and K over the headings as the arrows do, and past a group's note of no chats", async () => {
        await restart({
            transport: new FixtureTransport({
                data: twoFolders(data => void delete data.chats.find(chat => chat.id === 'c-2')!.folderId),
            }),
        });

        const uninstall = installDispatcher(hotkeys);
        const focused = () => document.activeElement?.getAttribute('data-key');
        const step = async (name: string) => {
            await act(async () => {
                document.activeElement!.dispatchEvent(
                    new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
                );
            });

            return focused();
        };

        try {
            rowOf('@new-chat').focus();

            expect(await step('j')).toBe(head(MAIN));
            expect(await step('j')).toBe('c-1');

            rowOf('c-2').focus();

            expect(await step('j')).toBe(head(API.id));
            // The note below the last heading is no row to stop on.
            expect(await step('j')).toBe(head(API.id));
            expect(await step('k')).toBe('c-2');

            rowOf(head(MAIN)).focus();

            expect(await step('k')).toBe('@new-chat');
        } finally {
            uninstall();
        }
    });

    it('opens the folded group of a chat opened from elsewhere', async () => {
        await restart();
        await draw(() => ui().toggleFolderCollapsed(API.id));

        expect(rowKeys()).not.toContain('c-2');

        await draw(() => ui().openChat('c-2'));
        await draw();

        expect(ui().collapsedFolders).toEqual([]);
        expect(rowKeys()).toContain('c-2');
        expect(isSelected('c-2')).toBe(true);
    });

    it('has a button in each heading for a chat in that folder: the page says where, and the new-chat row stays the open one', async () => {
        await restart();
        await press(buttonNamed('New chat in car-rental-api'));
        await draw();

        expect([ui().draft, ui().draftFolderId]).toEqual([true, API.id]);
        expect(folderSelect()?.textContent).toBe('car-rental-api');
        // Whatever folder the page is for, the row at the top is the one marked, and no heading is.
        expect(isSelected('@new-chat')).toBe(true);
        expect(rowOf(head(API.id)).hasAttribute('data-open')).toBe(false);

        // The main group's button is the same page as the row at the top.
        await press(buttonNamed('New chat in car-rental'));
        await draw();

        expect([ui().draft, ui().draftFolderId]).toEqual([true, null]);
        expect(isSelected('@new-chat')).toBe(true);
        expect(folderSelect()?.textContent).toBe('car-rental');
    });

    it("shows the main folder's page when the folder the new-chat page was for left the project", async () => {
        await restart();
        await draw(() => ui().openDraft([], 'fld_gone'));

        expect(isSelected('@new-chat')).toBe(true);
        expect(rowOf(head(API.id)).hasAttribute('data-open')).toBe(false);
        expect(folderSelect()?.textContent).toBe('car-rental');
        expect(container.textContent).not.toContain('fld_gone');
    });

    describe('the folder select of the new-chat page', () => {
        it('lists the folders of the project by name and ticks the one the chat is for, and picking another changes it', async () => {
            await restart();
            await press(rowOf('@new-chat'));
            await draw();

            expect(folderSelect()?.getAttribute('aria-label')).toBe('Folder: car-rental');

            await press(folderSelect()!);

            // The names are all of it: no path.
            expect([...document.body.querySelectorAll('[role^="menuitem"]')].map(row => row.textContent)).toEqual([
                'car-rental',
                'car-rental-api',
            ]);
            // The chosen folder is told to assistive technology, not only drawn as a tick, and the other is not.
            expect(folderItem('car-rental').getAttribute('aria-checked')).toBe('true');
            expect(folderItem('car-rental-api').getAttribute('aria-checked')).toBe('false');
            expect(folderItem('car-rental-api').getAttribute('aria-disabled')).not.toBe('true');

            await press(folderItem('car-rental-api'));
            await draw();

            expect([ui().draft, ui().draftFolderId]).toEqual([true, API.id]);
            expect(folderSelect()?.textContent).toBe('car-rental-api');
            // The new-chat row stays the open one, as when the heading's own button opened the page.
            expect(rowOf(head(API.id)).hasAttribute('data-open')).toBe(false);
            expect(isSelected('@new-chat')).toBe(true);

            await press(folderSelect()!);

            expect(folderItem('car-rental').getAttribute('aria-checked')).toBe('false');
            expect(folderItem('car-rental-api').getAttribute('aria-checked')).toBe('true');

            // The main folder is no folder of its own: it is the page the row at the top opens.
            await press(folderItem('car-rental'));
            await draw();

            expect([ui().draft, ui().draftFolderId]).toEqual([true, null]);
            expect(folderSelect()?.textContent).toBe('car-rental');
            expect(isSelected('@new-chat')).toBe(true);
        });

        it('keeps the words of the message when another folder is picked', async () => {
            await restart();
            await press(rowOf('@new-chat'));
            await draw();
            editor().commands.insertContent('Fix the endpoint');

            // The draft of the project may hold words of an earlier test: what is there is what must stay.
            const words = editor().getText();

            expect(words).toContain('Fix the endpoint');

            await press(folderSelect()!);
            await press(folderItem('car-rental-api'));
            await draw();

            expect(ui().draftFolderId).toBe(API.id);
            expect(editor().getText()).toBe(words);
        });

        it('adds no read of what the daemon knows of the folders when the page opens: the list and the page share the one', async () => {
            const transport = new FixtureTransport({ data: twoFolders() });
            const read = vi.spyOn(transport, 'getProjectsInfo');
            // The folder line reads the git facts of its one project (the branch): that is a read of its own, cheap, and not the one of every project that these tests watch.
            const allProjects = () => read.mock.calls.filter(([projectId]) => projectId === undefined).length;

            await restart({ transport });

            const reads = allProjects();

            expect(reads).toBe(1);

            await press(rowOf('@new-chat'));
            await draw();
            await press(buttonNamed('New chat in car-rental-api'));
            await draw();
            await draw(() => ui().openChat('c-2'));
            await press(rowOf('@new-chat'));
            await draw();

            expect(folderSelect()).not.toBeNull();
            expect(allProjects()).toBe(reads);
        });

        it('makes the chat in the folder that was picked there', async () => {
            const before = new Set(project().chats.keys());

            await restart();
            await press(rowOf('@new-chat'));
            await draw();
            await press(folderSelect()!);
            await press(folderItem('car-rental-api'));
            await draw();
            editor().commands.insertContent('Fix the endpoint');
            await act(async () => {
                field()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            });
            await draw();

            const made = [...project().chats.values()].filter(chat => !before.has(chat.id));

            expect(made).toHaveLength(1);
            expect(made[0]?.folderId).toBe(API.id);
        });

        it('is only on the new-chat page, grouped or flat, and a project of one folder has its folder read only in its place', async () => {
            await restart();
            await draw(() => ui().openChat('c-2'));

            expect(folderSelect()).toBeNull();

            await draw(() => ui().openDraft());

            expect(folderSelect()).not.toBeNull();

            await draw(() => ui().setGroupByFolder(false));

            expect(folderSelect()).not.toBeNull();

            // The fixture project has one folder: nothing to pick, so the line only says where the chat will work.
            act(() => reactRoot.unmount());
            store.dispose();
            reactRoot = createRoot(container);
            store = new RootStore(new FixtureTransport(), { storage: memoryStorage() });
            await store.load();
            await draw(() => {
                ui().setGroupByFolder(true);
                ui().openDraft();
            });

            expect(folderSelect()).toBeNull();
            expect(folderLine()?.textContent).toBe(SINGLE);
            expect(container.textContent).toContain('What should we work on?');
        });

        it('lists a folder that is gone from the disk, and does not let it be picked', async () => {
            const transport = new FixtureTransport({ data: twoFolders() });
            const info = await transport.getProjectsInfo();

            vi.spyOn(transport, 'getProjectsInfo').mockResolvedValue(
                info.map(entry =>
                    entry.projectId === FIXTURE_PROJECT_ID
                        ? {
                              ...entry,
                              folders: entry.folders.map(folder => ({ ...folder, exists: folder.folderId !== API.id })),
                          }
                        : entry
                )
            );
            await restart({ transport });
            await press(rowOf('@new-chat'));
            await draw();
            await press(folderSelect()!);

            // Its line says why it is not to be picked.
            const gone = [...document.body.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(row =>
                row.textContent?.startsWith('car-rental-api')
            )!;

            expect(gone.textContent).toBe('car-rental-apiThis folder no longer exists');
            expect(gone.getAttribute('aria-disabled')).toBe('true');

            await press(gone);

            expect(ui().draftFolderId).toBeNull();
        });
    });

    describe('the folder of a chat that is made', () => {
        it('stays under the message box with no select: the name, and the path on hover', async () => {
            await restart();
            await draw(() => ui().openChat('c-2'));

            expect(folderLine()?.textContent).toBe('car-rental-api');
            expect(folderLine()?.getAttribute('title')).toBe('~/car-rental-api');
            // Read only: nothing in it opens a list or takes a press.
            expect(folderSelect()).toBeNull();
            expect(folderLine()?.querySelector('button, [tabindex]')).toBeNull();

            // A chat with no folder works in the main one.
            await draw(() => ui().openChat('c-1'));

            expect(folderLine()?.textContent).toBe('car-rental');
        });

        it('is under the message box of the chat the page made, in the folder picked there', async () => {
            const before = new Set(project().chats.keys());

            await restart();
            await press(rowOf('@new-chat'));
            await draw();
            await press(folderSelect()!);
            await press(folderItem('car-rental-api'));
            await draw();
            editor().commands.insertContent('Fix the endpoint');
            await act(async () => {
                field()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            });
            await draw();

            expect([...project().chats.keys()].some(id => !before.has(id))).toBe(true);
            expect(folderSelect()).toBeNull();
            expect(folderLine()?.textContent).toBe('car-rental-api');
        });

        it('says when the folder is gone from the disk', async () => {
            const transport = new FixtureTransport({ data: twoFolders() });
            const info = await transport.getProjectsInfo();

            vi.spyOn(transport, 'getProjectsInfo').mockResolvedValue(
                info.map(entry =>
                    entry.projectId === FIXTURE_PROJECT_ID
                        ? {
                              ...entry,
                              folders: entry.folders.map(folder => ({ ...folder, exists: folder.folderId !== API.id })),
                          }
                        : entry
                )
            );
            await restart({ transport });
            await draw(() => ui().openChat('c-2'));

            expect(folderLine()?.hasAttribute('data-missing')).toBe(true);
            expect(folderLine()?.getAttribute('title')).toBe('This folder no longer exists');

            await draw(() => ui().openChat('c-1'));

            expect(folderLine()?.hasAttribute('data-missing')).toBe(false);
        });

        it('is there in a chat that is made, grouped or flat, and in a project of one folder', async () => {
            await restart({ grouping: false });
            await draw(() => ui().openChat('c-2'));

            expect(folderLine()?.textContent).toBe('car-rental-api');

            await draw(() => ui().setGroupByFolder(true));

            expect(folderLine()?.textContent).toBe('car-rental-api');

            // The fixture project has one folder.
            act(() => reactRoot.unmount());
            store.dispose();
            reactRoot = createRoot(container);
            store = new RootStore(new FixtureTransport(), { storage: memoryStorage() });
            await store.load();
            await draw(() => {
                ui().setGroupByFolder(true);
                ui().openChat('c-1');
            });

            expect(folderLine()?.textContent).toBe(SINGLE);
        });
    });

    it('reads what the daemon knows of the folders once, when the screen opens, whether the list is grouped or not, and not again on a timer', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

        try {
            const transport = new FixtureTransport({ data: twoFolders() });
            const read = vi.spyOn(transport, 'getProjectsInfo');
            // The folder line's own read of its project (the branch) is not counted: this is about the read of every project.
            const allProjects = () => read.mock.calls.filter(([projectId]) => projectId === undefined).length;

            await restart({ grouping: false, transport });
            expect(allProjects()).toBe(1);

            await draw(() => ui().setGroupByFolder(true));
            expect(allProjects()).toBe(1);

            await act(async () => void vi.advanceTimersByTime(60_000));
            expect(allProjects()).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('makes the chat in the folder of the page it was started from', async () => {
        const before = new Set(project().chats.keys());

        await restart();
        await press(buttonNamed('New chat in car-rental-api'));
        await draw();
        editor().commands.insertContent('Fix the endpoint');
        await act(async () => {
            field()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        });
        await draw();

        const made = [...project().chats.values()].filter(chat => !before.has(chat.id));

        expect(made).toHaveLength(1);
        expect(made[0]?.folderId).toBe(API.id);
    });

    it('says a folder is gone by its name, and keeps its button off', async () => {
        const transport = new FixtureTransport({ data: twoFolders() });
        const info = await transport.getProjectsInfo();

        vi.spyOn(transport, 'getProjectsInfo').mockResolvedValue(
            info.map(entry =>
                entry.projectId === FIXTURE_PROJECT_ID
                    ? {
                          ...entry,
                          folders: entry.folders.map(folder => ({ ...folder, exists: folder.folderId !== API.id })),
                      }
                    : entry
            )
        );
        await restart({ transport });
        await draw();

        expect(rowOf(head(API.id)).hasAttribute('data-missing')).toBe(true);
        expect(rowOf(head(MAIN)).hasAttribute('data-missing')).toBe(false);
        expect(buttonNamed('New chat in car-rental-api').disabled).toBe(true);
        expect(buttonNamed('New chat in car-rental').disabled).toBe(false);
    });
});

describe('the heading', () => {
    it('has the history, as a button, to the left of the filters', () => {
        // The rows have an Archive of their own, as a quick action: the heading's buttons are the ones outside the list.
        const buttons = [
            ...container.querySelectorAll<HTMLElement>('button[aria-label="History"], button[aria-label="Filters"]'),
        ].filter(button => !button.closest('[role="grid"]'));

        expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual(['History', 'Filters']);
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

    // The rows of the archive's list, which is in a popover beside the screen and not in it. The title of a group is a row of its own, with no key.
    const archiveRows = () =>
        [...document.body.querySelectorAll<HTMLElement>('[role="row"][data-key]')].filter(
            row => !container.contains(row)
        );
    const titles = () => archiveRows().map(row => row.textContent);
    const archiveRow = (title: string) => archiveRows().find(row => row.textContent?.startsWith(title))!;

    it('takes a chat out of the list and lists it, last put away first, with how long ago', async () => {
        await archive('c-2', true);
        await archive('c-4', true);

        expect(rowKeys()).toEqual(expect.not.arrayContaining(['c-2', 'c-4']));
        expect(rowKeys().filter(key => key?.startsWith('c-'))).toEqual(['c-1', 'c-6', 'c-5', 'c-3']);

        await press(buttonNamed('History'));

        expect(titles()).toEqual([expect.stringMatching(/^New chat/), expect.stringMatching(/^First version/)]);
        expect(titles()[0]).toMatch(/now$/);
    });

    it('opens under the heading and is wider than the column, so a title and its time have room', async () => {
        await press(buttonNamed('History'));

        const popover = document.body.querySelector<HTMLElement>('[data-modal-clickout-layer]')!;

        expect(popover.style.width).toBe('280px');
    });

    it('groups the chats by the day they were put away', async () => {
        await archive('c-2', true);
        await archive('c-4', true);
        await press(buttonNamed('History'));

        // Both were put away just now.
        const groups = [...document.body.querySelectorAll<HTMLElement>('[role="rowgroup"]')].filter(
            group => !container.contains(group)
        );

        expect(groups.map(group => group.querySelector('[role="rowheader"]')?.textContent)).toEqual(['Today']);
        expect(
            [...groups[0].querySelectorAll('[role="row"][data-key]')].map(row => row.getAttribute('data-key'))
        ).toEqual(['c-4', 'c-2']);
    });

    it('draws the time in the room of the `⋯`, which takes its place when the row is hovered', async () => {
        await archive('c-4', true);
        await press(buttonNamed('History'));

        const end = archiveRow('New chat').querySelector<HTMLElement>('button[aria-label^="Actions of"]')!
            .parentElement!;
        const time = end.querySelector<HTMLElement>('[data-show="item-rest"]')!;

        expect(time.textContent).toBe('now');
        expect(end.querySelector('button')!.getAttribute('data-show')).toBe('item-both');
    });

    it('shows the mark of the provider each chat runs on, as the list does, and the speech bubble for a chat that never started', async () => {
        await archive('c-2', true);
        await archive('c-4', true);
        await press(buttonNamed('History'));

        expect(archiveRow('First version').querySelector('[data-provider]')?.getAttribute('data-provider')).toBe(
            project().runs.get('r-orch-2')?.engine
        );
        expect(archiveRow('New chat').querySelector('[data-provider]')).toBeNull();
        expect(archiveRow('New chat').querySelector('svg')).not.toBeNull();
    });

    it('says so when there is nothing in it', async () => {
        await press(buttonNamed('History'));

        expect(titles()).toEqual([]);
        expect(document.body.textContent).toContain('No archived chats');
    });

    it('brings a chat back into the list and opens it when it is picked', async () => {
        await archive('c-4', true);
        await press(buttonNamed('History'));
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
        await press(buttonNamed('History'));

        expect(archiveRow('New chat').hasAttribute('data-open')).toBe(false);

        await press(archiveRow('New chat').querySelector<HTMLElement>('button[aria-label^="Actions of"]')!);

        expect(archiveRow('New chat').hasAttribute('data-open')).toBe(true);
    });

    it('has a menu in each row, with Unarchive and Delete', async () => {
        await archive('c-4', true);
        await press(buttonNamed('History'));
        await press(archiveRow('New chat').querySelector<HTMLElement>('button[aria-label^="Actions of"]')!);

        expect([...document.body.querySelectorAll('[role="menuitem"]')].map(row => row.textContent)).toEqual([
            'Unarchive',
            'Delete',
        ]);
    });

    it('puts a chat back in the list from its menu, without opening it', async () => {
        await archive('c-4', true);
        await press(buttonNamed('History'));
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
        await press(buttonNamed('History'));
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

    it('shows a green status in place of the archive shortcut while the chat works', () => {
        const busyActions = rowOf('c-1').querySelector('[slot="endAffix"]');

        expect(busyActions?.querySelector('button[aria-label="Archive"]')).toBeNull();
        expect(busyActions?.querySelector('[aria-label="Working"] [data-tone="success"]')).not.toBeNull();
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
        expect(buttonNamed('History').querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 16 16');
        expect(rowIcon.getAttribute('viewBox')).toBe('0 0 14 14');
    });
});

describe('threads', () => {
    const foldOf = (key: string) =>
        rowOf(key).querySelector<HTMLButtonElement>('button[aria-label^="Expand"], button[aria-label^="Collapse"]');
    const depthOf = (key: string) => rowOf(key).getAttribute('data-depth');
    const dotOf = (key: string) => rowOf(key).querySelector('[role="img"]')?.getAttribute('aria-label');
    const stopThreads = async () => {
        for (const runId of ['r-orch-6a', 'r-orch-6e']) await store.command({ type: 'run.cancel', runId });

        await vi.waitFor(() =>
            expect(['r-orch-6a', 'r-orch-6e'].map(id => project().runs.get(id)?.status)).toEqual([
                'cancelled',
                'cancelled',
            ])
        );
    };

    it("folds a chat's threads until it is opened: the chat has a fold and its threads are not rows", () => {
        expect(rowKeys()).not.toContain('c-6a');
        expect(foldOf('c-6')?.getAttribute('aria-label')).toBe('Expand Ship the checkout threads');
        expect(foldOf('c-6')?.getAttribute('aria-expanded')).toBe('false');
        expect(foldOf('c-1')).toBeNull();
    });

    it('lists the threads below their chat, one level in and in the order they were made, once the fold is opened, and at every depth', async () => {
        await act(async () => foldOf('c-6')!.click());
        expect(ui().expandedChats).toEqual(['c-6']);
        await draw();

        expect(rowKeys()).toEqual([
            '@new-chat',
            MAIN_GROUP,
            'c-1',
            'c-4',
            'c-6',
            'c-6a',
            'c-6b',
            'c-6c',
            'c-6e',
            'c-5',
            'c-3',
            'c-2',
        ]);
        expect(['c-6', 'c-6a', 'c-6e'].map(depthOf)).toEqual(['0', '1', '1']);
        expect(foldOf('c-6')?.getAttribute('aria-expanded')).toBe('true');

        await act(async () => foldOf('c-6a')!.click());
        await draw();

        expect(rowKeys().slice(4, 7)).toEqual(['c-6', 'c-6a', 'c-6a1']);
        expect(depthOf('c-6a1')).toBe('2');

        // Folding the chat hides every thread below it, the thread's own threads too.
        await act(async () => foldOf('c-6')!.click());
        await draw();

        expect(rowKeys().filter(key => key?.startsWith('c-6'))).toEqual(['c-6']);
    });

    it('opens a fold with the right arrow and closes it with the left one', async () => {
        const key = (name: string) =>
            act(async () => {
                rowOf('c-6').dispatchEvent(
                    new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
                );
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
            chatListPreferences.setSort('created');
            project().chats.set('c-6e', { ...project().chats.get('c-6e')!, updatedAt: Date.now() });
        });

        expect(rowKeys().filter(key => key?.startsWith('c-6'))).toEqual(['c-6', 'c-6a', 'c-6b', 'c-6c', 'c-6e']);
    });

    it('has a check in the Filters menu, Show finished sub-threads, that hides the threads whose run is over', async () => {
        await draw(() => ['c-6', 'c-6a'].forEach(id => ui().toggleChatExpanded(id)));
        await press(container.querySelector<HTMLElement>('button[aria-label="Filters"]')!);

        expect(menuItem('Show finished sub-threads').getAttribute('aria-checked')).toBe('true');
        expect([...document.body.querySelectorAll('[role^="menuitem"]')].map(row => row.textContent)).toEqual([
            'Show finished sub-threads',
            'Group chats by folder',
            'Last activity',
            'Created',
        ]);
        // A section that holds one check has no header; only the order does.
        expect([...document.body.querySelectorAll('[role="menu"] header')].map(header => header.textContent)).toEqual([
            'Sort by',
        ]);

        await press(menuItem('Show finished sub-threads'));
        expect(chatListPreferences.showFinishedThreads).toBe(false);
        await draw();

        // The working thread and the one waiting for its background work stay; c-6a's own thread is done, so c-6a has nothing to fold.
        expect(rowKeys().filter(key => key?.startsWith('c-6'))).toEqual(['c-6', 'c-6a', 'c-6e']);
        expect(foldOf('c-6a')).toBeNull();
    });

    it('keeps a finished thread listed while it is the open chat', async () => {
        await draw(() => {
            chatListPreferences.setShowFinishedThreads(false);
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

    it('lists a thread that waits for the person under its folded chat, with the dot on both, and the other threads stay folded away', async () => {
        // The thread rests for its background work while its agent asks: its card is the only sign (`Run.awaitingUser`).
        await draw(() => project().runs.set('r-orch-6e', { ...project().runs.get('r-orch-6e')!, awaitingUser: true }));

        expect(rowKeys()).toEqual(['@new-chat', MAIN_GROUP, 'c-1', 'c-4', 'c-6', 'c-6e', 'c-5', 'c-3', 'c-2']);
        expect(['c-6', 'c-6e'].map(depthOf)).toEqual(['0', '1']);
        expect(foldOf('c-6')?.getAttribute('aria-expanded')).toBe('false');
        expect(dotOf('c-6')).toBe('A thread is waiting for you');
        expect(dotOf('c-6e')).toBe('Waiting');

        // Opening the fold lists every thread, the asking one in its place.
        await act(async () => foldOf('c-6')!.click());
        await draw();
        expect(rowKeys()).toEqual([
            '@new-chat',
            MAIN_GROUP,
            'c-1',
            'c-4',
            'c-6',
            'c-6a',
            'c-6b',
            'c-6c',
            'c-6e',
            'c-5',
            'c-3',
            'c-2',
        ]);

        // Decided: the thread goes back behind the fold, and the chat's dot to its threads working.
        await act(async () => foldOf('c-6')!.click());
        await draw(() =>
            project().runs.set('r-orch-6e', { ...project().runs.get('r-orch-6e')!, awaitingUser: undefined })
        );
        expect(rowKeys()).not.toContain('c-6e');
        expect(dotOf('c-6')).toBe('Threads working');
    });

    it('offers no Archive on a chat whose threads work, and offers it on a finished thread', async () => {
        await draw(() => ui().toggleChatExpanded('c-6'));

        const busyActions = rowOf('c-6').querySelector('[slot="endAffix"]');

        expect(busyActions?.querySelector('button[aria-label="Archive"]')).toBeNull();
        expect(busyActions?.querySelector('[aria-label="Threads working"] [data-tone="success"]')).not.toBeNull();
        expect(rowOf('c-6b').querySelector('button[aria-label="Archive"]')?.hasAttribute('disabled')).toBe(false);

        await press(rowOf('c-6').querySelector<HTMLElement>('button[aria-label="Chat actions"]')!);

        expect(menuItem('Archive').textContent).toContain('Stop its threads first');
    });

    it('lists a thread put away alone in the archive by its title, and the threads put away with their chat nowhere on their own', async () => {
        const archiveTitles = () =>
            [...document.body.querySelectorAll<HTMLElement>('[role="row"][data-key]')]
                .filter(row => !container.contains(row))
                .map(row => row.textContent);

        await store.command({ type: 'chat.setArchived', chatId: 'c-6b', archived: true });
        await vi.waitFor(() => expect(project().chats.get('c-6b')?.archivedAt).toBeDefined());
        await draw();
        await press(buttonNamed('History'));

        expect(archiveTitles()).toEqual([expect.stringMatching(/^Write the refund tests/)]);

        await press(buttonNamed('History'));
        await stopThreads();
        await store.command({ type: 'chat.setArchived', chatId: 'c-6', archived: true });
        await vi.waitFor(() => expect(project().chats.get('c-6')?.archivedAt).toBeDefined());
        await draw();
        await press(buttonNamed('History'));

        expect(archiveTitles()).toEqual([expect.stringMatching(/^Ship the checkout/)]);
        expect(rowKeys().some(key => key?.startsWith('c-6'))).toBe(false);
    });

    it('asks before deleting a chat with threads, saying how many go with it', async () => {
        const { openConfirmModal } = await import('@clowdy/components/modals');

        await stopThreads();
        await draw();
        await press(rowOf('c-6').querySelector<HTMLElement>('button[aria-label="Chat actions"]')!);
        await press(menuItem('Delete'));

        // The message is an element (the dialog may add a checkbox for the chat's worktree) that carries the words the confirmation says.
        expect(openConfirmModal).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.objectContaining({
                    props: expect.objectContaining({
                        text: '"Ship the checkout", its 5 threads and the runs of their agents are deleted for good. The tasks they made stay.',
                    }),
                }),
            })
        );
    });
});

describe('a chat that works in a worktree', () => {
    const mark = (key: string) => rowOf(key).querySelector<HTMLElement>('[role="img"][aria-label*="worktree"]');

    async function restart(transport = new FixtureTransport({ data: withFixtureWorkspace(createFixtureData()) })) {
        act(() => reactRoot.unmount());
        store.dispose();
        reactRoot = createRoot(container);
        store = new RootStore(transport, { storage: memoryStorage() });
        await store.load();
        await draw();
    }

    /** The fixture daemon with a chat in a worktree, and what it reads of the project's worktrees as `set` last said (`undefined`: nothing). */
    function reading(workspaces: ProjectInfo['workspaces'], change?: (data: FixtureData) => void) {
        const data = withFixtureWorkspace(createFixtureData());

        change?.(data);

        const transport = new FixtureTransport({ data });
        const read = vi.spyOn(transport, 'getProjectsInfo');
        let current = workspaces;

        read.mockImplementation(async projectId =>
            (await FixtureTransport.prototype.getProjectsInfo.call(transport, projectId)).map(entry =>
                entry.projectId === FIXTURE_PROJECT_ID ? { ...entry, workspaces: current } : entry
            )
        );

        return { transport, read, set: (next: ProjectInfo['workspaces']) => void (current = next) };
    }

    it("has a branch mark after its title, with its branch in the mark's title, and no other row has one", async () => {
        await restart();

        expect(mark(FIXTURE_WORKSPACE_CHAT_ID)?.title).toBe('Works in a worktree on clowdy/ab12cd34');
        expect(mark(FIXTURE_WORKSPACE_CHAT_ID)?.querySelector('svg')).not.toBeNull();
        expect(rowKeys().filter(key => key && mark(key))).toEqual([FIXTURE_WORKSPACE_CHAT_ID]);
        // The title stays what the row is called, with the mark after it.
        expect(rowOf(FIXTURE_WORKSPACE_CHAT_ID).textContent).toContain('Weekend surcharge in a worktree');
        expect(mark(FIXTURE_WORKSPACE_CHAT_ID)?.previousElementSibling?.textContent).toBe(
            'Weekend surcharge in a worktree'
        );
    });

    it('says the branch the worktree has now, as the daemon read it, and not the one it was made with', async () => {
        await restart(reading([{ workspaceId: 'wks_ab12cd34', exists: true, branch: 'feature/other' }]).transport);

        expect(mark(FIXTURE_WORKSPACE_CHAT_ID)?.title).toBe('Works in a worktree on feature/other');
    });

    it('reads what the daemon knows again when the window gets focus, for the branch an agent switched to meanwhile', async () => {
        const { transport, read, set } = reading([
            { workspaceId: 'wks_ab12cd34', exists: true, branch: 'feature/other' },
        ]);

        await restart(transport);

        const everything = () => read.mock.calls.filter(([projectId]) => projectId === undefined).length;
        const reads = everything();

        set([{ workspaceId: 'wks_ab12cd34', exists: true, branch: 'hotfix' }]);
        await act(async () => {
            window.dispatchEvent(new Event('focus'));
        });
        await draw();

        expect(everything()).toBeGreaterThan(reads);
        expect(mark(FIXTURE_WORKSPACE_CHAT_ID)?.title).toBe('Works in a worktree on hotfix');
    });

    it('says the worktree is gone when the daemon says it is no longer on the disk', async () => {
        await restart(reading([{ workspaceId: 'wks_ab12cd34', exists: false }]).transport);

        expect(rowOf(FIXTURE_WORKSPACE_CHAT_ID).querySelector('[role="img"]')?.getAttribute('title')).toBe(
            'The worktree no longer exists'
        );
    });

    it('reads again when a worktree gets made, so a read taken while it was being made does not make the row call it gone', async () => {
        await restart(new FixtureTransport({ data: createFixtureData() }));

        const created = await store.command({
            type: 'chat.create',
            projectId: FIXTURE_PROJECT_ID,
            workspace: { mode: 'new' },
        });
        const { chat } = (created as { data: { chat: { id: string } } }).data;

        await vi.waitFor(() => expect(project().chats.get(chat.id)?.workspace?.ready).toBe(false));
        await draw();

        // The window gets focus while the worktree is being made: the read says there is none yet, and the row, which names the branch it will be made on, is not wrong.
        await act(async () => {
            window.dispatchEvent(new Event('focus'));
        });
        await draw();
        expect(mark(chat.id)?.title).toBe(`Works in a worktree on clowdy/${chat.id.slice(-8)}`);

        await store.command({ type: 'chat.send', chatId: chat.id, text: 'Go' });
        await vi.waitFor(() => expect(project().chats.get(chat.id)?.workspace?.ready).toBe(true));
        await draw();
        await vi.waitFor(() => expect(mark(chat.id)?.title).toBe(`Works in a worktree on clowdy/${chat.id.slice(-8)}`));
        expect(mark(chat.id)?.hasAttribute('data-gone')).toBe(false);
    });

    it('falls back to the branch it was made with when the read has no word on the worktree, and to a plain line when it was made with none', async () => {
        await restart(reading(undefined).transport);

        expect(mark(FIXTURE_WORKSPACE_CHAT_ID)?.title).toBe('Works in a worktree on clowdy/ab12cd34');

        await restart(
            reading(
                undefined,
                data => void delete data.chats.find(chat => chat.id === FIXTURE_WORKSPACE_CHAT_ID)!.workspace!.branch
            ).transport
        );

        expect(mark(FIXTURE_WORKSPACE_CHAT_ID)?.title).toBe('Works in a worktree');
    });

    it("shows the chat's folder, where it works and the branch read only under its message box, from the chat's own workspace", async () => {
        await restart();
        await draw(() => ui().openChat(FIXTURE_WORKSPACE_CHAT_ID));

        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe(
            FIXTURE_WORKSPACE_CHAT_ID
        );
        await vi.waitFor(() =>
            expect(
                container.querySelector('[aria-label="Where it runs: Worktree, branch clowdy/ab12cd34"]')?.textContent
            ).toBe('Worktreeclowdy/ab12cd34')
        );

        await draw(() => ui().openChat('c-1'));

        await vi.waitFor(() =>
            expect(
                container.querySelector('[aria-label="Where it runs: Main worktree, branch main"]')?.textContent
            ).toBe('main')
        );
    });
});

describe('the Star on GitHub card', () => {
    const card = () => container.querySelector('section[aria-label="Star on GitHub"]');

    afterEach(() => {
        runInAction(() => {
            starCardPreferences.dismissed = false;
        });
        localStorage.clear();
    });

    it('stands under the list, outside its rows, while it is due, and is gone once it is closed', async () => {
        // The fixture's personal space is twelve days old and its project has six chats.
        expect(card()).not.toBeNull();
        expect(card()!.closest('[role="row"]')).toBeNull();
        expect(
            container.querySelector('[aria-label="Agents"]')!.compareDocumentPosition(card()!) &
                Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();

        await draw(() => starCardPreferences.dismiss());

        expect(card()).toBeNull();
    });
});
