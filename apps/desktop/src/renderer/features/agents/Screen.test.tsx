// @vitest-environment happy-dom

import { Modal } from '@clowdy/components/Modal';
import { openConfirmModal } from '@clowdy/components/modals';
import { emptyComposerDoc, plainTextToDoc } from '@clowdy/components/RichInput';
import { runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_EMPTY_PROJECT_ID,
    FIXTURE_PERSONAL_PROJECT_ID,
    FIXTURE_PROJECT_ID,
    FIXTURE_WORKSPACE_CHAT_ID,
    type FixtureData,
    withFixtureWorkspace,
    withFixtureWorktrees,
} from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { hotkeys, installDispatcher } from '../../hotkeys';
import { NEW_CHAT_COMMAND, shellCommands } from '../../shell/shellCommands';
import { RootStore, RootStoreProvider } from '../../stores';
import { branchPullRequestsOf } from '../changes/branchPullRequests';
import { dropDraft, newChatDraftKey, saveDraft } from '../chats/composerDrafts';
import { setFiles } from '../chats/composerFiles';
import { refreshFolderGit } from '../openWith/useFolderGit';
import { terminalsStoreOf } from '../terminal/useTerminalsStore';
import { chatListPreferences } from './chatListPreferences';
import { openNewChat } from './openNewChat';
import { Screen } from './Screen';
import { starCardPreferences } from './starCardState';
import { chatWorktreeKey, worktreeKey } from './worktreeCards';

import type { Editor } from '@tiptap/core';
import type { ReactNode } from 'react';
import type { KeyValueStorage } from '../../stores/storage';

// Confirmations are only counted here; the other dialogs (removing a worktree) open for real.
vi.mock('@clowdy/components/modals', async importOriginal => ({
    ...(await importOriginal<typeof import('@clowdy/components/modals')>()),
    openConfirmModal: vi.fn(),
}));

vi.mock('../changes/BranchPicker', async importOriginal => ({
    BranchPicker: observer((await importOriginal<typeof import('../changes/BranchPicker')>()).BranchPicker),
}));
vi.mock('../changes/BranchList', async importOriginal => ({
    BranchList: observer((await importOriginal<typeof import('../changes/BranchList')>()).BranchList),
}));
// The app build makes every component an observer; the test build does not, so the ones that read stores the test changes are wrapped here.
vi.mock('./ProjectMenu', async importOriginal => ({
    ProjectMenu: observer((await importOriginal<typeof import('./ProjectMenu')>()).ProjectMenu),
}));
vi.mock('./BranchPullRequestBadge', async importOriginal => ({
    BranchPullRequestBadge: observer(
        (await importOriginal<typeof import('./BranchPullRequestBadge')>()).BranchPullRequestBadge
    ),
}));

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
const menuItem = (name: string) => {
    const rows = [...document.body.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
    return (rows.find(row => row.textContent?.trim() === name) ?? rows.find(row => row.textContent?.includes(name)))!;
};

/** Opens a submenu the way a keyboard user does, so both the menu and its controls are available. */
const openProjectSubmenu = async (name: 'Layout' | 'Display') => {
    await press(buttonNamed('Project menu'));
    await act(async () => {
        menuItem(name).dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
        );
    });
};

beforeEach(async () => {
    chatListPreferences.setShowUnusedWorktrees(false);
    chatListPreferences.setShowFinishedThreads(true);
    // These tests read the list as it was before working agents opened their chats by themselves; `AgentListWorking.test.tsx` has the setting on.
    chatListPreferences.setExpandRunningAgents(false);
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
    store = new RootStore(new FixtureTransport(), { storage: memoryStorage() });
    await store.load();
    await draw(() => ui().setChatListLayout('folder'));
});

afterEach(() => {
    act(() => reactRoot.unmount());
    for (const id of [FIXTURE_PROJECT_ID, FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PERSONAL_PROJECT_ID]) {
        dropDraft(newChatDraftKey(id));
    }
    container.remove();
    store.dispose();
    chatListPreferences.setShowUnusedWorktrees(false);
    chatListPreferences.setShowFinishedThreads(true);
    chatListPreferences.setExpandRunningAgents(true);
});

const drag = async (from: string, to: string, before = false) => {
    const transfer = new DataTransfer();
    transfer.setDragImage = vi.fn();
    const source = rowOf(from).querySelector<HTMLElement>('[draggable="true"]')!;
    const target = rowOf(to);
    const event = (type: string) => {
        const drag = new MouseEvent(type, { bubbles: true, cancelable: true, clientY: before ? -1 : 0 });
        Object.defineProperty(drag, 'dataTransfer', { value: transfer });
        return drag;
    };
    await act(async () => {
        source.dispatchEvent(event('dragstart'));
        target.dispatchEvent(event('dragover'));
        target.dispatchEvent(event('drop'));
        source.dispatchEvent(event('dragend'));
    });
    await draw();
};

describe('the list', () => {
    it('keeps the chat panel from becoming a scroll container', () => {
        const panel = container.querySelector<HTMLElement>('#main > div');

        expect(panel?.style.overflow).toBe('clip');
    });

    it('starts with the folder heading and chats, with no row for a run while chats are folded', () => {
        // The orchestrator is the chat, and a native sub-agent is a row below its chat once that is opened, or while it works with Expand running agents on.
        expect(rowKeys()).toEqual([MAIN_GROUP, 'c-4', 'c-5', 'c-3', 'c-6', 'c-1', 'c-2']);
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

    it('previews an expanded chat as a block and restores its position on cancellation', async () => {
        await draw(() => ui().toggleChatExpanded('c-6'));
        const before = rowKeys();
        const rows = Array.from(container.querySelectorAll<HTMLElement>('[role="row"][data-depth]'));
        const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
            this: HTMLElement
        ) {
            const index = rows.indexOf(this);
            return index < 0 ? new DOMRect(0, 0, 200, 1000) : new DOMRect(0, index * 36, 200, 36);
        });
        try {
            const transfer = new DataTransfer();
            transfer.setDragImage = vi.fn();
            const source = rowOf('c-6').querySelector<HTMLElement>('[draggable="true"]')!;
            const target = rowOf('c-4');
            const event = (type: string, y: number) => {
                const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 50, clientY: y });
                Object.defineProperty(e, 'dataTransfer', { value: transfer });
                return e;
            };
            await act(async () => {
                source.dispatchEvent(event('dragstart', 0));
                target.dispatchEvent(event('dragover', 1));
            });
            expect({
                root: rowOf('c-6').style.getPropertyValue('--reorder-offset'),
                child: rowOf('c-6a').style.getPropertyValue('--reorder-offset'),
                displaced: rowOf('c-4').style.getPropertyValue('--reorder-offset'),
                order: rowKeys(),
            }).toEqual({ root: '-108px', child: '-108px', displaced: '216px', order: before });
            await act(async () => source.dispatchEvent(event('dragend', 1)));
            expect({
                order: rowKeys(),
                offsets: rows.map(row => row.style.getPropertyValue('--reorder-offset')).filter(Boolean),
            }).toEqual({ order: before, offsets: [] });
        } finally {
            rect.mockRestore();
        }
    });

    it('keeps the hand-ordered list through activity and puts a newly created chat first', async () => {
        const chatKeys = () => rowKeys().filter(key => key?.startsWith('c-'));

        expect(chatKeys()).toEqual(['c-4', 'c-5', 'c-3', 'c-6', 'c-1', 'c-2']);
        await drag('c-5', 'c-4', true);
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

    it('omits move actions from a chat menu while keeping its other actions', async () => {
        await press(rowOf('c-5').querySelector<HTMLElement>('button[aria-label="Chat actions"]')!);
        expect(menuItem('Move up')).toBeUndefined();
        expect(menuItem('Move down')).toBeUndefined();
        expect(menuItem('Rename')).toBeDefined();
        expect(menuItem('Archive')).toBeDefined();
        expect(menuItem('Delete')).toBeDefined();
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

        await cover(() => {
            ui().setChatListLayout('simple');
            ui().openDraft();
        });
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
    beforeEach(async () => draw(() => ui().setChatListLayout('simple')));
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

        expect(isSelected(`@draft:${ui().draftId}`)).toBe(true);
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

    it('locks a sending draft when returning to it and opens its chat after success', async () => {
        let release!: () => void;
        const original = store.command.bind(store);
        vi.spyOn(store, 'command').mockImplementation(async input => {
            if (input.type === 'chat.send')
                await new Promise<void>(resolve => {
                    release = resolve;
                });
            return original(input);
        });
        await draw(() => ui().openDraft());
        const draft = ui().draftId!;
        type('First message');
        await pressEnter();
        await draw(() => ui().openChat('c-3'));
        await draw(() => ui().openDraftId(draft));
        expect(container.querySelector('[contenteditable="true"]')).toBeNull();
        expect(container.textContent).toContain('Sending message');
        await act(async () => release());
        await draw();
        expect(ui().draft).toBe(false);
        expect(ui().chatId).not.toBe('c-3');
        expect(ui().newChatDrafts.get(draft)).toBeUndefined();
    });

    it('does not change the selected chat when a first send completes elsewhere', async () => {
        let release!: () => void;
        const original = store.command.bind(store);
        vi.spyOn(store, 'command').mockImplementation(async input => {
            if (input.type === 'chat.send')
                await new Promise<void>(resolve => {
                    release = resolve;
                });
            return original(input);
        });
        await draw(() => ui().openDraft());
        const draft = ui().draftId!;
        type('First message');
        await pressEnter();
        await draw(() => ui().openChat('c-3'));
        await act(async () => release());
        await draw();
        expect([ui().draft, ui().chatId, ui().newChatDrafts.get(draft)]).toEqual([false, 'c-3', undefined]);
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

    it('shows a selected draft when the project has no chat', async () => {
        store.selectProject(FIXTURE_EMPTY_PROJECT_ID);
        await vi.waitFor(() => expect(store.selectedProject?.status).toBe('ready'));
        await draw(() => store.ui.forProject(FIXTURE_EMPTY_PROJECT_ID).setChatListLayout('simple'));

        const draft = store.ui.forProject(FIXTURE_EMPTY_PROJECT_ID).draftId;
        expect(rowKeys()).toEqual(['@new-chat', `@draft:${draft}`]);
        expect(isSelected(`@draft:${draft}`)).toBe(true);
        expect(field()).not.toBeNull();
    });
});

describe('grouped by folder', () => {
    it('shows a selected draft in an empty grouped project', async () => {
        store.selectProject(FIXTURE_EMPTY_PROJECT_ID);
        await vi.waitFor(() => expect(store.selectedProject?.status).toBe('ready'));
        await draw(() => store.ui.forProject(FIXTURE_EMPTY_PROJECT_ID).setChatListLayout('folder'));

        const draft = store.ui.forProject(FIXTURE_EMPTY_PROJECT_ID).draftId;
        expect(rowKeys()).toEqual([expect.stringMatching(/^@folder:/), `@draft:${draft}`]);
        expect(isSelected(`@draft:${draft}`)).toBe(true);
        expect(container.querySelector('[contenteditable="true"]')).not.toBeNull();
    });

    it('creates a persistent draft when typing after closing the empty project draft', async () => {
        store.selectProject(FIXTURE_EMPTY_PROJECT_ID);
        await vi.waitFor(() => expect(store.selectedProject?.status).toBe('ready'));
        await draw(() => store.ui.forProject(FIXTURE_EMPTY_PROJECT_ID).setChatListLayout('folder'));
        const emptyUi = store.ui.forProject(FIXTURE_EMPTY_PROJECT_ID);
        const first = emptyUi.draftId!;
        await press(rowOf(`@draft:${first}`).querySelector<HTMLElement>('button[aria-label="Close draft"]')!);
        await draw();
        const input = container.querySelector<HTMLElement & { editor: Editor }>('[contenteditable="true"]')!;
        await act(async () => {
            input.editor.commands.insertContent('Keep this');
        });
        await draw();
        expect(emptyUi.newChatDrafts.get(emptyUi.draftId!)?.doc).toBeDefined();
        expect(emptyUi.draftId).not.toBe(first);
        expect(rowKeys()).toContain(`@draft:${emptyUi.draftId}`);
    });

    it('sends the first message typed immediately after closing an empty project draft', async () => {
        store.selectProject(FIXTURE_EMPTY_PROJECT_ID);
        await vi.waitFor(() => expect(store.selectedProject?.status).toBe('ready'));
        await draw(() => store.ui.forProject(FIXTURE_EMPTY_PROJECT_ID).setChatListLayout('folder'));
        const emptyUi = store.ui.forProject(FIXTURE_EMPTY_PROJECT_ID);
        await press(rowOf(`@draft:${emptyUi.draftId}`).querySelector<HTMLElement>('button[aria-label="Close draft"]')!);
        await draw();
        const input = container.querySelector<HTMLElement & { editor: Editor }>('[contenteditable="true"]')!;
        const command = vi.spyOn(store, 'command');
        await act(async () => {
            input.editor.commands.insertContent('Send immediately');
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        });
        await draw();
        expect(command.mock.calls.map(([item]) => item).find(item => item.type === 'chat.send')).toMatchObject({
            text: 'Send immediately',
        });
        expect(emptyUi.draft).toBe(false);
    });

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
    const layoutMenu = async () => {
        await openProjectSubmenu('Layout');

        return [...document.body.querySelectorAll('[role="menu"][aria-label="Layout"] [role^="menuitem"]')].map(
            row => row.textContent
        );
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
            if (grouping !== null) ui().setChatListLayout(grouping ? 'folder' : 'simple');
        });
    }

    function twoFolders(change?: (data: FixtureData) => void): FixtureData {
        const data = createFixtureData();

        data.projects.find(candidate => candidate.id === FIXTURE_PROJECT_ID)!.folders.push(API);
        data.chats.find(chat => chat.id === 'c-2')!.folderId = API.id;
        change?.(data);

        return data;
    }

    it('offers a layout choice even for a project of one folder', async () => {
        await restart({ grouping: null, transport: new FixtureTransport() });
        // A project that kept no choice groups by folder and worktree.
        expect(await layoutMenu()).toEqual(['Simple list', 'By folder', 'By worktree']);
        expect(menuItem('By worktree').getAttribute('aria-checked')).toBe('true');
        expect(rowKeys()).toContain(worktreeKey(MAIN, '/Users/dev/car-rental'));

        await restart({ grouping: null });

        expect(await layoutMenu()).toEqual(['Simple list', 'By folder', 'By worktree']);
        expect(menuItem('By worktree').getAttribute('aria-checked')).toBe('true');
        expect(rowKeys()).toContain(worktreeKey(MAIN, '/Users/dev/car-rental'));

        await press(menuItem('Simple list'));
        expect(ui().groupByFolder).toBe(false);
        await draw();

        expect(rowKeys()).not.toContain(head(MAIN));
    });

    it('switches among the three list layouts and shows the selected mode', async () => {
        await openProjectSubmenu('Layout');
        await press(menuItem('By worktree'));
        expect([ui().groupByFolder, ui().groupByWorktree]).toEqual([true, true]);

        await openProjectSubmenu('Layout');
        expect(menuItem('By worktree').getAttribute('aria-checked')).toBe('true');
        await press(menuItem('Simple list'));
        expect([ui().groupByFolder, ui().groupByWorktree]).toEqual([false, false]);

        await openProjectSubmenu('Layout');
        expect(menuItem('Simple list').getAttribute('aria-checked')).toBe('true');
        await press(menuItem('By folder'));
        expect([ui().groupByFolder, ui().groupByWorktree]).toEqual([true, false]);
    });

    it('groups a project of one folder too, and keeps the list flat once the switch is off', async () => {
        await draw(() => ui().setGroupByFolder(true));

        expect(rowKeys()).toEqual([MAIN_GROUP, 'c-4', 'c-5', 'c-3', 'c-6', 'c-1', 'c-2']);

        await draw(() => ui().setGroupByFolder(false));

        expect(rowKeys()).toEqual(['@new-chat', 'c-4', 'c-5', 'c-3', 'c-6', 'c-1', 'c-2']);
    });

    it('lists a group for each folder, main first, with the chats that work in it below; a chat with no folder is in the main one', async () => {
        await restart();

        expect(rowKeys()).toEqual([head(MAIN), 'c-4', 'c-5', 'c-3', 'c-6', 'c-1', head(API.id), 'c-2']);
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

    it('opens a draft in the folder chosen from its actions without folding the group', async () => {
        await restart({ transport: new FixtureTransport({ data: withFixtureWorkspace(twoFolders()) }) });
        await draw(() => ui().openChat(FIXTURE_WORKSPACE_CHAT_ID));
        await press(buttonNamed('Worktree actions: car-rental-api'));
        expect([ui().draft, ui().chatId, ui().collapsedFolders]).toEqual([false, FIXTURE_WORKSPACE_CHAT_ID, []]);
        await press(menuItem('New chat'));
        expect([ui().draft, ui().draftFolderId, ui().draftWorkspace]).toEqual([true, API.id, null]);
        expect(ui().collapsedFolders).toEqual([]);
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
                rowOf(head(folderId)).querySelector<HTMLButtonElement>('button[aria-label^="Worktree actions:"]')!;
            const menuItems = () =>
                [
                    ...document.body.querySelectorAll('[role="menu"][aria-label="Worktree actions"] [role="menuitem"]'),
                ].map(row => row.textContent);
            const item = (text: string) =>
                [
                    ...document.body.querySelectorAll<HTMLElement>(
                        '[role="menu"][aria-label="Worktree actions"] [role="menuitem"]'
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
                'Open in Files',
                'Open in Terminal',
                'Copy path',
                'Open in…',
            ]);
            expect(item('Open in Files').getAttribute('aria-disabled')).toBe('true');
            expect(item('Open in Terminal').getAttribute('aria-disabled')).toBe('true');
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

    it('folds a group by its title and by the arrows, and remembers it', async () => {
        await restart();
        // The heading is a label: a press on its name folds nothing.
        await press(rowOf(head(API.id)));

        expect(ui().collapsedFolders).toEqual([]);
        expect(buttonNamed('Collapse car-rental-api').getAttribute('aria-expanded')).toBe('true');

        await press(buttonNamed('Collapse car-rental-api'));

        expect(ui().collapsedFolders).toEqual([API.id]);
        await draw();
        expect(rowKeys()).toEqual([head(MAIN), 'c-4', 'c-5', 'c-3', 'c-6', 'c-1', head(API.id)]);
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
        expect(rowKeys()).toEqual([head(MAIN), head(API.id), 'c-2']);
        await key('ArrowRight');
        expect(ui().collapsedFolders).toEqual([]);
    });

    it('folds a folder using the keyboard on its title', async () => {
        await restart();
        const button = buttonNamed('Collapse car-rental-api');
        button.focus();
        await act(async () => {
            button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            button.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
        });
        expect(ui().collapsedFolders).toEqual([API.id]);
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
            rowOf(head(MAIN)).focus();

            expect(await step('j')).toBe('c-4');

            rowOf('c-2').focus();

            expect(await step('j')).toBe(head(API.id));
            // The note below the last heading is no row to stop on.
            expect(await step('j')).toBe(head(API.id));
            expect(await step('k')).toBe('c-2');

            rowOf(head(MAIN)).focus();

            expect(await step('k')).toBe(head(MAIN));
        } finally {
            uninstall();
        }
    });

    it.each([
        ['simple', '@new-chat', 'c-4'],
        ['folder', MAIN_GROUP, 'c-4'],
        ['worktree', worktreeKey(MAIN, '/Users/dev/car-rental'), 'c-4'],
    ] as const)('navigates the first rows in the %s layout with J and K', async (layout, first, second) => {
        await draw(() => {
            ui().setChatListLayout(layout);
            ui().openDraft();
        });
        await vi.waitFor(() => expect(document.activeElement?.getAttribute('contenteditable')).toBe('true'));
        const uninstall = installDispatcher(hotkeys);
        const step = async (key: string) => {
            await act(async () => {
                document.activeElement!.dispatchEvent(
                    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
                );
            });
            return document.activeElement?.getAttribute('data-key');
        };
        try {
            rowOf(first).focus();
            expect(await step('j')).toBe(`@draft:${ui().draftId}`);
            expect(await step('j')).toBe(second);
            expect(await step('k')).toBe(`@draft:${ui().draftId}`);
            expect(await step('k')).toBe(first);
            expect(await step('k')).toBe(first);
            expect(rowKeys().includes('@new-chat')).toBe(layout === 'simple');
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

    it('selects the draft in the folder whose new chat button was pressed', async () => {
        await restart();
        await press(buttonNamed('New chat in car-rental-api'));
        await draw();

        expect([ui().draft, ui().draftFolderId]).toEqual([true, API.id]);
        expect(folderSelect()?.textContent).toContain('car-rental-api');
        expect(isSelected(`@draft:${ui().draftId}`)).toBe(true);
        expect(rowOf(head(API.id)).hasAttribute('data-open')).toBe(false);

        // The main group opens a draft in the main folder.
        await press(buttonNamed('New chat in car-rental'));
        await draw();

        expect([ui().draft, ui().draftFolderId]).toEqual([true, null]);
        expect(isSelected(`@draft:${ui().draftId}`)).toBe(true);
        expect(folderSelect()?.textContent).toContain('car-rental');
    });

    it('starts New chat in the active chat’s folder when it uses the folder checkout', async () => {
        await restart();
        await draw(() => {
            ui().openChat('c-2');
            ui().setChatListLayout('simple');
        });
        await press(rowOf('@new-chat'));
        await draw();

        expect(folderSelect()?.textContent).toContain('car-rental-api');
        expect(ui().draftWorkspace).toBeNull();
    });

    it("shows the main folder's page when the folder the new-chat page was for left the project", async () => {
        await restart();
        await draw(() => ui().openDraft([], 'fld_gone'));

        expect(isSelected(`@draft:${ui().draftId}`)).toBe(true);
        expect(rowOf(head(API.id)).hasAttribute('data-open')).toBe(false);
        expect(folderSelect()?.textContent).toContain('car-rental');
        expect(container.textContent).not.toContain('fld_gone');
    });

    describe('the folder select of the new-chat page', () => {
        it('lists the folders of the project by name and ticks the one the chat is for, and picking another changes it', async () => {
            await restart();
            await press(buttonNamed('New chat in car-rental'));
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
            // Changing folders moves the selected draft.
            expect(rowOf(head(API.id)).hasAttribute('data-open')).toBe(false);
            expect(isSelected(`@draft:${ui().draftId}`)).toBe(true);

            await press(folderSelect()!);

            expect(folderItem('car-rental').getAttribute('aria-checked')).toBe('false');
            expect(folderItem('car-rental-api').getAttribute('aria-checked')).toBe('true');

            // The main folder uses the default draft folder.
            await press(folderItem('car-rental'));
            await draw();

            expect([ui().draft, ui().draftFolderId]).toEqual([true, null]);
            expect(folderSelect()?.textContent).toContain('car-rental');
            expect(isSelected(`@draft:${ui().draftId}`)).toBe(true);
        });

        it('keeps the words of the message when another folder is picked', async () => {
            await restart();
            await press(buttonNamed('New chat in car-rental'));
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

            await press(buttonNamed('New chat in car-rental'));
            await draw();
            await press(buttonNamed('New chat in car-rental-api'));
            await draw();
            await draw(() => {
                ui().openChat('c-2');
                ui().setChatListLayout('simple');
            });
            await press(rowOf('@new-chat'));
            await draw();

            expect(folderSelect()?.textContent).toContain('car-rental-api');
            expect(allProjects()).toBe(reads);
        });

        it('makes the chat in the folder that was picked there', async () => {
            const before = new Set(project().chats.keys());

            await restart();
            await press(buttonNamed('New chat in car-rental'));
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
                ui().setChatListLayout('folder');
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
            await press(buttonNamed('New chat in car-rental'));
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

            expect(folderLine()?.textContent).toBe('feature/payments');
            expect(folderLine()?.getAttribute('title')).toBe('~/car-rental-api');
            // Read only: nothing in it opens a list or takes a press.
            expect(folderSelect()).toBeNull();
            expect(folderLine()?.querySelector('button, [tabindex]')).toBeNull();

            // A chat with no folder works in the main one.
            await draw(() => ui().openChat('c-1'));

            expect(folderLine()?.textContent).toBe('main');
        });

        it('is under the message box of the chat the page made, in the folder picked there', async () => {
            const before = new Set(project().chats.keys());

            await restart();
            await press(buttonNamed('New chat in car-rental'));
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
            expect(folderLine()?.textContent).toBe('feature/payments');
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

        it('shows the folder in a flat list and hides it when grouped by folder or worktree', async () => {
            await restart({ grouping: false });
            await draw(() => ui().openChat('c-2'));

            expect(folderLine()?.textContent).toBe('car-rental-api, feature/payments');

            await draw(() => ui().setChatListLayout('folder'));
            expect(folderLine()?.textContent).toBe('feature/payments');

            await draw(() => ui().setChatListLayout('worktree'));
            expect(folderLine()?.textContent).toBe('feature/payments');

            // The fixture project has one folder.
            act(() => reactRoot.unmount());
            store.dispose();
            reactRoot = createRoot(container);
            store = new RootStore(new FixtureTransport(), { storage: memoryStorage() });
            await store.load();
            await draw(() => {
                ui().setChatListLayout('folder');
                ui().openChat('c-1');
            });

            expect(folderLine()?.textContent).toBe('main');

            await draw(() => ui().setGroupByFolder(false));

            expect(folderLine()?.textContent).toBe('car-rental, main');
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
    it('has the history, as a button, to the left of the project menu', () => {
        // The rows have an Archive of their own, as a quick action: the heading's buttons are the ones outside the list.
        const buttons = [
            ...container.querySelectorAll<HTMLElement>(
                'button[aria-label="History"], button[aria-label="Project menu"]'
            ),
        ].filter(button => !button.closest('[role="grid"]'));

        expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual(['History', 'Project menu']);
        expect(buttons[0].parentElement).toBe(buttons[1].parentElement);
    });

    it('opens settings for the selected project', async () => {
        await press(buttonNamed('Project menu'));
        await press(menuItem('Project settings'));

        expect([store.ui.settingsOpen, store.ui.settingsPage, store.ui.settingsProjectId]).toEqual([
            true,
            'projects',
            FIXTURE_PROJECT_ID,
        ]);
    });

    it('adds the folder selected from the project menu', async () => {
        const previous = window.desktop;
        const choose = vi.fn(async () => ['/Users/dev/notes']);
        (window as { desktop?: unknown }).desktop = { chooseDirectories: choose };

        try {
            await press(buttonNamed('Project menu'));
            await press(menuItem('Add…'));
            await press(
                [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
                    item => item.textContent?.trim() === 'Choose folder on computer'
                )!
            );
            await act(async () => void (await new Promise(resolve => setTimeout(resolve, 0))));

            expect(choose).toHaveBeenCalledOnce();
            expect(store.ui.settingsOpen).toBe(false);
            expect(
                store.projects.find(project => project.id === FIXTURE_PROJECT_ID)?.folders.map(folder => folder.path)
            ).toContain('/Users/dev/notes');
        } finally {
            (window as { desktop?: unknown }).desktop = previous;
        }
    });

    it('opens the clone form from the project menu without keeping the add dialog open', async () => {
        const create = Modal.create.bind(Modal);
        vi.spyOn(Modal, 'create').mockImplementation(options => create({ ...options, animate: false }));
        try {
            await press(buttonNamed('Project menu'));
            await press(menuItem('Add…'));
            const clone = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
                node => node.textContent?.trim() === 'Clone Git repository'
            )!;
            await press(clone);
            await vi.waitFor(() =>
                expect(document.body.querySelector('input[aria-label="Repository address"]')).not.toBeNull()
            );
            expect(document.body.querySelector('[aria-label="Add to project"]')).toBeNull();
        } finally {
            for (const modal of [...Modal.opened].reverse()) await act(async () => modal.close(false));
            vi.restoreAllMocks();
        }
    });

    it('does not offer adding folders to the personal space', async () => {
        await draw(() => store.selectProject(FIXTURE_PERSONAL_PROJECT_ID));
        await draw();
        await press(buttonNamed('Project menu'));

        expect(
            [...document.body.querySelectorAll('[role^="menuitem"]')].some(row => row.textContent?.includes('Add…'))
        ).toBe(false);
        expect(menuItem('Project settings')).toBeTruthy();
    });

    it('selects the draft row only while its page is open', async () => {
        await draw(() => ui().setChatListLayout('simple'));
        await press(rowOf('@new-chat'));

        expect(ui().draft).toBe(true);

        // The test build has no observer, so the screen is drawn again by hand.
        await draw();

        const draft = ui().draftId;
        expect(isSelected(`@draft:${draft}`)).toBe(true);

        await draw(() => ui().openChat('c-3'));

        expect(isSelected(`@draft:${draft}`)).toBe(false);
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
        await drag('c-5', 'c-4', true);
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

    it('shows a green status in place of the archive shortcut while the chat works, its agent icon when agents work inside it', () => {
        const busyActions = rowOf('c-1').querySelector('[slot="endAffix"]');

        expect(busyActions?.querySelector('button[aria-label="Archive"]')).toBeNull();
        expect(busyActions?.querySelector('[aria-label="3 agents work inside"]')).not.toBeNull();
        expect(busyActions?.querySelector('[aria-label="Working"]')).toBeNull();
        expect(rowOf('c-4').querySelector('button[aria-label="Archive"]')?.hasAttribute('disabled')).toBe(false);
    });

    it('shows a bolt while a chat waits for background work, giving an active agent or a question its usual indicator', async () => {
        const run = project().runs.get('r-orch-5')!;
        expect(rowOf('c-5').querySelector('[aria-label="Waiting for background work"] svg')).not.toBeNull();

        await draw(() => project().runs.set(run.id, { ...run, status: 'running' }));
        expect(rowOf('c-5').querySelector('[aria-label="Working"] [data-tone="success"]')).not.toBeNull();

        await draw(() => project().runs.set(run.id, { ...run, awaitingUser: true }));
        expect(rowOf('c-5').querySelector('[aria-label="Waiting"] [data-tone="accent"]')).not.toBeNull();

        await draw(() => project().runs.set(run.id, { ...run, background: [] }));
        expect(rowOf('c-5').querySelector('[aria-label="Waiting for background work"] svg')).not.toBeNull();
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
    // The sub-agents that work for c-1 in the fixture end with it: a chat with an agent working inside keeps its agent icon, over a completion.
    const endAgentsOfC1 = () => {
        for (const id of ['r-na-02', 'r-na-03', 'r-na-05'])
            project().runs.set(id, { ...project().runs.get(id)!, status: 'succeeded', finishedAt: Date.now() });
    };

    it('starts without dots for past successes and clears a new completion when its row is opened', async () => {
        const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);

        try {
            expect(dotOf('c-2')).toBeUndefined();
            const run = project().runs.get('r-orch-1')!;
            await draw(() => {
                endAgentsOfC1();
                project().runs.set(run.id, { ...run, status: 'succeeded', finishedAt: Date.now() + 1 });
            });
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
            await draw(() => {
                endAgentsOfC1();
                project().runs.set(run.id, { ...run, status: 'succeeded', finishedAt: Date.now() + 1 });
            });
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
            await draw(() => {
                endAgentsOfC1();
                project().runs.set(run.id, { ...run, status: 'succeeded', finishedAt: Date.now() + 1 });
            });
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

        expect(rowKeys().slice(4, 7)).toEqual(['c-6', 'c-6a', 'c-6a1']);
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

    it('hides finished threads when their filter is turned off', async () => {
        await draw(() => ['c-6', 'c-6a'].forEach(id => ui().toggleChatExpanded(id)));
        await openProjectSubmenu('Display');

        expect(menuItem('Show completed threads').getAttribute('aria-checked')).toBe('true');

        await press(menuItem('Show completed threads'));
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

    it('marks a chat at rest whose threads work with the agent icon, and each thread with its own state', async () => {
        await draw(() => ui().toggleChatExpanded('c-6'));

        expect(dotOf('c-6')).toBe('2 agents work inside');
        expect(dotOf('c-6a')).toBe('Working');
        expect(dotOf('c-6c')).toBe('Failed');
        expect(dotOf('c-6b')).toBeUndefined();
        expect(rowOf('c-6e').querySelector('[data-provider]')?.getAttribute('data-provider')).toBe('codex');
    });

    it('lists a thread that waits for the person under its folded chat, with the dot on both, and the other threads stay folded away', async () => {
        // The thread rests for its background work while its agent asks: its card is the only sign (`Run.awaitingUser`).
        await draw(() => project().runs.set('r-orch-6e', { ...project().runs.get('r-orch-6e')!, awaitingUser: true }));

        expect(rowKeys()).toEqual([MAIN_GROUP, 'c-4', 'c-5', 'c-3', 'c-6', 'c-6e', 'c-1', 'c-2']);
        expect(['c-6', 'c-6e'].map(depthOf)).toEqual(['0', '1']);
        expect(foldOf('c-6')?.getAttribute('aria-expanded')).toBe('false');
        expect(dotOf('c-6')).toBe('A thread is waiting for you');
        expect(dotOf('c-6e')).toBe('Waiting');

        // Opening the fold lists every thread, the asking one in its place.
        await act(async () => foldOf('c-6')!.click());
        await draw();
        expect(rowKeys()).toEqual([
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

        // Decided: the thread goes back behind the fold, and the chat's dot gives way to the agent icon.
        await act(async () => foldOf('c-6')!.click());
        await draw(() =>
            project().runs.set('r-orch-6e', { ...project().runs.get('r-orch-6e')!, awaitingUser: undefined })
        );
        expect(rowKeys()).not.toContain('c-6e');
        expect(dotOf('c-6')).toBe('2 agents work inside');
    });

    it('offers no Archive on a chat whose threads work, and offers it on a finished thread', async () => {
        await draw(() => ui().toggleChatExpanded('c-6'));

        const busyActions = rowOf('c-6').querySelector('[slot="endAffix"]');

        expect(busyActions?.querySelector('button[aria-label="Archive"]')).toBeNull();
        expect(busyActions?.querySelector('[aria-label="2 agents work inside"]')).not.toBeNull();
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
        await draw(() => ui().setChatListLayout('folder'));
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

        await draw(() => ui().setChatListLayout('simple'));
        expect(
            container.querySelector('[aria-label="Current place: car-rental, Worktree, branch clowdy/ab12cd34"]')
                ?.textContent
        ).toBe('car-rental, Worktree clowdy/ab12cd34');
        await draw(() => ui().setChatListLayout('worktree'));
        expect(
            container.querySelector('[aria-label="Current place: Worktree, branch clowdy/ab12cd34"]')?.textContent
        ).toBe('Worktree clowdy/ab12cd34');

        await draw(() => ui().openChat('c-1'));

        await vi.waitFor(() =>
            expect(container.querySelector('[aria-label="Current place: branch main"]')?.textContent).toBe('main')
        );
    });

    it('shares the active chat’s worktree when the first message is sent from New chat', async () => {
        await restart();
        await draw(() => {
            ui().setChatListLayout('simple');
            ui().openChat(FIXTURE_WORKSPACE_CHAT_ID);
        });
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

    it('shares the active worktree when the new chat shortcut opens a grouped draft', async () => {
        await restart();
        await draw(() => {
            ui().setChatListLayout('worktree');
            ui().openChat(FIXTURE_WORKSPACE_CHAT_ID);
        });
        const workspace = project().chats.get(FIXTURE_WORKSPACE_CHAT_ID)!.workspace!;
        const command = shellCommands(store).find(entry => entry.id === NEW_CHAT_COMMAND)!;
        const dispose = hotkeys.defineCommand({ ...command, scope: 'app' });
        const uninstall = installDispatcher(hotkeys);
        try {
            await act(async () => {
                document.body.dispatchEvent(
                    new KeyboardEvent('keydown', {
                        key: 'n',
                        code: 'KeyN',
                        metaKey: hotkeys.family === 'mac',
                        ctrlKey: hotkeys.family === 'win',
                        bubbles: true,
                        cancelable: true,
                    })
                );
            });
            await draw();
            await vi.waitFor(() => expect(ui().draftWorkspaceRow?.id).toBe(workspace.id));
            expect(rowKeys()).not.toContain('@new-chat');
            expect(isSelected(`@draft:${ui().draftId}`)).toBe(true);

            const field = container.querySelector<HTMLElement & { editor: Editor }>('[contenteditable="true"]')!;
            await act(async () => {
                field.editor.commands.insertContent('Check the worktree');
            });
            await act(async () => {
                document.body.dispatchEvent(
                    new KeyboardEvent('keydown', {
                        key: 'n',
                        code: 'KeyN',
                        metaKey: hotkeys.family === 'mac',
                        ctrlKey: hotkeys.family === 'win',
                        bubbles: true,
                        cancelable: true,
                    })
                );
            });
            expect(ui().draftWorkspace).toEqual({ mode: 'existing', path: workspace.path });
            expect(field.editor.getText()).toBe('Check the worktree');

            // The project may not have loaded yet when the shortcut is pressed.
            await draw(() => openNewChat(undefined, ui()));
            expect(ui().draftWorkspace).toEqual({ mode: 'existing', path: workspace.path });
            expect(field.editor.getText()).toBe('Check the worktree');

            await act(async () => {
                field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            });
            await draw();
            expect(ui().draft).toBe(false);
            expect(ui().chatId).not.toBe(FIXTURE_WORKSPACE_CHAT_ID);
            expect(project().chats.get(ui().chatId!)?.workspace?.id).toBe(workspace.id);
        } finally {
            uninstall();
            dispose();
        }
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
        await draw(() => ui().setChatListLayout('folder'));

        const badge = (id: string) => rowOf(id).querySelector('[data-pr-state]');
        await vi.waitFor(() => expect(badge(first.id)?.getAttribute('aria-label')).toBe('1 pull request: 1 open'));
        expect(badge(second.id)?.textContent).toBe('');
        expect(badge(second.id)?.getAttribute('data-pr-state')).toBe('open');
        expect(badge(second.id)?.querySelector('svg')?.getAttribute('width')).toBe('12');
        expect(reads.mock.calls.filter(([, , name]) => name === branch)).toHaveLength(1);

        await draw(() => ui().setGroupByWorktree(true));
        const cardKey = chatWorktreeKey(first)!;
        await vi.waitFor(() => expect(badge(cardKey)?.getAttribute('data-pr-state')).toBe('open'));
        expect(badge(first.id)).toBeNull();
        expect(badge(second.id)).toBeNull();
        await draw(() => ui().toggleWorktreeCollapsed(cardKey));
        expect(badge(cardKey)?.getAttribute('data-pr-state')).toBe('open');
        expect(rowOf(first.id)).toBeNull();
        await draw(() => ui().toggleWorktreeCollapsed(cardKey));
        await draw(() => ui().setGroupByWorktree(false));
        expect(badge(first.id)?.getAttribute('data-pr-state')).toBe('open');
        expect(reads.mock.calls.filter(([, , name]) => name === branch)).toHaveLength(1);
        await act(async () => saveDraft(first.id, plainTextToDoc('Unsent')));
        expect(badge(first.id)?.getAttribute('data-pr-state')).toBe('open');
        expect(rowOf(first.id).querySelector('[aria-label="Unsent draft"]')).not.toBeNull();
        expect(badge(second.id)?.getAttribute('data-pr-state')).toBe('open');
        await act(async () => saveDraft(first.id, emptyComposerDoc()));
        expect(badge(first.id)?.getAttribute('data-pr-state')).toBe('open');
        const run = project().runs.get(first.orchestratorRunId!)!;
        await draw(() => project().runs.set(run.id, { ...run, status: 'running' }));
        expect(badge(first.id)?.getAttribute('data-pr-state')).toBe('open');
        expect(rowOf(first.id).querySelector('[aria-label="Working"]')).not.toBeNull();
        await draw(() => ui().setChatListLayout('simple'));
        expect(badge(first.id)?.getAttribute('data-pr-state')).toBe('open');
        expect(rowOf(first.id).querySelector('[aria-label="Working"]')).not.toBeNull();
        await draw(() => ui().setChatListLayout('folder'));
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
        await draw(() => ui().setGroupByWorktree(true));
        expect(badge(cardKey)?.getAttribute('data-pr-state')).toBe('merged');
        await act(async () =>
            runInAction(() => {
                fact.stale = true;
            })
        );
        expect(badge(cardKey)?.getAttribute('aria-label')).toContain('last known');
        await act(async () =>
            runInAction(() => {
                fact.stale = false;
            })
        );

        // The branch has commits of its own since that merge: the pull request is history, and no chat on it looks merged.
        await act(async () => {
            fact.accept({
                ...fact.value!,
                pullRequests: [{ ...pr(9, 'merged'), movedPast: true as const }, pr(11, 'closed'), pr(13, 'closed')],
            });
        });
        expect(badge(cardKey)).toBeNull();
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
        expect(badge(cardKey)).toBeNull();
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

describe('worktree cards', () => {
    async function restart(data = withFixtureWorktrees(createFixtureData())) {
        act(() => reactRoot.unmount());
        store.dispose();
        reactRoot = createRoot(container);
        store = new RootStore(new FixtureTransport({ data }), {
            storage: memoryStorage(),
        });
        await store.load();
        await draw(() => ui().setChatListLayout('folder'));
    }
    const mainKey = () => worktreeKey('fld_car_rental', '/Users/dev/car-rental');
    const workspaceKey = () => chatWorktreeKey(project().chats.get(FIXTURE_WORKSPACE_CHAT_ID)!)!;
    const cardRows = () =>
        [...container.querySelectorAll<HTMLElement>('[data-worktree-card]')].map(row => row.dataset.worktreeCard);
    const arrow = (key: string, direction: string) =>
        act(async () => {
            rowOf(key).dispatchEvent(new KeyboardEvent('keydown', { key: direction, bubbles: true, cancelable: true }));
        });

    it.each(['car-rental/feature', 'custom/team/very-long-feature-branch-name'])(
        'keeps the full branch %s distinct from its folder in the header and actions',
        async branch => {
            await restart();
            const workspace = project().chats.get(FIXTURE_WORKSPACE_CHAT_ID)!.workspace!;
            const read = store.transport.getProjectWorktrees.bind(store.transport);
            vi.spyOn(store.transport, 'getProjectWorktrees').mockImplementation(async projectId =>
                (await read(projectId)).map(folder => ({
                    ...folder,
                    worktrees: folder.worktrees.map(tree =>
                        tree.workspaceId === workspace.id ? { ...tree, branch } : tree
                    ),
                }))
            );
            await draw(() => ui().setGroupByWorktree(true));
            await draw();
            const row = rowOf(workspaceKey());
            const label = `car-rental, ${branch}`;
            expect([...row.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toContain(
                `Collapse ${label}`
            );
            expect(row.querySelector(`[title="${label}"]`)?.textContent).toContain(branch);
            expect([...row.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toContain(
                `Worktree actions: ${label}`
            );
            expect(
                [...rowOf(mainKey()).querySelectorAll('button')].map(button => button.getAttribute('aria-label'))
            ).toContain('Collapse car-rental');
            await arrow(workspaceKey(), 'ArrowLeft');
            await draw();
            expect(
                [...rowOf(workspaceKey()).querySelectorAll('button')].map(button => button.getAttribute('aria-label'))
            ).toContain(`Expand ${label}`);
        }
    );

    it('shows peer worktree groups in folder order and folds an empty checkout', async () => {
        await restart();
        await draw(() => ui().setChatListLayout('worktree'));
        const api = worktreeKey('fld_api', '/Users/dev/car-rental-api');
        const notes = worktreeKey('fld_notes', '/Users/dev/notes');
        expect(cardRows()).toEqual([mainKey(), workspaceKey(), api, notes]);
        expect(container.querySelectorAll('[data-key^="@folder:"]')).toHaveLength(0);
        expect(rowOf(api).querySelector('button[aria-label^="Collapse "]')?.getAttribute('aria-expanded')).toBe('true');
        await arrow(api, 'ArrowLeft');
        await draw();
        expect(rowOf(api).querySelector('button[aria-label^="Expand "]')?.getAttribute('aria-expanded')).toBe('false');
        await arrow(api, 'ArrowRight');
        await draw();
        expect(rowOf(api).querySelector('button[aria-label^="Collapse "]')?.getAttribute('aria-expanded')).toBe('true');
    });

    it('keeps flat order when disabled and puts checkout chats before worktree cards when enabled', async () => {
        await restart();
        const before = rowKeys();
        await openProjectSubmenu('Layout');
        expect(menuItem('By worktree').getAttribute('aria-checked')).toBe('false');
        await press(menuItem('By worktree'));
        await draw();
        expect(
            rowOf('c-1').compareDocumentPosition(rowOf(workspaceKey())) & Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();
        expect(
            rowOf(FIXTURE_WORKSPACE_CHAT_ID).closest('[data-worktree-card]')?.getAttribute('data-worktree-card')
        ).toBe(workspaceKey());
        await draw(() => ui().setGroupByWorktree(false));
        expect(rowKeys()).toEqual(before);
    });

    it('groups ordinary chats only while an additional worktree is visible', async () => {
        await restart();
        await draw(() => ui().setGroupByWorktree(true));
        await draw();
        expect(rowOf('c-4').closest('[data-worktree-card]')?.getAttribute('data-worktree-card')).toBe(mainKey());
        await arrow(mainKey(), 'ArrowLeft');
        await draw();
        expect(rowOf('c-4')).toBeNull();
        await draw(() => ui().openChat(FIXTURE_WORKSPACE_CHAT_ID));
        await draw(() => ui().openChat('c-4'));
        await draw();
        expect(isSelected('c-4')).toBe(true);
        await press(rowOf(mainKey()).querySelector<HTMLElement>('button[aria-label^="Worktree actions:"]')!);
        expect(menuItem('Remove worktree…')).toBeUndefined();
        await press(menuItem('New chat'));
        expect([ui().draft, ui().draftFolderId, ui().draftWorkspace]).toEqual([true, null, null]);
        await draw();
        expect(
            rowOf(`@draft:${ui().draftId}`).closest('[data-worktree-card]')?.getAttribute('data-worktree-card')
        ).toBe(mainKey());
    });

    it('keeps the main worktree available with no active chats regardless of the unused filter', async () => {
        await restart();
        await draw(() => {
            for (const [id, chat] of project().chats) {
                if (!chat.workspace && (!chat.folderId || chat.folderId === 'fld_car_rental'))
                    project().chats.set(id, { ...chat, archivedAt: Date.now() });
            }
            ui().setGroupByWorktree(true);
        });
        await draw();
        expect(cardRows()).toContain(workspaceKey());
        expect(cardRows()).toContain(mainKey());
        await draw(() => chatListPreferences.setShowUnusedWorktrees(true));
        expect(cardRows()).toContain(mainKey());
        await draw(() => chatListPreferences.setShowUnusedWorktrees(false));
        expect(cardRows()).toContain(mainKey());
        await press(rowOf(mainKey()).querySelector<HTMLElement>('button[aria-label^="New chat in "]')!);
        await draw();
        expect([ui().draft, ui().draftFolderId, ui().draftWorkspace]).toEqual([true, null, null]);
        expect(
            rowOf(`@draft:${ui().draftId}`).closest('[data-worktree-card]')?.getAttribute('data-worktree-card')
        ).toBe(mainKey());
    });

    it('shows a linked thread in its worktree while keeping it under its parent', async () => {
        await restart();
        const expectedWorktree = workspaceKey();
        const workspace = project().chats.get(FIXTURE_WORKSPACE_CHAT_ID)!.workspace!;
        await draw(() => {
            project().chats.delete(FIXTURE_WORKSPACE_CHAT_ID);
            project().chats.set('c-6a', { ...project().chats.get('c-6a')!, workspace });
            ui().setGroupByWorktree(true);
        });
        await draw();
        expect(rowOf('c-4').closest('[data-worktree-card]')?.getAttribute('data-worktree-card')).toBe(mainKey());
        const link = rowOf('@linked-thread:c-6a');
        expect(link.closest('[data-worktree-card]')?.getAttribute('data-worktree-card')).toBe(expectedWorktree);
        expect(link.textContent).toContain('Fix the price rounding');
        const uninstall = installDispatcher(hotkeys);
        try {
            rowOf(expectedWorktree).focus();
            await act(async () =>
                document.activeElement!.dispatchEvent(
                    new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true })
                )
            );
            expect(document.activeElement?.getAttribute('data-key')).toBe('@linked-thread:c-6a');
        } finally {
            uninstall();
        }
        await press(link);
        expect(ui().chatId).toBe('c-6a');
        await draw();
        await draw();
        expect(rowOf('c-6a').closest('[data-worktree-card]')?.getAttribute('data-worktree-card')).toBe(mainKey());
    });

    it('shows a thread in the main checkout of its own folder when its parent uses another worktree', async () => {
        await restart();
        const workspace = project().chats.get(FIXTURE_WORKSPACE_CHAT_ID)!.workspace!;
        await draw(() => {
            project().chats.set('c-6', { ...project().chats.get('c-6')!, workspace });
            project().chats.set('c-6a', { ...project().chats.get('c-6a')!, folderId: 'fld_api', workspace: undefined });
            ui().setGroupByWorktree(true);
        });
        await draw();
        expect(rowOf('@linked-thread:c-6a').closest('[data-worktree-card]')?.getAttribute('data-worktree-card')).toBe(
            worktreeKey('fld_api', '/Users/dev/car-rental-api')
        );
    });

    it('groups each folder independently and starts a chat in the selected folder checkout', async () => {
        await restart();
        const second = worktreeKey('fld_api', '/Users/dev/car-rental-api');
        await draw(() => {
            const chat = project().chats.get('c-4')!;
            project().chats.set(chat.id, { ...chat, folderId: 'fld_api' });
            ui().setGroupByWorktree(true);
            chatListPreferences.setShowUnusedWorktrees(true);
        });
        await draw();
        expect(rowOf('c-4').closest('[data-worktree-card]')?.getAttribute('data-worktree-card')).toBe(second);
        expect(rowOf('c-1').closest('[data-worktree-card]')?.getAttribute('data-worktree-card')).toBe(mainKey());
        await press(rowOf(second).querySelector<HTMLElement>('button[aria-label^="New chat in "]')!);
        expect([ui().draftFolderId, ui().draftWorkspace]).toEqual(['fld_api', null]);
    });

    it('joins the canonical Git path with its workspace card and opens the selected chat', async () => {
        await restart();
        const workspace = project().chats.get(FIXTURE_WORKSPACE_CHAT_ID)!.workspace!;
        const read = store.transport.getProjectWorktrees.bind(store.transport);
        vi.spyOn(store.transport, 'getProjectWorktrees').mockImplementation(async projectId =>
            (await read(projectId)).map(folder => ({
                ...folder,
                worktrees: folder.worktrees.map(tree =>
                    tree.workspaceId === workspace.id ? { ...tree, path: '/real/path/to/worktree' } : tree
                ),
            }))
        );
        await draw(() => {
            ui().setGroupByWorktree(true);
            ui().openChat(FIXTURE_WORKSPACE_CHAT_ID);
        });
        await draw();
        expect(cardRows()).toHaveLength(4);
        expect(
            rowOf(FIXTURE_WORKSPACE_CHAT_ID).closest('[data-worktree-card]')?.getAttribute('data-worktree-card')
        ).toContain(encodeURIComponent('/real/path/to/worktree'));
        expect(isSelected(FIXTURE_WORKSPACE_CHAT_ID)).toBe(true);
    });

    it('keeps a manually folded card closed until a chat in it is opened from elsewhere', async () => {
        await restart();
        await draw(() => {
            ui().setGroupByWorktree(true);
            ui().openChat(FIXTURE_WORKSPACE_CHAT_ID);
        });
        const key = workspaceKey();
        await arrow(key, 'ArrowLeft');
        await draw();
        expect(rowOf(FIXTURE_WORKSPACE_CHAT_ID)).toBeNull();
        await draw(() => ui().openChat('c-4'));
        await draw(() => ui().openChat(FIXTURE_WORKSPACE_CHAT_ID));
        await draw();
        expect(isSelected(FIXTURE_WORKSPACE_CHAT_ID)).toBe(true);
        expect(ui().collapsedWorktrees).not.toContain(key);
    });

    it('opens a folded worktree on a row click without closing it on another click', async () => {
        await restart();
        await draw(() => ui().setGroupByWorktree(true));
        const key = workspaceKey();
        await arrow(key, 'ArrowLeft');
        await draw();
        expect(rowOf(FIXTURE_WORKSPACE_CHAT_ID)).toBeNull();
        await press(rowOf(key));
        await draw();
        expect(rowOf(FIXTURE_WORKSPACE_CHAT_ID)).not.toBeNull();
        await press(rowOf(key));
        await draw();
        expect(rowOf(FIXTURE_WORKSPACE_CHAT_ID)).not.toBeNull();
    });

    it('keeps a folded worktree closed when opening its actions menu', async () => {
        await restart();
        await draw(() => ui().setGroupByWorktree(true));
        const key = workspaceKey();
        await arrow(key, 'ArrowLeft');
        await draw();
        await press(rowOf(key).querySelector<HTMLElement>('button[aria-label^="Worktree actions:"]')!);
        expect(menuItem('New chat')).toBeDefined();
        expect(rowOf(FIXTURE_WORKSPACE_CHAT_ID)).toBeNull();
    });

    it('opens the worktree actions on right-clicking its header', async () => {
        await restart();
        await draw(() => ui().setGroupByWorktree(true));
        await act(async () => {
            rowOf(workspaceKey()).dispatchEvent(
                new MouseEvent('contextmenu', {
                    bubbles: true,
                    cancelable: true,
                    button: 2,
                    clientX: 120,
                    clientY: 120,
                })
            );
        });
        expect(menuItem('Remove worktree…')).toBeDefined();
        expect(menuItem('Switch branch')).toBeDefined();
    });

    it.each(['folder', 'worktree'] as const)('opens %s group actions on right-clicking its title', async layout => {
        await restart();
        await draw(() => ui().setChatListLayout(layout));
        const key = layout === 'folder' ? MAIN_GROUP : workspaceKey();
        const title = rowOf(key).querySelector<HTMLElement>('button[aria-expanded]')!;
        await act(async () => {
            title.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
        });
        expect(menuItem('New chat')).toBeDefined();
        expect(menuItem('Switch branch')).toBeDefined();
        expect(title.getAttribute('aria-expanded')).toBe('true');
    });

    it('opens chat actions rather than worktree actions on a chat inside the card', async () => {
        await restart();
        await draw(() => ui().setGroupByWorktree(true));
        await act(async () => {
            rowOf(FIXTURE_WORKSPACE_CHAT_ID).dispatchEvent(
                new MouseEvent('contextmenu', {
                    bubbles: true,
                    cancelable: true,
                    button: 2,
                    clientX: 120,
                    clientY: 120,
                })
            );
        });
        expect(menuItem('Rename')).toBeDefined();
        expect(menuItem('Remove worktree…')).toBeUndefined();
    });

    it('shows unused worktrees in the list when enabled in Display', async () => {
        await restart();
        await draw(() => ui().setGroupByWorktree(true));
        expect(cardRows()).toEqual([
            mainKey(),
            workspaceKey(),
            worktreeKey('fld_api', '/Users/dev/car-rental-api'),
            worktreeKey('fld_notes', '/Users/dev/notes'),
        ]);
        expect(container.textContent).not.toContain('Unused worktrees');
        await openProjectSubmenu('Display');
        await press(menuItem('Show unused worktrees'));
        await draw();
        expect(cardRows().length).toBeGreaterThan(2);
        expect(container.textContent).not.toContain('Unused worktrees');
        await press(menuItem('Show unused worktrees'));
        await draw();
        expect(cardRows()).toEqual([
            mainKey(),
            workspaceKey(),
            worktreeKey('fld_api', '/Users/dev/car-rental-api'),
            worktreeKey('fld_notes', '/Users/dev/notes'),
        ]);
    });

    it('shows each checkout’s pull request on its card, including unused worktrees and other folders', async () => {
        const data = withFixtureWorktrees(createFixtureData());
        const pr = (head: string, state: 'open' | 'draft' | 'merged') => ({
            number: 42,
            state,
            head,
            base: 'main',
            title: 'Change',
            url: `https://github.com/acme/example/pull/${head}`,
            updatedAt: 42,
        });
        data.branchPullRequests = {
            '/Users/dev/car-rental': {
                main: [pr('main', 'open')],
                'search-filters': [pr('search-filters', 'merged')],
                'old-pricing': [pr('old-pricing', 'open')],
            },
            '/Users/dev/car-rental-api': { 'feature/payments': [pr('feature/payments', 'draft')] },
        };
        await restart(data);
        await draw(() => {
            ui().setGroupByWorktree(true);
            chatListPreferences.setShowUnusedWorktrees(true);
        });
        const unused = worktreeKey('fld_car_rental', '/Users/dev/worktrees/car-rental/search-filters');
        const missing = worktreeKey('fld_car_rental', '/Users/dev/car-rental-old');
        const api = worktreeKey('fld_api', '/Users/dev/car-rental-api');
        const detached = worktreeKey('fld_api', '/Users/dev/worktrees/car-rental-api/readme');
        const badge = (key: string) => rowOf(key)?.querySelector('[data-pr-state]')?.getAttribute('data-pr-state');
        await vi.waitFor(() =>
            expect([badge(mainKey()), badge(unused), badge(api)]).toEqual(['open', 'merged', 'draft'])
        );
        expect(badge(missing)).toBeUndefined();
        expect(badge(detached)).toBeUndefined();
        expect(badge('c-4')).toBeUndefined();
        await draw(() => chatListPreferences.setShowUnusedWorktrees(false));
        expect(rowOf(unused)).toBeNull();
        expect(badge(mainKey())).toBe('open');
        await draw(() => ui().setGroupByWorktree(false));
        await vi.waitFor(() => expect(badge('c-4')).toBe('open'));
    });

    it('does not show the planned branch pull request while a worktree is pending', async () => {
        const data = withFixtureWorktrees(createFixtureData());
        const chat = data.chats.find(candidate => candidate.id === FIXTURE_WORKSPACE_CHAT_ID)!;
        chat.workspace = { ...chat.workspace!, id: 'pending-pr', path: '/pending-pr', branch: 'planned', ready: false };
        data.branchPullRequests = {
            '/Users/dev/car-rental': {
                main: [
                    {
                        number: 41,
                        state: 'open',
                        head: 'main',
                        base: 'dev',
                        title: 'Main',
                        url: 'https://github.com/acme/car-rental/pull/41',
                        updatedAt: 41,
                    },
                ],
                planned: [
                    {
                        number: 42,
                        state: 'open',
                        head: 'planned',
                        base: 'main',
                        title: 'Planned',
                        url: 'https://github.com/acme/car-rental/pull/42',
                        updatedAt: 42,
                    },
                ],
            },
        };
        await restart(data);
        const reads = vi.spyOn(store.transport, 'getGitBranchPullRequests');
        await draw(() => ui().setGroupByWorktree(true));
        const pending = worktreeKey('fld_car_rental', '/pending-pr');
        await vi.waitFor(() => expect(rowOf(mainKey()).querySelector('[data-pr-state]')).not.toBeNull());
        expect(rowOf(pending).querySelector('[data-pr-state]')).toBeNull();
        expect(rowOf(chat.id).querySelector('[data-pr-state]')).toBeNull();
        expect(reads.mock.calls.some(([, , branch]) => branch === 'planned')).toBe(false);
    });

    it.each(['button', 'context menu'])(
        'opens branch selection for the clicked unused worktree via %s without changing the selected chat',
        async entry => {
            await restart();
            const original = store.transport.command.bind(store.transport);
            const command = vi.spyOn(store.transport, 'command').mockImplementation(input =>
                input.type === 'workspace.open'
                    ? Promise.resolve({
                          ok: true,
                          requestId: 'test',
                          data: {
                              workspace: {
                                  id: 'wks_ab12cd34',
                                  folderId: input.folderId,
                                  path: input.path,
                                  ready: true,
                                  managed: false,
                              },
                          },
                      })
                    : original(input)
            );
            await draw(() => {
                ui().setGroupByWorktree(true);
                ui().openChat('c-4');
                chatListPreferences.setShowUnusedWorktrees(true);
            });
            await draw();
            const card = cardRows().find(key => key?.includes('search-filters'))!;
            if (entry === 'button')
                await press(rowOf(card).querySelector<HTMLElement>('button[aria-label^="Worktree actions:"]')!);
            else
                await act(async () => {
                    rowOf(card).dispatchEvent(
                        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
                    );
                });
            await press(menuItem('Switch branch'));
            await vi.waitFor(() =>
                expect(command).toHaveBeenCalledWith({
                    type: 'workspace.open',
                    projectId: FIXTURE_PROJECT_ID,
                    folderId: 'fld_car_rental',
                    path: '/Users/dev/worktrees/car-rental/search-filters',
                })
            );
            expect(ui().chatId).toBe('c-4');
            await vi.waitFor(() =>
                expect(document.querySelector('input[placeholder="Filter branches"]')).not.toBeNull()
            );
        }
    );

    it('opens branch selection for the main checkout without creating a workspace', async () => {
        await restart();
        const commands = vi.spyOn(store.transport, 'command');
        const branches = vi.spyOn(store.transport, 'getGitBranches');
        await draw(() => ui().setGroupByWorktree(true));
        await draw();
        await press(rowOf(mainKey()).querySelector<HTMLElement>('button[aria-label^="Worktree actions:"]')!);
        await vi.waitFor(() => expect(menuItem('Switch branch')).toBeDefined());
        await press(menuItem('Switch branch'));
        await vi.waitFor(() =>
            expect(branches).toHaveBeenCalledWith(FIXTURE_PROJECT_ID, { folderId: 'fld_car_rental' })
        );
        expect(commands.mock.calls.some(([input]) => input.type === 'workspace.open')).toBe(false);
        expect(document.querySelector('input[placeholder="Filter branches"]')).not.toBeNull();
    });

    it.each(['Open in Files', 'Open in Terminal'] as const)(
        'opens %s in another worktree without changing the active draft',
        async action => {
            await restart();
            await draw(() => {
                ui().setGroupByWorktree(true);
                ui().openDraft([], 'fld_api');
            });
            const draft = ui().draftId;
            const workspace = project().chats.get(FIXTURE_WORKSPACE_CHAT_ID)!.workspace!;
            await press(rowOf(workspaceKey()).querySelector<HTMLElement>('button[aria-label^="Worktree actions:"]')!);
            await press(menuItem(action));
            await vi.waitFor(() => expect(ui().sidePanelPlace?.workspace?.id).toBe(workspace.id));
            expect([ui().draftId, ui().draftFolderId, ui().sidePanelTab]).toEqual([
                draft,
                'fld_api',
                action === 'Open in Files' ? 'files' : 'terminal',
            ]);
            if (action === 'Open in Terminal') {
                expect(
                    terminalsStoreOf(store.transport).activeOf(FIXTURE_PROJECT_ID, workspace.folderId, workspace.id)
                        ?.info.cwd
                ).toBe(workspace.path);
            }
            await draw(() => ui().openChat('c-4'));
            expect(ui().sidePanelPlace).toBeNull();
        }
    );

    it.each(['Open in Files', 'Open in Terminal'] as const)(
        'opens %s in another folder without changing the active chat',
        async action => {
            await restart();
            await draw(() => {
                ui().setGroupByWorktree(true);
                ui().openChat(FIXTURE_WORKSPACE_CHAT_ID);
            });
            const api = worktreeKey('fld_api', '/Users/dev/car-rental-api');
            await press(rowOf(api).querySelector<HTMLElement>('button[aria-label^="Worktree actions:"]')!);
            await press(menuItem(action));
            await vi.waitFor(() => expect(ui().sidePanelPlace?.folder.id).toBe('fld_api'));
            expect([ui().chatId, ui().sidePanelPlace?.workspace, ui().sidePanelTab]).toEqual([
                FIXTURE_WORKSPACE_CHAT_ID,
                undefined,
                action === 'Open in Files' ? 'files' : 'terminal',
            ]);
            if (action === 'Open in Terminal') {
                expect(terminalsStoreOf(store.transport).activeOf(FIXTURE_PROJECT_ID, 'fld_api')?.info.cwd).toBe(
                    '/Users/dev/car-rental-api'
                );
            }
        }
    );

    it('does not reopen the panel when a delayed worktree selection finishes after it was closed', async () => {
        await restart();
        await draw(() => {
            ui().setGroupByWorktree(true);
            chatListPreferences.setShowUnusedWorktrees(true);
        });
        const original = store.transport.command.bind(store.transport);
        let finish!: () => void;
        const gate = new Promise<void>(resolve => {
            finish = resolve;
        });
        vi.spyOn(store.transport, 'command').mockImplementation(async input => {
            if (input.type === 'workspace.open') await gate;
            return original(input);
        });
        const card = cardRows().find(key => key?.includes('search-filters'))!;
        await press(rowOf(card).querySelector<HTMLElement>('button[aria-label^="Worktree actions:"]')!);
        await press(menuItem('Open in Files'));
        await draw(() => ui().closeSidePanel());
        await act(async () => {
            finish();
            await gate;
        });
        await new Promise(resolve => setTimeout(resolve, 30));
        expect([ui().sidePanelOpen, ui().sidePanelPlace]).toEqual([false, null]);
    });

    it('starts a draft in a worktree with no chats from its own menu', async () => {
        await restart();
        await draw(() => ui().setGroupByWorktree(true));
        await draw(() => chatListPreferences.setShowUnusedWorktrees(true));
        const card = cardRows().find(key => key?.includes('search-filters'))!;
        await press(rowOf(card).querySelector<HTMLElement>('button[aria-label^="Worktree actions:"]')!);
        expect(menuItem('Open in Files')).toBeDefined();
        expect(menuItem('Open in Terminal')).toBeDefined();
        await press(menuItem('New chat'));
        expect([ui().draft, ui().draftWorkspace]).toEqual([
            true,
            { mode: 'existing', path: '/Users/dev/worktrees/car-rental/search-filters' },
        ]);
    });

    it('starts a draft in the worktree using its shortcut', async () => {
        await restart();
        await draw(() => ui().setGroupByWorktree(true));
        const workspace = project().chats.get(FIXTURE_WORKSPACE_CHAT_ID)!.workspace!;
        await press(rowOf(workspaceKey()).querySelector<HTMLElement>('button[aria-label^="New chat in "]')!);
        expect([ui().draft, ui().draftWorkspace]).toEqual([true, { mode: 'existing', path: workspace.path }]);
        await draw();
        expect(rowKeys()).not.toContain('@new-chat');
        expect(isSelected(`@draft:${ui().draftId}`)).toBe(true);
    });

    it('opens the folder checkout after starting a worktree draft', async () => {
        await restart();
        await draw(() => ui().setGroupByWorktree(true));
        await press(rowOf(workspaceKey()).querySelector<HTMLElement>('button[aria-label^="New chat in "]')!);
        const worktreeDraft = ui().draftId!;
        await press(buttonNamed('New chat in car-rental'));
        await draw();

        expect(ui().draftWorkspace).toBeNull();
        expect(ui().draftId).not.toBe(worktreeDraft);
        expect(isSelected(`@draft:${ui().draftId}`)).toBe(true);
        expect(rowKeys()).toContain(`@draft:${worktreeDraft}`);
    });

    it('keeps two worktree drafts and their text when switching and moving one into the other', async () => {
        await restart();
        await draw(() => {
            ui().setGroupByWorktree(true);
            chatListPreferences.setShowUnusedWorktrees(true);
        });
        const firstCard = workspaceKey();
        const secondCard = cardRows().find(key => key?.includes('search-filters'))!;
        await press(rowOf(firstCard).querySelector<HTMLElement>('button[aria-label^="New chat in "]')!);
        await draw();
        const first = ui().draftId!;
        const editor = () =>
            container.querySelector<HTMLElement & { editor: Editor }>('[contenteditable="true"]')!.editor;
        await act(async () => {
            editor().commands.insertContent('First worktree words');
        });
        await press(rowOf(secondCard).querySelector<HTMLElement>('button[aria-label^="New chat in "]')!);
        await draw();
        const second = ui().draftId!;
        expect(second).not.toBe(first);
        await act(async () => {
            editor().commands.insertContent('Second worktree words');
        });
        await press(rowOf(`@draft:${first}`));
        await draw();
        expect([isSelected(`@draft:${first}`), editor().getText()]).toEqual([true, 'First worktree words']);
        await draw(() =>
            ui().setDraftWorkspace({ mode: 'existing', path: '/Users/dev/worktrees/car-rental/search-filters' })
        );
        expect(rowOf(`@draft:${first}`).closest('[data-worktree-card]')?.getAttribute('data-worktree-card')).toBe(
            secondCard
        );
        await press(rowOf(`@draft:${second}`));
        await draw();
        expect([isSelected(`@draft:${second}`), editor().getText()]).toEqual([true, 'Second worktree words']);
        await press(rowOf(`@draft:${first}`));
        await draw();
        expect(editor().getText()).toBe('First worktree words');
    });

    it.each(['simple', 'folder', 'worktree'] as const)('shows a selected draft in the %s layout', async layout => {
        await restart();
        await draw(() => {
            ui().setChatListLayout(layout);
            ui().openDraft([], null, { mode: 'existing', path: '/missing-from-git' });
        });
        expect(isSelected(`@draft:${ui().draftId}`)).toBe(true);
    });

    it('closes an empty draft row without removing another draft', async () => {
        await restart();
        await draw(() => {
            ui().setChatListLayout('folder');
            ui().openDraft([], null, { mode: 'existing', path: '/first' });
        });
        const first = ui().draftId!;
        await draw(() => ui().openDraft([], null, { mode: 'existing', path: '/second' }));
        const second = ui().draftId!;
        await press(rowOf(`@draft:${first}`).querySelector<HTMLElement>('button[aria-label="Close draft"]')!);
        await draw();
        expect(rowKeys()).not.toContain(`@draft:${first}`);
        expect(isSelected(`@draft:${second}`)).toBe(true);
    });

    it('disables the shortcut while a worktree is still being prepared', async () => {
        await restart();
        await draw(() => {
            const chat = project().chats.get(FIXTURE_WORKSPACE_CHAT_ID)!;
            project().chats.set(chat.id, { ...chat, workspace: { ...chat.workspace!, ready: false } });
            ui().setGroupByWorktree(true);
        });
        await draw();
        const shortcut = rowOf(workspaceKey()).querySelector<HTMLButtonElement>('button[aria-label^="New chat in "]')!;
        expect(shortcut.disabled).toBe(true);
    });

    it('explains that a pending worktree is not prepared and does not offer branch switching', async () => {
        await restart();
        await draw(() => {
            const chat = project().chats.get(FIXTURE_WORKSPACE_CHAT_ID)!;
            project().chats.set(chat.id, {
                ...chat,
                workspace: {
                    ...chat.workspace!,
                    id: 'pending-worktree',
                    path: '/pending-worktree',
                    branch: undefined,
                    ready: false,
                },
            });
            ui().setGroupByWorktree(true);
        });
        await draw();
        expect(rowOf(workspaceKey()).querySelector('[title]')?.getAttribute('title')).toBe(
            'car-rental, Worktree — Worktree not prepared yet'
        );
        await press(rowOf(workspaceKey()).querySelector<HTMLElement>('button[aria-label^="Worktree actions:"]')!);
        const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Worktree actions"]')!;
        expect(menu.textContent).toContain('Worktree not prepared yet');
        expect(menu.textContent).not.toContain('no longer exists');
        expect(menuItem('Switch branch')).toBeUndefined();
        expect(menuItem('New chat').getAttribute('aria-disabled')).toBe('true');
    });

    it('folds and unfolds a worktree with its icon control', async () => {
        await restart();
        await draw(() => ui().setGroupByWorktree(true));
        const key = workspaceKey();
        await press(rowOf(key).querySelector<HTMLElement>('button[aria-label^="Collapse "]')!);
        await draw();
        expect(rowOf(FIXTURE_WORKSPACE_CHAT_ID)).toBeNull();
        await press(rowOf(key).querySelector<HTMLElement>('button[aria-label^="Expand "]')!);
        await draw();
        expect(rowOf(FIXTURE_WORKSPACE_CHAT_ID)).not.toBeNull();
    });

    it.each(['card', 'chip'] as const)('removes the selected worktree from the %s menu', async entry => {
        await restart();
        const create = Modal.create.bind(Modal);
        const dialog = vi.spyOn(Modal, 'create').mockImplementation(options => create({ ...options, animate: false }));
        window.desktop = {
            getOpenApps: async () => ({ editors: [], terminals: [], fileManagers: [] }),
            openPath: async () => undefined,
        } as never;
        try {
            await draw(() => {
                ui().setGroupByWorktree(entry === 'card');
                ui().openChat(FIXTURE_WORKSPACE_CHAT_ID);
            });
            const button =
                entry === 'card'
                    ? rowOf(workspaceKey()).querySelector<HTMLElement>('button[aria-label^="Worktree actions:"]')!
                    : container.querySelector<HTMLElement>('button[aria-label^="Current place:"]')!;
            await press(button);
            await press(menuItem('Remove worktree…'));
            await vi.waitFor(() => expect(dialog).toHaveBeenCalled());
            const confirm = () =>
                [...document.querySelectorAll<HTMLButtonElement>('[data-modal-window] button')].find(
                    button => button.textContent?.trim() === 'Remove worktree'
                );
            await vi.waitFor(() => expect(confirm()).toBeDefined());
            await press(confirm()!);
            await vi.waitFor(() => expect(Modal.opened).toHaveLength(0));
            await draw();
            const snapshot = await store.transport.getProjectSnapshot(FIXTURE_PROJECT_ID);
            expect({
                archived: snapshot.chats
                    .filter(chat => ['c-9', 'c-10'].includes(chat.id))
                    .map(chat => Boolean(chat.archivedAt)),
                selected: rowOf(FIXTURE_WORKSPACE_CHAT_ID) !== null && isSelected(FIXTURE_WORKSPACE_CHAT_ID),
                listed: (await store.transport.getProjectWorktrees(FIXTURE_PROJECT_ID))
                    .flatMap(group => group.worktrees)
                    .some(row => row.workspaceId === 'wks_ab12cd34'),
            }).toEqual({ archived: [true, true], selected: false, listed: false });
        } finally {
            for (const modal of [...Modal.opened].reverse()) await act(async () => modal.close(false));
            dialog.mockRestore();
            window.desktop = undefined;
        }
    });

    it('omits bulk archive and move actions from worktree menus', async () => {
        await restart();
        await draw(() => ui().setGroupByWorktree(true));
        await press(rowOf(workspaceKey()).querySelector<HTMLElement>('button[aria-label^="Worktree actions:"]')!);
        expect(menuItem('Archive all chats…')).toBeUndefined();
        expect(menuItem('Move up')).toBeUndefined();
        expect(menuItem('Move down')).toBeUndefined();
        expect(menuItem('Remove worktree…')).toBeDefined();
    });

    it('does not read the worktree list when grouping is off, and refreshes it on focus and folder Git changes', async () => {
        await restart();
        const read = vi.spyOn(store.transport, 'getProjectWorktrees');
        await act(async () => window.dispatchEvent(new Event('focus')));
        expect(read).not.toHaveBeenCalled();
        await draw(() => ui().setGroupByWorktree(true));
        expect(read).toHaveBeenCalledWith(FIXTURE_PROJECT_ID);
        read.mockClear();
        await act(async () => window.dispatchEvent(new Event('focus')));
        expect(read).toHaveBeenCalledWith(FIXTURE_PROJECT_ID);
        read.mockClear();
        await act(async () => refreshFolderGit(FIXTURE_PROJECT_ID, 'fld_car_rental'));
        expect(read).toHaveBeenCalledWith(FIXTURE_PROJECT_ID);
    });

    it('refuses a cross-group drop and a drop onto a card header', async () => {
        await restart();
        await draw(() => ui().setGroupByWorktree(true));
        const before = rowKeys();
        await drag(FIXTURE_WORKSPACE_CHAT_ID, 'c-4');
        await drag('c-4', workspaceKey());
        expect(rowKeys()).toEqual(before);
        expect(ui().chatOrder).toEqual([]);
    });

    it('moves a card with its entire group by dragging another card', async () => {
        await restart();
        await draw(() => ui().setGroupByWorktree(true));
        await draw(() => chatListPreferences.setShowUnusedWorktrees(true));
        const cards = cardRows();
        await drag(cards[1]!, cards[2]!);
        expect(cardRows().slice(0, 3)).toEqual([cards[0], cards[2], cards[1]]);
    });

    it('places a pending creation first after dragging two other worktrees', async () => {
        await restart();
        await draw(() => {
            ui().setGroupByWorktree(true);
            chatListPreferences.setShowUnusedWorktrees(true);
        });
        const cards = cardRows();
        const pending = workspaceKey();
        await drag(cards[2]!, cards[3]!);
        const afterDrag = cardRows().filter(key => key !== pending);
        await draw(() => ui().placeNewWorktree('fld_car_rental', [pending], Date.now(), 'cht_pending'));
        expect(cardRows()).toEqual([afterDrag[0], pending, ...afterDrag.slice(1)]);
    });

    it('keeps a canonical worktree in its dragged place when its chat is archived and restored', async () => {
        await restart();
        const chat = project().chats.get(FIXTURE_WORKSPACE_CHAT_ID)!;
        const pending = worktreeKey(chat.workspace!.folderId, chat.workspace!.path);
        const canonical = worktreeKey(chat.workspace!.folderId, '/canonical/tree');
        const read = store.transport.getProjectWorktrees.bind(store.transport);
        vi.spyOn(store.transport, 'getProjectWorktrees').mockImplementation(async projectId =>
            (await read(projectId)).map(folder => ({
                ...folder,
                worktrees: folder.worktrees.map(tree =>
                    tree.workspaceId === chat.workspace!.id ? { ...tree, path: '/canonical/tree' } : tree
                ),
            }))
        );
        await draw(() => {
            ui().setWorktreeOrder([pending]);
            ui().setGroupByWorktree(true);
            chatListPreferences.setShowUnusedWorktrees(true);
        });
        await draw();
        const cards = cardRows();
        expect(cards[1]).toBe(canonical);
        await drag(canonical, cards[2]!);
        expect(cardRows().slice(0, 3)).toEqual([cards[0], cards[2], canonical]);
        await draw(() => project().chats.set(chat.id, { ...chat, archivedAt: 1 }));
        expect(cardRows().slice(0, 3)).toEqual([cards[0], cards[2], canonical]);
        await draw(() => project().chats.set(chat.id, chat));
        expect(cardRows().slice(0, 3)).toEqual([cards[0], cards[2], canonical]);
    });

    it('uses the whole visible worktree group as the drag image', async () => {
        await restart();
        await draw(() => ui().setGroupByWorktree(true));
        const card = rowOf(workspaceKey()).closest<HTMLElement>('[data-worktree-card]')!;
        const transfer = new DataTransfer();
        transfer.setDragImage = vi.fn();
        const event = new MouseEvent('dragstart', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: transfer });
        await act(async () =>
            rowOf(workspaceKey()).querySelector<HTMLElement>('[draggable="true"]')!.dispatchEvent(event)
        );
        expect(transfer.setDragImage).toHaveBeenCalledWith(card, expect.any(Number), expect.any(Number));
        expect(card.contains(rowOf(FIXTURE_WORKSPACE_CHAT_ID))).toBe(true);
    });

    it('moves an occupied worktree among unused worktrees', async () => {
        await restart();
        await draw(() => {
            ui().setGroupByWorktree(true);
            chatListPreferences.setShowUnusedWorktrees(true);
        });
        const cards = cardRows();
        await drag(cards[1]!, cards[2]!);
        expect(cardRows().slice(0, 3)).toEqual([cards[0], cards[2], cards[1]]);
        expect(
            rowOf(FIXTURE_WORKSPACE_CHAT_ID).closest('[data-worktree-card]')?.getAttribute('data-worktree-card')
        ).toBe(cards[1]);
    });

    it('keeps cross-worktree threads below their root and only shows the place indicator without another status', async () => {
        await restart();
        const workspace = project().chats.get(FIXTURE_WORKSPACE_CHAT_ID)!.workspace!;
        await draw(() => {
            project().chats.set('c-6', { ...project().chats.get('c-6')!, workspace });
            ui().setGroupByWorktree(true);
            ui().toggleChatExpanded('c-6');
            ui().openChat('c-6b');
        });
        await draw();
        expect(
            ['c-6', 'c-6a', 'c-6b', 'c-6c'].map(id => [
                rowOf(id).closest('[data-worktree-card]')?.getAttribute('data-worktree-card'),
                rowOf(id).querySelector('[aria-label="Different worktree"]') !== null,
            ])
        ).toEqual([
            [workspaceKey(), false],
            [workspaceKey(), false],
            [workspaceKey(), true],
            [workspaceKey(), false],
        ]);
    });

    it('shows a thread’s pull request from its own folder inside its ancestor’s worktree card', async () => {
        const data = withFixtureWorktrees(createFixtureData());
        const root = data.chats.find(chat => chat.id === 'c-6')!;
        const thread = data.chats.find(chat => chat.id === 'c-6b')!;
        const workspace = data.chats.find(chat => chat.id === FIXTURE_WORKSPACE_CHAT_ID)!.workspace!;
        root.workspace = workspace;
        thread.workspace = {
            ...workspace,
            id: 'wks_api_thread',
            folderId: 'fld_api',
            path: '/Users/dev/worktrees/api-thread',
            branch: 'feature/api-thread',
        };
        data.branchPullRequests = {
            '/Users/dev/car-rental-api': {
                'feature/api-thread': [
                    {
                        number: 42,
                        state: 'open',
                        head: 'feature/api-thread',
                        base: 'main',
                        title: 'API change',
                        url: 'https://github.com/acme/car-rental-api/pull/42',
                        updatedAt: 42,
                    },
                ],
            },
        };
        await restart(data);
        await draw(() => {
            ui().setGroupByWorktree(true);
            ui().toggleChatExpanded('c-6');
            ui().openChat('c-6b');
        });
        await vi.waitFor(() =>
            expect(rowOf('c-6b').querySelector('[data-pr-state]')?.getAttribute('data-pr-state')).toBe('open')
        );
        expect(rowOf('c-6b').closest('[data-worktree-card]')?.getAttribute('data-worktree-card')).toBe(workspaceKey());
    });

    it('marks a cross-worktree grandchild relative to its immediate parent, not to the root', async () => {
        await restart();
        const workspace = project().chats.get(FIXTURE_WORKSPACE_CHAT_ID)!.workspace!;
        await draw(() => {
            project().chats.set('c-6a', { ...project().chats.get('c-6a')!, workspace });
            project().chats.set('c-6a1', { ...project().chats.get('c-6a1')!, workspace });
            ui().setGroupByWorktree(true);
            ui().openChat('c-6a1');
        });
        await draw();
        expect(rowOf('c-6a1').querySelector('[aria-label="Different worktree"]')).toBeNull();
        expect(rowOf(workspaceKey()).querySelector('[aria-label="Chats working"]')).toBeNull();
        await arrow(workspaceKey(), 'ArrowLeft');
        await draw();
        expect(rowOf(workspaceKey()).querySelector('[aria-label="Chats working"]')).not.toBeNull();
        await arrow(workspaceKey(), 'ArrowRight');
        await draw();
        expect(rowOf(workspaceKey()).querySelector('[aria-label="Chats working"]')).toBeNull();

        await draw(() => {
            const { workspace: _, ...chat } = project().chats.get('c-6a1')!;
            project().chats.set(chat.id, chat);
        });
        expect(rowOf('c-6a1').querySelector('[aria-label="Different worktree"]')).not.toBeNull();
    });

    it('shows a waiting indicator on a collapsed worktree and hides it when expanded', async () => {
        await restart();
        const workspace = project().chats.get(FIXTURE_WORKSPACE_CHAT_ID)!.workspace!;
        await draw(() => {
            project().chats.set('c-6', { ...project().chats.get('c-6')!, workspace });
            project().runs.set('r-orch-6e', { ...project().runs.get('r-orch-6e')!, awaitingUser: true });
            ui().setGroupByWorktree(true);
        });
        expect(rowOf(workspaceKey()).querySelector('[aria-label="Chats waiting for you"]')).toBeNull();
        await arrow(workspaceKey(), 'ArrowLeft');
        await draw();
        expect(
            rowOf(workspaceKey()).querySelector('[aria-label="Chats waiting for you"] [data-tone="accent"]')
        ).not.toBeNull();
        await arrow(workspaceKey(), 'ArrowRight');
        await draw();
        expect(rowOf(workspaceKey()).querySelector('[aria-label="Chats waiting for you"]')).toBeNull();
    });

    it('keeps a thread-only worktree visible regardless of the unused filter', async () => {
        await restart();
        const workspace = project().chats.get(FIXTURE_WORKSPACE_CHAT_ID)!.workspace!;
        const key = workspaceKey();
        await draw(() => {
            project().chats.delete(FIXTURE_WORKSPACE_CHAT_ID);
            project().chats.set('c-6a', { ...project().chats.get('c-6a')!, workspace });
            ui().setGroupByWorktree(true);
            ui().openChat('c-6a');
        });
        await draw();
        expect(cardRows()).toContain(key);
        expect(rowOf('c-6a')).not.toBeNull();
        await draw(() => chatListPreferences.setShowUnusedWorktrees(true));
        expect(cardRows()).toContain(key);
        expect(cardRows().length).toBeGreaterThan(0);
    });

    it('opens the card of a restored thread whose parent remains archived', async () => {
        await restart();
        const workspace = project().chats.get(FIXTURE_WORKSPACE_CHAT_ID)!.workspace!;
        const key = workspaceKey();
        await draw(() => {
            project().chats.set('c-6', { ...project().chats.get('c-6')!, archivedAt: 1 });
            project().chats.set('c-6a', { ...project().chats.get('c-6a')!, workspace });
            ui().setGroupByWorktree(true);
            ui().openChat('c-4');
            ui().toggleWorktreeCollapsed(key);
        });
        expect(rowOf('c-6a')).toBeNull();
        await draw(() => ui().openChat('c-6a1'));
        await draw();
        expect(rowOf('c-6a1')).not.toBeNull();
        expect(rowOf('@linked-thread:c-6a')).toBeNull();
        expect(ui().collapsedWorktrees).not.toContain(key);
    });

    it('does not offer a chat move across checkout and worktree boundaries', async () => {
        await restart();
        await draw(() => ui().setGroupByWorktree(true));
        await press(rowOf(FIXTURE_WORKSPACE_CHAT_ID).querySelector<HTMLElement>('button[aria-label="Chat actions"]')!);
        expect([menuItem('Move up'), menuItem('Move down')]).toEqual([undefined, undefined]);
    });
});
