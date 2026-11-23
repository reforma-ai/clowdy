// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_NOTES_FOLDER,
    FIXTURE_PERSONAL_PROJECT_ID,
    FIXTURE_PROJECT_ID,
    withFixtureWorktrees,
} from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { openManageWorktrees } from '../worktrees';
import { GroupFolderName } from './GroupFolderName';

import type { ProjectFolder } from '@clowdy/protocol';
import type { OpenApps } from '../../../shared/bridge';

vi.mock('../worktrees', () => ({ openManageWorktrees: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const APPS: OpenApps = {
    editors: [{ id: 'cursor', name: 'Cursor' }],
    terminals: [],
    fileManagers: [{ id: 'finder', name: 'Finder' }],
};

// The folders of Car Rental in the fixture: a GitHub repository on `main` (and a second one on `feature/payments`), and a folder that is no repository.
const CAR_RENTAL: ProjectFolder = { id: 'fld_car_rental', path: '/Users/dev/car-rental' };
const API: ProjectFolder = { id: 'fld_api', path: '/Users/dev/car-rental-api' };

let container: HTMLDivElement;
let root: Root;
let store: RootStore;

const settle = () =>
    act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
const press = async (target: HTMLElement) =>
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
const name = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Folder:"]')!;
const items = () => [
    ...document.body.querySelectorAll<HTMLElement>('[role="menu"][aria-label="Open folder"] [role="menuitem"]'),
];

async function draw(folder: ProjectFolder, project = FIXTURE_PROJECT_ID, missing = false) {
    window.desktop = { getOpenApps: async () => APPS, openPath: vi.fn(async () => undefined) } as never;
    store.selectProject(project);
    act(() =>
        root.render(
            <RootStoreProvider value={store}>
                <GroupFolderName name={folder.path.split('/').pop()!} folder={folder} missing={missing} />
            </RootStoreProvider>
        )
    );
    await settle();
    await press(name());
    await settle();
}

beforeEach(async () => {
    localStorage.clear();
    store = new RootStore(new FixtureTransport({ data: withFixtureWorktrees(createFixtureData()) }));
    await store.load();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(openManageWorktrees).mockClear();
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    window.desktop = undefined;
    store.dispose();
    localStorage.clear();
});

describe("the menu of a folder group's title", () => {
    it('has Manage worktrees last, under a separator, and opens the dialog on that folder', async () => {
        await draw(API);

        // After the folder's own items, whatever those are (Open in Files and Terminal come with the window's place being the folder, which the list sets as the menu opens).
        expect(items().map(row => row.textContent)).toEqual(['Copy path', 'Open in…', 'Manage worktrees…']);
        // A separator stands right before it: the last one in the menu comes before the item.
        const separators = [
            ...document.body.querySelectorAll('[role="menu"][aria-label="Open folder"] [role="separator"]'),
        ];

        expect(
            separators.at(-1)!.compareDocumentPosition(items().at(-1)!) & Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();

        await press(items().at(-1)!);

        expect(openManageWorktrees).toHaveBeenCalledExactlyOnceWith({
            root: store,
            projectId: FIXTURE_PROJECT_ID,
            folderId: API.id,
        });
    });

    it('names the main folder the same way, by its own id', async () => {
        await draw(CAR_RENTAL);
        await press(items().find(row => row.textContent === 'Manage worktrees…')!);

        expect(openManageWorktrees).toHaveBeenCalledExactlyOnceWith({
            root: store,
            projectId: FIXTURE_PROJECT_ID,
            folderId: CAR_RENTAL.id,
        });
    });

    it("has the item in the menu's first frame, before the folder's git has answered, so the menu does not change as it opens", async () => {
        window.desktop = { getOpenApps: async () => APPS, openPath: vi.fn(async () => undefined) } as never;
        store.selectProject(FIXTURE_PROJECT_ID);
        act(() =>
            root.render(
                <RootStoreProvider value={store}>
                    <GroupFolderName name="car-rental-api" folder={API} missing={false} />
                </RootStoreProvider>
            )
        );
        // No wait for anything: the press opens the menu, and the item is in it at once.
        act(() => void name().click());

        expect(items().map(row => row.textContent)).toContain('Manage worktrees…');
    });

    it("has it for a folder that is no repository too, since the dialog is the project's and says when none of its folders is one", async () => {
        await draw({ ...FIXTURE_NOTES_FOLDER });

        expect(items().map(row => row.textContent)).toEqual(['Copy path', 'Open in…', 'Manage worktrees…']);
    });

    it('has it for a folder that is gone from the disk, under the note and the repair, and for the personal space', async () => {
        await draw(API, FIXTURE_PROJECT_ID, true);

        expect(items().at(-1)!.textContent).toBe('Manage worktrees…');
        expect(document.body.textContent).toContain('This folder no longer exists');
    });
});
