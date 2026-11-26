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
// A path is a file on the disk unless a test says the disk has nothing there.
vi.mock('../../features/files/openInFiles', () => ({
    openInFiles: vi.fn(async () => true),
    kindOnDisk: vi.fn(async () => 'file'),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The Car Rental project's only folder: a GitHub repository on `main` in the fixture's git.
const FOLDER = { id: 'fld_car_rental', path: '/Users/dev/car-rental' };

let container: HTMLDivElement;
let root: Root;
let store: RootStore;
const writeText = vi.fn(() => Promise.resolve());

const settle = () =>
    act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
const draw = async (path: string) => {
    act(() =>
        root.render(
            <RootStoreProvider value={store}>
                <FileChip path={path} />
            </RootStoreProvider>
        )
    );
    await settle();
};
const chip = () => container.querySelector('button')!;
const press = () => act(async () => chip().click());
const rightClick = () =>
    act(
        async () =>
            void chip().dispatchEvent(
                new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 8 })
            )
    );
const items = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(row => row.textContent);
const item = (text: string) =>
    [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(row => row.textContent === text)!;
// What leaves the app is in a submenu of the menu, opened by pressing its row.
const MENU = ['Open in Files', 'Copy path', 'Copy relative path', 'Open in…'];
const pressRow = (target: HTMLElement) =>
    act(async () => {
        target.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true })
        );
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        target.dispatchEvent(
            new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true })
        );
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        target.click();
    });
const openGitHub = async () => {
    await pressRow(item('Open in…'));
    await pressRow(item('Open in GitHub'));
};

beforeEach(async () => {
    writeText.mockClear();
    vi.mocked(openInFiles).mockClear();
    vi.mocked(openInFiles).mockResolvedValue(true);
    vi.mocked(kindOnDisk).mockReset();
    vi.mocked(kindOnDisk).mockResolvedValue('file');
    toasts.success.mockClear();
    toasts.error.mockClear();
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
    window.desktop = undefined;
});

describe('FileChip', () => {
    it('shows the name of the file, with the whole path on hover', async () => {
        act(() =>
            root.render(
                <RootStoreProvider value={store}>
                    <FileChip path="./src/booking/price.ts" lines="12-20" />
                </RootStoreProvider>
            )
        );

        expect(chip().textContent).toBe('price.ts (12-20)');
        expect(chip().title).toBe('src/booking/price.ts');
    });

    it('opens the file in the Files tab when it is pressed, and shows no menu', async () => {
        await draw('./src/booking/price.ts');
        await press();

        expect(openInFiles).toHaveBeenCalledExactlyOnceWith(
            store,
            FIXTURE_PROJECT_ID,
            { folder: FOLDER },
            'src/booking/price.ts'
        );
        expect(items()).toEqual([]);
        expect(writeText).not.toHaveBeenCalled();
    });

    it('opens an absolute path that is in a folder of the project the same way, by its place in the folder', async () => {
        await draw('/Users/dev/car-rental/src/a.ts');
        await press();

        expect(openInFiles).toHaveBeenCalledExactlyOnceWith(store, FIXTURE_PROJECT_ID, { folder: FOLDER }, 'src/a.ts');
    });

    it('opens the menu of the path where the pointer is when the file is there but cannot be opened', async () => {
        vi.mocked(openInFiles).mockResolvedValue(false);
        await draw('src/unreadable.ts');
        await press();
        await settle();

        expect(items()).toEqual(MENU);
        expect(toasts.error).toHaveBeenCalledWith({ message: 'Couldn’t open this path' });
    });

    it('says the file does not exist, with the copies of its path and nothing else, when the disk has nothing there', async () => {
        vi.mocked(openInFiles).mockResolvedValue(false);
        vi.mocked(kindOnDisk).mockResolvedValue(undefined);
        await draw('src/gone.ts');
        await press();
        await settle();

        expect(document.body.querySelector('[role="menu"] header')?.textContent).toBe("This file doesn't exist");
        expect(items()).toEqual(['Copy path', 'Copy relative path']);

        await act(async () => item('Copy relative path').click());

        expect(writeText).toHaveBeenCalledExactlyOnceWith('src/gone.ts');
    });

    describe('a file that is not where the message wrote it', () => {
        const OPENED = 'apps/web/src/Price.tsx';
        const match = (path: string) => ({ folderId: FOLDER.id, path });
        const search = (...paths: string[]) =>
            vi.spyOn(store.transport, 'getProjectFiles').mockResolvedValue(paths.map(match));
        // Only the file the search found is on the disk: the written path is not.
        const gone = (...found: string[]) =>
            vi
                .mocked(openInFiles)
                .mockImplementation(async (_root, _project, _place, relative) => found.includes(relative));

        it('opens the one file that ends with a bare name on a press, with no menu and no toast', async () => {
            const find = search(OPENED);
            gone(OPENED);
            vi.mocked(kindOnDisk).mockResolvedValue(undefined);
            await draw('Price.tsx');
            await press();
            await settle();

            expect(find).toHaveBeenCalledWith(FIXTURE_PROJECT_ID, 'Price.tsx', 100, undefined);
            expect(openInFiles).toHaveBeenLastCalledWith(store, FIXTURE_PROJECT_ID, { folder: FOLDER }, OPENED);
            expect(items()).toEqual([]);
            expect(toasts.error).not.toHaveBeenCalled();
        });

        it('matches by whole names of folders and lets the case of the name go', async () => {
            search('apps/web/src/Price.tsx', 'apps/web/src/MyPrice.tsx', 'apps/web/src/price.tsx.bak', 'Price.tsx');
            gone('apps/web/src/Price.tsx');
            vi.mocked(kindOnDisk).mockResolvedValue(undefined);
            await draw('src/price.tsx');
            await press();
            await settle();

            expect(openInFiles).toHaveBeenLastCalledWith(store, FIXTURE_PROJECT_ID, { folder: FOLDER }, OPENED);
        });

        it('lists the files on a press when several end with the name, and opens the one that is pressed', async () => {
            search('src/a/index.ts', 'src/b/index.ts');
            gone('src/a/index.ts', 'src/b/index.ts');
            vi.mocked(kindOnDisk).mockResolvedValue(undefined);
            await draw('index.ts');
            await press();
            await settle();

            expect(document.body.querySelector('[role="menu"] header')?.textContent).toBe('Several files match');
            expect(items()).toEqual(['src/a/index.ts', 'src/b/index.ts']);
            expect(toasts.error).not.toHaveBeenCalled();

            await act(async () => item('src/b/index.ts').click());

            expect(openInFiles).toHaveBeenLastCalledWith(
                store,
                FIXTURE_PROJECT_ID,
                { folder: FOLDER },
                'src/b/index.ts'
            );
        });

        it('lists the first ten of a longer list', async () => {
            const many = Array.from({ length: 14 }, (_, index) => `pkg${index}/index.ts`);

            search(...many);
            vi.mocked(kindOnDisk).mockResolvedValue(undefined);
            await draw('index.ts');
            await rightClick();
            await settle();

            expect(items()).toEqual(many.slice(0, 10));
        });

        it('gives the menu of a file to the one file found, on a right-click, with its own path to copy', async () => {
            search(OPENED);
            vi.mocked(kindOnDisk).mockImplementation(async (_root, _project, _place, relative) =>
                relative === OPENED ? 'file' : undefined
            );
            await draw('Price.tsx');
            await rightClick();
            await settle();

            expect(items()).toEqual(MENU);

            await act(async () => item('Copy path').click());

            expect(writeText).toHaveBeenLastCalledWith(`${FOLDER.path}/${OPENED}`);
            expect(writeText).toHaveBeenCalledTimes(1);
        });

        it('says it is looking while the search is out, then that there is no such file when nothing ends with the name', async () => {
            let answer: (paths: Array<{ folderId: string; path: string }>) => void = () => undefined;

            vi.spyOn(store.transport, 'getProjectFiles').mockReturnValue(
                new Promise(resolve => {
                    answer = resolve as typeof answer;
                })
            );
            vi.mocked(kindOnDisk).mockResolvedValue(undefined);
            await draw('Gone.tsx');
            await rightClick();
            await settle();

            expect(document.body.querySelector('[role="menu"] header')?.textContent).toBe('Looking for this file');

            await act(async () => answer([]));
            await settle();

            expect(document.body.querySelector('[role="menu"] header')?.textContent).toBe("This file doesn't exist");
            expect(items()).toEqual(['Copy path', 'Copy relative path']);
        });

        it('says there is no such file when the search fails', async () => {
            vi.spyOn(store.transport, 'getProjectFiles').mockRejectedValue(new Error('no daemon'));
            vi.mocked(openInFiles).mockResolvedValue(false);
            vi.mocked(kindOnDisk).mockResolvedValue(undefined);
            await draw('Gone.tsx');
            await press();
            await settle();

            expect(toasts.error).toHaveBeenCalledWith({ message: 'Couldn’t open this path' });
            expect(document.body.querySelector('[role="menu"] header')?.textContent).toBe("This file doesn't exist");
        });

        it('does not look for a folder, nor in another folder of the project', async () => {
            const find = search(OPENED);

            vi.mocked(openInFiles).mockResolvedValue(false);
            vi.mocked(kindOnDisk).mockResolvedValue(undefined);
            await draw('markdown/');
            await press();
            await settle();

            expect(find).not.toHaveBeenCalled();
            expect(document.body.querySelector('[role="menu"] header')?.textContent).toBe("This folder doesn't exist");
        });

        it('leaves a file found in another folder out', async () => {
            vi.spyOn(store.transport, 'getProjectFiles').mockResolvedValue([
                { folderId: 'fld_other', path: 'src/Price.tsx' },
            ]);
            vi.mocked(openInFiles).mockResolvedValue(false);
            vi.mocked(kindOnDisk).mockResolvedValue(undefined);
            await draw('Price.tsx');
            await press();
            await settle();

            expect(openInFiles).toHaveBeenCalledExactlyOnceWith(
                store,
                FIXTURE_PROJECT_ID,
                { folder: FOLDER },
                'Price.tsx'
            );
            expect(document.body.querySelector('[role="menu"] header')?.textContent).toBe("This file doesn't exist");
        });
    });

    it("says it of a folder too, and keeps no relative copy for the project's own folder", async () => {
        vi.mocked(kindOnDisk).mockResolvedValue(undefined);
        await draw('src/missing/');
        await rightClick();
        await settle();

        expect(document.body.querySelector('[role="menu"] header')?.textContent).toBe("This folder doesn't exist");
        expect(items()).toEqual(['Copy path', 'Copy relative path']);
    });

    it('opens the menu on a right-click: Files, GitHub on the branch that is checked out, and the two copies', async () => {
        const open = vi.spyOn(window, 'open').mockReturnValue(null);

        await draw('src/booking/price.ts');
        await rightClick();
        await settle();

        expect(openInFiles).not.toHaveBeenCalled();
        expect(items()).toEqual(MENU);

        await openGitHub();

        expect(open).toHaveBeenCalledExactlyOnceWith(
            'https://github.com/acme/car-rental/blob/main/src/booking/price.ts',
            '_blank',
            'noopener'
        );
        open.mockRestore();
    });

    it('has Open in Terminal for a folder, and not for a file', async () => {
        vi.mocked(kindOnDisk).mockResolvedValue('directory');
        await draw('src/booking/');
        await rightClick();
        await settle();

        expect(items()).toEqual(['Open in Files', 'Open in Terminal', 'Copy path', 'Copy relative path', 'Open in…']);
    });

    it('opens the menu on a click with ⌘ or Ctrl held, in place of opening the file', async () => {
        await draw('src/booking/price.ts');
        await act(
            async () =>
                void chip().dispatchEvent(
                    new MouseEvent('click', {
                        bubbles: true,
                        cancelable: true,
                        metaKey: true,
                        clientX: 12,
                        clientY: 8,
                        detail: 1,
                    })
                )
        );
        await settle();

        expect(openInFiles).not.toHaveBeenCalled();
        expect(items()).toEqual(MENU);

        await act(async () => item('Copy path').click());
        await act(
            async () =>
                void chip().dispatchEvent(
                    new MouseEvent('click', {
                        bubbles: true,
                        cancelable: true,
                        ctrlKey: true,
                        clientX: 12,
                        clientY: 8,
                        detail: 1,
                    })
                )
        );
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
            const touch = (type: string) =>
                act(() => {
                    const event = new Event(type, { bubbles: true, cancelable: true });

                    Object.assign(event, {
                        pointerType: 'touch',
                        isPrimary: true,
                        pointerId: 1,
                        clientX: 12,
                        clientY: 8,
                    });
                    chip().dispatchEvent(event);
                });

            await touch('pointerdown');
            await act(async () => void vi.advanceTimersByTime(500));
            await touch('pointerup');
        } finally {
            vi.useRealTimers();
        }

        // The click that comes with the release is swallowed: the file is not opened.
        await press();
        await settle();

        uninstall();

        expect(openInFiles).not.toHaveBeenCalled();
        expect(items()).toEqual(MENU);
    });

    it('takes a path with no trailing slash for the folder it is on the disk: the page of GitHub is its tree', async () => {
        const open = vi.spyOn(window, 'open').mockReturnValue(null);

        vi.mocked(kindOnDisk).mockResolvedValue('directory');
        await draw('src/booking');
        await rightClick();
        await settle();
        await openGitHub();

        expect(kindOnDisk).toHaveBeenCalledExactlyOnceWith(
            store,
            FIXTURE_PROJECT_ID,
            { folder: FOLDER },
            'src/booking'
        );
        expect(open).toHaveBeenCalledExactlyOnceWith(
            'https://github.com/acme/car-rental/tree/main/src/booking',
            '_blank',
            'noopener'
        );
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

    describe('in no folder of the project, in the desktop app', () => {
        const openPath = vi.fn(async () => undefined);
        const drawWithApps = async (path: string) => {
            window.desktop = {
                getOpenApps: async () => ({
                    editors: [{ id: 'cursor', name: 'Cursor' }],
                    terminals: [{ id: 'ghostty', name: 'Ghostty' }],
                    fileManagers: [{ id: 'finder', name: 'Finder' }],
                }),
                openPath,
            } as unknown as typeof window.desktop;
            await draw(path);
            await press();
            await settle();
        };
        const submenu = () =>
            [...document.body.querySelectorAll<HTMLElement>('[aria-label="Open in"] [role="menuitem"]')].map(
                row => row.textContent
            );

        beforeEach(() => openPath.mockClear());

        it('shows a file in the file manager, which is what the chip of a file outside the project is for', async () => {
            await drawWithApps('/tmp/qc-shots/inset-panel.png');

            expect(items()).toEqual(['Copy path', 'Open in…']);

            await pressRow(item('Open in…'));

            expect(submenu()).toEqual(['Open in Cursor', 'Show in Finder']);

            await pressRow(item('Show in Finder'));

            expect(openPath).toHaveBeenCalledExactlyOnceWith('/tmp/qc-shots/inset-panel.png', {
                kind: 'fileManager',
                id: 'finder',
            });
            expect(openInFiles).not.toHaveBeenCalled();
        });

        it('opens a folder in the file manager and the terminal program, and has no relative copy or GitHub', async () => {
            await drawWithApps('/tmp/qc-shots/');
            await pressRow(item('Open in…'));

            expect(items().filter(text => text?.startsWith('Copy'))).toEqual(['Copy path']);
            expect(submenu()).toEqual(['Open in Cursor', 'Open in Finder', 'Open in Ghostty']);
        });

        it('has only the copy for a path written from the folder that climbs out of it', async () => {
            await drawWithApps('../elsewhere/a.png');

            expect(items()).toEqual(['Copy path']);
        });
    });
});
