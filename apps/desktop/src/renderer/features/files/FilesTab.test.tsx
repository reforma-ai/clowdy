// @vitest-environment happy-dom
import { EditorView } from '@codemirror/view';
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_PROJECT_ID,
    FIXTURE_WORKSPACE_CHAT_ID,
    FIXTURE_WORKTREE_PATH,
    withFixtureWorkspace,
} from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { registerComposer } from '../chats/composerBridge';
import FilesTab from './FilesTab';
import { filesStoreOf } from './useFilesStore';

import type { Chat, ChatWorkspace } from '@clowdy/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no layout: the view and the tree measure their host, so they are told a size.
vi.mock('use-resize-observer', () => ({ default: () => ({ ref: () => undefined, width: 600, height: 400 }) }));

// The babel plugin that makes the app's components observers does not run under Vitest.
const Tab = observer(FilesTab);

let container: HTMLDivElement;
let root: Root;
let store: RootStore;

const settle = () =>
    act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
    });
const rows = () => [...container.querySelectorAll('[role="treeitem"]')].map(row => row.textContent);
const draw = async (variant: 'files' | 'docs' = 'files') => {
    act(() =>
        root.render(
            <RootStoreProvider value={store}>
                <Tab variant={variant} />
            </RootStoreProvider>
        )
    );
    await settle();
    await settle();
};
const ui = () => store.ui.forProject(FIXTURE_PROJECT_ID);

beforeEach(async () => {
    localStorage.clear();
    store = new RootStore(new FixtureTransport({ data: withFixtureWorkspace(createFixtureData()) }));
    await store.load();
    store.selectProject(FIXTURE_PROJECT_ID);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    filesStoreOf(store).dispose();
    store.dispose();
    localStorage.clear();
});

describe('the Docs tab over a place', () => {
    it("draws the documents of the folder's own checkout when no chat is open", async () => {
        await draw('docs');

        expect(rows().some(text => text?.includes('weekend-pricing'))).toBe(true);
        expect(rows().some(text => text?.includes('weekend-surcharge'))).toBe(false);
    });

    it("draws the plan only the worktree has when the chat that works in it is open, and the folder's own again when it is not", async () => {
        ui().openChat(FIXTURE_WORKSPACE_CHAT_ID);
        await draw('docs');

        expect(rows().some(text => text?.includes('weekend-surcharge'))).toBe(true);
        expect(rows().some(text => text?.includes('weekend-pricing'))).toBe(true);

        act(() => ui().openChat(null));
        await settle();
        await settle();

        expect(rows().some(text => text?.includes('weekend-surcharge'))).toBe(false);
        expect(rows().some(text => text?.includes('weekend-pricing'))).toBe(true);

        // The worktree's own manager is kept, and comes back with the chat.
        act(() => ui().openChat(FIXTURE_WORKSPACE_CHAT_ID));
        await settle();

        expect(rows().some(text => text?.includes('weekend-surcharge'))).toBe(true);
    });

    it('draws the plan only the worktree has once a new-chat page that chose it has its row, though no chat works in it', async () => {
        store.dispose();
        store = new RootStore(new FixtureTransport({ data: createFixtureData() }));
        await store.load();
        store.selectProject(FIXTURE_PROJECT_ID);
        ui().openDraft([], null, { mode: 'existing', path: FIXTURE_WORKTREE_PATH });
        await draw('docs');

        // The page has not asked for the worktree yet: the place is the folder's own checkout.
        expect(rows().some(text => text?.includes('weekend-surcharge'))).toBe(false);

        const opened = await store.command({
            type: 'workspace.open',
            projectId: FIXTURE_PROJECT_ID,
            folderId: 'fld_car_rental',
            path: FIXTURE_WORKTREE_PATH,
        });

        if (!opened.ok) throw new Error(opened.error.message);

        act(() => ui().setDraftWorkspaceRow((opened.data as { workspace: ChatWorkspace }).workspace));
        await settle();
        await settle();

        expect(rows().some(text => text?.includes('weekend-surcharge'))).toBe(true);
    });

    it("keeps a document the person opened in the worktree's tabs when another chat comes on show and goes", async () => {
        ui().openChat(FIXTURE_WORKSPACE_CHAT_ID);
        await draw('docs');

        const worktree = store.selectedProject!.chats.get(FIXTURE_WORKSPACE_CHAT_ID)!;
        const manager = await filesStoreOf(store).startedManagerOf(
            FIXTURE_PROJECT_ID,
            { folder: store.selectedProject!.project.folders[0]!, workspace: worktree.workspace },
            'docs'
        );

        await manager.open('.briefback/weekend-surcharge/plan.md');
        act(() => ui().openChat(null));
        await settle();
        act(() => ui().openChat(FIXTURE_WORKSPACE_CHAT_ID));
        await settle();

        expect(manager.tabs.documents.map(document => document.path)).toEqual(['.briefback/weekend-surcharge/plan.md']);
    });
});

describe('a chat whose worktree is not made yet', () => {
    it("shows a note in place of the files and the documents, not an error and not the folder's own checkout, and the tree once the worktree is made", async () => {
        const made = await store.command({
            type: 'chat.create',
            projectId: FIXTURE_PROJECT_ID,
            workspace: { mode: 'new' },
        });
        const { chat } = (made as { data: { chat: Chat } }).data;
        const project = store.projectState(FIXTURE_PROJECT_ID)!;

        await vi.waitFor(() => expect(project.chats.get(chat.id)?.workspace?.ready).toBe(false));
        ui().openChat(chat.id);
        await draw('files');

        expect(container.textContent).toContain('The worktree is not made yet');
        expect(rows()).toEqual([]);

        await draw('docs');

        expect(container.textContent).toContain('The worktree is not made yet');
        expect(rows()).toEqual([]);

        // The chat's first message makes the worktree, and the tab lists it.
        await store.command({ type: 'chat.send', chatId: chat.id, text: 'Go' });
        await vi.waitFor(() => expect(project.chats.get(chat.id)?.workspace?.ready).toBe(true));
        await settle();
        await settle();

        expect(container.textContent).not.toContain('The worktree is not made yet');
        expect(rows().some(text => text?.includes('weekend-pricing'))).toBe(true);
    });
});

describe('Add to chat over the open file', () => {
    const editor = () => EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!;
    const button = () => container.querySelector<HTMLButtonElement>('.cm-tooltip button');
    const select = (from: number, to: number) =>
        act(async () => editor().dispatch({ selection: { anchor: from, head: to } }));

    async function openPrice() {
        await draw('files');

        const manager = await filesStoreOf(store).startedManagerOf(
            FIXTURE_PROJECT_ID,
            { folder: store.selectedProject!.project.folders[0]! },
            'files'
        );

        await manager.open('src/booking/price.ts');
        await settle();
        await vi.waitFor(() => expect(container.querySelector('.cm-editor')).not.toBeNull(), { timeout: 5000 });
    }

    it('offers nothing while no message box is mounted', async () => {
        await openPrice();
        await select(0, 5);
        await settle();

        expect(container.querySelector('.cm-editor')).not.toBeNull();
        expect(button()).toBeNull();
    });

    it("shows the button over selected words once a message box is mounted, and quotes the file's path and lines into it", async () => {
        const quoted: string[] = [];
        const unregister = registerComposer(text => quoted.push(text));

        await openPrice();

        const text = editor().state.doc.toString();
        const lines = text.split('\n');

        // The first two lines, whole.
        await select(0, lines[0]!.length + 1 + lines[1]!.length);

        expect(button()?.textContent).toContain('Add to chat');

        await act(async () => button()!.click());

        expect(quoted).toEqual([`\`src/booking/price.ts:1-2\`\n\`\`\`ts\n${lines[0]}\n${lines[1]}\n\`\`\``]);
        expect(editor().state.selection.main.empty).toBe(true);

        unregister();
    });

    it('shuts the side panel when it covers the chat, which cannot be typed in out of sight, and leaves a panel beside the chat open', async () => {
        const unregister = registerComposer(() => undefined);

        ui().sidePanelOpen = true;
        await openPrice();

        // Beside the chat: left as it is.
        await select(0, 5);
        await act(async () => button()!.click());
        expect(ui().sidePanelOpen).toBe(true);

        // Expanded, in the chat's place: shut, so the box that took the quote is on screen. The choice of the expanded size stays, so it comes back expanded.
        act(() => {
            ui().sidePanelExpanded = true;
        });
        await select(0, 5);
        await act(async () => button()!.click());
        expect(ui().sidePanelOpen).toBe(false);
        expect(ui().sidePanelExpanded).toBe(true);

        unregister();
    });

    it('takes the button away when the message box goes, and brings it back with the next one', async () => {
        const unregister = registerComposer(() => undefined);

        await openPrice();
        await select(0, 5);
        expect(button()).not.toBeNull();

        act(() => unregister());
        await settle();
        expect(button()).toBeNull();

        const again = registerComposer(() => undefined);

        await settle();
        expect(button()).not.toBeNull();

        again();
    });
});

describe('Add to chat from the tree', () => {
    const rowFor = (name: string) =>
        [...container.querySelectorAll<HTMLElement>('[role="treeitem"] [draggable="true"]')].find(
            row => row.textContent === name
        )!;
    const openMenu = (row: HTMLElement) =>
        act(async () => {
            row.dispatchEvent(
                new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })
            );
        });
    const menuItem = () =>
        [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
            item => item.textContent === 'Add to chat'
        );
    const press = (target: HTMLElement) =>
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

    it('adds paths of a file and folder from the chat worktree, and returns to a covered chat', async () => {
        const mention = vi.fn(() => true);
        const unregister = registerComposer(vi.fn(), mention);

        try {
            ui().openChat(FIXTURE_WORKSPACE_CHAT_ID);
            ui().sidePanelOpen = true;
            ui().sidePanelExpanded = true;
            await draw();

            await openMenu(rowFor('README.md'));
            await press(menuItem()!);
            expect(mention).toHaveBeenLastCalledWith([
                { path: `${FIXTURE_WORKTREE_PATH}/README.md`, name: 'README.md', kind: 'file' },
            ]);
            expect(ui().sidePanelOpen).toBe(false);

            await openMenu(rowFor('src'));
            await press(menuItem()!);
            expect(mention).toHaveBeenLastCalledWith([
                { path: `${FIXTURE_WORKTREE_PATH}/src`, name: 'src', kind: 'directory' },
            ]);
            expect(mention).toHaveBeenCalledTimes(2);
        } finally {
            await act(async () => unregister());
        }
    });

    it('does not offer the action when there is no composer', async () => {
        await draw();
        await openMenu(rowFor('README.md'));
        expect(menuItem()).toBeUndefined();
    });
});
