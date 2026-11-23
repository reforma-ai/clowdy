// @vitest-environment happy-dom
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID, FIXTURE_WORKSPACE_CHAT_ID, FIXTURE_WORKTREE_PATH, withFixtureWorkspace } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { openManageWorktrees } from '../worktrees';
import FilesTab from './FilesTab';
import { filesStoreOf } from './useFilesStore';

import type { Chat, ChatWorkspace } from '@clowdy/protocol';

vi.mock('../worktrees', () => ({ openManageWorktrees: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no layout: the view and the tree measure their host, so they are told a size.
vi.mock('use-resize-observer', () => ({ default: () => ({ ref: () => undefined, width: 600, height: 400 }) }));

// The babel plugin that makes the app's components observers does not run under Vitest.
const Tab = observer(FilesTab);

let container: HTMLDivElement;
let root: Root;
let store: RootStore;

const settle = () => act(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
});
const rows = () => [...container.querySelectorAll('[role="treeitem"]')].map(row => row.textContent);
const draw = async (variant: 'files' | 'docs' = 'files') => {
    act(() => root.render(<RootStoreProvider value={ store }><Tab variant={ variant } /></RootStoreProvider>));
    await settle();
    await settle();
};
const ui = () => store.ui.forProject(FIXTURE_PROJECT_ID);
const bar = () => container.querySelector<HTMLElement>('[data-place-bar]');
const press = (target: HTMLElement) => act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    target.click();
});

beforeEach(async () => {
    localStorage.clear();
    store = new RootStore(new FixtureTransport({ data: withFixtureWorkspace(createFixtureData()) }));
    await store.load();
    store.selectProject(FIXTURE_PROJECT_ID);
    vi.mocked(openManageWorktrees).mockClear();
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
    it('draws the documents of the folder\'s own checkout when no chat is open', async () => {
        await draw('docs');

        expect(rows().some(text => text?.includes('weekend-pricing'))).toBe(true);
        expect(rows().some(text => text?.includes('weekend-surcharge'))).toBe(false);
    });

    it('draws the plan only the worktree has when the chat that works in it is open, and the folder\'s own again when it is not', async () => {
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

    it('keeps a document the person opened in the worktree\'s tabs when another chat comes on show and goes', async () => {
        ui().openChat(FIXTURE_WORKSPACE_CHAT_ID);
        await draw('docs');

        const worktree = store.selectedProject!.chats.get(FIXTURE_WORKSPACE_CHAT_ID)!;
        const manager = await filesStoreOf(store).startedManagerOf(FIXTURE_PROJECT_ID, { folder: store.selectedProject!.project.folders[0]!, workspace: worktree.workspace }, 'docs');

        await manager.open('.briefback/weekend-surcharge/plan.md');
        act(() => ui().openChat(null));
        await settle();
        act(() => ui().openChat(FIXTURE_WORKSPACE_CHAT_ID));
        await settle();

        expect(manager.tabs.documents.map(document => document.path)).toEqual(['.briefback/weekend-surcharge/plan.md']);
    });
});

describe('the bar that names the place', () => {
    it('names the folder and its branch for the folder\'s own checkout, over the files, and opens the dialog on the folder from its name and its Manage button', async () => {
        await draw('files');

        expect(bar()?.textContent).toBe('car-rental · mainManage');
        expect(bar()?.nextElementSibling?.querySelector('[role="treeitem"]')).not.toBeNull();

        await press(bar()!.querySelector<HTMLButtonElement>('button:not([aria-label])')!);

        expect(openManageWorktrees).toHaveBeenLastCalledWith({ root: store, projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental' });

        await press(bar()!.querySelector<HTMLButtonElement>('button[aria-label="Manage worktrees"]')!);

        expect(openManageWorktrees).toHaveBeenCalledTimes(2);
        expect(openManageWorktrees).toHaveBeenLastCalledWith({ root: store, projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental' });
    });

    it('names the branch of the worktree the open chat works in, and goes back to the folder with no chat open', async () => {
        ui().openChat(FIXTURE_WORKSPACE_CHAT_ID);
        await draw('files');

        expect(bar()?.textContent).toBe('clowdy/ab12cd34Manage');

        act(() => ui().openChat(null));
        await settle();
        await settle();

        expect(bar()?.textContent).toBe('car-rental · mainManage');
    });

    it('names the branch of the worktree a new-chat page chose once the page has its row, though no chat works in it', async () => {
        store.dispose();
        store = new RootStore(new FixtureTransport({ data: createFixtureData() }));
        await store.load();
        store.selectProject(FIXTURE_PROJECT_ID);
        ui().openDraft([], null, { mode: 'existing', path: FIXTURE_WORKTREE_PATH });
        await draw('files');

        // The page has not asked for the worktree yet: the place is the folder's own checkout.
        expect(bar()?.textContent).toBe('car-rental · mainManage');

        const opened = await store.command({ type: 'workspace.open', projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental', path: FIXTURE_WORKTREE_PATH });

        if (!opened.ok) throw new Error(opened.error.message);

        act(() => ui().setDraftWorkspaceRow((opened.data as { workspace: ChatWorkspace }).workspace));
        await settle();
        await settle();

        expect(bar()?.textContent).toBe('clowdy/ab12cd34Manage');
    });

    it('is on the Docs tab too, which is the same place', async () => {
        await draw('docs');

        expect(bar()?.textContent).toBe('car-rental · mainManage');
    });

    it('is not there while the chat\'s worktree is not made, whose tab has a note instead', async () => {
        const made = await store.command({ type: 'chat.create', projectId: FIXTURE_PROJECT_ID, workspace: { mode: 'new' } });
        const { chat } = (made as { data: { chat: Chat } }).data;
        const project = store.projectState(FIXTURE_PROJECT_ID)!;

        await vi.waitFor(() => expect(project.chats.get(chat.id)?.workspace?.ready).toBe(false));
        ui().openChat(chat.id);
        await draw('files');

        expect(bar()).toBeNull();
    });
});

describe('a chat whose worktree is not made yet', () => {
    it('shows a note in place of the files and the documents, not an error and not the folder\'s own checkout, and the tree once the worktree is made', async () => {
        const made = await store.command({ type: 'chat.create', projectId: FIXTURE_PROJECT_ID, workspace: { mode: 'new' } });
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
