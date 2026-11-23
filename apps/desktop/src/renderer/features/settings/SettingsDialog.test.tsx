// @vitest-environment happy-dom
import { Modal } from '@clowdy/components/Modal';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { SettingsDialog } from './SettingsDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let store: RootStore;

// The window draws on the next animation frame, its content mounts a little later, and it opens and closes in 0.2 s and 0.15 s: it is let finish, as a window that is
// taken down in the middle of that rejects its animation.
const settle = () =>
    act(async () => {
        await new Promise(resolve => setTimeout(resolve, 300));
    });
// The observer plugin of the app does not run under Vitest: the dialog follows `settingsOpen` through a store that is read when the tree renders again.
const draw = async () => {
    act(() =>
        root.render(
            <RootStoreProvider value={store}>
                <SettingsDialog />
            </RootStoreProvider>
        )
    );
    await settle();
};
const windowEl = () => document.querySelector('[data-modal-window]');
const pages = () =>
    [...document.querySelectorAll('[data-modal-window] [aria-label="Settings pages"] [role="option"]')].map(
        item => item.textContent
    );

beforeEach(async () => {
    store = new RootStore(new FixtureTransport(), { storage: undefined });
    await store.load();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(async () => {
    act(() => root.unmount());

    for (const modal of Modal.opened) await modal.close(false);

    container.remove();
    store.dispose();
});

describe('the Settings window', () => {
    it('is not there while Settings is shut, and is a window over the app with the pages of Settings once it is open', async () => {
        await draw();

        expect(windowEl()).toBeNull();

        act(() => store.ui.openSettings('shortcuts'));
        await draw();

        expect(windowEl()).not.toBeNull();
        expect(pages()).toEqual([
            'Appearance',
            'Chat',
            'Files',
            'Shortcuts',
            'Projects',
            'Providers',
            'Skills',
            'About',
        ]);
        expect(windowEl()?.querySelector('nav [aria-current="page"]')?.textContent).toBe('Shortcuts');
    });

    it('goes when Settings is shut from the store', async () => {
        act(() => store.ui.openSettings());
        await draw();

        expect(windowEl()).not.toBeNull();

        act(() => store.ui.closeSettings());
        await draw();
        await settle();

        expect(windowEl()).toBeNull();
    });

    it('shuts Settings in the store when the window is closed with Esc, and again opens on the page it was left on', async () => {
        act(() => store.ui.openSettings('skills'));
        await draw();

        // The window keeps the focus on its overlay, which is where the key goes.
        await act(async () => {
            document
                .querySelector('[data-modal-overlay]')!
                .dispatchEvent(
                    new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })
                );
        });
        await settle();

        expect(store.ui.settingsOpen).toBe(false);
        expect(store.ui.settingsPage).toBe('skills');
    });
});
