// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_API_FOLDER, FIXTURE_PROJECT_ID, withFixtureWorktrees } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { openManageWorktrees } from '../worktrees';
import { PlaceBar, placeLabel } from './PlaceBar';

import type { ChatWorkspace, ProjectFolder } from '@clowdy/protocol';
import type { FolderGit } from '../openWith';
import type { Place } from '../sidePanel/currentPlace';

vi.mock('../worktrees', () => ({ openManageWorktrees: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CAR_RENTAL: ProjectFolder = { id: 'fld_car_rental', path: '/Users/dev/car-rental' };
const API: ProjectFolder = { ...FIXTURE_API_FOLDER };
const WORKSPACE: ChatWorkspace = { id: 'wks_ab12cd34', folderId: CAR_RENTAL.id, path: '/Users/dev/Clowdy/workspaces/car-rental/ab12cd34/car-rental', branch: 'clowdy/ab12cd34', managed: true, ready: true };

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
const bar = () => container.querySelector<HTMLElement>('[data-place-bar]');
const place = () => bar()?.querySelector<HTMLButtonElement>('button:not([aria-label])');
const manage = () => bar()?.querySelector<HTMLButtonElement>('button[aria-label="Manage worktrees"]');

async function draw(at: Place, git: FolderGit | undefined) {
    act(() => root.render(<RootStoreProvider value={ store }><PlaceBar place={ at } git={ git } /></RootStoreProvider>));
    await settle();
}

beforeEach(async () => {
    localStorage.clear();
    store = new RootStore(new FixtureTransport({ data: withFixtureWorktrees(createFixtureData()) }));
    await store.load();
    store.selectProject(FIXTURE_PROJECT_ID);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(openManageWorktrees).mockClear();
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    store.dispose();
    localStorage.clear();
});

describe('what the bar names', () => {
    it('is the folder and its branch for the folder\'s own checkout', () => {
        expect(placeLabel({ folder: CAR_RENTAL }, 'car-rental', { branch: 'main' })).toBe('car-rental · main');
    });

    it('is the branch alone for a worktree', () => {
        expect(placeLabel({ folder: CAR_RENTAL, workspace: WORKSPACE }, 'car-rental', { branch: 'clowdy/ab12cd34' })).toBe('clowdy/ab12cd34');
    });

    it('says a detached HEAD is one, in the checkout and in a worktree', () => {
        expect(placeLabel({ folder: CAR_RENTAL }, 'car-rental', { branch: '5c4b3a2', detached: true })).toBe('car-rental · Detached at 5c4b3a2');
        expect(placeLabel({ folder: CAR_RENTAL, workspace: WORKSPACE }, 'car-rental', { branch: '5c4b3a2', detached: true })).toBe('Detached at 5c4b3a2');
    });

    it('names a worktree that is gone from the disk by the branch it was made on', () => {
        expect(placeLabel({ folder: CAR_RENTAL, workspace: WORKSPACE }, 'car-rental', { gone: true })).toBe('clowdy/ab12cd34');
        expect(placeLabel({ folder: CAR_RENTAL, workspace: { ...WORKSPACE, branch: undefined } }, 'car-rental', { gone: true })).toBe('Worktree');
    });

    it('is nothing until git has answered, and nothing for a folder that is no repository', () => {
        expect(placeLabel({ folder: CAR_RENTAL }, 'car-rental', undefined)).toBeUndefined();
        expect(placeLabel({ folder: CAR_RENTAL }, 'car-rental', { remoteUrl: 'git@github.com:acme/car-rental.git' })).toBeUndefined();
        expect(placeLabel({ folder: CAR_RENTAL, workspace: WORKSPACE }, 'car-rental', undefined)).toBeUndefined();
    });
});

describe('the place bar', () => {
    it('names the folder and the branch of the folder\'s own checkout, with a Manage button after it', async () => {
        await draw({ folder: CAR_RENTAL }, { branch: 'main' });

        expect(bar()?.textContent).toBe('car-rental · mainManage');
        expect(place()?.textContent).toBe('car-rental · main');
        expect(manage()?.textContent).toBe('Manage');
    });

    it('opens the dialog on the place\'s folder from the name and from the Manage button', async () => {
        await draw({ folder: CAR_RENTAL }, { branch: 'main' });
        await press(place()!);

        expect(openManageWorktrees).toHaveBeenLastCalledWith({ root: store, projectId: FIXTURE_PROJECT_ID, folderId: CAR_RENTAL.id });

        await press(manage()!);

        expect(openManageWorktrees).toHaveBeenCalledTimes(2);
        expect(openManageWorktrees).toHaveBeenLastCalledWith({ root: store, projectId: FIXTURE_PROJECT_ID, folderId: CAR_RENTAL.id });
    });

    it('leaves the name out of the tab order, so the keyboard stops once at Manage before the file manager', async () => {
        await draw({ folder: CAR_RENTAL }, { branch: 'main' });

        expect(place()?.tabIndex).toBe(-1);
        expect(manage()?.tabIndex).toBe(0);
    });

    it('names the worktree\'s branch alone, and opens the dialog on the worktree\'s folder', async () => {
        await draw({ folder: CAR_RENTAL, workspace: WORKSPACE }, { branch: 'clowdy/ab12cd34' });

        expect(place()?.textContent).toBe('clowdy/ab12cd34');

        await press(manage()!);

        expect(openManageWorktrees).toHaveBeenCalledExactlyOnceWith({ root: store, projectId: FIXTURE_PROJECT_ID, folderId: CAR_RENTAL.id });
    });

    it('is the project\'s other folder\'s own: its short name, its branch, its id', async () => {
        await draw({ folder: API }, { branch: 'feature/payments' });

        expect(place()?.textContent).toBe('car-rental-api · feature/payments');

        await press(place()!);

        expect(openManageWorktrees).toHaveBeenCalledExactlyOnceWith({ root: store, projectId: FIXTURE_PROJECT_ID, folderId: API.id });
    });

    it('is not drawn before git has answered, and not for a folder that is no repository', async () => {
        await draw({ folder: CAR_RENTAL }, undefined);

        expect(bar()).toBeNull();

        await draw({ folder: { id: 'fld_notes', path: '/Users/dev/notes' } }, {});

        expect(bar()).toBeNull();
    });
});
