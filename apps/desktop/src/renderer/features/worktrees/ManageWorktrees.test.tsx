// @vitest-environment happy-dom
import { Modal } from '@clowdy/components/Modal';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_EMPTY_PROJECT_ID,
    FIXTURE_PERSONAL_PROJECT_ID,
    FIXTURE_PROJECT_ID,
    FIXTURE_WORKSPACE_CHAT_ID,
    FIXTURE_WORKTREE_SECOND_CHAT_ID,
    type FixtureData,
    withFixtureWorktrees,
} from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { overrideTransport } from '../../daemon/testing';
import { RootStore } from '../../stores';
import { openManageWorktrees } from './ManageWorktrees';

import type { FolderWorktrees } from '@clowdy/protocol';
import type { Transport } from '../../daemon/transport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLOWDY_WORKTREE = '/Users/dev/Clowdy/workspaces/car-rental/ab12cd34/car-rental';
const FOUND_WORKTREE = '/Users/dev/orca/car-rental/search-filters';
const LOCKED_WORKTREE = '/Users/dev/car-rental-hotfix';
const MISSING_WORKTREE = '/Users/dev/car-rental-old';
const DETACHED_WORKTREE = '/Users/dev/orca/car-rental-api/readme';

let store: RootStore;

const memoryStorage = () => {
    const data: Record<string, string> = {};

    return {
        getItem: (key: string) => data[key] ?? null,
        setItem: (key: string, value: string) => void (data[key] = value),
    };
};

/** The window draws on the next animation frame and its content mounts a little later. */
async function settle() {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 60));
    });
}

/** The tooltip that a keyboard focus opens: it is there once the library's own timer has run, which a loaded machine delays past a fixed wait. */
const openTooltip = () =>
    vi.waitFor(
        () => {
            const found = document.querySelector('[role="tooltip"]');

            expect(found).not.toBeNull();

            return found!;
        },
        { timeout: 5000 }
    );

/** The projects' state is loaded by the feed: the chats of the project are there once it has answered. */
async function flush() {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
}

async function open(
    options: { overrides?: Partial<Transport>; data?: FixtureData; folderId?: string; projectId?: string } = {}
) {
    const {
        overrides = {},
        data = withFixtureWorktrees(createFixtureData()),
        folderId,
        projectId = FIXTURE_PROJECT_ID,
    } = options;

    store = new RootStore(overrideTransport(new FixtureTransport({ data }), overrides), { storage: memoryStorage() });
    await store.load();
    store.selectProject(projectId);
    await flush();
    act(() => openManageWorktrees({ root: store, projectId, ...(folderId && { folderId }) }));
    await settle();
}

const dialog = () => document.body.querySelector<HTMLElement>('[data-modal-window]');
const groups = () => [...document.body.querySelectorAll<HTMLElement>('section[data-folder-id]')];
const group = (name: string) => groups().find(section => section.querySelector('h3')?.textContent === name)!;
const rowsOf = (section: HTMLElement) => [...section.querySelectorAll<HTMLElement>('li[data-worktree-path]')];
const row = (path: string) => document.body.querySelector<HTMLElement>(`li[data-worktree-path="${path}"]`)!;
const buttonIn = (parent: HTMLElement, label: string) =>
    parent.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const textButton = (parent: HTMLElement, text: string) =>
    [...parent.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent?.trim() === text);
const click = (element: HTMLElement) => act(async () => element.click());
const isOpen = () => Modal.opened.length > 0;
const items = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const item = (text: string) => items().find(candidate => candidate.textContent?.startsWith(text));
const pressEscape = () =>
    act(
        async () =>
            void document.activeElement?.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })
            )
    );

/** Opens the More menu of a row. */
async function openMore(path: string) {
    await click(row(path).querySelector<HTMLElement>('button[aria-label^="More for"]')!);
    await settle();
}

async function openChats() {
    await click(textButton(row(CLOWDY_WORKTREE), '2 chats')!);
    await settle();
}

/** Opens the More menu of a row, reads its items (their text and whether each is off), and shuts it again, so the next row's menu is the only one on the page. */
async function moreMenu(path: string) {
    await openMore(path);

    const read = items().map(candidate => ({
        text: candidate.textContent!,
        off: candidate.getAttribute('aria-disabled') === 'true',
    }));

    await pressEscape();
    await settle();

    return read;
}

const removeOf = (read: Array<{ text: string; off: boolean }>) => read.find(entry => entry.text.startsWith('Remove'));

/** Flies out the submenu `Open in…` of the menu on show: React Aria opens a submenu on the key. */
async function openIn() {
    await act(async () => {
        const target = item('Open in…')!;

        target.focus();
        target.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true })
        );
    });
    await settle();

    return [
        ...document.body.querySelectorAll<HTMLElement>('[role="menu"][aria-label="Open in"] [role="menuitem"]'),
    ].map(candidate => candidate.textContent);
}

beforeEach(() => {
    // The modal animates by itself, whatever the motion setting; a test that ends while it moves leaves a cancelled animation behind.
    const create = Modal.create.bind(Modal);

    vi.spyOn(Modal, 'create').mockImplementation(options => create({ ...options, animate: false }));
});

afterEach(async () => {
    for (const modal of Modal.opened) await modal.close(false);

    vi.restoreAllMocks();
    delete (window as { desktop?: unknown }).desktop;
    store.dispose();
    document.body.innerHTML = '';
});

describe('Manage worktrees', () => {
    it('adds a named worktree to the selected repository and returns to the refreshed list', async () => {
        // A nested modal needs a visible parent; happy-dom has no layout.
        vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: 640,
            bottom: 480,
            width: 640,
            height: 480,
            toJSON: () => ({}),
        });

        await open({ folderId: 'fld_api' });
        const add = textButton(group('car-rental-api'), 'New worktree')!;

        expect(add.closest('li')).toBe(group('car-rental-api').querySelector('ul')!.lastElementChild);
        await click(add);
        await settle();

        const input = document.querySelector<HTMLInputElement>('input[aria-label="Worktree name"]')!;
        const form = input.closest('form')!;
        const submit = textButton(form, 'Create worktree')!;
        const typeName = (value: string) =>
            act(async () => {
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });

        expect(textButton(form, 'Cancel')?.dataset.variant).toBe('filled');
        expect(form.textContent).not.toContain('Repository:');
        expect(form.textContent).toContain('Settings → Chat → Branch prefix');
        expect(submit.disabled).toBe(true);
        await typeName('../next');
        expect(submit.disabled).toBe(true);
        await typeName('next');
        expect(form.textContent).toContain('Creates a separate Git branch named clowdy/next');
        await click(submit);
        await settle();

        expect(input.isConnected).toBe(false);
        expect(
            rowsOf(group('car-rental-api'))
                .map(row => row.textContent)
                .join()
        ).toContain('clowdy/next');
        expect(groups()).toHaveLength(1);
    });

    it('requires saving edited settings before creating a worktree', async () => {
        await open({ folderId: 'fld_api' });
        const name = dialog()!.querySelector<HTMLInputElement>('input[aria-label="Folder name"]')!;
        const create = textButton(group('car-rental-api'), 'New worktree')!;
        expect(create.disabled).toBe(false);
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Backend');
            name.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(name.value).toBe('Backend');
        expect(create.disabled).toBe(true);
        expect(dialog()!.textContent).toContain('Save folder settings before creating a worktree');
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, '');
            name.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(create.disabled).toBe(false);
    });

    it('keeps worktrees accessible in the personal space without offering unsupported settings', async () => {
        await open({ projectId: FIXTURE_PERSONAL_PROJECT_ID });
        expect(dialog()!.textContent).toContain('Worktrees');
        expect(dialog()!.textContent).toContain('Folder settings are unavailable in the personal space');
        expect(dialog()!.querySelector('input[aria-label="Folder name"]')).toBeNull();
    });

    it('shows only the selected folder, alongside its settings', async () => {
        await open({ folderId: 'fld_api' });
        expect(dialog()!.textContent).toContain('Settings of car-rental-api');
        expect(groups().map(section => section.querySelector('h3')!.textContent)).toEqual(['car-rental-api']);
        expect(rowsOf(group('car-rental-api')).map(item => item.dataset.worktreePath)).toEqual([
            '/Users/dev/car-rental-api',
            '/Users/dev/Clowdy/workspaces/car-rental-api/ab12cd34/car-rental-api',
            DETACHED_WORKTREE,
        ]);
        expect(dialog()!.querySelector('input[aria-label="Folder name"]')).not.toBeNull();
    });

    it("marks the folder's own checkout with its branch and whether it has local changes, and gives it no Remove", async () => {
        await open();

        const main = row('/Users/dev/car-rental');

        expect(main.dataset.main).toBe('true');
        expect(main.textContent).toContain('main');
        expect(main.textContent).toContain('Project checkout');
        expect(main.textContent).toContain('No local changes');
        // The base is no place to compare the folder's own checkout with.
        expect(main.textContent).not.toContain('merged');
        expect(removeOf(await moreMenu('/Users/dev/car-rental'))).toBeUndefined();
        expect(buttonIn(main, 'New chat in this folder: main')).not.toBeNull();
    });

    it('says for each worktree its branch or the commit it is on, how many files are changed, whether its work is in the base, and its path', async () => {
        await open();

        const clowdy = row(CLOWDY_WORKTREE);

        expect(clowdy.textContent).toContain('clowdy/ab12cd34');
        expect(clowdy.textContent).toContain('3 changes');
        expect(clowdy.textContent).toContain('Not merged');

        const found = row(FOUND_WORKTREE);

        expect(found.textContent).toContain('search-filters');
        expect(found.textContent).toContain('2 changes');
        expect(found.textContent).toContain('Not merged');

        const locked = row(LOCKED_WORKTREE);

        expect(locked.textContent).toContain('hotfix/invoice');
        expect(locked.textContent).toContain('No local changes');
    });

    it('has the path of a worktree in the tooltip of its name, and in no line of the row', async () => {
        await open();

        const found = row(FOUND_WORKTREE);

        expect(found.textContent).not.toContain('/Users/dev/orca');

        // The name takes the focus, which a keyboard reaches, and the tooltip opens on it.
        const name = [...found.querySelectorAll<HTMLElement>('[tabindex="0"]')].find(
            element => element.textContent === 'search-filters'
        )!;

        await act(async () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
            name.focus();
        });

        expect((await openTooltip()).textContent).toBe('~/orca/car-rental/search-filters');
    });

    it('gives each row one badge at most, the one that matters most: Locked over Merged, Missing on disk over the rest', async () => {
        await open();

        const badges = (path: string) =>
            [...row(path).querySelectorAll<HTMLElement>('[aria-label="Tags"] [role="row"]')].map(
                badge => badge.textContent
            );

        expect(badges('/Users/dev/car-rental')).toEqual(['Project checkout']);
        // Merged into the base, and locked: the lock is what to know.
        expect(badges(LOCKED_WORKTREE)).toEqual(['Locked']);
        expect(badges(MISSING_WORKTREE)).toEqual(['Missing on disk']);
        expect(badges(FOUND_WORKTREE)).toEqual(['Not merged']);
        expect(badges(CLOWDY_WORKTREE)).toEqual(['Not merged']);
    });

    it('marks a locked worktree and one whose folder is gone, which has no state of its own to show and no chat to start', async () => {
        await open();

        expect(row(LOCKED_WORKTREE).textContent).toContain('Locked');
        expect(row(CLOWDY_WORKTREE).textContent).not.toContain('Locked');

        const missing = row(MISSING_WORKTREE);

        expect(missing.dataset.missing).toBe('true');
        expect(missing.textContent).toContain('Missing on disk');
        expect(missing.textContent).not.toContain('No local changes');
        expect(buttonIn(missing, 'New chat in this worktree: old-pricing')!.disabled).toBe(true);
        // A disabled button takes no hover and no focus, so the reason is on the focusable stand-in beside it.
        expect(missing.querySelector('[role="button"][aria-disabled]')?.getAttribute('aria-label')).toBe(
            'New chat in this worktree: old-pricing'
        );
        expect(row(FOUND_WORKTREE).querySelector('[role="button"][aria-disabled]')).toBeNull();
        expect(row(FOUND_WORKTREE).textContent).not.toContain('Missing on disk');
        expect(buttonIn(row(FOUND_WORKTREE), 'New chat in this worktree: search-filters')!.disabled).toBe(false);
    });

    it('shows a chat count beside the changes and previews the chat names on keyboard focus', async () => {
        await open();

        const worktree = row(CLOWDY_WORKTREE);
        const count = textButton(worktree, '2 chats')!;

        expect(worktree.textContent).toContain('3 changes·2 chats');
        expect(worktree.textContent).not.toContain('Weekend surcharge in a worktree');
        expect(textButton(row(FOUND_WORKTREE), '0 chats')).toBeUndefined();

        await act(async () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
            count.focus();
        });

        const tooltip = await openTooltip();

        expect(tooltip.textContent).toContain('Weekend surcharge in a worktree');
        expect(tooltip.textContent).toContain('Show the weekend surcharge in the form (archived)');
    });

    it('opens the chat that works in a worktree when it is pressed, and closes the dialog', async () => {
        await open();
        await openChats();
        await click(item('Weekend surcharge in a worktree')!);
        await flush();

        expect(store.ui.forProject(FIXTURE_PROJECT_ID).chatId).toBe(FIXTURE_WORKSPACE_CHAT_ID);
        expect(isOpen()).toBe(false);
    });

    it('brings an archived chat out of the archive, as a link to one does, when it is pressed', async () => {
        await open();
        await openChats();
        await click(item('Show the weekend surcharge in the form')!);
        await flush();

        const ui = store.ui.forProject(FIXTURE_PROJECT_ID);

        expect(ui.chatId).toBe(FIXTURE_WORKTREE_SECOND_CHAT_ID);
        expect(
            store.projectState(FIXTURE_PROJECT_ID)!.chats.get(FIXTURE_WORKTREE_SECOND_CHAT_ID)!.archivedAt
        ).toBeUndefined();
        expect(isOpen()).toBe(false);
    });

    it('opens the new-chat page in the worktree, in its folder, when New chat in this worktree is pressed, and closes the dialog', async () => {
        await open();
        await click(buttonIn(row(FOUND_WORKTREE), 'New chat in this worktree: search-filters')!);

        const ui = store.ui.forProject(FIXTURE_PROJECT_ID);

        expect(ui.draft).toBe(true);
        // The project's main folder is no folder of its own: a chat there follows the main folder.
        expect(ui.draftFolderId).toBeNull();
        expect(ui.draftWorkspace).toEqual({ mode: 'existing', path: FOUND_WORKTREE });
        expect(isOpen()).toBe(false);
    });

    it("opens the new-chat page for another folder of the project, in that folder's worktree", async () => {
        await open({ folderId: 'fld_api' });
        await click(buttonIn(row(DETACHED_WORKTREE), 'New chat in this worktree: Detached at 3a2b1c0')!);

        const ui = store.ui.forProject(FIXTURE_PROJECT_ID);

        expect(ui.draftFolderId).toBe('fld_api');
        expect(ui.draftWorkspace).toEqual({ mode: 'existing', path: DETACHED_WORKTREE });
    });

    it("opens the new-chat page in the folder's own checkout, with no worktree, when New chat in this folder is pressed", async () => {
        await open({ folderId: 'fld_api' });

        // Start from a worktree, as the page may have had one chosen: the checkout is the folder itself.
        store.ui.forProject(FIXTURE_PROJECT_ID).openDraft([], null, { mode: 'existing', path: FOUND_WORKTREE });
        await click(buttonIn(row('/Users/dev/car-rental-api'), 'New chat in this folder: feature/payments')!);

        const ui = store.ui.forProject(FIXTURE_PROJECT_ID);

        expect(ui.draft).toBe(true);
        expect(ui.draftFolderId).toBe('fld_api');
        expect(ui.draftWorkspace).toBeNull();
        expect(isOpen()).toBe(false);
    });

    it('does not hand the focus back to the button that opened it when it closes for a new chat or for a chat, which the page it shows takes', async () => {
        const trigger = document.body.appendChild(document.createElement('button'));

        trigger.focus();
        await open();
        await click(buttonIn(row(FOUND_WORKTREE), 'New chat in this worktree: search-filters')!);

        expect(isOpen()).toBe(false);
        expect(document.activeElement).not.toBe(trigger);

        trigger.focus();
        await open();
        await openChats();
        await click(item('Weekend surcharge in a worktree')!);
        await flush();

        expect(isOpen()).toBe(false);
        expect(document.activeElement).not.toBe(trigger);
    });

    it("draws Remove in the More menu of every worktree but the folder's own checkout, and holds it off for a lock and for a chat that works in the worktree", async () => {
        await open();

        for (const path of [FOUND_WORKTREE, MISSING_WORKTREE])
            expect(removeOf(await moreMenu(path))?.off, path).toBe(false);

        for (const path of [CLOWDY_WORKTREE, LOCKED_WORKTREE])
            expect(removeOf(await moreMenu(path))?.off, path).toBe(true);

        expect(removeOf(await moreMenu('/Users/dev/car-rental'))).toBeUndefined();
        // Remove is not a button of the row any more.
        expect(row(FOUND_WORKTREE).querySelector('button[aria-label^="Remove"]')).toBeNull();
    });

    it('opens no confirmation from a Remove that is off, for a chat or for a lock', async () => {
        await open();

        for (const path of [CLOWDY_WORKTREE, LOCKED_WORKTREE]) {
            await openMore(path);
            await click(item('Remove')!);
            await pressEscape();
            await settle();
        }

        expect(Modal.opened).toHaveLength(1);
    });

    it('says a worktree whose folder is gone has only its record to remove', async () => {
        await open();

        expect(removeOf(await moreMenu(MISSING_WORKTREE))?.text).toBe('Remove record…');
        expect(removeOf(await moreMenu(FOUND_WORKTREE))?.text).toBe('Remove…');
    });

    it('names, under a Remove that is off, the reason the daemon gave, and under no other', async () => {
        await open();

        expect(removeOf(await moreMenu(LOCKED_WORKTREE))?.text).toContain('Git has it locked: on an external drive');
        expect(removeOf(await moreMenu(CLOWDY_WORKTREE))?.text).toContain('A chat works in it');
        // Nothing stops a worktree that nobody works in and nobody locked: its Remove waits for the confirmation, not for a reason.
        expect(removeOf(await moreMenu(FOUND_WORKTREE))?.text).toBe('Remove…');
    });

    it('has no line in the row for why a Remove is off: the reason is under Remove in the More menu', async () => {
        await open();

        // Locked, and a chat works in it: the row has the facts and the chats, and the menu has the reason.
        for (const path of [CLOWDY_WORKTREE, LOCKED_WORKTREE])
            expect(row(path).textContent, path).not.toContain("Can't remove");
    });

    it("keeps Remove off for the repository's own working tree, when a row that is not the folder's checkout is one", async () => {
        const worktree = {
            branch: 'main',
            head: 'a1b2c3d',
            missing: false,
            changes: 0,
            submodules: false,
            managed: false,
            chats: [],
        };
        const getProjectWorktrees = async (): Promise<FolderWorktrees[]> => [
            {
                folderId: 'fld_car_rental',
                name: 'car-rental',
                isRepository: true,
                worktrees: [
                    { ...worktree, path: '/Users/dev/car-rental', branch: 'feature', main: true, blocked: 'main' },
                    { ...worktree, path: '/Users/dev/car-rental-primary', main: false, blocked: 'main' },
                ],
            },
        ];

        await open({ overrides: { getProjectWorktrees } });

        const remove = removeOf(await moreMenu('/Users/dev/car-rental-primary'));

        expect(remove?.off).toBe(true);
        expect(remove?.text).toContain("The repository's own working tree");
    });

    it('has only two buttons at the end of a row, New chat and More, and the rest in the More menu', async () => {
        await open();

        const buttons = (path: string) =>
            [...row(path).querySelectorAll<HTMLElement>('[class*="actions"] button')].map(button =>
                button.getAttribute('aria-label')
            );

        expect(buttons(FOUND_WORKTREE)).toEqual([
            'New chat in this worktree: search-filters',
            'More for search-filters',
        ]);
        expect(buttons('/Users/dev/car-rental')).toEqual(['New chat in this folder: main', 'More for main']);
    });

    it('opens the More menu of a worktree with New chat, the copy of its path and Open in…, then Remove under a separator, and without Open in Files, which would act behind the dialog', async () => {
        (window as { desktop?: unknown }).desktop = {
            openPath: vi.fn(),
            getOpenApps: async () => ({ editors: [], terminals: [], fileManagers: [{ id: 'finder', name: 'Finder' }] }),
        };
        await open();
        await openMore(FOUND_WORKTREE);

        expect(items().map(candidate => candidate.textContent)).toEqual([
            'New chat',
            'Copy path',
            'Open in…',
            'Remove…',
        ]);
        expect(document.body.querySelectorAll('[role="menu"] [role="separator"]')).toHaveLength(1);
        expect(item('Remove')!.previousElementSibling?.getAttribute('role')).toBe('separator');
        // The programs of the computer are in the submenu.
        expect(await openIn()).toEqual(['Open in Finder', 'Open in GitHub']);
    });

    it("gives the folder's own checkout the same menu without Remove, and its place is no place of the dialog: no Open in Files", async () => {
        (window as { desktop?: unknown }).desktop = {
            openPath: vi.fn(),
            getOpenApps: async () => ({ editors: [], terminals: [], fileManagers: [{ id: 'finder', name: 'Finder' }] }),
        };
        await open();
        // The window works in the folder's own checkout, which is the place of the first row: an `OpenWithMenu` would offer Open in Files there.
        await openMore('/Users/dev/car-rental');

        expect(items().map(candidate => candidate.textContent)).toEqual(['New chat', 'Copy path', 'Open in…']);
        expect(document.body.querySelector('[role="menu"] [role="separator"]')).toBeNull();
    });

    it('offers only GitHub to open a worktree in, in a page that is not the desktop app, which has no programs', async () => {
        await open();
        await openMore(FOUND_WORKTREE);

        expect(await openIn()).toEqual(['Open in GitHub']);
    });

    it('marks a row open while its More menu or its right-click menu is, so its buttons stay shown after the pointer has left', async () => {
        await open();

        expect(row(FOUND_WORKTREE).dataset.open).toBeUndefined();

        await openMore(FOUND_WORKTREE);

        expect(row(FOUND_WORKTREE).dataset.open).toBe('true');

        await pressEscape();
        await settle();

        expect(row(FOUND_WORKTREE).dataset.open).toBeUndefined();

        await act(
            async () =>
                void row(FOUND_WORKTREE).dispatchEvent(
                    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })
                )
        );
        await settle();

        expect(row(FOUND_WORKTREE).dataset.open).toBe('true');
    });

    it('opens the same menu on a right-click anywhere on the row, and shuts it when an item is chosen', async () => {
        await open();
        await act(
            async () =>
                void row(FOUND_WORKTREE)
                    .querySelector('[class*="title"]')!
                    .dispatchEvent(
                        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })
                    )
        );
        await settle();

        expect(items().map(candidate => candidate.textContent)).toEqual([
            'New chat',
            'Copy path',
            'Open in…',
            'Remove…',
        ]);

        await click(item('New chat')!);
        await settle();

        expect(store.ui.forProject(FIXTURE_PROJECT_ID).draftWorkspace).toEqual({
            mode: 'existing',
            path: FOUND_WORKTREE,
        });
        expect(isOpen()).toBe(false);
    });

    it('starts a new chat in the worktree from the More menu as the button does, and closes the dialog', async () => {
        await open();
        await openMore(FOUND_WORKTREE);
        await click(item('New chat')!);

        const ui = store.ui.forProject(FIXTURE_PROJECT_ID);

        expect(ui.draft).toBe(true);
        expect(ui.draftWorkspace).toEqual({ mode: 'existing', path: FOUND_WORKTREE });
        expect(isOpen()).toBe(false);
    });

    it('turns New chat off in the More menu for a worktree whose folder is gone', async () => {
        await open();

        expect((await moreMenu(MISSING_WORKTREE)).find(entry => entry.text === 'New chat')?.off).toBe(true);
    });

    it('reads the worktrees when it opens and again each time the window gets focus', async () => {
        const getProjectWorktrees = vi.fn((projectId: string) =>
            new FixtureTransport({ data: withFixtureWorktrees(createFixtureData()) }).getProjectWorktrees(projectId)
        );

        await open({ overrides: { getProjectWorktrees } });

        expect(getProjectWorktrees).toHaveBeenCalledTimes(1);
        expect(getProjectWorktrees).toHaveBeenCalledWith(FIXTURE_PROJECT_ID);

        await act(async () => void window.dispatchEvent(new Event('focus')));
        await settle();

        expect(getProjectWorktrees).toHaveBeenCalledTimes(2);
        // The list stays while the next read runs.
        expect(groups()).toHaveLength(1);
    });

    it('shows what is changed since the last read when the window gets focus again', async () => {
        const data = withFixtureWorktrees(createFixtureData());

        await open({ data });

        expect(row(FOUND_WORKTREE).textContent).toContain('2 changes');

        data.worktrees!['/Users/dev/car-rental']![0]!.changes = 7;
        await act(async () => void window.dispatchEvent(new Event('focus')));
        await settle();

        expect(row(FOUND_WORKTREE).textContent).toContain('7 changes');
    });

    it('drops an answer that comes after a newer read, so the list is never put back to what an older read saw', async () => {
        const base = new FixtureTransport({ data: withFixtureWorktrees(createFixtureData()) });
        const answers: Array<(groups: FolderWorktrees[]) => void> = [];
        const getProjectWorktrees = vi.fn((projectId: string) => {
            if (getProjectWorktrees.mock.calls.length === 1) return base.getProjectWorktrees(projectId);

            return new Promise<FolderWorktrees[]>(resolve => answers.push(resolve));
        });
        const withChanges = async (changes: number) => {
            const read = await base.getProjectWorktrees(FIXTURE_PROJECT_ID);

            read[0]!.worktrees.find(worktree => worktree.path === FOUND_WORKTREE)!.changes = changes;

            return read;
        };

        await open({ overrides: { getProjectWorktrees } });

        // Two reads are on their way, and the second one answers first.
        await act(async () => void window.dispatchEvent(new Event('focus')));
        await act(async () => void window.dispatchEvent(new Event('focus')));
        await act(async () => answers[1]!(await withChanges(7)));

        expect(row(FOUND_WORKTREE).textContent).toContain('7 changes');

        await act(async () => answers[0]!(await withChanges(5)));

        expect(row(FOUND_WORKTREE).textContent).toContain('7 changes');
        expect(row(FOUND_WORKTREE).textContent).not.toContain('5 changes');
    });

    it('waits with a loading state, and then shows the list', async () => {
        let answer!: (groups: FolderWorktrees[]) => void;
        const getProjectWorktrees = vi.fn(
            () =>
                new Promise<FolderWorktrees[]>(resolve => {
                    answer = resolve;
                })
        );

        await open({ overrides: { getProjectWorktrees } });

        expect(dialog()!.textContent).toContain('Loading worktrees…');
        expect(groups()).toEqual([]);
        // The table the list will be, in two rows of blocks, with no spinner: the same card and the same rows, so the list takes the place without a jump.
        expect(dialog()!.querySelectorAll('ul[data-skeleton] > li')).toHaveLength(2);
        expect(dialog()!.querySelector('[role="status"]')?.textContent).toBe('Loading worktrees…');
        expect(dialog()!.querySelector('[aria-busy="true"]')).not.toBeNull();

        await act(async () =>
            answer([
                {
                    folderId: 'fld_car_rental',
                    name: 'car-rental',
                    isRepository: true,
                    worktrees: [
                        {
                            path: '/Users/dev/car-rental',
                            branch: 'main',
                            head: 'a1b2c3d',
                            main: true,
                            missing: false,
                            changes: 0,
                            submodules: false,
                            managed: false,
                            chats: [],
                            blocked: 'main',
                        },
                    ],
                },
            ])
        );

        expect(dialog()!.textContent).not.toContain('Loading worktrees…');
        expect(dialog()!.querySelector('[data-skeleton]')).toBeNull();
        expect(rowsOf(group('car-rental'))).toHaveLength(1);
    });

    it('says it could not read the worktrees, and reads again on Try again', async () => {
        const base = new FixtureTransport({ data: withFixtureWorktrees(createFixtureData()) });
        const getProjectWorktrees = vi.fn(async (projectId: string) => {
            if (getProjectWorktrees.mock.calls.length === 1) throw new Error('git did not answer');

            return base.getProjectWorktrees(projectId);
        });

        await open({ overrides: { getProjectWorktrees } });

        expect(dialog()!.textContent).toContain("Couldn't load the worktrees");
        expect(groups()).toEqual([]);

        await click(textButton(dialog()!, 'Try again')!);
        await settle();

        expect(dialog()!.textContent).not.toContain("Couldn't load the worktrees");
        expect(groups()).toHaveLength(1);
    });

    it('keeps the list it has and says so when a later read fails', async () => {
        const base = new FixtureTransport({ data: withFixtureWorktrees(createFixtureData()) });
        const getProjectWorktrees = vi.fn(async (projectId: string) => {
            if (getProjectWorktrees.mock.calls.length > 1) throw new Error('git did not answer');

            return base.getProjectWorktrees(projectId);
        });

        await open({ overrides: { getProjectWorktrees } });
        await act(async () => void window.dispatchEvent(new Event('focus')));
        await settle();

        expect(groups()).toHaveLength(1);
        expect(dialog()!.textContent).toContain("Couldn't refresh the list");
        expect(dialog()!.textContent).not.toContain("Couldn't load the worktrees");
    });

    it('puts a Try again beside the note that the list could not be refreshed, which reads it again and clears the note', async () => {
        const base = new FixtureTransport({ data: withFixtureWorktrees(createFixtureData()) });
        const getProjectWorktrees = vi.fn(async (projectId: string) => {
            if (getProjectWorktrees.mock.calls.length === 2) throw new Error('git did not answer');

            return base.getProjectWorktrees(projectId);
        });

        await open({ overrides: { getProjectWorktrees } });
        await act(async () => void window.dispatchEvent(new Event('focus')));
        await settle();

        expect(dialog()!.textContent).toContain("Couldn't refresh the list");

        await click(textButton(dialog()!, 'Try again')!);
        await settle();

        expect(getProjectWorktrees).toHaveBeenCalledTimes(3);
        expect(dialog()!.textContent).not.toContain("Couldn't refresh the list");
        expect(groups()).toHaveLength(1);
    });

    it("says so when none of the project's folders is a repository", async () => {
        const base = new FixtureTransport({ data: withFixtureWorktrees(createFixtureData()) });
        const getProjectWorktrees = async (projectId: string) =>
            (await base.getProjectWorktrees(projectId)).map(entry => ({
                ...entry,
                isRepository: false,
                worktrees: [],
            }));

        await open({ overrides: { getProjectWorktrees } });

        expect(groups()).toEqual([]);
        expect(dialog()!.textContent).toContain('This folder is not a git repository');
    });

    it('stays open when the window shows another project, as it does when it is opened from Settings for a project the window does not show', async () => {
        await open();
        await act(async () => store.selectProject(FIXTURE_EMPTY_PROJECT_ID));
        await settle();

        expect(isOpen()).toBe(true);
        expect(groups()).toHaveLength(1);
    });

    it('takes the person to the project with Settings shut when a new chat or a chat is chosen, though the window showed another project with Settings open', async () => {
        await open();
        await act(async () => store.selectProject(FIXTURE_EMPTY_PROJECT_ID));
        act(() => store.ui.openProjectSettings(FIXTURE_PROJECT_ID));
        await click(buttonIn(row(FOUND_WORKTREE), 'New chat in this worktree: search-filters')!);

        expect(store.selectedProjectId).toBe(FIXTURE_PROJECT_ID);
        expect(store.ui.settingsOpen).toBe(false);
        expect(store.ui.forProject(FIXTURE_PROJECT_ID).draft).toBe(true);
        expect(isOpen()).toBe(false);
    });
});
