// @vitest-environment happy-dom
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID, FIXTURE_WORKSPACE_CHAT_ID, withFixtureWorkspace } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { InfoTab } from './InfoTab';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The babel plugin that makes the app's components observers does not run under Vitest.
const Info = observer(InfoTab);

let container: HTMLDivElement;
let root: Root;
let store: RootStore;

const settle = () => act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
});
const rows = () => [...container.querySelectorAll('dt')].map(label => [label.textContent, label.parentElement?.querySelector('dd')?.textContent]);

async function draw() {
    act(() => root.render(<RootStoreProvider value={ store }><Info /></RootStoreProvider>));
    await settle();
    await settle();
}

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
});
