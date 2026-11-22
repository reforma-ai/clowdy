// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PERSONAL_PROJECT_ID, FIXTURE_PROJECT_ID, FIXTURE_WORKSPACE_CHAT_ID, withFixtureWorkspace } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { openInFiles } from '../files/openInFiles';
import { openWithPreferences } from '../openWith';
import { openInTerminal } from '../terminal/openInTerminal';
import { ChatFolder } from './ChatFolder';

import type { ChatWorkspace, ProjectInfo } from '@clowdy/protocol';
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

async function draw({ bridge, missing = false, project = FIXTURE_PROJECT_ID, folder = FOLDER, workspace }: { bridge?: Partial<NonNullable<Window['desktop']>>; missing?: boolean; project?: string; folder?: typeof FOLDER; workspace?: ChatWorkspace }) {
    window.desktop = bridge as never;
    store.selectProject(project);
    act(() => root.render(<RootStoreProvider value={ store }><ChatFolder name="web" folder={ folder } missing={ missing } workspace={ workspace } /></RootStoreProvider>));
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
    it('tells where the chat works and the branch that is checked out after its name, and no branch for a folder git does not know', async () => {
        await draw({});

        expect(container.textContent).toBe('webProject checkoutmain');

        await draw({ project: FIXTURE_PERSONAL_PROJECT_ID, folder: { id: 'fld_personal', path: '/Users/dev/Clowdy/Personal' } });

        expect(container.textContent).toBe('webProject checkout');
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

    it('offers Locate… for a folder that is gone, which moves the folder where the person picks; no Remove for the only folder of a project, nothing at all for the personal space', async () => {
        const choose = vi.fn(async () => ['/Users/dev/car-rental-moved']);
        const bridge = { getOpenApps: async () => APPS, openPath: vi.fn(async () => undefined), chooseDirectories: choose };

        // The Clowdy project: no agent at work in it, so its main folder can move.
        const clowdy = { id: 'fld_clowdy', path: '/Users/dev/clowdy' };

        await draw({ bridge, missing: true, project: FIXTURE_EMPTY_PROJECT_ID, folder: clowdy });
        await press(pill()!);

        expect(items().map(row => row.textContent)).toEqual(['Locate…', 'Open in Files', 'Open in Terminal', 'Copy path', 'Open in…']);

        await press(item('Locate…'));

        expect(choose).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(store.projects.find(project => project.id === FIXTURE_EMPTY_PROJECT_ID)?.folders).toEqual([{ id: clowdy.id, path: '/Users/dev/car-rental-moved' }]));

        // A folder that is there has no repair.
        await draw({ bridge });
        await press(pill()!);

        expect(items().map(row => row.textContent)).not.toContain('Locate…');

        await draw({ project: FIXTURE_PERSONAL_PROJECT_ID, folder: { id: 'fld_personal', path: '/Users/dev/Clowdy/Personal' }, bridge, missing: true });
        await press(pill()!);

        expect(items().map(row => row.textContent)).not.toContain('Locate…');
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
        expect(container.textContent).toBe('webProject checkoutmain');
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

describe('the folder of a chat that works in a worktree', () => {
    const APP = { getOpenApps: async () => APPS, openPath: vi.fn(async () => undefined) };
    let workspace: ChatWorkspace;

    /** The read of what the daemon knows about the project, with the worktree's entry as the test says. */
    const reads = (entry: ProjectInfo['workspaces']) => {
        const info = vi.spyOn(store.transport, 'getProjectsInfo');

        info.mockImplementation(async () => [{ projectId: FIXTURE_PROJECT_ID, folders: [{ folderId: FOLDER.id, exists: true, remoteUrl: 'git@github.com:acme/car-rental.git', branch: 'main', chats: 0 }], chats: 0, tasks: 0, activeRuns: 0, workspaces: entry }]);

        return info;
    };

    beforeEach(async () => {
        store.dispose();

        const data = withFixtureWorkspace(createFixtureData());

        workspace = data.chats.find(chat => chat.id === FIXTURE_WORKSPACE_CHAT_ID)!.workspace!;
        store = new RootStore(new FixtureTransport({ data }));
        await store.load();
    });

    it('says it is a worktree, with its path on hover, and the branch the tree has checked out now', async () => {
        await draw({ workspace });

        expect(container.textContent).toBe('webWorktreeclowdy/ab12cd34');
        expect(container.querySelector<HTMLElement>('[aria-label="Where it runs: Worktree"]')?.title).toBe('~/Clowdy/workspaces/car-rental/ab12cd34/car-rental');
        expect(container.querySelector('[data-missing]')).toBeNull();
    });

    it('shows the branch the agent switched to, and reads it again when the window gets focus', async () => {
        const info = reads([{ workspaceId: workspace.id, exists: true, branch: 'feature/other' }]);

        await draw({ workspace });

        expect(container.textContent).toBe('webWorktreefeature/other');

        info.mockImplementation(async () => [{ projectId: FIXTURE_PROJECT_ID, folders: [], chats: 0, tasks: 0, activeRuns: 0, workspaces: [{ workspaceId: workspace.id, exists: true, branch: '5c4d3e2', detached: true }] }]);
        act(() => void window.dispatchEvent(new Event('focus')));
        await settle();

        expect(container.textContent).toBe('webWorktree5c4d3e2');
        expect(container.querySelector('[title="Detached HEAD"]')).not.toBeNull();
    });

    it('names no branch until the read has answered, and none that the read does not know once the worktree is made', async () => {
        const never = vi.spyOn(store.transport, 'getProjectsInfo').mockReturnValue(new Promise(() => undefined));

        await draw({ workspace });

        // The name the chat was made with may be out of date by now: it is not shown in its place.
        expect(container.textContent).toBe('webWorktree');

        never.mockRestore();
        reads([]);
        await draw({ workspace: { ...workspace, id: 'wks_other' } });

        expect(container.textContent).toBe('webWorktree');
    });

    it('shows the branch it will be made on while the worktree is not made yet, whatever the read says', async () => {
        reads([]);
        await draw({ workspace: { ...workspace, ready: false } });

        expect(container.textContent).toBe('webWorktreeclowdy/ab12cd34');
    });

    it('reads the branch again when the worktree gets made', async () => {
        const info = reads([{ workspaceId: workspace.id, exists: true, branch: 'feature/other' }]);

        await draw({ workspace: { ...workspace, ready: false } });
        expect(container.textContent).toBe('webWorktreeclowdy/ab12cd34');

        info.mockClear();
        await draw({ workspace });

        expect(info).toHaveBeenCalled();
        expect(container.textContent).toBe('webWorktreefeature/other');
    });

    it('marks the folder as gone when the worktree is no longer on the disk', async () => {
        reads([{ workspaceId: workspace.id, exists: false }]);
        await draw({ workspace, bridge: APP });

        expect(pill()?.hasAttribute('data-missing')).toBe(true);
        expect(container.textContent).toBe('webWorktree');
    });

    it('opens the menu on the worktree, whose path it copies and opens, and offers neither Files nor the Terminal, which show the main checkout', async () => {
        const openPath = vi.fn(async () => undefined);
        const writeText = vi.fn(async () => undefined);

        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        await draw({ workspace, bridge: { getOpenApps: async () => APPS, openPath } });
        await press(pill()!);

        expect(items().map(row => row.textContent)).toEqual(['Copy path', 'Open in…']);

        await press(item('Copy path'));

        expect(writeText).toHaveBeenCalledExactlyOnceWith(workspace.path);

        await press(pill()!);
        await openOutside();
        await press(outside('Open in Cursor'));

        expect(openPath).toHaveBeenCalledExactlyOnceWith(workspace.path, { kind: 'editor', id: 'cursor' });
    });

    it('is read only outside the desktop app, with the worktree\'s path on hover', async () => {
        await draw({ workspace });

        expect(container.querySelector<HTMLElement>('[role="group"][aria-label="Folder"]')?.title).toBe('~/Clowdy/workspaces/car-rental/ab12cd34/car-rental');
        expect(container.querySelector('button')).toBeNull();
    });
});
