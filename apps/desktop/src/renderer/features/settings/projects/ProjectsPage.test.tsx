// @vitest-environment happy-dom
import { Modal } from '@clowdy/components/Modal';
import { LAST_USED } from '@clowdy/protocol';
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PERSONAL_PROJECT_ID, FIXTURE_PROJECT_ID, type FixtureData } from '../../../daemon/fixtureData';
import { FixtureTransport } from '../../../daemon/fixtureTransport';
import { overrideTransport } from '../../../daemon/testing';
import { RootStore, RootStoreProvider } from '../../../stores';
import { ProjectsPage } from './ProjectsPage';

import type { OpenConfirmModalOptions } from '@clowdy/components/modals';
import type { SortableList as SortableListComponent, SortableListDropContext } from '@clowdy/components/SortableList';
import type { ProjectId } from '@clowdy/protocol';
import type { Transport } from '../../../daemon/transport';

const confirm = vi.hoisted(() => vi.fn());
const toasts = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }));

vi.mock('@clowdy/components/modals', () => ({ openConfirmModal: confirm }));
vi.mock('@clowdy/components/Toast', () => ({ toast: toasts }));

/**
 * happy-dom cannot drag, so the tests move a row the way a drop does: through the list's own `onChange`, with the items in their new
 * order, and ask its `canDrop` what a drag would. The real list still draws the rows; each list is found by its label.
 */
const sortables = vi.hoisted(() => new Map<string, {
    items: unknown[];
    onChange: (items: unknown[]) => void;
    canDrop?: (context: SortableListDropContext<unknown>) => boolean;
}>());

vi.mock('@clowdy/components/SortableList', async (importOriginal) => {
    const actual = await importOriginal<{ SortableList: typeof SortableListComponent }>();
    const { createElement } = await import('react');

    return {
        ...actual,
        SortableList: (props: Parameters<typeof actual.SortableList>[0]) => {
            sortables.set(props['aria-label'], {
                items: [...props.items],
                onChange: items => props.onChange(items, { item: items[0], index: 0 }),
                canDrop: props.canDrop as ((context: SortableListDropContext<unknown>) => boolean) | undefined,
            });

            return createElement(actual.SortableList, props);
        },
    };
});

// The babel plugin that makes the app's components observers does not run under Vitest.
const Page = observer(ProjectsPage);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;

const memoryStorage = () => {
    const data: Record<string, string> = {};

    return { getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => void (data[key] = value) };
};

async function flush() {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
}

async function open(projectId: string | null = null, overrides: Partial<Transport> = {}, data: FixtureData = createFixtureData()) {
    store = new RootStore(overrideTransport(new FixtureTransport({ data }), overrides), { storage: memoryStorage() });
    await store.load();
    store.ui.openProjectSettings(projectId);
    act(() => reactRoot.render(<RootStoreProvider value={ store }><Page /></RootStoreProvider>));
    await flush();
}

const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${ label }"]`)!;
const row = (projectId: string) => container.querySelector<HTMLButtonElement>(`button[data-project-id="${ projectId }"]`);
const named = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent?.trim() === text)!;
const click = (element: HTMLElement) => act(async () => element.click());
const lastConfirm = () => confirm.mock.calls.at(-1)![0] as OpenConfirmModalOptions;
/** Closes the last confirmation as the window does, after a confirm or a cancel. */
const closeConfirm = () => act(() => (confirm.mock.calls.at(-1)![1] as { onClose: () => void }).onClose());

/** The fixture data, with these folders added after the first one of the project. */
function withFolders(projectId: ProjectId, ...paths: string[]): FixtureData {
    const data = createFixtureData();
    const project = data.projects.find(candidate => candidate.id === projectId)!;

    project.folders.push(...paths.map((path, index) => ({ id: `fld_added_${ index + 1 }`, path })));

    return data;
}

const folderPaths = (projectId: ProjectId) => store.projects.find(project => project.id === projectId)!.folders.map(folder => folder.path);
const rows = () => [...container.querySelectorAll<HTMLElement>('[data-folder-path]')];
const rowPaths = () => rows().map(item => item.dataset.folderPath);
/** The rows marked Main: there is one, the first, in a project of its own. */
const marked = () => rows().filter(item => item.textContent?.includes('Main')).map(item => item.dataset.folderPath);

/** Whether the list lets the folder at `from` be dropped on the one at `to`, as it asks while a row is dragged over another. */
function canDropOn(from: number, to: number): boolean {
    const { items, canDrop } = sortables.get('Folders')!;
    const context = { items: [items[from]], target: items[to], sourceParent: null, sourceLevel: 1, parent: null, targetLevel: 1, dropPosition: 'before' as const };

    return canDrop?.(context) ?? true;
}

/** Drops the folder at `from` at `to`. */
async function move(from: number, to: number) {
    const list = sortables.get('Folders')!;
    const items = [...list.items];
    const [moved] = items.splice(from, 1);

    items.splice(to, 0, moved);
    await act(async () => list.onChange(items));
    await flush();
}

function type(input: HTMLInputElement, value: string) {
    act(() => {
        input.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

beforeEach(() => {
    confirm.mockReset();
    toasts.error.mockReset();
    sortables.clear();
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
    // The modal animates by itself, whatever the motion setting; a test that ends while it moves leaves a cancelled animation behind.
    const create = Modal.create.bind(Modal);

    vi.spyOn(Modal, 'create').mockImplementation(options => create({ ...options, animate: false }));
});

afterEach(async () => {
    for (const modal of Modal.opened) await modal.close(false);

    vi.restoreAllMocks();
    delete (window as { desktop?: unknown }).desktop;
    act(() => reactRoot.unmount());
    container.remove();
    store.dispose();
    document.body.innerHTML = '';
});

describe('ProjectsPage list', () => {
    it('lists the personal space first, then the projects, with where they are and what they hold', async () => {
        await open(undefined, {}, withFolders(FIXTURE_PROJECT_ID, '/Users/dev/car-rental-api', '/Users/dev/notes'));

        const rows = [...container.querySelectorAll('button[data-project-id]')].map(item => item.textContent);

        expect(rows).toEqual([
            expect.stringContaining('Personal'),
            expect.stringContaining('Car Rental'),
            expect.stringContaining('Clowdy'),
        ]);
        // The main folder, and how many the project has besides.
        expect(rows[1]).toContain('/Users/dev/car-rental+2 folders');
        expect(rows[1]).toContain('4 chats · 11 tasks');
        expect(rows[2]).not.toContain('folder');
        expect(rows[2]).toContain('No chats or tasks yet');
    });

    it('opens the page of a project from its row and goes back to the list', async () => {
        await open();
        await click(row(FIXTURE_EMPTY_PROJECT_ID)!);

        expect(store.ui.settingsProjectId).toBe(FIXTURE_EMPTY_PROJECT_ID);
        expect(container.querySelector('input[aria-label="Project name"]')).not.toBeNull();

        await click(named('Projects'));

        expect(store.ui.settingsProjectId).toBeNull();
        expect(row(FIXTURE_EMPTY_PROJECT_ID)).not.toBeNull();
    });

    it('opens the page of a project from its menu', async () => {
        await open();
        await click(button('Clowdy actions'));
        await click([...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Configure')!);

        expect(store.ui.settingsProjectId).toBe(FIXTURE_EMPTY_PROJECT_ID);
    });

    it('opens a project from its menu, leaving Settings', async () => {
        await open();
        await click(button('Clowdy actions'));
        await click([...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Open project')!);

        expect(store.selectedProjectId).toBe(FIXTURE_EMPTY_PROJECT_ID);
        expect(store.ui.settingsOpen).toBe(false);
    });

    it('takes one step back from the opened project to the list it was opened from', async () => {
        await open();
        await click(button('Clowdy actions'));
        await click([...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Open project')!);
        act(() => store.history.back());

        expect(store.selectedProjectId).toBe(FIXTURE_PROJECT_ID);
        expect([store.ui.settingsOpen, store.ui.settingsPage]).toEqual([true, 'projects']);
    });

    it('offers no removal for the personal space', async () => {
        await open();
        await click(button('Personal actions'));

        expect([...document.body.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(['Configure', 'Open project']);
    });

    it('asks before removing a project from its menu, and removes it once confirmed', async () => {
        await open();
        await click(button('Clowdy actions'));
        await click([...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Remove…')!);

        expect(lastConfirm()).toMatchObject({ title: 'Remove Clowdy?', destructive: true });
        expect(lastConfirm().message).toContain('/Users/dev/clowdy');

        await act(async () => lastConfirm().onConfirm());
        await flush();

        expect(store.projects.map(project => project.name)).toEqual(['Personal', 'Car Rental']);
    });

    it('opens the Add project form from the one Add project… button, with no menu between', async () => {
        await open();
        await click(named('Add project…'));
        await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 60));
        });

        expect(document.body.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
        expect(document.body.querySelector('form')?.textContent).toContain('Without folders, Clowdy creates one named after the project');
    });

    it('does not offer removal while agents work in the project', async () => {
        await open();
        await click(button('Car Rental actions'));

        const remove = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Remove…')!;

        expect(remove.getAttribute('aria-disabled')).toBe('true');
    });
});

describe('ProjectsPage project', () => {
    it('shows the folders, the first marked Main, each with a button that opens its git remote', async () => {
        await open(FIXTURE_PROJECT_ID, {}, withFolders(FIXTURE_PROJECT_ID, '/Users/dev/car-rental-api'));

        expect(rowPaths()).toEqual(['/Users/dev/car-rental', '/Users/dev/car-rental-api']);
        expect(marked()).toEqual(['/Users/dev/car-rental']);
        expect(rows()[0]!.querySelector<HTMLAnchorElement>('a[href="https://github.com/acme/car-rental"]')?.textContent).toBe('Open in GitHub');
        expect(rows()[1]!.querySelector<HTMLAnchorElement>('a[href="https://github.com/acme/car-rental-api"]')?.textContent).toBe('Open in GitHub');
        expect(container.textContent).not.toContain('Branch');
        expect(container.textContent).not.toContain('Change folder');
    });

    it('renames on blur, and puts the name back on Escape', async () => {
        await open(FIXTURE_EMPTY_PROJECT_ID);

        const input = container.querySelector<HTMLInputElement>('input[aria-label="Project name"]')!;

        type(input, 'Escaped');
        await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        expect(input.value).toBe('Clowdy');

        type(input, 'Clowdy Desktop');
        await act(async () => input.blur());
        await flush();

        expect(store.projects.find(project => project.id === FIXTURE_EMPTY_PROJECT_ID)?.name).toBe('Clowdy Desktop');
        expect(container.querySelector<HTMLInputElement>('input[aria-label="Project name"]')?.value).toBe('Clowdy Desktop');
    });

    it('does not rename to nothing', async () => {
        await open(FIXTURE_EMPTY_PROJECT_ID);

        const input = container.querySelector<HTMLInputElement>('input[aria-label="Project name"]')!;

        type(input, '   ');
        await act(async () => input.blur());
        await flush();

        expect(store.projects.find(project => project.id === FIXTURE_EMPTY_PROJECT_ID)?.name).toBe('Clowdy');
        expect(input.value).toBe('Clowdy');
    });

    it('saves the agent and the mode of new chats, keeps Last used as a choice of its own, and follows the app with Default', async () => {
        await open(FIXTURE_EMPTY_PROJECT_ID);

        const settings = () => store.projects.find(project => project.id === FIXTURE_EMPTY_PROJECT_ID)!.settings;
        const radio = (group: string, label: string) => [...container.querySelectorAll<HTMLElement>(`[aria-label="${ group }"] [role="radio"]`)].find(item => item.textContent === label)!;
        const checked = (group: string) => container.querySelector(`[aria-label="${ group }"] [role="radio"][aria-checked="true"]`)?.textContent;

        // Nothing saved is Default, for the agent and for the mode: the project follows Settings > Chat.
        expect([checked('Agent for new chats'), checked('Mode for new chats')]).toEqual(['Default', 'Default']);

        await click(radio('Agent for new chats', 'Codex'));
        await flush();
        expect(settings().engine).toBe('codex');

        await click(radio('Mode for new chats', 'Hands-on'));
        await flush();
        expect(settings().chatMode).toBe('semi');

        await click(radio('Agent for new chats', 'Last used'));
        await flush();
        expect(settings().engine).toBe(LAST_USED);
        expect(settings().chatMode).toBe('semi');

        await click(radio('Mode for new chats', 'Last used'));
        await flush();
        expect(settings().chatMode).toBe(LAST_USED);
        expect([checked('Agent for new chats'), checked('Mode for new chats')]).toEqual(['Last used', 'Last used']);

        await click(radio('Agent for new chats', 'Default'));
        await click(radio('Mode for new chats', 'Default'));
        await flush();
        expect(settings()).not.toHaveProperty('engine');
        expect(settings()).not.toHaveProperty('chatMode');
    });

    it('confirms with the counts before removing, and leaves the page when the project is gone', async () => {
        await open(FIXTURE_EMPTY_PROJECT_ID);
        await click(named('Remove project'));

        expect(lastConfirm()).toMatchObject({ title: 'Remove Clowdy?', confirmLabel: 'Remove project', destructive: true });

        await act(async () => lastConfirm().onConfirm());
        await flush();

        expect(store.ui.settingsProjectId).toBeNull();
        expect(row(FIXTURE_PROJECT_ID)).not.toBeNull();
        expect(row(FIXTURE_EMPTY_PROJECT_ID)).toBeNull();
    });

    it('adds the folders picked in one dialog after the others, at once, leaving out one the project has', async () => {
        (window as { desktop?: unknown }).desktop = { chooseDirectories: async () => ['/Users/dev/car-rental-api', '/Users/dev/clowdy', '/Users/dev/notes', '/Users/dev/notes'] };
        await open(FIXTURE_EMPTY_PROJECT_ID);

        // One folder: nothing to remove, it is the project's only one.
        expect(container.querySelector('button[aria-label^="Remove "]')).toBeNull();

        await click(named('Add folders…'));
        await flush();

        expect(confirm).not.toHaveBeenCalled();
        expect(folderPaths(FIXTURE_EMPTY_PROJECT_ID)).toEqual(['/Users/dev/clowdy', '/Users/dev/car-rental-api', '/Users/dev/notes']);
        expect(rowPaths()).toEqual(['/Users/dev/clowdy', '/Users/dev/car-rental-api', '/Users/dev/notes']);
        expect(marked()).toEqual(['/Users/dev/clowdy']);
        // The page reads the folders again when the project changes: the new folder's remote shows.
        expect(rows()[1]!.querySelector('a[href="https://github.com/acme/car-rental-api"]')).not.toBeNull();
    });

    it('adds nothing when the folder dialog is closed without a choice', async () => {
        const command = vi.fn();

        (window as { desktop?: unknown }).desktop = { chooseDirectories: async () => [] };
        await open(FIXTURE_EMPTY_PROJECT_ID, { command });
        await click(named('Add folders…'));
        await flush();

        expect(command).not.toHaveBeenCalled();
    });

    it('reorders the folders under the main one at once, with no dialog', async () => {
        await open(FIXTURE_EMPTY_PROJECT_ID, {}, withFolders(FIXTURE_EMPTY_PROJECT_ID, '/Users/dev/car-rental-api', '/Users/dev/notes'));
        await move(2, 1);

        expect(confirm).not.toHaveBeenCalled();
        expect(folderPaths(FIXTURE_EMPTY_PROJECT_ID)).toEqual(['/Users/dev/clowdy', '/Users/dev/notes', '/Users/dev/car-rental-api']);
        expect(rowPaths()).toEqual(['/Users/dev/clowdy', '/Users/dev/notes', '/Users/dev/car-rental-api']);
    });

    it('makes another folder main once the person confirmed it, and puts the order back when they did not', async () => {
        await open(FIXTURE_EMPTY_PROJECT_ID, {}, withFolders(FIXTURE_EMPTY_PROJECT_ID, '/Users/dev/car-rental-api'));

        // With no agent working, a folder can be dragged above the main one.
        expect(canDropOn(1, 0)).toBe(true);

        await move(1, 0);

        expect(lastConfirm()).toMatchObject({ title: 'Make car-rental-api the main folder?', confirmLabel: 'Make main folder' });
        expect(lastConfirm().message).toContain('Clowdy will work in /Users/dev/car-rental-api from now on');
        expect(lastConfirm().message).toContain('starts a new conversation');
        // Nothing is sent before the answer; the list shows the order dragged meanwhile.
        expect(folderPaths(FIXTURE_EMPTY_PROJECT_ID)).toEqual(['/Users/dev/clowdy', '/Users/dev/car-rental-api']);
        expect(rowPaths()).toEqual(['/Users/dev/car-rental-api', '/Users/dev/clowdy']);

        closeConfirm();
        await flush();

        expect(rowPaths()).toEqual(['/Users/dev/clowdy', '/Users/dev/car-rental-api']);

        await move(1, 0);
        await act(async () => lastConfirm().onConfirm());
        closeConfirm();
        await flush();

        expect(folderPaths(FIXTURE_EMPTY_PROJECT_ID)).toEqual(['/Users/dev/car-rental-api', '/Users/dev/clowdy']);
        expect(marked()).toEqual(['/Users/dev/car-rental-api']);
    });

    it('applies a new main folder to the folders the project has when the person confirms, not when the dialog opened', async () => {
        /** Another window changes the folders while the dialog is open. */
        const elsewhere = async (folders: ({ id: string } | { path: string })[]) => {
            await act(async () => void await store.command({ type: 'project.update', projectId: FIXTURE_EMPTY_PROJECT_ID, folders }));
            await flush();
        };
        const confirmed = async () => {
            await act(async () => lastConfirm().onConfirm());
            closeConfirm();
            await flush();
        };

        await open(FIXTURE_EMPTY_PROJECT_ID, {}, withFolders(FIXTURE_EMPTY_PROJECT_ID, '/Users/dev/car-rental-api'));
        await move(1, 0);
        await elsewhere([{ id: 'fld_clowdy' }, { id: 'fld_added_1' }, { path: '/Users/dev/notes' }]);
        await confirmed();

        expect(folderPaths(FIXTURE_EMPTY_PROJECT_ID)).toEqual(['/Users/dev/car-rental-api', '/Users/dev/clowdy', '/Users/dev/notes']);

        await click(button('Remove car-rental-api'));
        await elsewhere([...store.projects.find(project => project.id === FIXTURE_EMPTY_PROJECT_ID)!.folders.map(folder => ({ id: folder.id })), { path: '/Users/dev/web' }]);
        await confirmed();

        expect(folderPaths(FIXTURE_EMPTY_PROJECT_ID)).toEqual(['/Users/dev/clowdy', '/Users/dev/notes', '/Users/dev/web']);
    });

    it('asks before removing the main folder, and makes the next one main', async () => {
        await open(FIXTURE_EMPTY_PROJECT_ID, {}, withFolders(FIXTURE_EMPTY_PROJECT_ID, '/Users/dev/car-rental-api'));
        await click(button('Remove clowdy'));

        expect(lastConfirm()).toMatchObject({ title: 'Remove clowdy?', confirmLabel: 'Remove folder' });
        expect(lastConfirm().message).toContain('Clowdy will work in /Users/dev/car-rental-api from now on, and /Users/dev/clowdy leaves the project');
        expect(folderPaths(FIXTURE_EMPTY_PROJECT_ID)).toHaveLength(2);

        await act(async () => lastConfirm().onConfirm());
        await flush();

        expect(folderPaths(FIXTURE_EMPTY_PROJECT_ID)).toEqual(['/Users/dev/car-rental-api']);
        expect(marked()).toEqual(['/Users/dev/car-rental-api']);
    });

    it('removes another folder at once, and moves the focus to the folder that takes its place', async () => {
        (window as { desktop?: unknown }).desktop = { chooseDirectories: async () => [] };
        await open(FIXTURE_EMPTY_PROJECT_ID, {}, withFolders(FIXTURE_EMPTY_PROJECT_ID, '/Users/dev/car-rental-api', '/Users/dev/notes'));
        await click(button('Remove car-rental-api'));
        await flush();

        expect(confirm).not.toHaveBeenCalled();
        expect(folderPaths(FIXTURE_EMPTY_PROJECT_ID)).toEqual(['/Users/dev/clowdy', '/Users/dev/notes']);
        expect(document.activeElement?.getAttribute('aria-label')).toBe('Remove notes');

        // The last folder left has no Remove: the focus goes on to what adds folders.
        await click(button('Remove notes'));
        await flush();

        expect(folderPaths(FIXTURE_EMPTY_PROJECT_ID)).toEqual(['/Users/dev/clowdy']);
        expect(document.activeElement?.textContent).toBe('Add folders…');
    });

    it('shows the daemon\'s refusal of a new main folder in the dialog, and of another change as a toast', async () => {
        const refusal = { ok: false as const, requestId: 'r', error: { code: 'conflict' as const, message: 'The agents of this project are still working. Stop them first.' } };

        await open(FIXTURE_EMPTY_PROJECT_ID, { command: async () => refusal }, withFolders(FIXTURE_EMPTY_PROJECT_ID, '/Users/dev/car-rental-api', '/Users/dev/notes'));
        await move(1, 0);

        await expect(lastConfirm().onConfirm()).rejects.toThrow('Stop them first');

        closeConfirm();
        await flush();
        await move(2, 1);

        expect(toasts.error).toHaveBeenCalledWith({ message: 'The agents of this project are still working. Stop them first.' });
        // The order goes back to the daemon's.
        expect(rowPaths()).toEqual(['/Users/dev/clowdy', '/Users/dev/car-rental-api', '/Users/dev/notes']);
    });

    it('keeps the main folder in place while agents work, but moves, adds and removes the others', async () => {
        (window as { desktop?: unknown }).desktop = { chooseDirectories: async () => ['/Users/dev/notes'] };
        await open(FIXTURE_PROJECT_ID, {}, withFolders(FIXTURE_PROJECT_ID, '/Users/dev/car-rental-api', '/Users/dev/car-rental-web'));

        expect(button('Remove car-rental').disabled).toBe(true);
        expect(button('Remove car-rental-api').disabled).toBe(false);
        expect(container.textContent).toContain('Agents are working in this project. Stop them before changing the main folder.');

        // A drag neither moves the main folder nor puts another above it; the others change places.
        expect(canDropOn(0, 1)).toBe(false);
        expect(canDropOn(1, 0)).toBe(false);
        expect(canDropOn(2, 1)).toBe(true);

        // A drop that reached the top anyway is put back, with no dialog.
        await move(1, 0);

        expect(confirm).not.toHaveBeenCalled();
        expect(rowPaths()).toEqual(['/Users/dev/car-rental', '/Users/dev/car-rental-api', '/Users/dev/car-rental-web']);

        await move(2, 1);

        expect(folderPaths(FIXTURE_PROJECT_ID)).toEqual(['/Users/dev/car-rental', '/Users/dev/car-rental-web', '/Users/dev/car-rental-api']);

        await click(named('Add folders…'));
        await flush();

        expect(folderPaths(FIXTURE_PROJECT_ID)).toEqual(['/Users/dev/car-rental', '/Users/dev/car-rental-web', '/Users/dev/car-rental-api', '/Users/dev/notes']);

        await click(button('Remove car-rental-api'));
        await flush();

        expect(folderPaths(FIXTURE_PROJECT_ID)).toEqual(['/Users/dev/car-rental', '/Users/dev/car-rental-web', '/Users/dev/notes']);
        expect(toasts.error).not.toHaveBeenCalled();
    });

    it('keeps Remove project off while agents work, and says why', async () => {
        await open(FIXTURE_PROJECT_ID);

        expect(named('Remove project').disabled).toBe(true);
        expect(container.textContent).toContain('Agents are working in this project');
    });

    it('shows the personal space with its one folder, read only, and new-chat settings only', async () => {
        await open(FIXTURE_PERSONAL_PROJECT_ID);

        expect(container.querySelector('input[aria-label="Project name"]')).toBeNull();
        expect(rowPaths()).toEqual(['/Users/dev/Clowdy/Personal']);
        expect(marked()).toEqual([]);
        expect(container.querySelector('button[aria-label^="Remove "]')).toBeNull();
        expect(container.textContent).not.toContain('Add folders');
        expect(container.textContent).not.toContain('Remove project');
        expect(container.querySelector('[aria-label="Agent for new chats"]')).not.toBeNull();
    });

    it('says so when the folders could not be checked', async () => {
        await open(FIXTURE_EMPTY_PROJECT_ID, { getProjectsInfo: () => Promise.reject(new Error('offline')) });

        expect(container.textContent).toContain('Couldn\'t check the folders');
    });

    it('warns about each folder that is gone: the main one stops the agents, another is left out', async () => {
        const info = { projectId: FIXTURE_EMPTY_PROJECT_ID, folders: [{ folderId: 'fld_clowdy', exists: false }, { folderId: 'fld_added_1', exists: false }, { folderId: 'fld_added_2', exists: true, remoteUrl: 'git@github.com:acme/notes.git' }], chats: 0, tasks: 0, activeRuns: 0 };

        await open(FIXTURE_EMPTY_PROJECT_ID, { getProjectsInfo: async () => [info] }, withFolders(FIXTURE_EMPTY_PROJECT_ID, '/Users/dev/car-rental-api', '/Users/dev/notes'));

        expect(rows()[0]!.textContent).toContain('This folder no longer exists, so the agents of this project cannot work.');
        expect(rows()[1]!.textContent).toContain('This folder no longer exists, so the agents leave it out');
        expect(rows()[2]!.textContent).not.toContain('no longer exists');
        expect(rows()[2]!.querySelector('a[href="https://github.com/acme/notes"]')).not.toBeNull();
    });
});
