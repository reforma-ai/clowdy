// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_PERSONAL_PROJECT_ID, FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { openInFiles } from '../files/openInFiles';
import { openWithPreferences } from '../openWith';
import { openInTerminal } from '../terminal/openInTerminal';
import { ChatFolder } from './ChatFolder';

import type { OpenApps } from '../../../shared/bridge';

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock('@clowdy/components/Toast', () => ({ toast: toasts }));
vi.mock('../files/openInFiles', () => ({ openInFiles: vi.fn(async () => true) }));
vi.mock('../terminal/openInTerminal', () => ({ openInTerminal: vi.fn(async () => true) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const APPS: OpenApps = {
    editors: [{ id: 'cursor', name: 'Cursor' }, { id: 'zed', name: 'Zed' }],
    terminals: [{ id: 'ghostty', name: 'Ghostty' }, { id: 'terminal', name: 'Terminal' }],
    fileManagers: [{ id: 'finder', name: 'Finder' }, { id: 'path-finder', name: 'Path Finder' }],
};

// The Car Rental project's folder: a GitHub repository on `main` in the fixture's git.
const FOLDER = { id: 'fld_car_rental', path: '/Users/dev/car-rental' };

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
const pill = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Folder:"]');
// The rows of the menu itself, and those of its `Open in…` submenu (a menu of its own, once that row is pressed).
const items = () => [...document.body.querySelectorAll<HTMLElement>('[role="menu"][aria-label="Open folder"] [role="menuitem"]')];
const item = (text: string) => items().find(row => row.textContent === text)!;
const outsideItems = () => [...document.body.querySelectorAll<HTMLElement>('[role="menu"][aria-label="Open in"] [role="menuitem"]')];
const outside = (text: string) => outsideItems().find(row => row.textContent === text)!;
const openOutside = () => press(item('Open in…'));

async function draw({ bridge, missing = false, project = FIXTURE_PROJECT_ID, folder = FOLDER }: { bridge?: Partial<NonNullable<Window['desktop']>>; missing?: boolean; project?: string; folder?: typeof FOLDER }) {
    window.desktop = bridge as never;
    store.selectProject(project);
    act(() => root.render(<RootStoreProvider value={ store }><ChatFolder name="web" folder={ folder } missing={ missing } /></RootStoreProvider>));
    await settle();
}

beforeEach(async () => {
    store = new RootStore(new FixtureTransport());
    await store.load();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    openWithPreferences.editor = undefined;
    openWithPreferences.terminal = undefined;
    openWithPreferences.fileManager = undefined;
    toasts.error.mockClear();
    toasts.success.mockClear();
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.desktop = undefined;
    store.dispose();
});

describe('the folder of a chat', () => {
    it('tells the branch that is checked out after its name, and nothing for a folder git does not know', async () => {
        await draw({});

        expect(container.textContent).toBe('webmain');

        await draw({ project: FIXTURE_PERSONAL_PROJECT_ID, folder: { id: 'fld_personal', path: '/Users/dev/Clowdy/Personal' } });

        expect(container.textContent).toBe('web');
    });

    it('is read only outside the desktop app: its name, the path on hover, and nothing to press', async () => {
        await draw({});

        const line = container.querySelector<HTMLElement>('[role="group"][aria-label="Folder"]');

        expect(line?.textContent).toBe('web');
        expect(line?.title).toBe('~/car-rental');
        expect(container.querySelector('button')).toBeNull();
    });

    it('is a pill that opens a menu in the desktop app: the file manager and the editor, the first the computer has until others are picked', async () => {
        await draw({ bridge: { getOpenApps: async () => APPS, openPath: vi.fn(async () => undefined) } });

        expect(pill()?.textContent).toBe('web');
        expect(pill()?.hasAttribute('data-missing')).toBe(false);

        expect(pill()?.hasAttribute('data-open')).toBe(false);

        await press(pill()!);

        // What the app does itself, and the copy, are in the menu; what leaves the app is in the submenu.
        expect(items().map(row => row.textContent)).toEqual(['Open in Files', 'Open in Terminal', 'Copy path', 'Open in…']);
        expect(outsideItems()).toEqual([]);

        await openOutside();

        expect(outsideItems().map(row => row.textContent)).toEqual(['Open in Cursor', 'Open in Finder', 'Open in Ghostty', 'Open in GitHub']);
        // The mark the style turns the chevron over by, and keeps the plate under, while the menu is open.
        expect(pill()?.hasAttribute('data-open')).toBe(true);
    });

    it('opens the folder in the one that is pressed', async () => {
        const openPath = vi.fn(async () => undefined);

        await draw({ bridge: { getOpenApps: async () => APPS, openPath } });
        await press(pill()!);
        await openOutside();
        await press(outside('Open in Cursor'));

        expect(openPath).toHaveBeenCalledExactlyOnceWith(FOLDER.path, { kind: 'editor', id: 'cursor' });

        await press(pill()!);
        await openOutside();
        await press(outside('Open in Finder'));

        expect(openPath).toHaveBeenLastCalledWith(FOLDER.path, { kind: 'fileManager', id: 'finder' });
    });

    it('uses the programs Settings > Files picked', async () => {
        const openPath = vi.fn(async () => undefined);

        openWithPreferences.setEditor('zed');
        openWithPreferences.setTerminal('terminal');
        openWithPreferences.setFileManager('path-finder');
        await draw({ bridge: { getOpenApps: async () => APPS, openPath } });
        await press(pill()!);
        await openOutside();

        expect(outsideItems().map(row => row.textContent)).toEqual(['Open in Zed', 'Open in Path Finder', 'Open in Terminal', 'Open in GitHub']);

        await press(outside('Open in Zed'));

        expect(openPath).toHaveBeenCalledWith(FOLDER.path, { kind: 'editor', id: 'zed' });

        await press(pill()!);
        await openOutside();
        await press(outside('Open in Terminal'));

        expect(openPath).toHaveBeenLastCalledWith(FOLDER.path, { kind: 'terminal', id: 'terminal' });
    });

    it('has no item for an editor or a terminal when the computer has none', async () => {
        await draw({ bridge: { getOpenApps: async () => ({ editors: [], terminals: [], fileManagers: APPS.fileManagers }), openPath: vi.fn(async () => undefined) } });
        await press(pill()!);
        await openOutside();

        expect(items().map(row => row.textContent)).toEqual(['Open in Files', 'Open in Terminal', 'Copy path', 'Open in…']);
        expect(outsideItems().map(row => row.textContent)).toEqual(['Open in Finder', 'Open in GitHub']);
    });

    it('says the folder is gone, and offers nothing to press, when it is missing', async () => {
        const openPath = vi.fn(async () => undefined);

        await draw({ bridge: { getOpenApps: async () => APPS, openPath }, missing: true });
        await press(pill()!);

        expect(pill()?.hasAttribute('data-missing')).toBe(true);
        expect(document.body.textContent).toContain('This folder no longer exists');
        // The built-in ones and the programs need the folder; the copy and the page on GitHub do not.
        expect(items().map(row => row.getAttribute('aria-disabled'))).toEqual(['true', 'true', null, null]);

        await openOutside();

        expect(outsideItems().map(row => row.getAttribute('aria-disabled'))).toEqual(['true', 'true', 'true', null]);

        await press(outside('Open in Finder'));

        expect(openPath).not.toHaveBeenCalled();
    });

    it('draws each program with its own icon, and a plain one of its kind for a program that has none', async () => {
        const icon = 'data:image/png;base64,Y3Vyc29y';

        await draw({ bridge: { getOpenApps: async () => ({ editors: [{ id: 'cursor', name: 'Cursor', icon }], terminals: [{ id: 'terminal', name: 'Terminal' }], fileManagers: [{ id: 'finder', name: 'Finder' }] }), openPath: vi.fn(async () => undefined) } });
        await press(pill()!);
        await openOutside();

        const picture = (text: string) => outside(text).querySelector<HTMLImageElement>('img');

        expect(picture('Open in Cursor')?.getAttribute('src')).toBe(icon);
        expect(picture('Open in Finder')).toBeNull();
        expect(picture('Open in Terminal')).toBeNull();
        expect(outside('Open in Finder').querySelector('svg')).not.toBeNull();
        expect(outside('Open in Terminal').querySelector('svg')).not.toBeNull();
        // The rows the app does itself have a mark of their own, and so does the submenu's.
        expect(item('Open in Terminal').querySelector('svg')).not.toBeNull();
        expect(item('Open in…').querySelector('svg')).not.toBeNull();
    });

    it('tells it in a toast when the program cannot open the folder', async () => {
        await draw({ bridge: { getOpenApps: async () => APPS, openPath: vi.fn(async () => Promise.reject(new Error('gone'))) } });
        await press(pill()!);
        await openOutside();
        await press(outside('Open in Cursor'));

        expect(toasts.error).toHaveBeenCalledWith({ message: 'Couldn\'t open it in Cursor' });
    });

    it('shows the branch in the desktop app too, beside the pill', async () => {
        await draw({ bridge: { getOpenApps: async () => APPS, openPath: vi.fn(async () => undefined) } });

        expect(pill()?.textContent).toBe('web');
        expect(container.textContent).toBe('webmain');
    });

    it('opens the folder in the built-in file manager', async () => {
        await draw({ bridge: { getOpenApps: async () => APPS, openPath: vi.fn(async () => undefined) } });
        await press(pill()!);
        await press(item('Open in Files'));

        expect(openInFiles).toHaveBeenCalledExactlyOnceWith(store, FIXTURE_PROJECT_ID, FOLDER, '');
    });

    it('starts a shell of the Terminal tab in the folder', async () => {
        vi.mocked(openInTerminal).mockClear();
        await draw({ bridge: { getOpenApps: async () => APPS, openPath: vi.fn(async () => undefined) } });
        await press(pill()!);
        await press(item('Open in Terminal'));

        expect(openInTerminal).toHaveBeenCalledExactlyOnceWith(store, FIXTURE_PROJECT_ID, FOLDER, '');
    });

    it('opens the repository on GitHub, in the browser', async () => {
        const open = vi.spyOn(window, 'open').mockReturnValue(null);

        await draw({ bridge: { getOpenApps: async () => APPS, openPath: vi.fn(async () => undefined) } });
        await press(pill()!);
        await openOutside();
        await press(outside('Open in GitHub'));

        expect(open).toHaveBeenCalledExactlyOnceWith('https://github.com/acme/car-rental', '_blank', 'noopener');
        open.mockRestore();
    });

    it('copies the path of the folder', async () => {
        const writeText = vi.fn(async () => undefined);

        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        await draw({ bridge: { getOpenApps: async () => APPS, openPath: vi.fn(async () => undefined) } });
        await press(pill()!);
        await press(item('Copy path'));

        expect(writeText).toHaveBeenCalledExactlyOnceWith(FOLDER.path);
        expect(toasts.success).toHaveBeenCalledWith({ message: 'Path copied' });
    });

    it('has no GitHub item for a folder whose origin is somewhere else, or that has no repository', async () => {
        await draw({ project: FIXTURE_PERSONAL_PROJECT_ID, folder: { id: 'fld_personal', path: '/Users/dev/Clowdy/Personal' }, bridge: { getOpenApps: async () => APPS, openPath: vi.fn(async () => undefined) } });
        await press(pill()!);
        await openOutside();

        expect(outsideItems().map(row => row.textContent)).not.toContain('Open in GitHub');
    });
});
