// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider, SETTINGS_PAGES } from '../../stores';
import { Screen } from './Screen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let store: RootStore;

const draw = () => act(async () => root.render(<RootStoreProvider value={ store }><Screen /></RootStoreProvider>));
const sidebarPages = () => [...container.querySelectorAll('[aria-label="Settings pages"] [role="option"]')].map(item => item.textContent);

beforeEach(async () => {
    store = new RootStore(new FixtureTransport(), { storage: undefined });
    await store.load();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    store.dispose();
});

describe('Settings', () => {
    it('has a sidebar entry for every page the store can show, in the order SETTINGS_PAGES names', async () => {
        await draw();

        expect(sidebarPages()).toEqual(['Appearance', 'Chat', 'Files', 'Shortcuts', 'Projects', 'Providers', 'Skills']);
        expect(sidebarPages()).toHaveLength(SETTINGS_PAGES.length);
    });

    it('shows the Shortcuts page when the store points at it, as `?` does', async () => {
        store.ui.openSettings('shortcuts');
        await draw();

        const page = container.querySelector('section[aria-label="Shortcuts"]');

        expect(page?.querySelector('[role="heading"]')?.textContent).toBe('Shortcuts');
        expect(page?.textContent).toContain('Show keyboard shortcuts');
    });
});
