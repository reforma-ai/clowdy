// @vitest-environment happy-dom
import { Modal } from '@clowdy/components/Modal';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PROJECT_ID, FIXTURE_WORKSPACE_CHAT_ID, FIXTURE_WORKTREE_SECOND_CHAT_ID, withFixtureWorktrees, type FixtureData } from '../../daemon/fixtureData';
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

    return { getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => void (data[key] = value) };
};

/** The window draws on the next animation frame and its content mounts a little later. */
async function settle() {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 60));
    });
}

/** The projects' state is loaded by the feed: the chats of the project are there once it has answered. */
async function flush() {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
}

async function open(options: { overrides?: Partial<Transport>; data?: FixtureData; folderId?: string } = {}) {
    const { overrides = {}, data = withFixtureWorktrees(createFixtureData()), folderId } = options;

    store = new RootStore(overrideTransport(new FixtureTransport({ data }), overrides), { storage: memoryStorage() });
    await store.load();
    store.selectProject(FIXTURE_PROJECT_ID);
    await flush();
    act(() => openManageWorktrees({ root: store, projectId: FIXTURE_PROJECT_ID, ...(folderId && { folderId }) }));
    await settle();
}

const dialog = () => document.body.querySelector<HTMLElement>('[data-modal-window]');
const groups = () => [...document.body.querySelectorAll<HTMLElement>('section[data-folder-id]')];
const group = (name: string) => groups().find(section => section.querySelector('h3')?.textContent === name)!;
const rowsOf = (section: HTMLElement) => [...section.querySelectorAll<HTMLElement>('li[data-worktree-path]')];
const row = (path: string) => document.body.querySelector<HTMLElement>(`li[data-worktree-path="${ path }"]`)!;
const buttonIn = (parent: HTMLElement, label: string) => parent.querySelector<HTMLButtonElement>(`button[aria-label="${ label }"]`);
const textButton = (parent: HTMLElement, text: string) => [...parent.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent?.trim() === text);
const click = (element: HTMLElement) => act(async () => element.click());
const isOpen = () => Modal.opened.length > 0;

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
    it('lists the project\'s repositories, each with its own checkout first and a row for every worktree git lists, and no group for a folder that is no repository', async () => {
        await open();

        expect(dialog()!.textContent).toContain('Manage worktrees');
        expect(groups().map(section => section.querySelector('h3')!.textContent)).toEqual(['car-rental', 'car-rental-api']);
        expect(rowsOf(group('car-rental')).map(item => item.dataset.worktreePath)).toEqual(['/Users/dev/car-rental', CLOWDY_WORKTREE, FOUND_WORKTREE, LOCKED_WORKTREE, MISSING_WORKTREE]);
        expect(rowsOf(group('car-rental-api')).map(item => item.dataset.worktreePath)).toEqual(['/Users/dev/car-rental-api', '/Users/dev/Clowdy/workspaces/car-rental-api/ab12cd34/car-rental-api', DETACHED_WORKTREE]);
        expect(document.body.textContent).not.toContain('notes');
    });

    it('marks the folder\'s own checkout with its branch and whether it is clean, and gives it no Remove', async () => {
        await open();

        const main = row('/Users/dev/car-rental');

        expect(main.dataset.main).toBe('true');
        expect(main.textContent).toContain('main');
        expect(main.textContent).toContain('Project checkout');
        expect(main.textContent).toContain('Clean');
        // The base is no place to compare the folder's own checkout with.
        expect(main.textContent).not.toContain('merged');
        expect(buttonIn(main, 'Remove main')).toBeNull();
        expect(buttonIn(main, 'New chat in this folder: main')).not.toBeNull();
    });

    it('says for each worktree its branch or the commit it is on, how many files are changed, whether its work is in the base, and its path', async () => {
        await open();

        const clowdy = row(CLOWDY_WORKTREE);

        expect(clowdy.textContent).toContain('clowdy/ab12cd34');
        expect(clowdy.textContent).toContain('3 changed');
        expect(clowdy.textContent).toContain('Not merged');

        const found = row(FOUND_WORKTREE);

        expect(found.textContent).toContain('search-filters');
        expect(found.textContent).toContain('2 changed');
        expect(found.textContent).toContain('Not merged');

        const locked = row(LOCKED_WORKTREE);

        expect(locked.textContent).toContain('hotfix/invoice');
        expect(locked.textContent).toContain('Clean');
        expect(locked.textContent).toContain('Merged');
        expect(locked.textContent).not.toContain('Not merged');

        // A worktree on a detached HEAD is named by its commit.
        expect(row(DETACHED_WORKTREE).textContent).toContain('Detached at 3a2b1c0');
    });

    it('marks a locked worktree and one whose folder is gone, which has no state of its own to show and no chat to start', async () => {
        await open();

        expect(row(LOCKED_WORKTREE).textContent).toContain('Locked');
        expect(row(CLOWDY_WORKTREE).textContent).not.toContain('Locked');

        const missing = row(MISSING_WORKTREE);

        expect(missing.dataset.missing).toBe('true');
        expect(missing.textContent).toContain('Missing on disk');
        expect(missing.textContent).not.toContain('Clean');
        expect(buttonIn(missing, 'New chat in this worktree: old-pricing')!.disabled).toBe(true);
        // A disabled button takes no hover and no focus, so the reason is on the focusable stand-in beside it.
        expect(missing.querySelector('[role="button"][aria-disabled]')?.getAttribute('aria-label')).toBe('New chat in this worktree: old-pricing');
        expect(row(FOUND_WORKTREE).querySelector('[role="button"][aria-disabled]')).toBeNull();
        expect(row(FOUND_WORKTREE).textContent).not.toContain('Missing on disk');
        expect(buttonIn(row(FOUND_WORKTREE), 'New chat in this worktree: search-filters')!.disabled).toBe(false);
    });

    it('lists the chats that work in a worktree, the archived ones too, and none for a worktree nobody works in', async () => {
        await open();

        const chats = row(CLOWDY_WORKTREE).querySelector<HTMLElement>('[aria-label="Chats"]')!;
        const buttons = [...chats.querySelectorAll('button')].map(button => button.textContent);

        expect(buttons).toEqual(['Weekend surcharge in a worktree', 'Show the weekend surcharge in the formArchived']);
        expect(row(FOUND_WORKTREE).querySelector('[aria-label="Chats"]')).toBeNull();
    });

    it('opens the chat that works in a worktree when it is pressed, and closes the dialog', async () => {
        await open();
        await click(textButton(row(CLOWDY_WORKTREE), 'Weekend surcharge in a worktree')!);
        await flush();

        expect(store.ui.forProject(FIXTURE_PROJECT_ID).chatId).toBe(FIXTURE_WORKSPACE_CHAT_ID);
        expect(isOpen()).toBe(false);
    });

    it('brings an archived chat out of the archive, as a link to one does, when it is pressed', async () => {
        await open();
        await click(textButton(row(CLOWDY_WORKTREE), 'Show the weekend surcharge in the formArchived')!);
        await flush();

        const ui = store.ui.forProject(FIXTURE_PROJECT_ID);

        expect(ui.chatId).toBe(FIXTURE_WORKTREE_SECOND_CHAT_ID);
        expect(store.projectState(FIXTURE_PROJECT_ID)!.chats.get(FIXTURE_WORKTREE_SECOND_CHAT_ID)!.archivedAt).toBeUndefined();
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

    it('opens the new-chat page for another folder of the project, in that folder\'s worktree', async () => {
        await open();
        await click(buttonIn(row(DETACHED_WORKTREE), 'New chat in this worktree: Detached at 3a2b1c0')!);

        const ui = store.ui.forProject(FIXTURE_PROJECT_ID);

        expect(ui.draftFolderId).toBe('fld_api');
        expect(ui.draftWorkspace).toEqual({ mode: 'existing', path: DETACHED_WORKTREE });
    });

    it('opens the new-chat page in the folder\'s own checkout, with no worktree, when New chat in this folder is pressed', async () => {
        await open();

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
        await click(textButton(row(CLOWDY_WORKTREE), 'Weekend surcharge in a worktree')!);
        await flush();

        expect(isOpen()).toBe(false);
        expect(document.activeElement).not.toBe(trigger);
    });

    it('scrolls the group of the folder it was opened for into view, once', async () => {
        const scrolled: Array<string | undefined> = [];

        vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function scroll(this: Element) {
            scrolled.push((this as HTMLElement).dataset.folderId);
        });
        await open({ folderId: 'fld_api' });

        expect(scrolled).toEqual(['fld_api']);

        // A read the window's focus makes does not move the person's scroll.
        await act(async () => void window.dispatchEvent(new Event('focus')));
        await settle();

        expect(scrolled).toEqual(['fld_api']);
    });

    it('draws Remove for every worktree but the folder\'s own checkout, and holds it off for a lock and for a chat that works in the worktree', async () => {
        await open();

        const remove = (path: string) => row(path).querySelector<HTMLButtonElement>('button[aria-label^="Remove "]');

        for (const path of [CLOWDY_WORKTREE, FOUND_WORKTREE, LOCKED_WORKTREE, MISSING_WORKTREE]) expect(remove(path), path).not.toBeNull();

        expect(remove(CLOWDY_WORKTREE)!.disabled).toBe(true);
        expect(remove(LOCKED_WORKTREE)!.disabled).toBe(true);
        expect(remove(FOUND_WORKTREE)!.disabled).toBe(false);
        expect(remove(MISSING_WORKTREE)!.disabled).toBe(false);
        expect(row('/Users/dev/car-rental').querySelector('button[aria-label^="Remove "]')).toBeNull();
    });

    it('opens no confirmation from a Remove that is off, for a chat or for a lock', async () => {
        await open();
        await click(buttonIn(row(CLOWDY_WORKTREE), 'Remove clowdy/ab12cd34')!);
        await click(buttonIn(row(LOCKED_WORKTREE), 'Remove hotfix/invoice')!);

        expect(Modal.opened).toHaveLength(1);
    });

    it('says a worktree whose folder is gone has only its record to remove', async () => {
        await open();

        expect(buttonIn(row(MISSING_WORKTREE), 'Remove record of old-pricing')).not.toBeNull();
        expect(buttonIn(row(MISSING_WORKTREE), 'Remove old-pricing')).toBeNull();
    });

    it('names, beside a Remove that is off, the reason the daemon gave', async () => {
        await open();

        const stand = (path: string) => row(path).querySelector<HTMLElement>('[role="button"][aria-disabled]');

        expect(stand(LOCKED_WORKTREE)?.getAttribute('aria-label')).toBe('Remove hotfix/invoice');
        expect(stand(CLOWDY_WORKTREE)?.getAttribute('aria-label')).toBe('Remove clowdy/ab12cd34');
        // Nothing stops a worktree that nobody works in and nobody locked: its Remove waits for the confirmation, not for a reason.
        expect(stand(FOUND_WORKTREE)).toBeNull();
    });

    it('says in the row, not only on hover, why a Remove is off, and says it once', async () => {
        await open();

        const note = 'Can\'t remove';
        const occurrences = (text: string) => text.split(note).length - 1;

        // A chat works in it: the reason leads the chats it is about, and the chats do not repeat it.
        const clowdy = row(CLOWDY_WORKTREE);

        expect(clowdy.textContent).toContain('Can\'t remove while these chats work in it');
        expect(occurrences(clowdy.textContent!)).toBe(1);
        expect(clowdy.querySelector('[aria-label="Chats"]')!.textContent).not.toContain(note);

        // Locked: git's reason when it gave one.
        expect(row(LOCKED_WORKTREE).textContent).toContain('Can\'t remove: git has it locked (on an external drive)');
        expect(occurrences(row(LOCKED_WORKTREE).textContent!)).toBe(1);

        // Nothing stops it, a missing folder is no reason (it has Remove record), and the folder's own checkout has no Remove to explain.
        for (const path of [FOUND_WORKTREE, MISSING_WORKTREE, DETACHED_WORKTREE, '/Users/dev/car-rental']) expect(row(path).textContent, path).not.toContain(note);
    });

    it('says the repository\'s own working tree, when a row that is not the folder\'s checkout is one, cannot be removed', async () => {
        const worktree = { branch: 'main', head: 'a1b2c3d', missing: false, changes: 0, submodules: false, managed: false, chats: [] };
        const getProjectWorktrees = async (): Promise<FolderWorktrees[]> => [{
            folderId: 'fld_car_rental',
            name: 'car-rental',
            isRepository: true,
            worktrees: [
                { ...worktree, path: '/Users/dev/car-rental', branch: 'feature', main: true, blocked: 'main' },
                { ...worktree, path: '/Users/dev/car-rental-primary', main: false, blocked: 'main' },
            ],
        }];

        await open({ overrides: { getProjectWorktrees } });

        expect(row('/Users/dev/car-rental-primary').textContent).toContain('Can\'t remove: it is the repository\'s own working tree');
        expect(buttonIn(row('/Users/dev/car-rental-primary'), 'Remove main')!.disabled).toBe(true);
        expect(row('/Users/dev/car-rental').textContent).not.toContain('Can\'t remove');
    });

    it('offers the programs of the computer for a worktree in the desktop app, and nothing to open it in a page that is not', async () => {
        await open();

        expect(buttonIn(row(FOUND_WORKTREE), 'Open search-filters')).toBeNull();

        await act(async () => Modal.opened[0]!.close(false));
        (window as { desktop?: unknown }).desktop = { openPath: vi.fn(), getOpenApps: async () => ({ editors: [], terminals: [], fileManagers: [{ id: 'finder', name: 'Finder' }] }) };
        await open();

        expect(buttonIn(row(FOUND_WORKTREE), 'Open search-filters')).not.toBeNull();
    });

    it('opens the menu of a worktree with the programs of the computer and the copy of its path, and without Open in Files, which would act behind the dialog', async () => {
        (window as { desktop?: unknown }).desktop = { openPath: vi.fn(), getOpenApps: async () => ({ editors: [], terminals: [], fileManagers: [{ id: 'finder', name: 'Finder' }] }) };
        await open();
        // The window works in the folder's own checkout, which is the place of the first row: its menu would offer Open in Files if the dialog were a place.
        await click(buttonIn(row('/Users/dev/car-rental'), 'Open main')!);
        await settle();

        expect([...document.body.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(['Copy path', 'Open in…']);
    });

    it('reads the worktrees when it opens and again each time the window gets focus', async () => {
        const getProjectWorktrees = vi.fn((projectId: string) => new FixtureTransport({ data: withFixtureWorktrees(createFixtureData()) }).getProjectWorktrees(projectId));

        await open({ overrides: { getProjectWorktrees } });

        expect(getProjectWorktrees).toHaveBeenCalledTimes(1);
        expect(getProjectWorktrees).toHaveBeenCalledWith(FIXTURE_PROJECT_ID);

        await act(async () => void window.dispatchEvent(new Event('focus')));
        await settle();

        expect(getProjectWorktrees).toHaveBeenCalledTimes(2);
        // The list stays while the next read runs.
        expect(groups()).toHaveLength(2);
    });

    it('shows what is changed since the last read when the window gets focus again', async () => {
        const data = withFixtureWorktrees(createFixtureData());

        await open({ data });

        expect(row(FOUND_WORKTREE).textContent).toContain('2 changed');

        data.worktrees!['/Users/dev/car-rental']![0]!.changes = 7;
        await act(async () => void window.dispatchEvent(new Event('focus')));
        await settle();

        expect(row(FOUND_WORKTREE).textContent).toContain('7 changed');
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

        expect(row(FOUND_WORKTREE).textContent).toContain('7 changed');

        await act(async () => answers[0]!(await withChanges(5)));

        expect(row(FOUND_WORKTREE).textContent).toContain('7 changed');
        expect(row(FOUND_WORKTREE).textContent).not.toContain('5 changed');
    });

    it('waits with a loading state, and then shows the list', async () => {
        let answer!: (groups: FolderWorktrees[]) => void;
        const getProjectWorktrees = vi.fn(() => new Promise<FolderWorktrees[]>((resolve) => {
            answer = resolve;
        }));

        await open({ overrides: { getProjectWorktrees } });

        expect(dialog()!.textContent).toContain('Loading worktrees…');
        expect(groups()).toEqual([]);

        await act(async () => answer([{ folderId: 'fld_car_rental', name: 'car-rental', isRepository: true, worktrees: [{ path: '/Users/dev/car-rental', branch: 'main', head: 'a1b2c3d', main: true, missing: false, changes: 0, submodules: false, managed: false, chats: [], blocked: 'main' }] }]));

        expect(dialog()!.textContent).not.toContain('Loading worktrees…');
        expect(rowsOf(group('car-rental'))).toHaveLength(1);
    });

    it('says it could not read the worktrees, and reads again on Try again', async () => {
        const base = new FixtureTransport({ data: withFixtureWorktrees(createFixtureData()) });
        const getProjectWorktrees = vi.fn(async (projectId: string) => {
            if (getProjectWorktrees.mock.calls.length === 1) throw new Error('git did not answer');

            return base.getProjectWorktrees(projectId);
        });

        await open({ overrides: { getProjectWorktrees } });

        expect(dialog()!.textContent).toContain('Couldn\'t read the worktrees');
        expect(groups()).toEqual([]);

        await click(textButton(dialog()!, 'Try again')!);
        await settle();

        expect(dialog()!.textContent).not.toContain('Couldn\'t read the worktrees');
        expect(groups()).toHaveLength(2);
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

        expect(groups()).toHaveLength(2);
        expect(dialog()!.textContent).toContain('Couldn\'t refresh the list');
        expect(dialog()!.textContent).not.toContain('Couldn\'t read the worktrees');
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

        expect(dialog()!.textContent).toContain('Couldn\'t refresh the list');

        await click(textButton(dialog()!, 'Try again')!);
        await settle();

        expect(getProjectWorktrees).toHaveBeenCalledTimes(3);
        expect(dialog()!.textContent).not.toContain('Couldn\'t refresh the list');
        expect(groups()).toHaveLength(2);
    });

    it('says so when none of the project\'s folders is a repository', async () => {
        const base = new FixtureTransport({ data: withFixtureWorktrees(createFixtureData()) });
        const getProjectWorktrees = async (projectId: string) => (await base.getProjectWorktrees(projectId)).map(entry => ({ ...entry, isRepository: false, worktrees: [] }));

        await open({ overrides: { getProjectWorktrees } });

        expect(groups()).toEqual([]);
        expect(dialog()!.textContent).toContain('None of the project\'s folders is a git repository');
    });

    it('closes when the project it is for is not the one the window shows', async () => {
        await open();
        expect(isOpen()).toBe(true);

        await act(async () => store.selectProject(FIXTURE_EMPTY_PROJECT_ID));
        await settle();

        expect(isOpen()).toBe(false);
    });
});
