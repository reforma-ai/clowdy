// @vitest-environment happy-dom
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_PERSONAL_PROJECT_ID, FIXTURE_PROJECT_ID, FIXTURE_WORKSPACE_CHAT_ID, withFixtureWorkspace, type FixtureData, type FixturePullRequestScript } from '../../daemon/fixtureData';
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
// A row's value is what it shows, not the Manage button beside it.
const valueOf = (row: Element | null | undefined) => [...row?.childNodes ?? []].filter(node => !(node instanceof HTMLElement && node.getAttribute('aria-label') === 'Manage worktrees')).map(node => node.textContent).join('');
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

/** Starts the store on the fixtures, with `tweak` having its say about them first. */
async function start(tweak?: (data: FixtureData) => void) {
    const data = withFixtureWorkspace(createFixtureData());

    tweak?.(data);
    store = new RootStore(new FixtureTransport({ data }));
    await store.load();
    store.selectProject(FIXTURE_PROJECT_ID);
}

beforeEach(async () => {
    localStorage.clear();
    vi.mocked(openManageWorktrees).mockClear();
    await start();
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

        expect(rows().slice(0, 3)).toEqual([['Project', 'Car Rental'], ['Folder', '~/car-rental'], ['Branch', 'main']]);
    });

    it('adds the worktree the open chat works in, and the branch the worktree has now', async () => {
        store.ui.forProject(FIXTURE_PROJECT_ID).openChat(FIXTURE_WORKSPACE_CHAT_ID);
        await draw();

        expect(rows().slice(0, 4)).toEqual([['Project', 'Car Rental'], ['Folder', '~/car-rental'], ['Worktree', '~/Clowdy/workspaces/car-rental/ab12cd34/car-rental'], ['Branch', 'clowdy/ab12cd34']]);
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

describe('the git rows of the Info tab', () => {
    it('says what the folder\'s own checkout is compared with and that it is level with it, and has no pull request and no files', async () => {
        await draw();

        expect(rows().slice(3)).toEqual([['Base', 'origin/main'], ['Ahead and behind', 'Even with origin/main']]);
    });

    it('adds the pull request and the size of the work for a chat in a worktree, ahead and behind its base', async () => {
        store.ui.forProject(FIXTURE_PROJECT_ID).openChat(FIXTURE_WORKSPACE_CHAT_ID);
        await draw();

        expect(rows().slice(4)).toEqual([
            ['Base', 'origin/main'],
            ['Ahead and behind', '2 ahead, 1 behind origin/main'],
            ['Pull request', '#128 Open'],
            ['Files changed', '4 files, +102 \u22125'],
        ]);
    });

    it('opens the pull request on GitHub from its row', async () => {
        const open = vi.spyOn(window, 'open').mockReturnValue(null);

        store.ui.forProject(FIXTURE_PROJECT_ID).openChat(FIXTURE_WORKSPACE_CHAT_ID);
        await draw();
        await press(container.querySelector<HTMLButtonElement>('button[aria-label="Open pull request 128 on GitHub"]')!);

        expect(open).toHaveBeenCalledExactlyOnceWith('https://github.com/acme/car-rental/pull/128', '_blank', 'noopener');
        open.mockRestore();
    });

    it.each<[FixturePullRequestScript, string | undefined]>([['draft', '#128 Draft'], ['merged', '#128 Merged'], ['closed', '#128 Closed'], ['none', undefined], ['not_signed_in', undefined], ['no_gh', undefined], ['unavailable', undefined]])('shows the pull request of the %s script as %s', async (script, shown) => {
        // The script of a pull request names its own number in the fixture: the row says the state and the number of that script's pull request.
        await act(() => root.unmount());
        await start((data) => {
            data.pullRequests['/Users/dev/car-rental'] = { worktree: script };
        });
        root = createRoot(container);
        store.ui.forProject(FIXTURE_PROJECT_ID).openChat(FIXTURE_WORKSPACE_CHAT_ID);
        await draw();

        const row = rows().find(([label]) => label === 'Pull request');

        if (shown === undefined) expect(row).toBeUndefined();
        else expect(row?.[1]).toMatch(new RegExp(`^#\\d+ ${ shown.split(' ')[1] }$`));
    });

    it('shows nothing of git for a folder that is no repository', async () => {
        await act(() => root.unmount());
        await start();
        store.selectProject(FIXTURE_PERSONAL_PROJECT_ID);
        root = createRoot(container);
        await draw();

        expect(rows().map(([label]) => label)).toEqual(['Project', 'Folder']);
    });

    it('shows no git row before the first answer has come', async () => {
        act(() => root.render(<RootStoreProvider value={ store }><Info /></RootStoreProvider>));

        expect(rows().map(([label]) => label)).toEqual(['Project', 'Folder']);
    });
});
