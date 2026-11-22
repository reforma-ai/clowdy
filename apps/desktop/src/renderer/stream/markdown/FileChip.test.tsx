// @vitest-environment happy-dom
import { installLongPressContextMenu } from '@clowdy/components/Popover';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { kindOnDisk, openInFiles } from '../../features/files/openInFiles';
import { RootStore, RootStoreProvider } from '../../stores';
import { FileChip } from './FileChip';

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock('@clowdy/components/Toast', () => ({ toast: toasts }));
vi.mock('../../features/files/openInFiles', () => ({ openInFiles: vi.fn(async () => true), kindOnDisk: vi.fn(async () => undefined) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The Car Rental project's only folder: a GitHub repository on `main` in the fixture's git.
const FOLDER = { id: 'fld_car_rental', path: '/Users/dev/car-rental' };

let container: HTMLDivElement;
let root: Root;
let store: RootStore;
const writeText = vi.fn(() => Promise.resolve());

const settle = () => act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
});
const draw = async (path: string) => {
    act(() => root.render(<RootStoreProvider value={ store }><FileChip path={ path } /></RootStoreProvider>));
    await settle();
};
const chip = () => container.querySelector('button')!;
const press = () => act(async () => chip().click());
const rightClick = () => act(async () => void chip().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 8 })));
const items = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(row => row.textContent);
const item = (text: string) => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(row => row.textContent === text)!;

beforeEach(async () => {
    writeText.mockClear();
    vi.mocked(openInFiles).mockClear();
    vi.mocked(openInFiles).mockResolvedValue(true);
    vi.mocked(kindOnDisk).mockReset();
    vi.mocked(kindOnDisk).mockResolvedValue(undefined);
    toasts.success.mockClear();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    store = new RootStore(new FixtureTransport());
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
});

describe('FileChip', () => {
    it('shows the name of the file, with the whole path on hover', async () => {
        act(() => root.render(<RootStoreProvider value={ store }><FileChip path="./src/booking/price.ts" lines="12-20" /></RootStoreProvider>));

        expect(chip().textContent).toBe('price.ts (12-20)');
        expect(chip().title).toBe('src/booking/price.ts');
    });

    it('opens the file in the Files tab when it is pressed, and shows no menu', async () => {
        await draw('./src/booking/price.ts');
        await press();

        expect(openInFiles).toHaveBeenCalledExactlyOnceWith(store, FIXTURE_PROJECT_ID, FOLDER, 'src/booking/price.ts');
        expect(items()).toEqual([]);
        expect(writeText).not.toHaveBeenCalled();
    });

    it('opens an absolute path that is in a folder of the project the same way, by its place in the folder', async () => {
        await draw('/Users/dev/car-rental/src/a.ts');
        await press();

        expect(openInFiles).toHaveBeenCalledExactlyOnceWith(store, FIXTURE_PROJECT_ID, FOLDER, 'src/a.ts');
    });

    it('opens the menu of the path where the pointer is when the file is not there to open', async () => {
        vi.mocked(openInFiles).mockResolvedValue(false);
        await draw('src/gone.ts');
        await press();
        await settle();

        expect(items()).toEqual(['Open in Files', 'Open in GitHub', 'Copy path', 'Copy relative path']);
    });

    it('opens the menu on a right-click: Files, GitHub on the branch that is checked out, and the two copies', async () => {
        const open = vi.spyOn(window, 'open').mockReturnValue(null);

        await draw('src/booking/price.ts');
        await rightClick();
        await settle();

        expect(openInFiles).not.toHaveBeenCalled();
        expect(items()).toEqual(['Open in Files', 'Open in GitHub', 'Copy path', 'Copy relative path']);

        await act(async () => item('Open in GitHub').click());

        expect(open).toHaveBeenCalledExactlyOnceWith('https://github.com/acme/car-rental/blob/main/src/booking/price.ts', '_blank', 'noopener');
        open.mockRestore();
    });

    it('opens the menu on a click with ⌘ or Ctrl held, in place of opening the file', async () => {
        await draw('src/booking/price.ts');
        await act(async () => void chip().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true, clientX: 12, clientY: 8, detail: 1 })));
        await settle();

        expect(openInFiles).not.toHaveBeenCalled();
        expect(items()).toEqual(['Open in Files', 'Open in GitHub', 'Copy path', 'Copy relative path']);

        await act(async () => item('Copy path').click());
        await act(async () => void chip().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true, clientX: 12, clientY: 8, detail: 1 })));
        await settle();

        expect(openInFiles).not.toHaveBeenCalled();
        expect(items()).toContain('Copy relative path');
    });

    it('opens the menu on a long touch, and the release does not open the file', async () => {
        await draw('src/booking/price.ts');
        // What the window installs once: a long touch is sent to the chip as a right-click.
        const uninstall = installLongPressContextMenu(document);

        vi.useFakeTimers();

        try {
            const touch = (type: string) => act(() => {
                const event = new Event(type, { bubbles: true, cancelable: true });

                Object.assign(event, { pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: 12, clientY: 8 });
                chip().dispatchEvent(event);
            });

            await touch('pointerdown');
            await act(async () => void vi.advanceTimersByTime(500));
            await touch('pointerup');
        }
        finally {
            vi.useRealTimers();
        }

        // The click that comes with the release is swallowed: the file is not opened.
        await press();
        await settle();

        uninstall();

        expect(openInFiles).not.toHaveBeenCalled();
        expect(items()).toEqual(['Open in Files', 'Open in GitHub', 'Copy path', 'Copy relative path']);
    });

    it('takes a path with no trailing slash for the folder it is on the disk: the page of GitHub is its tree', async () => {
        const open = vi.spyOn(window, 'open').mockReturnValue(null);

        vi.mocked(kindOnDisk).mockResolvedValue('directory');
        await draw('src/booking');
        await rightClick();
        await settle();
        await act(async () => item('Open in GitHub').click());

        expect(kindOnDisk).toHaveBeenCalledExactlyOnceWith(store, FIXTURE_PROJECT_ID, FOLDER, 'src/booking');
        expect(open).toHaveBeenCalledExactlyOnceWith('https://github.com/acme/car-rental/tree/main/src/booking', '_blank', 'noopener');
        open.mockRestore();
    });

    it('keeps a path that the disk says nothing about as a file', async () => {
        const open = vi.spyOn(window, 'open').mockReturnValue(null);

        await draw('src/gone');
        await rightClick();
        await settle();
        await act(async () => item('Open in GitHub').click());

        expect(open).toHaveBeenCalledExactlyOnceWith('https://github.com/acme/car-rental/blob/main/src/gone', '_blank', 'noopener');
        open.mockRestore();
    });

    it('copies the path, absolute or relative, from the menu', async () => {
        await draw('src/booking/price.ts');
        await rightClick();
        await settle();
        await act(async () => item('Copy path').click());

        expect(writeText).toHaveBeenLastCalledWith('/Users/dev/car-rental/src/booking/price.ts');

        await rightClick();
        await settle();
        await act(async () => item('Copy relative path').click());

        expect(writeText).toHaveBeenLastCalledWith('src/booking/price.ts');
    });

    it('offers only the copy of the path for a path in no folder of the project, and opens that menu on a press', async () => {
        await draw('/Users/me/elsewhere/a.ts');
        await press();
        await settle();

        expect(openInFiles).not.toHaveBeenCalled();
        expect(items()).toEqual(['Copy path']);

        await act(async () => item('Copy path').click());

        expect(writeText).toHaveBeenCalledExactlyOnceWith('/Users/me/elsewhere/a.ts');
    });
});
