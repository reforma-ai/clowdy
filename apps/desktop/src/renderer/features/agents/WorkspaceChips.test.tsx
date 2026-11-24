// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_PERSONAL_PROJECT_ID,
    FIXTURE_PROJECT_ID,
    type FixtureData,
    withFixtureWorkspace,
} from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { TransportError } from '../../daemon/transport';
import { RootStore, RootStoreProvider } from '../../stores';
import { currentPlace } from '../sidePanel/currentPlace';
import { openManageWorktrees } from '../worktrees';
import { DraftChat } from './DraftChat';

import type { Chat, CommandResult, CreatedWorktree, FolderGit } from '@clowdy/protocol';
import type { Editor } from '@tiptap/core';
import type { KeyValueStorage } from '../../stores/storage';

// The dialog itself is `features/worktrees`' own subject; here only that the control opens it, and for which folder.
vi.mock('../worktrees', async importOriginal => ({
    ...(await importOriginal<typeof import('../worktrees')>()),
    openManageWorktrees: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The new-chat page's one control for where the chat works, on the fixture project: one folder, `car-rental`, a repository on `main` whose default branch is `origin/main`, with
 * the branches `main`, `dev`, `feature/payments`, `origin/main` and `origin/dev`, and one worktree besides its own, `clowdy/ab12cd34`, with changes in it.
 */

const API = { id: 'fld_api', path: '/Users/dev/car-rental-api' };
const WORKTREE = '/Users/dev/Clowdy/workspaces/car-rental/ab12cd34/car-rental';

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

let container: HTMLDivElement;
let root: Root;
let store: RootStore;
let missingFolders = new Set<string>();

const ui = (projectId = FIXTURE_PROJECT_ID) => store.ui.forProject(projectId);
// The test build has no MobX observer plugin, so the page is drawn again by hand after a change, as the observer does in the app.
const render = () =>
    root.render(
        <RootStoreProvider value={store}>
            <DraftChat missing={missingFolders} />
        </RootStoreProvider>
    );
const settle = () =>
    act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
        render();
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
        render();
    });

/** The control's pill: the only one of its kind on the page. */
const chip = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Where it runs"]');
/** The base of the row of a new worktree, in the open menu: a press target of its own at the row's end. */
const baseButton = () =>
    document.body.querySelector<HTMLButtonElement>('[role="menu"] button[aria-label^="Start from"]');
const menuItems = () => [...document.body.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')];
const menuItem = (text: string) => menuItems().find(row => row.textContent?.startsWith(text))!;
/** Existing worktree rows in the main menu. */
const iconsOf = (row: HTMLElement) => row.querySelectorAll('svg').length;
const worktreeRows = () => [...document.body.querySelectorAll<HTMLElement>('[role="menu"] [data-worktree]')];
const worktreeRow = (text: string) => worktreeRows().find(row => row.textContent?.startsWith(text))!;
const options = () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
const option = (text: string) => options().find(row => row.textContent?.startsWith(text))!;
const search = () => document.body.querySelector<HTMLInputElement>('input[type="text"]')!;
const field = () => container.querySelector<HTMLElement>('[contenteditable="true"]');
const editor = () => (field() as HTMLElement & { editor: Editor }).editor;
/** What the line under the message box says, apart from the mode at its end. */
const line = () => container.textContent;

const draw = (before?: () => void) =>
    act(async () => {
        before?.();
        render();
    });

async function start({
    data = createFixtureData(),
    project = FIXTURE_PROJECT_ID,
    transport = new FixtureTransport({ data }),
}: {
    data?: FixtureData;
    project?: string;
    transport?: FixtureTransport;
} = {}) {
    act(() => root.unmount());
    store.dispose();
    root = createRoot(container);
    store = new RootStore(transport, { storage: memoryStorage() });
    await store.load();
    store.selectProject(project);
    await draw(() => ui(project).openDraft());
    await settle();
}

/** Presses a row of the control's menu: `Main worktree`, `New worktree`, or a worktree by its branch. */
async function chooseMode(text: string) {
    await press(chip()!);
    await press(menuItem(text));
    await settle();
}

/** Picks the ref a new worktree starts from in the list that opens from the base at the end of its row. */
async function pickBase(name: string) {
    await press(chip()!);
    await press(baseButton()!);
    await settle();
    await press(option(name));
    await settle();
}

/** Opens the menu containing the folder's worktrees. */
async function openWorktrees() {
    await press(chip()!);
}

/** Picks a worktree of the folder, by its branch, in the menu. */
async function chooseWorktree(branch: string) {
    await openWorktrees();
    await press(worktreeRow(branch));
    await settle();
}

async function send(words: string) {
    act(() => {
        editor().commands.insertContent(words);
    });
    await act(async () => {
        field()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await settle();
}

/** What the daemon answers a command it cannot take. */
const refused: CommandResult = {
    ok: false,
    requestId: 'req-refused',
    error: { code: 'unavailable', message: 'No daemon' },
};

const made = (before: ReadonlySet<string>): Chat[] =>
    [...store.selectedProject!.chats.values()].filter(chat => !before.has(chat.id));

beforeEach(async () => {
    missingFolders = new Set();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    store = new RootStore(new FixtureTransport(), { storage: memoryStorage() });
    await store.load();
    store.selectProject(FIXTURE_PROJECT_ID);
    await draw(() => ui().openDraft());
    await settle();
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    store.dispose();
});

describe('the control', () => {
    const textsOf = (rows: HTMLElement[]) => rows.map(row => row.textContent);
    /** Whether the slot at a row's start has a check: the slot is there on every row, so the words line up. */
    const dimParts = () =>
        [...chip()!.querySelectorAll('span')]
            .filter(part => part.className.includes('color-secondary-muted-text'))
            .map(part => part.textContent);

    it('says the branch that is checked out to begin with and nothing of a mode, in the one pill there is', () => {
        expect(chip()?.textContent).toBe('main');
        expect(chip()?.getAttribute('aria-label')).toBe('Where it runs: Main worktree, branch main');
        expect(container.querySelectorAll('button[aria-label^="Where it runs"]')).toHaveLength(1);
        expect(container.querySelector('[aria-label^="Branch"]')).toBeNull();
        expect(chip()?.querySelector('svg')).not.toBeNull();
        expect(dimParts()).toEqual([]);
    });

    it.each([
        ['main checkout', undefined, '~/car-rental'],
        ['existing worktree', 'clowdy/ab12cd34', '~/Clowdy/workspaces/car-rental/ab12cd34/car-rental'],
    ])('shows the selected path on the %s control', async (_name, worktree, path) => {
        if (worktree) await chooseWorktree(worktree);
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
            chip()!.focus();
        });
        await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
        expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(path);
    });

    it('lists main, new and existing worktrees, followed by Folder settings…', async () => {
        await press(chip()!);

        expect(textsOf(menuItems())).toEqual([
            'Main worktreeUse the project foldermain',
            'New worktreeUse a new folder and branchFrom origin/main',
            'clowdy/ab12cd34Worktree',
            'Folder settings…',
        ]);
        // Manage opens a dialog and does not select a place.
        expect(menuItems().map(row => row.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', null]);
        expect(menuItems().map(row => row.getAttribute('role'))).toEqual([
            'menuitemradio',
            'menuitemradio',
            'menuitemradio',
            'menuitem',
        ]);
        expect(menuItems().every(row => row.getAttribute('aria-disabled') !== 'true')).toBe(true);
        // One separator stands between the three places to work in and Folder settings….
        expect(document.body.querySelectorAll('[role="menu"] [role="separator"]')).toHaveLength(1);

        const rows = [...document.body.querySelectorAll<HTMLElement>('[role="menu"] > *')];

        expect(rows.map(row => row.getAttribute('role'))).toEqual([
            'menuitemradio',
            'menuitemradio',
            'menuitemradio',
            'separator',
            'group',
        ]);
        // Existing worktrees are directly available.
        expect(worktreeRows()).toHaveLength(1);
    });

    it('gives each row of the menu an icon and ticks none: the row that is on is the one the menu has selected', async () => {
        await press(chip()!);

        // An icon each, and the chevron too on the three rows that open something beside the menu (the branch of the main worktree and the base of a new one are chips with a chevron of their own).
        expect(menuItems().map(iconsOf)).toEqual([2, 2, 1, 1]);
        expect(document.body.querySelector('[role="menu"] [aria-label="Current"]')).toBeNull();
        expect(menuItems().map(row => row.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', null]);
    });

    it('makes the chat a new worktree from the default branch, and says so in the pill with the base in the dim tone', async () => {
        await chooseMode('New worktree');

        expect(ui().draftWorkspace).toEqual({ mode: 'new' });
        expect(chip()?.textContent).toBe('Worktreefrom origin/main');
        expect(chip()?.getAttribute('aria-label')).toBe('Where it runs: New worktree from origin/main');
        expect(dimParts()).toEqual(['from origin/main']);
        expect(container.querySelector('[aria-label^="Branch"]')).toBeNull();

        await press(chip()!);

        expect(menuItem('New worktree').getAttribute('aria-checked')).toBe('true');
        expect(menuItem('Main worktree').getAttribute('aria-checked')).toBe('false');
    });

    it('sends the chat into the worktree that is picked, and says its branch after the word Worktree in the dim tone', async () => {
        await chooseWorktree('clowdy/ab12cd34');

        expect(ui().draftWorkspace).toEqual({ mode: 'existing', path: WORKTREE });
        expect(chip()?.textContent).toBe('Worktreeclowdy/ab12cd34');
        expect(chip()?.getAttribute('aria-label')).toBe('Where it runs: Worktree, branch clowdy/ab12cd34');
        expect(dimParts()).toEqual(['Worktree']);
        expect(options()).toEqual([]);
        expect(menuItems()).toEqual([]);

        // The worktree is the selected row of the menu, and the main worktree is no longer selected.
        await press(chip()!);

        expect(menuItem('Main worktree').getAttribute('aria-checked')).toBe('false');

        expect(worktreeRow('clowdy/ab12cd34').getAttribute('aria-checked')).toBe('true');
    });

    it('goes back to the current checkout from a worktree', async () => {
        await chooseMode('New worktree');
        await chooseMode('Main worktree');

        expect(ui().draftWorkspace).toBeNull();
        expect(chip()?.textContent).toBe('main');

        await chooseWorktree('clowdy/ab12cd34');
        await chooseMode('Main worktree');

        expect(ui().draftWorkspace).toBeNull();
        expect(chip()?.textContent).toBe('main');
    });

    // A single choice list shuts for Enter, and leaves itself open for Space unless its items say otherwise.
    it('shuts for Space as for Enter, whichever row it is pressed on', async () => {
        const key = async (target: HTMLElement, name: string, code: string) =>
            act(async () => {
                target.focus();
                target.dispatchEvent(
                    new KeyboardEvent('keydown', { key: name, code, bubbles: true, cancelable: true })
                );
                target.dispatchEvent(new KeyboardEvent('keyup', { key: name, code, bubbles: true, cancelable: true }));
                render();
            });

        await press(chip()!);
        await key(menuItem('New worktree'), ' ', 'Space');
        await settle();

        expect(ui().draftWorkspace).toEqual({ mode: 'new' });
        expect(menuItems()).toEqual([]);
        expect(options()).toEqual([]);

        // Space chooses an existing worktree and closes the menu.
        await press(chip()!);
        await key(worktreeRow('clowdy/ab12cd34'), ' ', 'Space');
        await settle();

        expect(ui().draftWorkspace).toEqual({ mode: 'existing', path: WORKTREE });
        expect(menuItems()).toEqual([]);
    });

    it('is off in a repository with no commit, for a new worktree, saying so', async () => {
        const transport = new FixtureTransport();

        vi.spyOn(transport, 'getFolderGit').mockResolvedValue({
            isRepository: true,
            branch: 'main',
            branches: [],
            worktrees: [{ path: '/Users/dev/car-rental', branch: 'main', head: 'a1b2c3d', main: true, dirty: false }],
        });
        await start({ transport });
        await press(chip()!);

        expect(menuItem('New worktree').getAttribute('aria-disabled')).toBe('true');
        expect(menuItem('New worktree').textContent).toContain('The repository has no commit yet');
        expect(baseButton()).toBeNull();
    });

    it('omits existing worktree rows when the folder has no other worktree', async () => {
        const transport = new FixtureTransport();

        vi.spyOn(transport, 'getFolderGit').mockResolvedValue({
            isRepository: true,
            branch: 'main',
            defaultBranch: 'origin/main',
            branches: [{ name: 'main', remote: false }],
            worktrees: [{ path: '/Users/dev/car-rental', branch: 'main', head: 'a1b2c3d', main: true, dirty: false }],
        });
        await start({ transport });
        await press(chip()!);

        expect(textsOf(menuItems())).toEqual([
            'Main worktreeUse the project foldermain',
            'New worktreeUse a new folder and branchFrom origin/main',
            'Folder settings…',
        ]);
        expect(
            [...document.body.querySelectorAll<HTMLElement>('[role="menu"] > *')].map(row => row.getAttribute('role'))
        ).toEqual(['menuitemradio', 'menuitemradio', 'separator', 'group']);
    });

    it('says a detached HEAD by its short hash in the pill and on the row of the main worktree', async () => {
        const transport = new FixtureTransport();

        vi.spyOn(transport, 'getFolderGit').mockResolvedValue({
            isRepository: true,
            branch: '5c4d3e2',
            detached: true,
            defaultBranch: 'origin/main',
            branches: [{ name: 'main', remote: false }],
            worktrees: [{ path: '/Users/dev/car-rental', head: '5c4d3e2', main: true, dirty: false }],
        });
        await start({ transport });

        expect(chip()?.textContent).toBe('5c4d3e2');
        expect(chip()?.getAttribute('aria-label')).toBe('Where it runs: Main worktree, detached at 5c4d3e2');

        // The hash is no branch: the pill says so in its tooltip, which the keyboard's focus shows.
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
            chip()!.focus();
        });
        await act(async () => new Promise(resolve => setTimeout(resolve, 0)));

        expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Detached HEAD');

        await press(chip()!);

        expect(menuItem('Main worktree').textContent).toBe('Main worktreeUse the project folder5c4d3e2');
    });
});

describe('the branch a new worktree starts from', () => {
    it('is the base at the end of the row of a new worktree, a press target of its own that opens the list of branches and leaves the row alone', async () => {
        await press(chip()!);

        expect(baseButton()?.textContent).toBe('From origin/main');
        expect(baseButton()?.closest('[role="menuitemradio"]')?.textContent).toContain('New worktree');

        await press(baseButton()!);
        await settle();

        // The list is open at the menu's side and the menu stays open under it, and nothing was chosen: the row of the new worktree was not pressed.
        expect(menuItems().length).toBeGreaterThan(0);
        expect(options().length).toBeGreaterThan(0);
        expect(ui().draftWorkspace).toBeNull();
        expect(chip()?.textContent).toBe('main');
    });

    it('does not open the list when the row itself is pressed, which chooses the new worktree and shuts the menu', async () => {
        await press(chip()!);
        await press(menuItem('New worktree'));
        await settle();

        expect(ui().draftWorkspace).toEqual({ mode: 'new' });
        expect(menuItems()).toEqual([]);
        expect(options()).toEqual([]);
    });

    it("is out of the tab order, since the right arrow on the row is the keyboard's way to it", async () => {
        await press(chip()!);

        expect(baseButton()?.getAttribute('tabindex')).toBe('-1');
    });

    it('opens the list of the base for the right arrow on the row of a new worktree, and on no row of Folder settings', async () => {
        const key = async (target: HTMLElement) =>
            act(async () => {
                target.focus();
                target.dispatchEvent(
                    new KeyboardEvent('keydown', {
                        key: 'ArrowRight',
                        code: 'ArrowRight',
                        bubbles: true,
                        cancelable: true,
                    })
                );
                render();
            });

        await press(chip()!);
        await key(menuItem('Folder settings'));
        await settle();

        expect(options()).toEqual([]);
        expect(menuItems().length).toBeGreaterThan(0);

        await key(menuItem('New worktree'));
        await settle();

        // The menu stays open with the list beside it.
        expect(menuItems().length).toBeGreaterThan(0);
        expect(options().map(row => row.textContent)).toEqual([
            'main',
            'dev',
            'feature/payments',
            'origin/mainDefault',
            'origin/dev',
        ]);
        expect(ui().draftWorkspace).toBeNull();
    });

    describe('in the list', () => {
        beforeEach(async () => {
            await press(chip()!);
            await press(baseButton()!);
            await settle();
        });

        it('has the branches, local and remote, with the default one marked and ticked, and the pill looks pressed while it is open', () => {
            expect(options().map(row => row.textContent)).toEqual([
                'main',
                'dev',
                'feature/payments',
                'origin/mainDefault',
                'origin/dev',
            ]);
            expect(option('origin/main').querySelector('[aria-label="Current"]')).not.toBeNull();
            expect(chip()?.hasAttribute('data-open')).toBe(true);
        });

        it('has the local branches first and the remote ones after them, each under its heading', () => {
            const groups = [...document.body.querySelectorAll('[role="listbox"] [role="group"]')];

            expect(groups.map(group => group.getAttribute('aria-label'))).toEqual(['Local', 'Remote']);
            expect(
                groups.map(group => [...group.querySelectorAll('[role="option"]')].map(row => row.textContent))
            ).toEqual([
                ['main', 'dev', 'feature/payments'],
                ['origin/mainDefault', 'origin/dev'],
            ]);
            expect(document.body.querySelector('[role="listbox"]')?.textContent).toContain('Remote');
        });

        it('is searched as the person types', async () => {
            await act(async () => {
                search().focus();
            });
            await act(async () => {
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search(), 'pay');
                search().dispatchEvent(new Event('input', { bubbles: true }));
            });

            expect(options().map(row => row.textContent)).toEqual(['feature/payments']);
            // Typing in it does not take the menu from under it.
            expect(menuItems().length).toBeGreaterThan(0);
        });

        it('makes the chat a new worktree from the branch picked, and shuts the list and the menu with it', async () => {
            await press(option('origin/dev'));
            await settle();

            expect(ui().draftWorkspace).toEqual({ mode: 'new', base: 'origin/dev' });
            expect(chip()?.textContent).toBe('Worktreefrom origin/dev');
            expect(options()).toEqual([]);
            expect(menuItems()).toEqual([]);
        });

        it('is shut by Escape alone, chooses nothing and leaves the menu open, which the next Escape shuts', async () => {
            await act(async () => {
                search().dispatchEvent(
                    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
                );
            });
            await settle();

            expect(options()).toEqual([]);
            expect(menuItems().length).toBeGreaterThan(0);
            expect(ui().draftWorkspace).toBeNull();

            await act(async () => {
                menuItem('Main worktree').focus();
                menuItem('Main worktree').dispatchEvent(
                    new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })
                );
            });
            await settle();

            expect(menuItems()).toEqual([]);
            expect(ui().draftWorkspace).toBeNull();
        });
    });

    it('has no headings for a folder that has only local branches', async () => {
        const transport = new FixtureTransport();

        vi.spyOn(transport, 'getFolderGit').mockResolvedValue({
            isRepository: true,
            branch: 'main',
            defaultBranch: 'main',
            branches: [
                { name: 'main', remote: false },
                { name: 'dev', remote: false },
            ],
            worktrees: [{ path: '/Users/dev/car-rental', branch: 'main', head: 'a1b2c3d', main: true, dirty: false }],
        });
        await start({ transport });
        await press(chip()!);
        await press(baseButton()!);
        await settle();

        expect(options().map(row => row.textContent)).toEqual(['mainDefault', 'dev']);
        expect(document.body.querySelector('[role="listbox"]')?.textContent).not.toMatch(/Local|Remote/);
    });

    it('is kept when the row of a new worktree is pressed again, and the base at its end shows it', async () => {
        await pickBase('dev');
        await chooseMode('New worktree');

        expect(ui().draftWorkspace).toEqual({ mode: 'new', base: 'dev' });

        await press(chip()!);

        expect(baseButton()?.textContent).toBe('From dev');
    });

    it('ticks the base the new worktree starts from when the list is open again', async () => {
        await pickBase('dev');
        await press(chip()!);
        await press(baseButton()!);
        await settle();

        expect(option('dev').querySelector('[aria-label="Current"]')).not.toBeNull();
        expect(option('origin/main').querySelector('[aria-label="Current"]')).toBeNull();
    });
});

describe('Existing worktrees', () => {
    it('show their branch, git icon and chat count', async () => {
        await start({ data: withFixtureWorkspace(createFixtureData()) });
        await openWorktrees();

        expect(worktreeRows().map(row => row.textContent)).toEqual(['clowdy/ab12cd34Worktree used in 1 chat']);
        expect(worktreeRows().map(iconsOf)).toEqual([1]);
        expect(document.body.textContent).not.toContain('Changes');
    });

    it('labels an unused worktree without a chat count', async () => {
        await openWorktrees();

        expect(worktreeRows().map(row => row.textContent)).toEqual(['clowdy/ab12cd34Worktree']);
    });

    describe('the ones a chat works in and the ones none does', () => {
        const withThree = (data: FixtureData) => {
            const transport = new FixtureTransport({ data });
            const git = {
                isRepository: true as const,
                branch: 'main',
                defaultBranch: 'origin/main',
                branches: [{ name: 'main', remote: false }],
                worktrees: [
                    { path: '/Users/dev/car-rental', branch: 'main', head: 'a1b2c3d', main: true, dirty: false },
                    {
                        path: '/Users/dev/trees/stale-one',
                        branch: 'worktree-agent-a1',
                        head: 'b1',
                        main: false,
                        dirty: true,
                    },
                    { path: WORKTREE, branch: 'clowdy/ab12cd34', head: 'c1', main: false, dirty: false },
                    {
                        path: '/Users/dev/trees/stale-two',
                        branch: 'worktree-agent-a2',
                        head: 'd1',
                        main: false,
                        dirty: false,
                    },
                ],
            };

            vi.spyOn(transport, 'getFolderGit').mockResolvedValue(git);

            return transport;
        };

        it('are listed first, then unused worktrees, each in git order', async () => {
            const data = withFixtureWorkspace(createFixtureData());

            await start({ data, transport: withThree(data) });
            await openWorktrees();

            expect(worktreeRows().map(row => row.textContent)).toEqual([
                'clowdy/ab12cd34Worktree used in 1 chat',
                'worktree-agent-a1Worktree',
                'worktree-agent-a2Worktree',
            ]);
        });

        it('have no heading when none are in use', async () => {
            await start({ transport: withThree(createFixtureData()) });
            await openWorktrees();

            expect(worktreeRows()).toHaveLength(3);
            expect(document.body.textContent).not.toContain('Not in use');
        });
    });

    it('count all chats using a worktree', async () => {
        const data = withFixtureWorkspace(createFixtureData());
        const used = data.chats.find(chat => chat.workspace)!;

        for (const [id, title] of [
            ['c-x1', 'Second chat'],
            ['c-x2', 'Third chat'],
            ['c-x3', 'Fourth chat'],
        ])
            data.chats.push({ ...structuredClone(used), id, title, orchestratorRunId: undefined });

        await start({ data });
        await openWorktrees();

        expect(worktreeRow('clowdy/ab12cd34').textContent).toContain('Worktree used in 4 chats');
    });

    it('scroll when there are many, in a box that keeps the popover to a height', async () => {
        const transport = new FixtureTransport();
        const worktrees = Array.from({ length: 30 }, (_, n) => ({
            path: `/Users/dev/trees/t${n}`,
            branch: `feature/t${n}`,
            head: 'a1b2c3d',
            main: false,
            dirty: false,
        }));

        vi.spyOn(transport, 'getFolderGit').mockResolvedValue({
            isRepository: true,
            branch: 'main',
            defaultBranch: 'origin/main',
            branches: [{ name: 'main', remote: false }],
            worktrees: [
                { path: '/Users/dev/car-rental', branch: 'main', head: 'a1b2c3d', main: true, dirty: false },
                ...worktrees,
            ],
        });
        await start({ transport });
        await openWorktrees();

        // The menu keeps its height with thirty worktree rows.
        expect(worktreeRows()).toHaveLength(30);
        expect(menuItems()).toHaveLength(33);
        expect(
            document.body
                .querySelector('[role="menu"][aria-label="Where the chat works"]')
                ?.closest('[style*="max-height"]')
        ).not.toBeNull();
    });
});

describe('Folder settings…', () => {
    const opener = vi.mocked(openManageWorktrees);
    const twoFolders = () => {
        const data = createFixtureData();

        data.projects.find(candidate => candidate.id === FIXTURE_PROJECT_ID)!.folders.push(API);

        return data;
    };
    const key = async (target: HTMLElement, name: string, code: string) =>
        act(async () => {
            target.focus();
            target.dispatchEvent(new KeyboardEvent('keydown', { key: name, code, bubbles: true, cancelable: true }));
            target.dispatchEvent(new KeyboardEvent('keyup', { key: name, code, bubbles: true, cancelable: true }));
            render();
        });

    beforeEach(() => opener.mockClear());

    it('is the last row, behind a separator, and says what it is as a plain menu item', async () => {
        await press(chip()!);

        const manage = menuItem('Folder settings');

        expect(manage.textContent).toBe('Folder settings…');
        expect(menuItems().at(-1)).toBe(manage);
        expect(manage.getAttribute('role')).toBe('menuitem');
        expect(manage.getAttribute('aria-disabled')).not.toBe('true');
        // It sits in a group of its own that selects nothing, and the separator is the group's neighbour.
        expect(manage.parentElement?.previousElementSibling?.getAttribute('role')).toBe('separator');
    });

    it('opens the dialog of the project for the folder of the page, and shuts the menu', async () => {
        await press(chip()!);
        await press(menuItem('Folder settings'));
        await settle();

        expect(opener).toHaveBeenCalledExactlyOnceWith({
            root: store,
            projectId: FIXTURE_PROJECT_ID,
            folderId: 'fld_car_rental',
        });
        expect(menuItems()).toEqual([]);
    });

    it('chooses no place: the choice that was made and what the pill says stay', async () => {
        await pickBase('dev');
        await press(chip()!);
        await press(menuItem('Folder settings'));
        await settle();

        expect(opener).toHaveBeenCalledOnce();
        expect(ui().draftWorkspace).toEqual({ mode: 'new', base: 'dev' });
        expect(chip()?.textContent).toBe('Worktreefrom dev');
        // The base list is not what the press opens.
        expect(options()).toEqual([]);

        await press(chip()!);

        expect(menuItems().map(row => row.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', null]);
    });

    it('opens it for the other folder when that is the folder of the page', async () => {
        await start({ transport: new FixtureTransport({ data: twoFolders() }) });
        await press(chip()!);
        await press(
            [...document.body.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(
                row => row.textContent === 'car-rental-api'
            )!
        );
        await settle();
        await press(chip()!);
        await press(menuItem('Folder settings'));
        await settle();

        expect(opener).toHaveBeenCalledExactlyOnceWith({
            root: store,
            projectId: FIXTURE_PROJECT_ID,
            folderId: API.id,
        });
    });

    it('opens for Enter and for Space, and shuts the menu for both', async () => {
        await press(chip()!);
        await key(menuItem('Folder settings'), 'Enter', 'Enter');
        await settle();

        expect(opener).toHaveBeenCalledTimes(1);
        expect(menuItems()).toEqual([]);

        await press(chip()!);
        await key(menuItem('Folder settings'), ' ', 'Space');
        await settle();

        expect(opener).toHaveBeenCalledTimes(2);
        expect(menuItems()).toEqual([]);
    });

    it('is reached by the arrow keys: down from the last worktree, and round from the first row, which wraps to it', async () => {
        await press(chip()!);
        await key(worktreeRow('clowdy/ab12cd34'), 'ArrowDown', 'ArrowDown');

        expect(document.activeElement).toBe(menuItem('Folder settings'));

        await key(menuItem('Folder settings'), 'ArrowDown', 'ArrowDown');

        expect(document.activeElement).toBe(menuItem('Main worktree'));

        await key(menuItem('Main worktree'), 'ArrowUp', 'ArrowUp');

        expect(document.activeElement).toBe(menuItem('Folder settings'));
    });

    it('gives focus back to the pill when the dialog is dismissed with Escape, though the row that opened it went with the menu', async () => {
        // The one test that draws the dialog itself: where focus returns is what the dialog noted when it opened, and that row is gone.
        const { openManageWorktrees: openDialog } =
            await vi.importActual<typeof import('../worktrees')>('../worktrees');

        opener.mockImplementationOnce(openDialog);
        await press(chip()!);
        await key(menuItem('Folder settings'), 'Enter', 'Enter');
        // The dialog notes the element to go back to once it has opened.
        await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 400));
        });

        expect(document.body.textContent).toContain('Name, worktree setup and worktrees of this folder');
        expect(document.activeElement).not.toBe(chip());

        await key(document.activeElement as HTMLElement, 'Escape', 'Escape');
        await vi.waitFor(() => expect(document.activeElement).toBe(chip()));
        expect(document.body.textContent).not.toContain('Name, worktree setup and worktrees of this folder');
    });

    it('is in the menu of a repository with no commit too, where a new worktree is off', async () => {
        const transport = new FixtureTransport();

        vi.spyOn(transport, 'getFolderGit').mockResolvedValue({
            isRepository: true,
            branch: 'main',
            branches: [],
            worktrees: [{ path: '/Users/dev/car-rental', branch: 'main', head: 'a1b2c3d', main: true, dirty: false }],
        });
        await start({ transport });
        await press(chip()!);

        expect(menuItem('Folder settings').getAttribute('aria-disabled')).not.toBe('true');

        await press(menuItem('Folder settings'));

        expect(opener).toHaveBeenCalledOnce();
    });

    it('is nowhere when the folder is no repository: there is no control to open it from', async () => {
        const transport = new FixtureTransport();

        vi.spyOn(transport, 'getFolderGit').mockResolvedValue({ isRepository: false });
        await start({ transport });

        expect(chip()).toBeNull();
        expect(document.body.textContent).not.toContain('Folder settings');
        expect(opener).not.toHaveBeenCalled();
    });
});

describe('a folder that offers no worktree', () => {
    const hint = async () => {
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
            container
                .querySelector<HTMLElement>(
                    '[role="button"][aria-disabled][aria-label="Where it runs: Git unavailable"]'
                )!
                .focus();
        });
        await settle();

        return document.querySelector('[role="tooltip"]')?.textContent;
    };

    it('has no control at all when the folder is no repository: nothing to pick and no branch to say', async () => {
        await start({ project: FIXTURE_PERSONAL_PROJECT_ID });

        expect(chip()).toBeNull();
        expect(container.querySelector('[aria-label^="Where it runs"]')).toBeNull();
        expect(container.querySelector('[aria-label^="Branch"]')).toBeNull();
    });

    it('says why the daemon could not read the folder, in its own words when it gave them, in a dim label that does not open', async () => {
        const transport = new FixtureTransport();

        vi.spyOn(transport, 'getFolderGit').mockRejectedValue(new TransportError('git did not answer', 503));
        await start({ transport });

        expect(chip()).toBeNull();
        expect(container.querySelector('[aria-label="Where it runs: Git unavailable"]')?.textContent).toBe(
            'Git unavailable'
        );
        expect(await hint()).toBe('Git did not answer');
    });

    it('says something when the daemon gave no reason', async () => {
        const transport = new FixtureTransport();

        vi.spyOn(transport, 'getFolderGit').mockRejectedValue(new Error(''));
        await start({ transport });

        expect(await hint()).toBe("Couldn't read the folder's git");
    });

    it('shows nothing while the daemon has not answered yet', async () => {
        const transport = new FixtureTransport();

        vi.spyOn(transport, 'getFolderGit').mockReturnValue(new Promise<FolderGit>(() => undefined));
        await start({ transport });

        expect(chip()).toBeNull();
        expect(container.querySelector('[aria-label^="Where it runs"]')).toBeNull();
    });

    it('holds the first message while a choice that was made waits for the read, rather than send the chat to the folder itself, and lets it go once the read answers', async () => {
        const transport = new FixtureTransport();
        let answer: (git: FolderGit) => void = () => undefined;

        vi.spyOn(transport, 'getFolderGit').mockReturnValue(
            new Promise<FolderGit>(resolve => {
                answer = resolve;
            })
        );
        await start({ transport });
        // The page comes back from another chat (back, forward) with its choice, and the read is on its way again.
        await draw(() => ui().setDraftWorkspace({ mode: 'new', base: 'dev' }));

        const before = new Set(store.selectedProject!.chats.keys());

        await send('Fix it');
        expect(made(before)).toHaveLength(0);
        expect(editor().getText()).toContain('Fix it');

        const sentWith = await FixtureTransport.prototype.getFolderGit.call(
            transport,
            FIXTURE_PROJECT_ID,
            'fld_car_rental'
        );

        await act(async () => answer(sentWith));
        await settle();
        await act(async () => {
            field()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        });
        await settle();

        expect(made(before)).toHaveLength(1);
        expect(made(before)[0]?.workspace?.managed).toBe(true);
    });

    it('holds nothing back while the read is on its way and Project checkout is what was chosen', async () => {
        const transport = new FixtureTransport();

        vi.spyOn(transport, 'getFolderGit').mockReturnValue(new Promise<FolderGit>(() => undefined));
        await start({ transport });

        const before = new Set(store.selectedProject!.chats.keys());

        await send('Fix it');

        expect(made(before)).toHaveLength(1);
        expect(made(before)[0]?.workspace).toBeUndefined();
    });

    it('sends the chat to the folder itself, whatever had been chosen, while the read does not bear the choice out', async () => {
        const transport = new FixtureTransport();
        const read = vi.spyOn(transport, 'getFolderGit');

        await start({ transport });
        await chooseMode('New worktree');
        expect(ui().draftWorkspace).toEqual({ mode: 'new' });

        // The window gets focus, and the read now says the folder is no repository: the control is gone and nothing is sent.
        read.mockResolvedValue({ isRepository: false });
        act(() => void window.dispatchEvent(new Event('focus')));
        await settle();

        expect(chip()).toBeNull();

        const before = new Set(store.selectedProject!.chats.keys());

        await send('Fix it');

        expect(made(before)).toHaveLength(1);
        expect(made(before)[0]?.workspace).toBeUndefined();
    });
});

describe('the first message', () => {
    it('selects and uses a newly created worktree while the draft still has an older Git listing', async () => {
        const transport = new FixtureTransport();
        const command = vi.spyOn(transport, 'command');
        await start({ transport });

        const folderId = 'fld_car_rental';
        const oldListing = await transport.getFolderGit(FIXTURE_PROJECT_ID, folderId);
        vi.spyOn(transport, 'getFolderGit').mockResolvedValue(oldListing);
        const created = await store.command({
            type: 'workspace.create',
            projectId: FIXTURE_PROJECT_ID,
            folderId,
            branchName: 'fresh',
        });
        if (!created.ok) throw new Error(created.error.message);
        const { path } = created.data as CreatedWorktree;
        const known = new Set(store.selectedProject!.chats.keys());

        await draw(() => ui().openDraft([], null, { mode: 'existing', path }));
        await settle();

        expect(chip()?.getAttribute('aria-label')).toBe('Where it runs: Worktree, branch clowdy/fresh');
        expect(currentPlace(store.selectedProject!, ui()).workspace?.path).toBe(path);
        await send('Work here');

        expect(command).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'chat.create', workspace: { mode: 'existing', path } })
        );
        expect(made(known)[0]?.workspace?.path).toBe(path);
    });

    it('makes a chat in the folder itself when Project checkout is on', async () => {
        const before = new Set(store.selectedProject!.chats.keys());

        await send('Fix the price');

        expect(made(before)).toHaveLength(1);
        expect(made(before)[0]?.workspace).toBeUndefined();
    });

    it('makes a chat in a new worktree that starts from the base that was picked', async () => {
        const before = new Set(store.selectedProject!.chats.keys());

        await pickBase('dev');
        await send('Fix the price');

        const [chat] = made(before);

        // The fixture daemon makes the worktree at the first message, as the daemon does: it is ready, on the branch of its own, with the step in the chat's stream.
        expect(chat?.workspace).toMatchObject({
            managed: true,
            ready: true,
            folderId: 'fld_car_rental',
            branch: `clowdy/${chat!.id.slice(-8)}`,
        });
        expect(
            (await store.transport.getItems({ chatId: chat!.id }))
                .slice(0, 2)
                .map(item => (item.body.kind === 'tool' ? item.body.name : item.body.kind))
        ).toEqual(['user', 'workspace']);
    });

    it('makes a chat in the existing worktree that was picked, sharing the worktree with the chats that have it', async () => {
        const before = new Set(store.selectedProject!.chats.keys());

        await chooseWorktree('clowdy/ab12cd34');
        await send('Fix the price');

        expect(made(before)[0]?.workspace).toMatchObject({ path: WORKTREE, ready: true, branch: 'clowdy/ab12cd34' });
    });

    it('shows the chat that was made, and the page that made it starts over in Project checkout', async () => {
        await chooseMode('New worktree');
        await send('Fix the price');

        expect(ui().draft).toBe(false);
        expect(ui().draftWorkspace).toBeNull();

        await draw(() => ui().openDraft());
        await settle();

        expect(chip()?.textContent).toBe('main');
    });

    it('goes on in the chat a first message that failed had made while the choice is as it was, and starts another when it changed', async () => {
        const transport = new FixtureTransport();
        const original = transport.command.bind(transport);
        const commands = vi.spyOn(transport, 'command');

        await start({ transport });
        await chooseMode('New worktree');

        // The chat is made, and its first message is refused.
        commands.mockImplementationOnce(original).mockImplementationOnce(async () => refused);

        const before = new Set(store.selectedProject!.chats.keys());

        await send('First try');
        expect(made(before)).toHaveLength(1);
        expect(ui().draft).toBe(true);

        commands.mockRestore();
        await send('Second try');
        // The retry goes to the chat that was made, which has its worktree.
        expect(made(before)).toHaveLength(1);
        expect(made(before)[0]?.workspace?.managed).toBe(true);
        expect(ui().draft).toBe(false);
    });

    it("makes another chat when the worktree was changed after a first message that failed, since a chat's worktree is fixed from the start", async () => {
        const transport = new FixtureTransport();
        const original = transport.command.bind(transport);
        const commands = vi.spyOn(transport, 'command');

        await start({ transport });
        await chooseMode('New worktree');
        commands.mockImplementationOnce(original).mockImplementationOnce(async () => refused);

        const before = new Set(store.selectedProject!.chats.keys());

        await send('First try');
        expect(made(before)).toHaveLength(1);

        commands.mockRestore();
        await chooseMode('Main worktree');
        await send('Second try');

        const chats = made(before);

        expect(chats).toHaveLength(2);
        expect(chats.filter(chat => chat.workspace)).toHaveLength(1);
        expect(ui().draft).toBe(false);
        expect(ui().chatId).toBe(chats.find(chat => !chat.workspace)?.id);
    });
});

describe('the folder of the page', () => {
    const twoFolders = () => {
        const data = createFixtureData();

        data.projects.find(candidate => candidate.id === FIXTURE_PROJECT_ID)!.folders.push(API);

        return data;
    };

    it('exposes the selected folder and workspace independently', async () => {
        await start({ data: twoFolders() });
        await press(chip()!);

        expect(menuItem('car-rental').getAttribute('aria-checked')).toBe('true');
        expect(menuItem('car-rental-api').getAttribute('aria-checked')).toBe('false');
        expect(menuItem('Main worktree').getAttribute('aria-checked')).toBe('true');
        expect(menuItem('New worktree').getAttribute('aria-checked')).toBe('false');

        await press(menuItem('New worktree'));
        await press(chip()!);
        expect(menuItem('car-rental').getAttribute('aria-checked')).toBe('true');
        expect(menuItem('Main worktree').getAttribute('aria-checked')).toBe('false');
        expect(menuItem('New worktree').getAttribute('aria-checked')).toBe('true');
    });

    it('takes the chips along: the lists are read for the folder that is picked, and the choice goes back to Project checkout', async () => {
        const transport = new FixtureTransport({ data: twoFolders() });
        const read = vi.spyOn(transport, 'getFolderGit');

        await start({ transport });
        await pickBase('dev');

        expect(ui().draftWorkspace).toEqual({ mode: 'new', base: 'dev' });
        expect(read).toHaveBeenCalledExactlyOnceWith(FIXTURE_PROJECT_ID, 'fld_car_rental');

        await press(chip()!);
        await press(
            [...document.body.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(
                row => row.textContent === 'car-rental-api'
            )!
        );
        await settle();

        expect(read).toHaveBeenLastCalledWith(FIXTURE_PROJECT_ID, API.id);
        expect(ui().draftWorkspace).toBeNull();
        // The branch the pill says is the other folder's.
        expect(chip()?.textContent).toBe('car-rental-apifeature/payments');
    });

    it('keeps folder selection available while the new folder is loading, without showing the old workspace', async () => {
        const transport = new FixtureTransport({ data: twoFolders() });

        await start({ transport });
        await chooseMode('New worktree');
        vi.spyOn(transport, 'getFolderGit').mockReturnValue(new Promise<FolderGit>(() => undefined));
        await draw(() => ui().setDraftFolder(API.id));

        expect(chip()?.textContent).toBe('car-rental-apiReading Git…');
        await press(chip()!);
        expect(menuItem('car-rental')).toBeDefined();
        expect(menuItems().some(row => row.hasAttribute('data-new-worktree'))).toBe(false);
    });

    it.each([
        ['a non-repository', false, 'Not a repository'],
        ['a failed read', true, 'Git unavailable'],
    ])('keeps folder choices accessible for %s', async (_name, failed, label) => {
        const transport = new FixtureTransport({ data: twoFolders() });

        await start({ transport });
        const read = vi.spyOn(transport, 'getFolderGit');

        if (failed) read.mockRejectedValue(new TransportError('git did not answer', 503));
        else read.mockResolvedValue({ isRepository: false });
        await draw(() => ui().setDraftFolder(API.id));
        await settle();
        expect(chip()?.textContent).toBe(`car-rental-api${label}`);
        await press(chip()!);
        expect(menuItem('car-rental-api').getAttribute('aria-checked')).toBe('true');
        expect(menuItem('car-rental').getAttribute('aria-checked')).toBe('false');
        expect(menuItems().some(row => row.hasAttribute('data-new-worktree'))).toBe(false);
    });

    it('shows missing folders but does not allow selecting them', async () => {
        await start({ data: twoFolders() });
        missingFolders.add(API.id);
        await draw();
        await press(chip()!);
        const row = menuItem('car-rental-api');

        expect(row.getAttribute('aria-disabled')).toBe('true');
        expect(row.textContent).toContain('This folder no longer exists');
        await press(row);
        expect(ui().draftFolderId).toBeNull();
    });

    it('returns focus to the control while the selected folder loads and when it answers', async () => {
        const transport = new FixtureTransport({ data: twoFolders() });
        let answer: (git: FolderGit) => void = () => undefined;

        await start({ transport });
        const git = await transport.getFolderGit(FIXTURE_PROJECT_ID, API.id);
        vi.spyOn(transport, 'getFolderGit').mockReturnValue(
            new Promise<FolderGit>(resolve => {
                answer = resolve;
            })
        );
        await press(chip()!);
        await press(menuItem('car-rental-api'));
        await settle();
        await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 30));
        });
        expect(document.activeElement).toBe(chip());
        await act(async () => answer(git));
        await settle();
        await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 30));
        });
        expect(document.activeElement).toBe(chip());
    });

    it('keeps the choice with the page through another chat, back and forward', async () => {
        await pickBase('dev');

        const view = ui().view;

        await draw(() => ui().openChat('c-1'));
        await draw(() => ui().show(view));
        await settle();

        expect(chip()?.textContent).toBe('Worktreefrom dev');
    });
});

describe('the place of the page', () => {
    const pickWorktree = () => chooseWorktree('clowdy/ab12cd34');
    const placeOfPage = () => currentPlace(store.selectedProject!, ui());

    it("is the folder's own checkout in Project checkout and for a new worktree, which the first message makes", async () => {
        expect(placeOfPage().workspace).toBeUndefined();

        await chooseMode('New worktree');

        expect(placeOfPage().workspace).toBeUndefined();
        expect(ui().draftWorkspaceRow).toBeNull();
    });

    it("is the worktree that is picked once the daemon has answered for it, and the folder's own checkout again when it is left", async () => {
        await pickWorktree();

        expect(ui().draftWorkspaceRow).toMatchObject({ path: WORKTREE, managed: true, ready: true });
        expect(placeOfPage()).toMatchObject({
            folder: { id: 'fld_car_rental' },
            workspace: { path: WORKTREE, ready: true },
        });

        await chooseMode('Main worktree');

        expect(ui().draftWorkspaceRow).toBeNull();
        expect(placeOfPage().workspace).toBeUndefined();
    });

    it('makes the chat of the first message work in that same row, so the place does not change when it starts', async () => {
        await pickWorktree();

        const before = placeOfPage();
        const known = new Set(store.selectedProject!.chats.keys());

        await send('Fix the price');

        const [chat] = made(known);

        expect(chat?.workspace?.id).toBe(before.workspace?.id);
        expect(chat?.workspace?.path).toBe(WORKTREE);
    });

    it('asks once for a worktree, and again for another', async () => {
        const transport = new FixtureTransport();
        const asked = vi.spyOn(transport, 'command');

        await start({ transport });
        await pickWorktree();
        await draw(() => ui().setDraftWorkspace({ mode: 'existing', path: WORKTREE }));
        await settle();

        expect(asked.mock.calls.filter(([command]) => command.type === 'workspace.open')).toEqual([
            [{ type: 'workspace.open', projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental', path: WORKTREE }],
        ]);
    });

    it('asks again for a worktree whose row went with the last chat that worked in it, so the page and the chat of its first message share the row that is made', async () => {
        const data = withFixtureWorkspace(createFixtureData());
        const transport = new FixtureTransport({ data });
        const asked = vi.spyOn(transport, 'command');

        await start({ data, transport });
        await pickWorktree();

        const sharing = [...store.selectedProject!.chats.values()].find(chat => chat.workspace?.path === WORKTREE)!;
        const opened = () => asked.mock.calls.filter(([command]) => command.type === 'workspace.open').length;

        expect(ui().draftWorkspaceRow?.id).toBe(sharing.workspace!.id);
        expect(opened()).toBe(1);

        // The only chat that worked in the worktree is deleted while the page is open: its row goes with it, so the page asks for the worktree again.
        await act(async () => {
            await store.command({ type: 'chat.delete', chatId: sharing.id });
        });
        await settle();
        await settle();
        await settle();

        expect(store.selectedProject!.chats.has(sharing.id)).toBe(false);
        expect(opened()).toBe(2);
        expect(ui().draftWorkspaceRow).toMatchObject({ path: WORKTREE });
        expect(placeOfPage().workspace?.path).toBe(WORKTREE);

        const row = ui().draftWorkspaceRow!;
        const known = new Set(store.selectedProject!.chats.keys());

        await send('Fix the price');

        expect(made(known)[0]?.workspace?.id).toBe(row.id);
    });

    it('does not ask again for a row nobody has worked in when the chats change', async () => {
        const transport = new FixtureTransport();
        const asked = vi.spyOn(transport, 'command');

        await start({ transport });
        await pickWorktree();
        await settle();
        await settle();

        expect(asked.mock.calls.filter(([command]) => command.type === 'workspace.open')).toHaveLength(1);
    });

    it('drops an answer for a choice that changed while it was on its way', async () => {
        const transport = new FixtureTransport();
        const original = transport.command.bind(transport);
        let answer: () => void = () => undefined;

        vi.spyOn(transport, 'command').mockImplementation(async command => {
            if (command.type !== 'workspace.open') return original(command);

            await new Promise<void>(resolve => {
                answer = resolve;
            });

            return original(command);
        });
        await start({ transport });
        await pickWorktree();

        expect(ui().draftWorkspaceRow).toBeNull();

        await chooseMode('Main worktree');
        await act(async () => answer());
        await settle();

        expect(ui().draftWorkspaceRow).toBeNull();
        expect(placeOfPage().workspace).toBeUndefined();
    });

    it("stays in the folder's own checkout, without a word, when the daemon refuses or cannot be reached", async () => {
        const transport = new FixtureTransport();
        const original = transport.command.bind(transport);

        vi.spyOn(transport, 'command').mockImplementation(async command =>
            command.type === 'workspace.open' ? refused : original(command)
        );
        await start({ transport });
        await pickWorktree();

        expect(ui().draftWorkspace).toEqual({ mode: 'existing', path: WORKTREE });
        expect(ui().draftWorkspaceRow).toBeNull();
        expect(placeOfPage().workspace).toBeUndefined();
    });
});
