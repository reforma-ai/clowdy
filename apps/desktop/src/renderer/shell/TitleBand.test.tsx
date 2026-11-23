// @vitest-environment happy-dom
import { Modal } from '@clowdy/components/Modal';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixtureTransport } from '../daemon/fixtureTransport';
import { openQuickSearch, quickSearchCommands } from '../features/quickSearch';
import { useCommands } from '../hotkeys';
import { RootStore, RootStoreProvider } from '../stores';
import { TitleBand } from './TitleBand';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The title band on the fixture daemon. The test build has no MobX observer plugin, so the band is drawn again by hand after the store changes, as the observer does in the app.
 */

const storage = { getItem: () => null, setItem: () => undefined };

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;

/** The window's part that registers the palette's keys, as `Shell` does, so the button has keys to show. */
function Keyed() {
    useCommands(
        'app',
        quickSearchCommands({ available: () => store.showsProjectScreen, open: tab => openQuickSearch(store, tab) })
    );

    return <TitleBand />;
}

const draw = () =>
    act(async () => {
        reactRoot.render(
            <RootStoreProvider value={store}>
                <Keyed />
            </RootStoreProvider>
        );
    });

const searchButton = () => container.querySelector<HTMLElement>('button[aria-label="Search"]');
const field = () => document.body.querySelector<HTMLInputElement>('input[role="combobox"]');

beforeEach(async () => {
    // The modal animates by itself, whatever the motion setting; a test that ends while it moves leaves a cancelled animation behind.
    const create = Modal.create.bind(Modal);

    vi.spyOn(Modal, 'create').mockImplementation(options => create({ ...options, animate: false }));

    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
    store = new RootStore(new FixtureTransport(), { storage });
    await store.load();
    await vi.waitFor(() => expect(store.showsProjectScreen).toBe(true));
});

afterEach(async () => {
    for (const modal of Modal.opened) await modal.close(false);

    act(() => reactRoot.unmount());
    vi.restoreAllMocks();
    store.dispose();
    document.body.innerHTML = '';
});

describe('the search button of the title band', () => {
    it("shows the palette's keys at its end", async () => {
        await draw();
        // The command is registered in an effect, so the keys are known for the draw after the first.
        await draw();

        expect(searchButton()!.textContent).toContain('Search');
        expect(searchButton()!.querySelector('[data-hotkey]')).not.toBeNull();
    });

    it('opens the palette on its first tab', async () => {
        await draw();
        await act(async () => searchButton()!.click());
        await vi.waitFor(() => expect(field()).not.toBeNull());

        expect(field()!.placeholder).toBe('Search chats, files, documents and the text in them');
    });

    it("is not there while Settings is over the project's screen, and the band keeps its middle", async () => {
        act(() => store.ui.openSettings());
        await draw();

        expect(searchButton()).toBeNull();
        expect(container.querySelector('header')).not.toBeNull();
    });
});
