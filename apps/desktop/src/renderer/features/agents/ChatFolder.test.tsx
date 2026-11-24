// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_EMPTY_PROJECT_ID,
    FIXTURE_PERSONAL_PROJECT_ID,
    FIXTURE_PROJECT_ID,
    FIXTURE_WORKSPACE_CHAT_ID,
    withFixtureWorkspace,
} from '../../daemon/fixtureData';
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
    editors: [
        { id: 'cursor', name: 'Cursor' },
        { id: 'zed', name: 'Zed' },
    ],
    terminals: [
        { id: 'ghostty', name: 'Ghostty' },
        { id: 'terminal', name: 'Terminal' },
    ],
    fileManagers: [
        { id: 'finder', name: 'Finder' },
        { id: 'path-finder', name: 'Path Finder' },
    ],
};

// The Car Rental project's folder: a GitHub repository on `main` in the fixture's git.
const FOLDER = { id: 'fld_car_rental', path: '/Users/dev/car-rental' };

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
const pill = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Current place:"]');
// The rows of the menu itself, and those of its `Open in…` submenu (a menu of its own, once that row is pressed).
const items = () => [
    ...document.body.querySelectorAll<HTMLElement>(
        ':is([role="menu"][aria-label="Open folder"], [role="menu"][aria-label="Worktree actions"]) [role="menuitem"]'
    ),
];
const item = (text: string) => items().find(row => row.textContent === text)!;
const outsideItems = () => [
    ...document.body.querySelectorAll<HTMLElement>('[role="menu"][aria-label="Open in"] [role="menuitem"]'),
];
const outside = (text: string) => outsideItems().find(row => row.textContent === text)!;
const openOutside = () => press(item('Open in…'));

async function draw({
    bridge,
    missing = false,
    project = FIXTURE_PROJECT_ID,
    folder = FOLDER,
    workspace,
    showFolder = true,
}: {
    bridge?: Partial<NonNullable<Window['desktop']>>;
    missing?: boolean;
    project?: string;
    folder?: typeof FOLDER;
    workspace?: ChatWorkspace;
    showFolder?: boolean;
}) {
    window.desktop = bridge as never;
    store.selectProject(project);
    act(() =>
        root.render(
            <RootStoreProvider value={store}>
                <ChatFolder
                    name="web"
                    folder={folder}
                    missing={missing}
                    workspace={workspace}
                    showFolder={showFolder}
                />
            </RootStoreProvider>
        )
    );
    await settle();
}

beforeEach(async () => {
    // Which chat is open is kept in the browser's storage and comes back with the store: a test starts with none.
    localStorage.clear();
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
    it('tells the branch that is checked out after its name, as one label with no word for the mode, and nothing for a folder git does not know', async () => {
        await draw({});

        expect(container.textContent).toBe('web · main');

        const label = container.querySelector<HTMLElement>('[aria-label="Current place: web, branch main"]');

        // The git mark and the branch, in one label that says on hover and to a screen reader where it runs.
        expect(label?.textContent).toBe('web · main');
        expect(label?.title).toBe('~/car-rental');
        expect(label?.querySelector('svg')).not.toBeNull();

        await draw({
            project: FIXTURE_PERSONAL_PROJECT_ID,
            folder: { id: 'fld_personal', path: '/Users/dev/Clowdy/Personal' },
        });

        expect(container.textContent).toBe('web');
        expect(container.querySelector('[aria-label="Current place: web"]')).not.toBeNull();
    });

    it('omits the folder for one folder and names a non-git folder', async () => {
        await draw({ showFolder: false });
        expect(container.textContent).toBe('main');
        expect(container.querySelector('[aria-label="Current place: branch main"]')).not.toBeNull();
        await draw({
            project: FIXTURE_PERSONAL_PROJECT_ID,
            folder: { id: 'fld_personal', path: '/Users/dev/Clowdy/Personal' },
            showFolder: false,
        });
        expect(container.textContent).toBe('web');
    });

    it('says the short hash of a detached HEAD in place of a branch, and so on hover', async () => {
        vi.spyOn(store.transport, 'getProjectsInfo').mockImplementation(async () => [
            {
                projectId: FIXTURE_PROJECT_ID,
                folders: [
                    {
                        folderId: FOLDER.id,
                        exists: true,
                        remoteUrl: undefined,
                        branch: '5c4d3e2',
                        detached: true,
                        chats: 0,
                    },
                ],
                chats: 0,
                tasks: 0,
                activeRuns: 0,
            },
        ]);
        await draw({});

        expect(container.textContent).toBe('web · 5c4d3e2');
        expect(
            container.querySelector<HTMLElement>('[aria-label="Current place: web, detached at 5c4d3e2"]')?.title
        ).toBe('~/car-rental\nDetached HEAD');
    });

    it('is read only outside the desktop app: its name, the path on hover, and nothing to press', async () => {
        await draw({});

        const line = container.querySelector<HTMLElement>('[role="group"][aria-label^="Current place:"]');

        expect(line?.textContent).toBe('web · main');
        expect(line?.title).toBe('~/car-rental');
        expect(container.querySelector('button')).toBeNull();
    });

    it('is a pill that opens a menu in the desktop app: the file manager and the editor, the first the computer has until others are picked', async () => {
        await draw({ bridge: { getOpenApps: async () => APPS, openPath: vi.fn(async () => undefined) } });

        expect(pill()?.textContent).toBe('webmain');
        expect(pill()?.hasAttribute('data-missing')).toBe(false);

        expect(pill()?.hasAttribute('data-open')).toBe(false);

        await press(pill()!);

        // What the app does itself, and the copy, are in the menu; what leaves the app is in the submenu.
        expect(items().map(row => row.textContent)).toEqual([
            'New chat',
            'Open in Files',
            'Open in Terminal',
            'Copy path',
            'Open in…',
        ]);
        expect(outsideItems()).toEqual([]);

        await openOutside();

        expect(outsideItems().map(row => row.textContent)).toEqual([
            'Open in Cursor',
            'Open in Finder',
            'Open in Ghostty',
            'Open in GitHub',
        ]);
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

        expect(outsideItems().map(row => row.textContent)).toEqual([
            'Open in Zed',
            'Open in Path Finder',
            'Open in Terminal',
            'Open in GitHub',
        ]);

        await press(outside('Open in Zed'));

        expect(openPath).toHaveBeenCalledWith(FOLDER.path, { kind: 'editor', id: 'zed' });

        await press(pill()!);
        await openOutside();
        await press(outside('Open in Terminal'));

        expect(openPath).toHaveBeenLastCalledWith(FOLDER.path, { kind: 'terminal', id: 'terminal' });
    });

    it('has no item for an editor or a terminal when the computer has none', async () => {
        await draw({
            bridge: {
                getOpenApps: async () => ({ editors: [], terminals: [], fileManagers: APPS.fileManagers }),
                openPath: vi.fn(async () => undefined),
            },
        });
        await press(pill()!);
        await openOutside();

        expect(items().map(row => row.textContent)).toEqual([
            'New chat',
            'Open in Files',
            'Open in Terminal',
            'Copy path',
            'Open in…',
        ]);
        expect(outsideItems().map(row => row.textContent)).toEqual(['Open in Finder', 'Open in GitHub']);
    });

    it('says the folder is gone, and offers nothing to press, when it is missing', async () => {
        const openPath = vi.fn(async () => undefined);

        await draw({ bridge: { getOpenApps: async () => APPS, openPath }, missing: true });
        await press(pill()!);

        expect(pill()?.hasAttribute('data-missing')).toBe(true);
        expect(document.body.textContent).toContain('This folder no longer exists');
        // The built-in ones and the programs need the folder; the copy and the page on GitHub do not.
        expect(items().map(row => row.getAttribute('aria-disabled'))).toEqual(['true', 'true', 'true', null, null]);

        await openOutside();

        expect(outsideItems().map(row => row.getAttribute('aria-disabled'))).toEqual(['true', 'true', 'true', null]);

        await press(outside('Open in Finder'));

        expect(openPath).not.toHaveBeenCalled();
    });

    it('offers Locate… for a folder that is gone, which moves the folder where the person picks; no Remove for the only folder of a project, nothing at all for the personal space', async () => {
        const choose = vi.fn(async () => ['/Users/dev/car-rental-moved']);
        const bridge = {
            getOpenApps: async () => APPS,
            openPath: vi.fn(async () => undefined),
            chooseDirectories: choose,
        };

        // The Clowdy project: no agent at work in it, so its main folder can move.
        const clowdy = { id: 'fld_clowdy', path: '/Users/dev/clowdy' };

        await draw({ bridge, missing: true, project: FIXTURE_EMPTY_PROJECT_ID, folder: clowdy });
        await press(pill()!);

        expect(items().map(row => row.textContent)).toEqual([
            'Locate…',
            'New chat',
            'Open in Files',
            'Open in Terminal',
            'Copy path',
            'Open in…',
        ]);

        await press(item('Locate…'));

        expect(choose).toHaveBeenCalledOnce();
        await vi.waitFor(() =>
            expect(store.projects.find(project => project.id === FIXTURE_EMPTY_PROJECT_ID)?.folders).toEqual([
                { id: clowdy.id, path: '/Users/dev/car-rental-moved' },
            ])
        );

        // A folder that is there has no repair.
        await draw({ bridge });
        await press(pill()!);

        expect(items().map(row => row.textContent)).not.toContain('Locate…');

        await draw({
            project: FIXTURE_PERSONAL_PROJECT_ID,
            folder: { id: 'fld_personal', path: '/Users/dev/Clowdy/Personal' },
            bridge,
            missing: true,
        });
        await press(pill()!);

        expect(items().map(row => row.textContent)).not.toContain('Locate…');
    });

    it('draws each program with its own icon, and a plain one of its kind for a program that has none', async () => {
        const icon = 'data:image/png;base64,Y3Vyc29y';

        await draw({
            bridge: {
                getOpenApps: async () => ({
                    editors: [{ id: 'cursor', name: 'Cursor', icon }],
                    terminals: [{ id: 'terminal', name: 'Terminal' }],
                    fileManagers: [{ id: 'finder', name: 'Finder' }],
                }),
                openPath: vi.fn(async () => undefined),
            },
        });
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
        await draw({
            bridge: { getOpenApps: async () => APPS, openPath: vi.fn(async () => Promise.reject(new Error('gone'))) },
        });
        await press(pill()!);
        await openOutside();
        await press(outside('Open in Cursor'));

        expect(toasts.error).toHaveBeenCalledWith({ message: "Couldn't open it in Cursor" });
    });

    it('shows the branch in the desktop app too, beside the pill', async () => {
        await draw({ bridge: { getOpenApps: async () => APPS, openPath: vi.fn(async () => undefined) } });

        expect(pill()?.textContent).toBe('webmain');
        expect(container.textContent).toBe('webmain');
    });

    it('opens the folder in the built-in file manager', async () => {
        await draw({ bridge: { getOpenApps: async () => APPS, openPath: vi.fn(async () => undefined) } });
        await press(pill()!);
        await press(item('Open in Files'));

        expect(openInFiles).toHaveBeenCalledExactlyOnceWith(store, FIXTURE_PROJECT_ID, { folder: FOLDER }, '');
    });

    it('starts a shell of the Terminal tab in the folder', async () => {
        vi.mocked(openInTerminal).mockClear();
        await draw({ bridge: { getOpenApps: async () => APPS, openPath: vi.fn(async () => undefined) } });
        await press(pill()!);
        await press(item('Open in Terminal'));

        expect(openInTerminal).toHaveBeenCalledExactlyOnceWith(store, FIXTURE_PROJECT_ID, { folder: FOLDER }, '');
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
        await draw({
            project: FIXTURE_PERSONAL_PROJECT_ID,
            folder: { id: 'fld_personal', path: '/Users/dev/Clowdy/Personal' },
            bridge: { getOpenApps: async () => APPS, openPath: vi.fn(async () => undefined) },
        });
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

        info.mockImplementation(async () => [
            {
                projectId: FIXTURE_PROJECT_ID,
                folders: [
                    {
                        folderId: FOLDER.id,
                        exists: true,
                        remoteUrl: 'git@github.com:acme/car-rental.git',
                        branch: 'main',
                        chats: 0,
                    },
                ],
                chats: 0,
                tasks: 0,
                activeRuns: 0,
                workspaces: entry,
            },
        ]);

        return info;
    };

    beforeEach(async () => {
        store.dispose();
        localStorage.clear();

        const data = withFixtureWorkspace(createFixtureData());

        workspace = data.chats.find(chat => chat.id === FIXTURE_WORKSPACE_CHAT_ID)!.workspace!;
        store = new RootStore(new FixtureTransport({ data }));
        await store.load();
    });

    it('says it is a worktree, with its path on hover, and the branch the tree has checked out now', async () => {
        await draw({ workspace });

        expect(container.textContent).toBe('web · Worktree clowdy/ab12cd34');

        const label = container.querySelector<HTMLElement>(
            '[aria-label="Current place: web, Worktree, branch clowdy/ab12cd34"]'
        );

        expect(label?.textContent).toBe('web · Worktree clowdy/ab12cd34');
        expect(label?.title).toBe('~/Clowdy/workspaces/car-rental/ab12cd34/car-rental');
        expect(container.querySelector('[data-missing]')).toBeNull();
    });

    it('shows the branch the agent switched to, and reads it again when the window gets focus', async () => {
        const info = reads([{ workspaceId: workspace.id, exists: true, branch: 'feature/other' }]);

        await draw({ workspace });

        expect(container.textContent).toBe('web · Worktree feature/other');

        info.mockImplementation(async () => [
            {
                projectId: FIXTURE_PROJECT_ID,
                folders: [],
                chats: 0,
                tasks: 0,
                activeRuns: 0,
                workspaces: [{ workspaceId: workspace.id, exists: true, branch: '5c4d3e2', detached: true }],
            },
        ]);
        act(() => void window.dispatchEvent(new Event('focus')));
        await settle();

        expect(container.textContent).toBe('web · Worktree 5c4d3e2');
        // The hash stands in a branch's place, and the label says it is a commit: on hover with the worktree's path, and to a screen reader.
        expect(
            container.querySelector<HTMLElement>('[aria-label="Current place: web, Worktree, detached at 5c4d3e2"]')
                ?.title
        ).toMatch(/\nDetached HEAD$/);
    });

    it('names no branch until the read has answered, and none that the read does not know once the worktree is made', async () => {
        const never = vi.spyOn(store.transport, 'getProjectsInfo').mockReturnValue(new Promise(() => undefined));

        await draw({ workspace });

        // The name the chat was made with may be out of date by now: it is not shown in its place.
        expect(container.textContent).toBe('web · Worktree');

        never.mockRestore();
        reads([]);
        await draw({ workspace: { ...workspace, id: 'wks_other' } });

        expect(container.textContent).toBe('web · Worktree');
    });

    it('shows the worktree prefix in the same muted style as the new-chat selector', async () => {
        await draw({ workspace, bridge: APP, showFolder: false });

        const parts = [...pill()!.querySelectorAll<HTMLElement>('span')];
        const prefix = parts.find(part => part.textContent === 'Worktree')!;
        const branch = parts.find(part => part.textContent === 'clowdy/ab12cd34')!;

        expect(prefix.className).toContain('color-secondary-muted-text');
        expect(branch.className).not.toContain('color-secondary-muted-text');
    });

    it('does not add an empty label when the worktree branch is unknown', async () => {
        reads([]);
        await draw({ workspace: { ...workspace, id: 'wks_other' }, bridge: APP, showFolder: false });

        const content = pill()!.querySelector('[class*="triggerContent"]')!;
        expect([...content.children].map(child => child.textContent)).toEqual(['', 'Worktree', '']);
    });

    it('shows the branch it will be made on while the worktree is not made yet, whatever the read says', async () => {
        reads([]);
        await draw({ workspace: { ...workspace, ready: false } });

        expect(container.textContent).toBe('web · Worktree clowdy/ab12cd34');
    });

    it('reads the branch again when the worktree gets made', async () => {
        const info = reads([{ workspaceId: workspace.id, exists: true, branch: 'feature/other' }]);

        await draw({ workspace: { ...workspace, ready: false } });
        expect(container.textContent).toBe('web · Worktree clowdy/ab12cd34');

        info.mockClear();
        await draw({ workspace });

        expect(info).toHaveBeenCalled();
        expect(container.textContent).toBe('web · Worktree feature/other');
    });

    it('marks the folder as gone when the worktree is no longer on the disk', async () => {
        reads([{ workspaceId: workspace.id, exists: false }]);
        await draw({ workspace, bridge: APP });

        expect(pill()?.hasAttribute('data-missing')).toBe(true);
<<<<<<< HEAD
        expect(container.textContent).toBe('webWorktree');
=======
        expect(container.textContent).toBe('web · Worktree');
        await press(pill()!);
        expect(document.body.textContent).toContain('This worktree no longer exists');
        expect(item('New chat').getAttribute('aria-disabled')).toBe('true');
>>>>>>> origin/main
    });

    it('opens the menu on the worktree, whose path it copies and opens', async () => {
        const openPath = vi.fn(async () => undefined);
        const writeText = vi.fn(async () => undefined);

        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        await draw({ workspace, bridge: { getOpenApps: async () => APPS, openPath } });
        await press(pill()!);
        await press(item('Copy path'));

        expect(writeText).toHaveBeenCalledExactlyOnceWith(workspace.path);

        await press(pill()!);
        await openOutside();
        await press(outside('Open in Cursor'));

        expect(openPath).toHaveBeenCalledExactlyOnceWith(workspace.path, { kind: 'editor', id: 'cursor' });
    });

    it('opens a new chat in the worktree from the same chip that shows its branch', async () => {
        await draw({ workspace, bridge: APP });

        expect(container.querySelectorAll('button')).toHaveLength(1);
        expect(pill()?.textContent).toBe('web · Worktree clowdy/ab12cd34');
        await press(pill()!);
        await press(item('New chat'));

        const ui = store.selectedProjectUi!;

        expect(ui.draft).toBe(true);
        expect(ui.draftFolderId).toBeNull();
        expect(ui.draftWorkspace).toEqual({ mode: 'existing', path: workspace.path });
    });

    it('offers Files and the Terminal for the worktree while the chat that works in it is open, since the tabs show it', async () => {
        vi.mocked(openInFiles).mockClear();
        vi.mocked(openInTerminal).mockClear();
        store.ui.forProject(FIXTURE_PROJECT_ID).openChat(FIXTURE_WORKSPACE_CHAT_ID);
        await draw({ workspace, bridge: { getOpenApps: async () => APPS, openPath: vi.fn(async () => undefined) } });
        await press(pill()!);

        expect(items().map(row => row.textContent)).toEqual([
            'New chat',
            'Open in Files',
            'Open in Terminal',
            'Copy path',
            'Open in…',
        ]);

        await press(item('Open in Files'));

        expect(openInFiles).toHaveBeenCalledExactlyOnceWith(
            store,
            FIXTURE_PROJECT_ID,
            { folder: FOLDER, workspace },
            ''
        );

        await press(pill()!);
        await press(item('Open in Terminal'));

        expect(openInTerminal).toHaveBeenCalledExactlyOnceWith(
            store,
            FIXTURE_PROJECT_ID,
            { folder: FOLDER, workspace },
            ''
        );
    });

    it("offers neither Files nor the Terminal while the tabs show another place: the folder's own checkout, or a worktree that is not made yet", async () => {
        await draw({ workspace, bridge: { getOpenApps: async () => APPS, openPath: vi.fn(async () => undefined) } });
        await press(pill()!);

        // No chat is open: the tabs show the folder's own checkout, not this worktree.
        expect(items().map(row => row.textContent)).toEqual(['New chat', 'Copy path', 'Open in…']);

        await press(item('Copy path'));
        store.ui.forProject(FIXTURE_PROJECT_ID).openChat(FIXTURE_WORKSPACE_CHAT_ID);
        await draw({
            workspace: { ...workspace, ready: false },
            bridge: { getOpenApps: async () => APPS, openPath: vi.fn(async () => undefined) },
        });
        await press(pill()!);

        expect(items().map(row => row.textContent)).toEqual(['New chat', 'Copy path', 'Open in…']);
        expect(item('New chat').getAttribute('aria-disabled')).toBe('true');
    });

    it("is read only outside the desktop app, with the worktree's path on hover", async () => {
        await draw({ workspace });

        expect(container.querySelector<HTMLElement>('[role="group"][aria-label^="Current place:"]')?.title).toBe(
            '~/Clowdy/workspaces/car-rental/ab12cd34/car-rental'
        );
        expect(container.querySelector('button')).toBeNull();
    });
});
