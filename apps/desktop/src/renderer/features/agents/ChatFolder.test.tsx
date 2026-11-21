// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openWithPreferences } from '../openWith';
import { ChatFolder } from './ChatFolder';

import type { OpenApps } from '../../../shared/bridge';

const toasts = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock('@clowdy/components/Toast', () => ({ toast: toasts }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const APPS: OpenApps = {
    editors: [{ id: 'cursor', name: 'Cursor' }, { id: 'zed', name: 'Zed' }],
    fileManagers: [{ id: 'finder', name: 'Finder' }, { id: 'path-finder', name: 'Path Finder' }],
};

let container: HTMLDivElement;
let root: Root;

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
const pill = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Folder:"]');
const items = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const item = (text: string) => items().find(row => row.textContent === text)!;

async function draw({ bridge, missing = false }: { bridge?: Partial<NonNullable<Window['desktop']>>; missing?: boolean }) {
    window.desktop = bridge as never;
    act(() => root.render(<ChatFolder name="web" path="/Users/dev/web" missing={ missing } />));
    await settle();
}

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    openWithPreferences.editor = undefined;
    openWithPreferences.fileManager = undefined;
    toasts.error.mockClear();
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.desktop = undefined;
});

describe('the folder of a chat', () => {
    it('is read only outside the desktop app: its name, the path on hover, and nothing to press', async () => {
        await draw({});

        const line = container.querySelector<HTMLElement>('[role="group"][aria-label="Folder"]');

        expect(line?.textContent).toBe('web');
        expect(line?.title).toBe('/Users/dev/web');
        expect(container.querySelector('button')).toBeNull();
    });

    it('is a pill that opens a menu in the desktop app: the file manager and the editor, the first the computer has until others are picked', async () => {
        await draw({ bridge: { getOpenApps: async () => APPS, openFolder: vi.fn(async () => undefined) } });

        expect(pill()?.textContent).toBe('web');
        expect(pill()?.hasAttribute('data-missing')).toBe(false);

        await press(pill()!);

        expect(items().map(row => row.textContent)).toEqual(['Open in Finder', 'Open in Cursor']);
    });

    it('opens the folder in the one that is pressed', async () => {
        const openFolder = vi.fn(async () => undefined);

        await draw({ bridge: { getOpenApps: async () => APPS, openFolder } });
        await press(pill()!);
        await press(item('Open in Cursor'));

        expect(openFolder).toHaveBeenCalledExactlyOnceWith('/Users/dev/web', { kind: 'editor', id: 'cursor' });

        await press(pill()!);
        await press(item('Open in Finder'));

        expect(openFolder).toHaveBeenLastCalledWith('/Users/dev/web', { kind: 'fileManager', id: 'finder' });
    });

    it('uses the programs Settings > Files picked', async () => {
        const openFolder = vi.fn(async () => undefined);

        openWithPreferences.setEditor('zed');
        openWithPreferences.setFileManager('path-finder');
        await draw({ bridge: { getOpenApps: async () => APPS, openFolder } });
        await press(pill()!);

        expect(items().map(row => row.textContent)).toEqual(['Open in Path Finder', 'Open in Zed']);

        await press(item('Open in Zed'));

        expect(openFolder).toHaveBeenCalledWith('/Users/dev/web', { kind: 'editor', id: 'zed' });
    });

    it('has no item for an editor when the computer has none', async () => {
        await draw({ bridge: { getOpenApps: async () => ({ editors: [], fileManagers: APPS.fileManagers }), openFolder: vi.fn(async () => undefined) } });
        await press(pill()!);

        expect(items().map(row => row.textContent)).toEqual(['Open in Finder']);
    });

    it('says the folder is gone, and offers nothing to press, when it is missing', async () => {
        const openFolder = vi.fn(async () => undefined);

        await draw({ bridge: { getOpenApps: async () => APPS, openFolder }, missing: true });
        await press(pill()!);

        expect(pill()?.hasAttribute('data-missing')).toBe(true);
        expect(document.body.textContent).toContain('This folder no longer exists');
        expect(items().map(row => row.getAttribute('aria-disabled'))).toEqual(['true', 'true']);

        await press(item('Open in Finder'));

        expect(openFolder).not.toHaveBeenCalled();
    });

    it('tells it in a toast when the program cannot open the folder', async () => {
        await draw({ bridge: { getOpenApps: async () => APPS, openFolder: vi.fn(async () => Promise.reject(new Error('gone'))) } });
        await press(pill()!);
        await press(item('Open in Cursor'));

        expect(toasts.error).toHaveBeenCalledWith({ message: 'Couldn\'t open the folder in Cursor' });
    });
});
