// @vitest-environment happy-dom
import { openConfirmModal } from '@clowdy/components/modals';
import { emptyComposerDoc, plainTextToDoc } from '@clowdy/components/RichInput';
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
import { branchPullRequestsOf } from '../changes/branchPullRequests';
import { saveDraft } from '../chats/composerDrafts';
import { setFiles } from '../chats/composerFiles';
import { refreshFolderGit } from '../openWith/useFolderGit';
import { chatListPreferences } from './chatListPreferences';
import { Screen } from './Screen';
import { starCardPreferences } from './starCardState';

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
 * The Agents screen on the fixture project. Chats newest first: c-4 (empty), c-5, c-3, c-6 (Ship the checkout, at rest, with threads),
 * c-1 (Simplify booking, orchestrator r-orch-1), c-2. The threads of c-6, oldest first: c-6a (Fix the price rounding, working, with the finished thread c-6a1),
 * c-6b (finished), c-6c (failed), c-6e (waiting for background work). Native sub-agents live in r-orch-1's session (r-na-01 to r-na-05): cards in its
 * stream, and rows below c-1 once it is opened (with Expand running agents off, as here, they stay out while it is folded; `AgentListWorking.test.tsx` has them). The test build has no MobX observer plugin, so the screen is drawn again by hand after a change, as the observer does in the app.
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
    chatListPreferences.setShowFinishedThreads(true);
    // These tests read the list as it was before working agents opened their chats by themselves; `AgentListWorking.test.tsx` has the setting on.
    chatListPreferences.setExpandRunningAgents(false);
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
    chatListPreferences.setShowFinishedThreads(true);
    chatListPreferences.setExpandRunningAgents(true);
});

describe('the list', () => {
    it('keeps the chat panel from becoming a scroll container', () => {
        const panel = container.querySelector<HTMLElement>('#main > div');

        expect(panel?.style.overflow).toBe('clip');
    });

    it('starts with the new-chat row, then the chats, and has no row for a run while the chats are folded', () => {
        // The orchestrator is the chat, and a native sub-agent is a row below its chat once that is opened, or while it works with Expand running agents on.
        expect(rowKeys()).toEqual(['@new-chat', MAIN_GROUP, 'c-4', 'c-5', 'c-3', 'c-6', 'c-1', 'c-2']);
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

    it('keeps the hand-ordered list through activity and puts a newly created chat first', async () => {
        const chatKeys = () => rowKeys().filter(key => key?.startsWith('c-'));

        expect(chatKeys()).toEqual(['c-4', 'c-5', 'c-3', 'c-6', 'c-1', 'c-2']);
        await press(rowOf('c-5').querySelector<HTMLElement>('button[aria-label="Chat actions"]')!);
        await press(menuItem('Move up'));
        await draw();
        expect(chatKeys()).toEqual(['c-5', 'c-4', 'c-3', 'c-6', 'c-1', 'c-2']);
        expect(isSelected('c-4')).toBe(true);

        await draw(() => {
            const chat = project().chats.get('c-2')!;
            const now = Date.now();

            project().chats.set(chat.id, { ...chat, updatedAt: now });
            project().chats.set('c-new', { ...chat, id: 'c-new', createdAt: now, updatedAt: now });
        });
        expect(chatKeys()).toEqual(['c-new', 'c-5', 'c-4', 'c-3', 'c-6', 'c-1', 'c-2']);
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
        expect(isSelected('c-4')).toBe(true);
        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe('c-4');
    });
});

describe('what is open', () => {
    it('opens a sub-agent beside its chat, whichever chat was open: its page shows and its own row is the selected one', async () => {
        await draw(() => {
            ui().openChat('c-3');
            ui().openRun('r-na-04');
        });

        expect(container.querySelector('[data-testid="run"]')?.getAttribute('data-run-id')).toBe('r-na-04');
        expect(container.querySelector('[data-testid="chat"]')).toBeNull();
        expect(isSelected('r-na-04')).toBe(true);
        expect(isSelected('c-1')).toBe(false);
        expect(isSelected('c-3')).toBe(false);
    });

    it('takes the orchestrator for its chat', async () => {
        await draw(() => ui().openRun('r-orch-1'));

        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe('c-1');
        expect(isSelected('c-1')).toBe(true);
    });

    it('falls back to a chat when the remembered run is gone', async () => {
        await draw(() => ui().openRun('r-gone'));

        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe('c-4');
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
    const head = (folderId: string) => `@folder:${folderId}`;
    const field = () => container.querySelector<HTMLElement>('[contenteditable="true"]');
    const editor = () => (field() as HTMLElement & { editor: Editor }).editor;
    /** The select under the new-chat page's message box, and the rows of its list. */
    const folderSelect = () =>
        container.querySelector<HTMLButtonElement>('button[aria-label^="Where it runs"][aria-label*="folder "]');
    /** The read only line of a chat that is made, in the place the select had. */
    const folderLine = () => container.querySelector<HTMLElement>('[role="group"][aria-label^="Current place:"]');
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
            'Expand running agents',
            'Group chats by folder',
        ]);
        expect(menuItem('Group chats by folder').getAttribute('aria-checked')).toBe('true');
        expect(rowKeys()).toContain(MAIN_GROUP);

        await restart({ grouping: null });

        expect(await filtersMenu()).toEqual([
            'Show finished sub-threads',
            'Expand running agents',
            'Group chats by folder',
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

        expect(rowKeys()).toEqual(['@new-chat', MAIN_GROUP, 'c-4', 'c-5', 'c-3', 'c-6', 'c-1', 'c-2']);

        await draw(() => ui().setGroupByFolder(false));

        expect(rowKeys()).toEqual(['@new-chat', 'c-4', 'c-5', 'c-3', 'c-6', 'c-1', 'c-2']);
    });

    it('lists a group for each folder, main first, with the chats that work in it below; a chat with no folder is in the main one', async () => {
        await restart();

        expect(rowKeys()).toEqual(['@new-chat', head(MAIN), 'c-4', 'c-5', 'c-3', 'c-6', 'c-1', head(API.id), 'c-2']);
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
            'c-4',
            'c-5',
            'c-3',
            'c-6',
            'c-1',
            'c-2',
            head(API.id),
            `@empty:${API.id}`,
        ]);
        expect(rowOf(`@empty:${API.id}`).textContent).toBe('No chats');
    });

    it('keeps the current chat when opening a folder menu and opens a draft when New chat is chosen', async () => {
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
            await restart({ transport: new FixtureTransport({ data: withFixtureWorkspace(twoFolders()) }) });
            expect(name(MAIN)?.textContent).toBe('car-rental');
            await draw(() => ui().openChat(FIXTURE_WORKSPACE_CHAT_ID));
            const workspace = project().chats.get(FIXTURE_WORKSPACE_CHAT_ID)!.workspace!;

            await press(name(MAIN)!);
            await press(menuItem('New chat'));
            expect(ui().draftWorkspace).toEqual({ mode: 'existing', path: workspace.path });
            await draw(() => ui().openChat(FIXTURE_WORKSPACE_CHAT_ID));

            await press(name(API.id)!);
            expect([ui().draft, ui().chatId]).toEqual([false, FIXTURE_WORKSPACE_CHAT_ID]);
            expect(isSelected(FIXTURE_WORKSPACE_CHAT_ID)).toBe(true);
            expect(menuItems()).toEqual(['New chat', 'Copy path', 'Open in…', 'Folder settings…']);

            await press(menuItem('New chat'));
            await draw();

            expect([ui().draft, ui().draftFolderId]).toEqual([true, API.id]);
            expect(ui().draftWorkspace).toBeNull();
            expect(isSelected('@new-chat')).toBe(true);

            // The built-in tabs can open the folder when it matches the current draft.
            await press(name(API.id)!);
            expect(menuItems()).toEqual([
                'New chat',
                'Open in Files',
                'Open in Terminal',
                'Copy path',
                'Open in…',
                'Folder settings…',
            ]);

            await press(menuItem('New chat'));
            await draw(() => ui().setDraftWorkspace({ mode: 'new' }));
            await press(name(MAIN)!);
            expect([ui().draft, ui().draftFolderId, ui().draftWorkspace]).toEqual([true, API.id, { mode: 'new' }]);
            await press(menuItem('New chat'));

            // The main folder's draft follows the project's main folder.
            expect([ui().draft, ui().draftFolderId]).toEqual([true, null]);
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
                'New chat',
                'Copy path',
                'Open in…',
                'Folder settings…',
            ]);
            expect(item('New chat').getAttribute('aria-disabled')).toBe('true');
            await press(item('New chat'));
            expect(ui().draft).toBe(false);

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
        expect(rowKeys()).toEqual(['@new-chat', head(MAIN), 'c-4', 'c-5', 'c-3', 'c-6', 'c-1', head(API.id)]);
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
            expect(await step('j')).toBe('c-4');

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
        expect(folderSelect()?.textContent).toContain('car-rental-api');
        // Whatever folder the page is for, the row at the top is the one marked, and no heading is.
        expect(isSelected('@new-chat')).toBe(true);
        expect(rowOf(head(API.id)).hasAttribute('data-open')).toBe(false);

        // The main group's button is the same page as the row at the top.
        await press(buttonNamed('New chat in car-rental'));
        await draw();

        expect([ui().draft, ui().draftFolderId]).toEqual([true, null]);
        expect(isSelected('@new-chat')).toBe(true);
        expect(folderSelect()?.textContent).toContain('car-rental');
    });

    it('starts New chat in the active chat’s folder when it uses the folder checkout', async () => {
        await restart();
        await draw(() => ui().openChat('c-2'));
        await press(rowOf('@new-chat'));
        await draw();

        expect(folderSelect()?.textContent).toContain('car-rental-api');
        expect(ui().draftWorkspace).toBeNull();
    });

    it("shows the main folder's page when the folder the new-chat page was for left the project", async () => {
        await restart();
        await draw(() => ui().openDraft([], 'fld_gone'));

        expect(isSelected('@new-chat')).toBe(true);
        expect(rowOf(head(API.id)).hasAttribute('data-open')).toBe(false);
        expect(folderSelect()?.textContent).toContain('car-rental');
        expect(container.textContent).not.toContain('fld_gone');
    });

    describe('the folder select of the new-chat page', () => {
        it('lists the folders of the project by name and ticks the one the chat is for, and picking another changes it', async () => {
            await restart();
            await press(rowOf('@new-chat'));
            await draw();

            expect(folderSelect()?.getAttribute('aria-label')).toContain('folder car-rental');

            await press(folderSelect()!);

            // The same menu offers folders and workspace choices.
            expect(folderItem('car-rental')).toBeDefined();
            expect(folderItem('car-rental-api')).toBeDefined();
            expect(document.body.textContent).toContain('New worktree');
            // The chosen folder is told to assistive technology, not only drawn as a tick, and the other is not.
            expect(folderItem('car-rental').getAttribute('aria-checked')).toBe('true');
            expect(folderItem('car-rental-api').getAttribute('aria-checked')).toBe('false');
            expect(folderItem('car-rental-api').getAttribute('aria-disabled')).not.toBe('true');

            await press(folderItem('car-rental-api'));
            await draw();

            expect([ui().draft, ui().draftFolderId]).toEqual([true, API.id]);
            expect(folderSelect()?.textContent).toContain('car-rental-api');
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
            expect(folderSelect()?.textContent).toContain('car-rental');
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

        it('is only on the new-chat page for projects with multiple folders', async () => {
            await restart();
            await draw(() => ui().openChat('c-2'));

            expect(folderSelect()).toBeNull();

            await draw(() => ui().openDraft());

            expect(folderSelect()).not.toBeNull();

            await draw(() => ui().setGroupByFolder(false));

            expect(folderSelect()).not.toBeNull();

            // The fixture project has one folder: there is no folder control to pick or display.
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
            expect(folderLine()).toBeNull();
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

            expect(folderLine()?.textContent).toBe('car-rental-api, feature/payments');
            expect(folderLine()?.getAttribute('title')).toBe('~/car-rental-api');
            // Read only: nothing in it opens a list or takes a press.
            expect(folderSelect()).toBeNull();
            expect(folderLine()?.querySelector('button, [tabindex]')).toBeNull();

            // A chat with no folder works in the main one.
            await draw(() => ui().openChat('c-1'));

            expect(folderLine()?.textContent).toBe('car-rental, main');
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
            expect(folderLine()?.textContent).toBe('car-rental-api, feature/payments');
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
            expect(folderLine()?.getAttribute('title')).toBe('~/car-rental-api\nThis folder no longer exists');

            await draw(() => ui().openChat('c-1'));

            expect(folderLine()?.hasAttribute('data-missing')).toBe(false);
        });

        it('shows a chat folder only in a project with multiple folders, grouped or flat', async () => {
            await restart({ grouping: false });
            await draw(() => ui().openChat('c-2'));

            expect(folderLine()?.textContent).toBe('car-rental-api, feature/payments');

            await draw(() => ui().setGroupByFolder(true));

            expect(folderLine()?.textContent).toBe('car-rental-api, feature/payments');

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

            expect(folderLine()?.textContent).toBe('main');
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

    it('restores a manually positioned chat to its slot after moving other chats', async () => {
        await draw(() => ui().setChatOrder(['c-4', 'c-5', 'c-2', 'c-3', 'c-6', 'c-1']));
        await archive('c-2', true);
        await press(rowOf('c-5').querySelector<HTMLElement>('button[aria-label="Chat actions"]')!);
        await press(menuItem('Move up'));
        await archive('c-2', false);

        expect(rowKeys().filter(key => key?.startsWith('c-'))).toEqual(['c-5', 'c-4', 'c-2', 'c-3', 'c-6', 'c-1']);
    });

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
        expect(rowKeys().filter(key => key?.startsWith('c-'))).toEqual(['c-5', 'c-3', 'c-6', 'c-1']);

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
        await draw(() => ui().openChat('c-1'));
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
        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe('c-5');
    });

    it('shows a green status in place of the archive shortcut while the chat works', () => {
        const busyActions = rowOf('c-1').querySelector('[slot="endAffix"]');

        expect(busyActions?.querySelector('button[aria-label="Archive"]')).toBeNull();
        expect(busyActions?.querySelector('[aria-label="Working"] [data-tone="success"]')).not.toBeNull();
        expect(rowOf('c-4').querySelector('button[aria-label="Archive"]')?.hasAttribute('disabled')).toBe(false);
    });

    it('shows a bolt while a chat waits for commands, giving an active agent or a question its usual indicator', async () => {
        const run = project().runs.get('r-orch-5')!;
        expect(rowOf('c-5').querySelector('[aria-label="Background command running"] svg')).not.toBeNull();

        await draw(() => project().runs.set(run.id, { ...run, status: 'running' }));
        expect(rowOf('c-5').querySelector('[aria-label="Working"] [data-tone="success"]')).not.toBeNull();

        await draw(() => project().runs.set(run.id, { ...run, awaitingUser: true }));
        expect(rowOf('c-5').querySelector('[aria-label="Waiting"] [data-tone="accent"]')).not.toBeNull();

        await draw(() => project().runs.set(run.id, { ...run, background: [] }));
        expect(rowOf('c-5').querySelector('[aria-label="Background"] [data-tone="success"]')).not.toBeNull();
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

        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe('c-4');
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

describe('chat completion dots', () => {
    const dotOf = (key: string) => rowOf(key).querySelector('[role="img"]')?.getAttribute('aria-label');

    it('starts without dots for past successes and clears a new completion when its row is opened', async () => {
        const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);

        try {
            expect(dotOf('c-2')).toBeUndefined();
            const run = project().runs.get('r-orch-1')!;
            await draw(() => project().runs.set(run.id, { ...run, status: 'succeeded', finishedAt: Date.now() + 1 }));
            expect(dotOf('c-1')).toBe('Done');
            await press(rowOf('c-1'));
            await draw();
            expect(isSelected('c-1')).toBe(true);
            // Draw the read state changed by the effect, as the observer does in the app.
            await draw();
            expect(dotOf('c-1')).toBeUndefined();
            await press(rowOf('c-2'));
            await draw();
            expect(dotOf('c-1')).toBeUndefined();
        } finally {
            focus.mockRestore();
        }
    });

    it('keeps a completion unread in an unfocused window until the person returns', async () => {
        const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);

        try {
            const run = project().runs.get('r-orch-1')!;
            await draw(() => ui().openChat('c-1'));
            await draw(() => project().runs.set(run.id, { ...run, status: 'succeeded', finishedAt: Date.now() + 1 }));
            expect(dotOf('c-1')).toBe('Done');
            focus.mockReturnValue(true);
            await draw(() => window.dispatchEvent(new Event('focus')));
            expect(dotOf('c-1')).toBeUndefined();
        } finally {
            focus.mockRestore();
        }
    });

    it('keeps a completion unread until the chat is revealed by closing Settings', async () => {
        const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);

        try {
            const run = project().runs.get('r-orch-1')!;
            await draw(() => {
                ui().openChat('c-1');
                store.ui.openSettings();
            });
            await draw(() => project().runs.set(run.id, { ...run, status: 'succeeded', finishedAt: Date.now() + 1 }));
            expect(dotOf('c-1')).toBe('Done');
            await draw(() => store.ui.closeSettings());
            await draw();
            expect(dotOf('c-1')).toBeUndefined();
        } finally {
            focus.mockRestore();
        }
    });
});

describe('threads', () => {
    const foldOf = (key: string) =>
        rowOf(key).querySelector<HTMLButtonElement>('button[aria-label^="Expand"], button[aria-label^="Collapse"]');
    const depthOf = (key: string) => rowOf(key).getAttribute('data-depth');
    const dotOf = (key: string) => rowOf(key).querySelector('[role="img"]')?.getAttribute('aria-label');

    it('shows the draft icon when text or attachments are added and hides it when cleared', async () => {
        const icon = () => rowOf('c-4').querySelector('[aria-label="Unsent draft"] svg');

        expect(dotOf('c-4')).toBeUndefined();
        await act(async () => saveDraft('c-4', plainTextToDoc('Unsent')));
        expect(dotOf('c-4')).toBe('Unsent draft');
        expect(icon()?.getAttribute('viewBox')).toBe('0 0 12 12');
        await act(async () => saveDraft('c-4', emptyComposerDoc()));
        expect(dotOf('c-4')).toBeUndefined();
        await act(async () =>
            setFiles('c-4', [{ key: 'file', name: 'a.txt', mediaType: 'text/plain', size: 1, status: 'ready' }])
        );
        expect(dotOf('c-4')).toBe('Unsent draft');
        expect(icon()).not.toBeNull();
        await act(async () => setFiles('c-4', []));
        expect(dotOf('c-4')).toBeUndefined();
    });
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
        // A chat with no threads and no sub-agents has none.
        expect(foldOf('c-4')).toBeNull();
    });

    it('lists the threads below their chat, one level in and in the order they were made, once the fold is opened, and at every depth', async () => {
        await act(async () => foldOf('c-6')!.click());
        expect(ui().expandedChats).toEqual(['c-6']);
        await draw();

        expect(rowKeys()).toEqual([
            '@new-chat',
            MAIN_GROUP,
            'c-4',
            'c-5',
            'c-3',
            'c-6',
            'c-6a',
            'c-6b',
            // The sub-agent of the chat itself, made between its threads (it is over, and the finished are listed).
            'r-na-07',
            'c-6c',
            'c-6e',
            'c-1',
            'c-2',
        ]);
        expect(['c-6', 'c-6a', 'c-6e'].map(depthOf)).toEqual(['0', '1', '1']);
        expect(foldOf('c-6')?.getAttribute('aria-expanded')).toBe('true');

        await act(async () => foldOf('c-6a')!.click());
        await draw();

        expect(rowKeys().slice(5, 8)).toEqual(['c-6', 'c-6a', 'c-6a1']);
        expect(depthOf('c-6a1')).toBe('2');

        // Folding the chat hides every thread below it, the thread's own threads too.
        await act(async () => foldOf('c-6')!.click());
        await draw();

        expect(rowKeys().filter(key => key?.startsWith('c-6'))).toEqual(['c-6']);
        expect(rowKeys()).not.toContain('r-na-07');
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

    it('keeps sibling threads in creation order when their activity changes', async () => {
        await draw(() => {
            ui().toggleChatExpanded('c-6');
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
            'Expand running agents',
            'Group chats by folder',
        ]);
        expect(document.body.querySelector('[role="menu"] header')).toBeNull();

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

        expect(rowKeys()).toEqual(['@new-chat', MAIN_GROUP, 'c-4', 'c-5', 'c-3', 'c-6', 'c-6e', 'c-1', 'c-2']);
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
            'c-4',
            'c-5',
            'c-3',
            'c-6',
            'c-6a',
            'c-6b',
            // The sub-agent of the chat itself, made between its threads (it is over, and the finished are listed).
            'r-na-07',
            'c-6c',
            'c-6e',
            'c-1',
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
                title: 'Delete “Ship the checkout”?',
                confirmLabel: 'Delete chat',
                message: expect.objectContaining({
                    props: expect.objectContaining({
                        text: 'This will also delete 5 threads. You can’t undo this. Tasks stay in the project.',
                    }),
                }),
            })
        );
    });
});

describe('a chat that works in a worktree', () => {
    async function restart() {
        const transport = new FixtureTransport({ data: withFixtureWorkspace(createFixtureData()) });

        act(() => reactRoot.unmount());
        store.dispose();
        reactRoot = createRoot(container);
        store = new RootStore(transport, { storage: memoryStorage() });
        await store.load();
        await draw();
    }

    it('shows the worktree below the composer without a worktree icon in the sidebar', async () => {
        await restart();
        const row = rowOf(FIXTURE_WORKSPACE_CHAT_ID);

        expect(row.textContent).toContain('Weekend surcharge in a worktree');
        expect(row.querySelector('[role="img"][aria-label*="worktree" i]')).toBeNull();

        await draw(() => ui().openChat(FIXTURE_WORKSPACE_CHAT_ID));

        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe(
            FIXTURE_WORKSPACE_CHAT_ID
        );
        await vi.waitFor(() =>
            expect(
                container.querySelector('[aria-label="Current place: Worktree, branch clowdy/ab12cd34"]')?.textContent
            ).toBe('Worktree clowdy/ab12cd34')
        );

        await draw(() => ui().openChat('c-1'));

        await vi.waitFor(() =>
            expect(container.querySelector('[aria-label="Current place: branch main"]')?.textContent).toBe('main')
        );
    });

    it('shares the active chat’s worktree when the first message is sent from New chat', async () => {
        await restart();
        await draw(() => ui().openChat(FIXTURE_WORKSPACE_CHAT_ID));
        const workspace = project().chats.get(FIXTURE_WORKSPACE_CHAT_ID)!.workspace!;

        await press(rowOf('@new-chat'));
        await draw();
        await vi.waitFor(() => expect(ui().draftWorkspaceRow?.id).toBe(workspace.id));

        const field = container.querySelector<HTMLElement & { editor: Editor }>('[contenteditable="true"]')!;

        await act(async () => {
            field.editor.commands.insertContent('Check the worktree');
            field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        });
        await draw();

        expect(ui().draft).toBe(false);
        expect(ui().chatId).not.toBe(FIXTURE_WORKSPACE_CHAT_ID);
        expect(project().chats.get(ui().chatId!)?.workspace?.id).toBe(workspace.id);
    });

    it('shares the automatically selected pull request badge across chats on the actual checked-out branch', async () => {
        const data = withFixtureWorkspace(createFixtureData());
        const first = data.chats.find(chat => chat.id === FIXTURE_WORKSPACE_CHAT_ID)!;
        const second = { ...first, id: 'c-shared-history', title: 'Shared worktree' };
        data.chats.push(second);
        const folderId = first.workspace!.folderId;
        const branch = first.workspace!.branch!;
        const folderPath = data.projects
            .find(project => project.id === FIXTURE_PROJECT_ID)!
            .folders.find(folder => folder.id === folderId)!.path;
        const pr = (number: number, state: 'open' | 'merged' | 'closed', head = branch) => ({
            number,
            state,
            head,
            base: 'main',
            title: `PR ${number}`,
            url: `https://github.com/acme/car-rental/pull/${number}`,
            updatedAt: number,
        });
        data.branchPullRequests = {
            [folderPath]: {
                [branch]: [pr(10, 'merged'), pr(11, 'open'), pr(13, 'closed')],
                'feature/current': [pr(12, 'closed', 'feature/current')],
            },
        };
        const transport = new FixtureTransport({ data });
        const reads = vi.spyOn(transport, 'getGitBranchPullRequests');

        act(() => reactRoot.unmount());
        store.dispose();
        reactRoot = createRoot(container);
        store = new RootStore(transport, { storage: memoryStorage() });
        await store.load();
        await draw();

        const badge = (id: string) => rowOf(id).querySelector('[data-pr-state]');
        await vi.waitFor(() => expect(badge(first.id)?.getAttribute('aria-label')).toBe('1 pull request: 1 open'));
        expect(badge(second.id)?.textContent).toBe('');
        expect(badge(second.id)?.getAttribute('data-pr-state')).toBe('open');
        expect(badge(second.id)?.querySelector('svg')?.getAttribute('width')).toBe('12');
        expect(reads.mock.calls.filter(([, , name]) => name === branch)).toHaveLength(1);
        await act(async () => saveDraft(first.id, plainTextToDoc('Unsent')));
        expect(badge(first.id)).toBeNull();
        expect(badge(second.id)?.getAttribute('data-pr-state')).toBe('open');
        await act(async () => saveDraft(first.id, emptyComposerDoc()));
        expect(badge(first.id)?.getAttribute('data-pr-state')).toBe('open');
        const run = project().runs.get(first.orchestratorRunId!)!;
        await draw(() => project().runs.set(run.id, { ...run, status: 'running' }));
        expect(badge(first.id)).toBeNull();
        expect(rowOf(first.id).querySelector('[aria-label="Working"]')).not.toBeNull();
        await draw(() => project().runs.set(run.id, run));
        expect(badge(first.id)?.getAttribute('data-pr-state')).toBe('open');
        expect(badge(second.id)?.getAttribute('data-pr-state')).toBe('open');

        const fact = branchPullRequestsOf(transport).of({ projectId: FIXTURE_PROJECT_ID, folderId, branch });
        await act(async () => {
            fact.accept({
                ...fact.value!,
                pullRequests: [
                    pr(9, 'merged'),
                    { ...pr(10, 'merged'), archived: true },
                    pr(11, 'closed'),
                    pr(13, 'closed'),
                ],
            });
        });
        expect(badge(first.id)?.getAttribute('data-pr-state')).toBe('merged');
        expect(badge(second.id)?.getAttribute('aria-label')).toBe('1 pull request: 1 merged');
        expect(badge(second.id)?.textContent).toBe('');

        // The branch has commits of its own since that merge: the pull request is history, and no chat on it looks merged.
        await act(async () => {
            fact.accept({
                ...fact.value!,
                pullRequests: [{ ...pr(9, 'merged'), movedPast: true as const }, pr(11, 'closed'), pr(13, 'closed')],
            });
        });
        expect(badge(first.id)).toBeNull();
        expect(badge(second.id)).toBeNull();

        // The recorded ChatWorkspace branch remains the original name after an external checkout.
        // ProjectInfo says what the worktree is actually on now.
        const info = await transport.getProjectsInfo();
        vi.spyOn(transport, 'getProjectsInfo').mockImplementation(async projectId =>
            info
                .filter(project => !projectId || project.projectId === projectId)
                .map(project => ({
                    ...project,
                    workspaces: project.workspaces?.map(workspace =>
                        workspace.workspaceId === first.workspace!.id
                            ? { ...workspace, branch: 'feature/current' }
                            : workspace
                    ),
                }))
        );
        await act(async () => refreshFolderGit(FIXTURE_PROJECT_ID, folderId));
        const switched = branchPullRequestsOf(transport).of({
            projectId: FIXTURE_PROJECT_ID,
            folderId,
            branch: 'feature/current',
        });
        await vi.waitFor(() => expect(switched.value?.pullRequests[0]?.state).toBe('closed'));
        expect(badge(first.id)).toBeNull();
        expect(badge(second.id)).toBeNull();
        expect(reads.mock.calls.filter(([, , name]) => name === 'feature/current')).toHaveLength(1);
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
