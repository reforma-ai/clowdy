// @vitest-environment happy-dom
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { openWithPreferences } from '../openWith';
import { FilesPage } from './FilesPage';

import type { OpenApps } from '../../../shared/bridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The babel plugin that makes the app's components observers does not run under Vitest.
const Page = observer(FilesPage);

const APPS: OpenApps = {
    editors: [{ id: 'cursor', name: 'Cursor' }, { id: 'zed', name: 'Zed' }],
    fileManagers: [{ id: 'finder', name: 'Finder' }, { id: 'path-finder', name: 'Path Finder' }],
};

let container: HTMLDivElement;
let root: Root;
let store: RootStore;

const settle = () => act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
});
const press = async (target: HTMLElement) => act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    target.click();
});
/** The buttons that open the two selects, in the order of the rows. */
const triggers = () => [...container.querySelectorAll<HTMLButtonElement>('button')];

async function draw(bridge: Partial<NonNullable<Window['desktop']>> | undefined) {
    window.desktop = bridge as never;
    act(() => root.render(<RootStoreProvider value={ store }><Page /></RootStoreProvider>));
    await settle();
}

beforeEach(async () => {
    store = new RootStore(new FixtureTransport(), { storage: undefined });
    await store.load();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    openWithPreferences.editor = undefined;
    openWithPreferences.fileManager = undefined;
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    store.dispose();
    window.desktop = undefined;
});

describe('FilesPage', () => {
    it('shows the first program of each list until one is picked', async () => {
        await draw({ getOpenApps: async () => APPS });

        expect(container.textContent).toContain('Default IDE');
        expect(container.textContent).toContain('Default file manager');
        expect(triggers().map(button => button.textContent)).toEqual(['Cursor', 'Finder']);
    });

    it('shows the program that was picked, and keeps a pick', async () => {
        await draw({ getOpenApps: async () => APPS });
        await press(triggers()[0]!);

        const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(row => row.textContent === 'Zed')!;

        await press(option);

        expect(openWithPreferences.editor).toBe('zed');
        expect(triggers()[0]!.textContent).toBe('Zed');
        expect(openWithPreferences.fileManager).toBeUndefined();
    });

    it('falls back to the first program when the one that was picked is not installed any more, and keeps the pick', async () => {
        openWithPreferences.setEditor('webstorm');
        await draw({ getOpenApps: async () => APPS });

        expect(triggers()[0]!.textContent).toBe('Cursor');
        expect(openWithPreferences.editor).toBe('webstorm');
    });

    it('is off, and says none were found, for a list that is empty: a computer with no editor', async () => {
        await draw({ getOpenApps: async () => ({ editors: [], fileManagers: [{ id: 'finder', name: 'Finder' }] }) });

        expect(triggers().map(button => [button.textContent, button.disabled])).toEqual([['None found', true], ['Finder', false]]);
    });

    it('finds no program in a page that is not the desktop app', async () => {
        await draw(undefined);

        expect(triggers().map(button => [button.textContent, button.disabled])).toEqual([['None found', true], ['None found', true]]);
    });

    it('reads the computer once when it is opened', async () => {
        const getOpenApps = vi.fn(async () => APPS);

        await draw({ getOpenApps });

        expect(getOpenApps).toHaveBeenCalledOnce();
    });
});
