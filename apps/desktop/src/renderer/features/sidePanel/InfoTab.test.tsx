// @vitest-environment happy-dom
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID, FIXTURE_WORKSPACE_CHAT_ID, withFixtureWorkspace } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { openManageWorktrees } from '../worktrees';
import { InfoTab } from './InfoTab';

vi.mock('../worktrees', () => ({ openManageWorktrees: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The babel plugin that makes the app's components observers does not run under Vitest.
const Info = observer(InfoTab);

let container: HTMLDivElement;
let root: Root;
let store: RootStore;

const settle = () => act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
});
// A row's value is what it shows, not the buttons beside it.
const valueOf = (row: Element | null | undefined) => [...row?.childNodes ?? []].filter(node => !(node instanceof HTMLElement && node.tagName === 'BUTTON')).map(node => node.textContent).join('');
const rows = () => [...container.querySelectorAll('dt')].map(label => [label.textContent, valueOf(label.parentElement?.querySelector('dd'))]);
const press = (target: HTMLElement) => act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    target.click();
});
const manage = () => container.querySelector<HTMLButtonElement>('button[aria-label="Manage worktrees"]');

async function draw() {
    act(() => root.render(<RootStoreProvider value={ store }><Info /></RootStoreProvider>));
    await settle();
    await settle();
}

beforeEach(async () => {
    localStorage.clear();
    vi.mocked(openManageWorktrees).mockClear();
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
    store.dispose();
    localStorage.clear();
});

describe('the Info tab', () => {
    it('names the project, its folder and the branch the folder has checked out', async () => {
        await draw();

        expect(rows()).toEqual([['Project', 'Car Rental'], ['Folder', '~/car-rental'], ['Branch', 'main']]);
    });

    it('adds the worktree the open chat works in, and the branch the worktree has now', async () => {
        store.ui.forProject(FIXTURE_PROJECT_ID).openChat(FIXTURE_WORKSPACE_CHAT_ID);
        await draw();

        expect(rows()).toEqual([['Project', 'Car Rental'], ['Folder', '~/car-rental'], ['Worktree', '~/Clowdy/workspaces/car-rental/ab12cd34/car-rental'], ['Branch', 'clowdy/ab12cd34']]);
    });

    it('has a Manage button in the Worktree row that opens the dialog on the worktree\'s folder', async () => {
        store.ui.forProject(FIXTURE_PROJECT_ID).openChat(FIXTURE_WORKSPACE_CHAT_ID);
        await draw();

        expect(manage()?.closest('dd')?.previousElementSibling?.textContent).toBe('Worktree');

        await press(manage()!);

        expect(openManageWorktrees).toHaveBeenCalledExactlyOnceWith({ root: store, projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental' });
    });

    it('has no Manage button for a chat in the folder\'s own checkout, which has no Worktree row', async () => {
        await draw();

        expect(manage()).toBeNull();
    });
});
