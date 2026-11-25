// @vitest-environment happy-dom
import { Modal } from '@clowdy/components/Modal';
import { LAST_USED, NO_PROJECT_ICON } from '@clowdy/protocol';
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_EMPTY_PROJECT_ID,
    FIXTURE_PERSONAL_PROJECT_ID,
    FIXTURE_PROJECT_ID,
    type FixtureData,
} from '../../../daemon/fixtureData';
import { FixtureTransport } from '../../../daemon/fixtureTransport';
import { overrideTransport } from '../../../daemon/testing';
import { RootStore, RootStoreProvider } from '../../../stores';
import { SettingsWindow } from '../SettingsWindow';

import type { OpenConfirmModalOptions } from '@clowdy/components/modals';
import type { SortableList as SortableListComponent, SortableListDropContext } from '@clowdy/components/SortableList';
import type { FolderSettings, ProjectId } from '@clowdy/protocol';
import type { Transport } from '../../../daemon/transport';

const confirm = vi.hoisted(() => vi.fn());
const toasts = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }));

const square = vi.hoisted(() => vi.fn<(file: Blob) => Promise<string>>());

vi.mock('@clowdy/components/modals', () => ({ openConfirmModal: confirm }));
vi.mock('@clowdy/components/Toast', () => ({ toast: toasts }));
// happy-dom draws no pictures: the tests say what drawing a picture small gives.
vi.mock('./squareIcon', async importOriginal => ({
    ...(await importOriginal<Record<string, unknown>>()),
    squareIcon: square,
}));
// The babel plugin that makes the app's components observers does not run under Vitest: `observer` stands in for it here.
vi.mock('../../../shared/ProjectIcon', async importOriginal => {
    const { ProjectIcon } = await importOriginal<typeof import('../../../shared/ProjectIcon')>();
    const mobx = await import('mobx-react-lite');

    return { ProjectIcon: mobx.observer(ProjectIcon) };
});

/**
 * happy-dom cannot drag, so the tests move a row the way a drop does: through the list's own `onChange`, with the items in their new
 * order, and ask its `canDrop` what a drag would. The real list still draws the rows; each list is found by its label.
 */
const sortables = vi.hoisted(
    () =>
        new Map<
            string,
            {
                items: unknown[];
                onChange: (items: unknown[]) => void;
                canDrop?: (context: SortableListDropContext<unknown>) => boolean;
            }
        >()
);

vi.mock('@clowdy/components/SortableList', async importOriginal => {
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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;

const memoryStorage = () => {
    const data: Record<string, string> = {};

    return {
        getItem: (key: string) => data[key] ?? null,
        setItem: (key: string, value: string) => void (data[key] = value),
    };
};

async function flush() {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
}

/** `overrides` may be made from the transport it overrides, to pass a call on after looking at it. */
async function open(
    projectId: string | null = null,
    overrides: Partial<Transport> | ((base: Transport) => Partial<Transport>) = {},
    data: FixtureData = createFixtureData()
) {
    const base = new FixtureTransport({ data });

    store = new RootStore(overrideTransport(base, typeof overrides === 'function' ? overrides(base) : overrides), {
        storage: memoryStorage(),
    });
    await store.load();
    store.ui.openProjectSettings(projectId);
    // The page is drawn in the Settings window, whose layout holds the project's page as its stack.
    act(() =>
        reactRoot.render(
            <RootStoreProvider value={store}>
                <SettingsWindow />
            </RootStoreProvider>
        )
    );
    await flush();
}

const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const row = (projectId: string) => container.querySelector<HTMLButtonElement>(`button[data-project-id="${projectId}"]`);
const named = (text: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        candidate => candidate.textContent?.trim() === text
    )!;
const click = (element: HTMLElement) => act(async () => element.click());
const lastConfirm = () => confirm.mock.calls.at(-1)![0] as OpenConfirmModalOptions;
/** Closes the last confirmation as the window does, after a confirm or a cancel. */
const closeConfirm = () => act(() => (confirm.mock.calls.at(-1)![1] as { onClose: () => void }).onClose());

/** The fixture data, with these folders added after the first one of the project. */
function withFolders(projectId: ProjectId, ...paths: string[]): FixtureData {
    const data = createFixtureData();
    const project = data.projects.find(candidate => candidate.id === projectId)!;

    project.folders.push(...paths.map((path, index) => ({ id: `fld_added_${index + 1}`, path })));

    return data;
}

const folderPaths = (projectId: ProjectId) =>
    store.projects.find(project => project.id === projectId)!.folders.map(folder => folder.path);
const rows = () => [...container.querySelectorAll<HTMLElement>('[data-folder-path]')];
const rowPaths = () => rows().map(item => item.dataset.folderPath);
/** The rows marked Main: there is one, the first, in a project of its own. */
const marked = () =>
    rows()
        .filter(item => item.textContent?.includes('Main'))
        .map(item => item.dataset.folderPath);

/** Whether the list lets the folder at `from` be dropped on the one at `to`, as it asks while a row is dragged over another. */
function canDropOn(from: number, to: number): boolean {
    const { items, canDrop } = sortables.get('Folders')!;
    const context = {
        items: [items[from]],
        target: items[to],
        sourceParent: null,
        sourceLevel: 1,
        parent: null,
        targetLevel: 1,
        dropPosition: 'before' as const,
    };

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
    square.mockReset();
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
        expect(rows[1]).toContain('~/car-rental+2 folders');
        // What a project holds is marks after its name, with no count of none.
        // The archived tasks are counted: deleting the project takes them too.
        expect(rows[1]).toContain('Car Rental11 chats21 tasks');
        expect(rows[2]).not.toContain('folder');
        expect(rows[2]).not.toContain('chat');
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
        await click(
            [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
                item => item.textContent === 'Configure'
            )!
        );

        expect(store.ui.settingsProjectId).toBe(FIXTURE_EMPTY_PROJECT_ID);
    });

    it('opens a project from its menu, leaving Settings', async () => {
        await open();
        await click(button('Clowdy actions'));
        await click(
            [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
                item => item.textContent === 'Open project'
            )!
        );

        expect(store.selectedProjectId).toBe(FIXTURE_EMPTY_PROJECT_ID);
        expect(store.ui.settingsOpen).toBe(false);
    });

    it('leaves Settings for the opened project, and one step back goes to the project the window was on', async () => {
        await open();
        await click(button('Clowdy actions'));
        await click(
            [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
                item => item.textContent === 'Open project'
            )!
        );

        expect(store.ui.settingsOpen).toBe(false);

        act(() => store.history.back());

        expect(store.selectedProjectId).toBe(FIXTURE_PROJECT_ID);
        expect(store.ui.settingsOpen).toBe(false);
    });

    it('offers no removal for the personal space', async () => {
        await open();
        await click(button('Personal actions'));

        expect([...document.body.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual([
            'Configure',
            'Open project',
        ]);
    });

    it('asks before removing a project from its menu, and removes it once confirmed', async () => {
        await open();
        await click(button('Clowdy actions'));
        await click(
            [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
                item => item.textContent === 'Remove…'
            )!
        );

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
        expect(document.body.querySelector('form')?.textContent).toContain(
            'Without folders, Clowdy creates one named after the project'
        );
    });

    it('does not offer removal while agents work in the project', async () => {
        await open();
        await click(button('Car Rental actions'));

        const remove = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
            item => item.textContent === 'Remove…'
        )!;

        expect(remove.getAttribute('aria-disabled')).toBe('true');
    });
});

describe('ProjectsPage project', () => {
    it('shows the folders, the first marked Main, each with a button that opens its git remote', async () => {
        await open(FIXTURE_PROJECT_ID, {}, withFolders(FIXTURE_PROJECT_ID, '/Users/dev/car-rental-api'));

        expect(rowPaths()).toEqual(['/Users/dev/car-rental', '/Users/dev/car-rental-api']);
        expect(marked()).toEqual(['/Users/dev/car-rental']);
        expect(
            rows()[0]!.querySelector<HTMLAnchorElement>('a[href="https://github.com/acme/car-rental"]')?.textContent
        ).toBe('Open in GitHub');
        expect(
            rows()[1]!.querySelector<HTMLAnchorElement>('a[href="https://github.com/acme/car-rental-api"]')?.textContent
        ).toBe('Open in GitHub');
        expect(container.textContent).not.toContain('Branch');
        expect(container.textContent).not.toContain('Change folder');
    });

    it('does not show a project-wide worktrees section', async () => {
        await open(FIXTURE_PROJECT_ID);
        expect(container.textContent).not.toContain('Manage worktrees');
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
        expect(container.querySelector<HTMLInputElement>('input[aria-label="Project name"]')?.value).toBe(
            'Clowdy Desktop'
        );
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
        const radio = (group: string, label: string) =>
            [...container.querySelectorAll<HTMLElement>(`[aria-label="${group}"] [role="radio"]`)].find(
                item => item.textContent === label
            )!;
        const checked = (group: string) =>
            container.querySelector(`[aria-label="${group}"] [role="radio"][aria-checked="true"]`)?.textContent;

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

        expect(lastConfirm()).toMatchObject({
            title: 'Remove Clowdy?',
            confirmLabel: 'Remove project',
            destructive: true,
        });

        await act(async () => lastConfirm().onConfirm());
        await flush();

        expect(store.ui.settingsProjectId).toBeNull();
        expect(row(FIXTURE_PROJECT_ID)).not.toBeNull();
        expect(row(FIXTURE_EMPTY_PROJECT_ID)).toBeNull();
    });

    it('adds the folders picked in one dialog after the others, at once, leaving out one the project has', async () => {
        (window as { desktop?: unknown }).desktop = {
            chooseDirectories: async () => [
                '/Users/dev/car-rental-api',
                '/Users/dev/clowdy',
                '/Users/dev/notes',
                '/Users/dev/notes',
            ],
        };
        await open(FIXTURE_EMPTY_PROJECT_ID);

        // One folder: nothing to remove, it is the project's only one.
        expect(container.querySelector('button[aria-label^="Remove "]')).toBeNull();

        await click(named('Add folders…'));
        await flush();

        expect(confirm).not.toHaveBeenCalled();
        expect(folderPaths(FIXTURE_EMPTY_PROJECT_ID)).toEqual([
            '/Users/dev/clowdy',
            '/Users/dev/car-rental-api',
            '/Users/dev/notes',
        ]);
        expect(rowPaths()).toEqual(['/Users/dev/clowdy', '/Users/dev/car-rental-api', '/Users/dev/notes']);
        expect(marked()).toEqual(['/Users/dev/clowdy']);
        // The page reads the folders again when the project changes: the new folder's remote shows.
        expect(rows()[1]!.querySelector('a[href="https://github.com/acme/car-rental-api"]')).not.toBeNull();
    });

    it('clones a repository into the project at once: the folder it made is added like a picked one', async () => {
        // The one answer of the folder dialog is for Choose folder… in the clone dialog, which has the folder `code` with files in it.
        (window as { desktop?: unknown }).desktop = { chooseDirectories: async () => ['/Users/dev/code'] };
        // A window opened over another is anchored to it and closes when its anchor is not on the page: happy-dom lays nothing out, so every element would be gone.
        const box = { x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 400, width: 400, height: 400 };

        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ ...box, toJSON: () => box });
        vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([box] as unknown as DOMRectList);

        const cloneGit = vi.fn(async (request: { path: string }) => request.path);
        const inDialog = (text: string) =>
            [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
                candidate => candidate.textContent?.trim() === text && !container.contains(candidate)
            )!;

        await open(FIXTURE_EMPTY_PROJECT_ID, { cloneGit: cloneGit as Transport['cloneGit'] });
        expect(named('Add folders…')).not.toBeUndefined();

        await click(named('Clone repository…'));
        await flush();
        type(
            document.body.querySelector<HTMLInputElement>('input[aria-label="Repository address"]')!,
            'https://github.com/acme/booking-api.git'
        );
        await click(inDialog('Choose folder…'));
        await act(async () => void (await new Promise(resolve => setTimeout(resolve, 450))));
        await click(inDialog('Clone'));
        await flush();

        expect(cloneGit).toHaveBeenCalledOnce();
        expect(cloneGit.mock.calls[0][0]).toEqual({
            url: 'https://github.com/acme/booking-api.git',
            path: '/Users/dev/code/booking-api',
        });
        // At once: the project has the folder, after its main one, with no further question.
        expect(folderPaths(FIXTURE_EMPTY_PROJECT_ID)).toEqual(['/Users/dev/clowdy', '/Users/dev/code/booking-api']);
        expect(rowPaths()).toEqual(['/Users/dev/clowdy', '/Users/dev/code/booking-api']);
        expect(confirm).not.toHaveBeenCalled();
        expect(document.body.querySelector('input[aria-label="Repository address"]')).toBeNull();
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
        await open(
            FIXTURE_EMPTY_PROJECT_ID,
            {},
            withFolders(FIXTURE_EMPTY_PROJECT_ID, '/Users/dev/car-rental-api', '/Users/dev/notes')
        );
        await move(2, 1);

        expect(confirm).not.toHaveBeenCalled();
        expect(folderPaths(FIXTURE_EMPTY_PROJECT_ID)).toEqual([
            '/Users/dev/clowdy',
            '/Users/dev/notes',
            '/Users/dev/car-rental-api',
        ]);
        expect(rowPaths()).toEqual(['/Users/dev/clowdy', '/Users/dev/notes', '/Users/dev/car-rental-api']);
    });

    it('makes another folder main once the person confirmed it, and puts the order back when they did not', async () => {
        await open(FIXTURE_EMPTY_PROJECT_ID, {}, withFolders(FIXTURE_EMPTY_PROJECT_ID, '/Users/dev/car-rental-api'));

        // With no agent working, a folder can be dragged above the main one.
        expect(canDropOn(1, 0)).toBe(true);

        await move(1, 0);

        expect(lastConfirm()).toMatchObject({
            title: 'Make car-rental-api the main folder?',
            confirmLabel: 'Make main folder',
        });
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
            await act(
                async () =>
                    void (await store.command({ type: 'project.update', projectId: FIXTURE_EMPTY_PROJECT_ID, folders }))
            );
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

        expect(folderPaths(FIXTURE_EMPTY_PROJECT_ID)).toEqual([
            '/Users/dev/car-rental-api',
            '/Users/dev/clowdy',
            '/Users/dev/notes',
        ]);

        await click(button('Remove car-rental-api'));
        await elsewhere([
            ...store.projects
                .find(project => project.id === FIXTURE_EMPTY_PROJECT_ID)!
                .folders.map(folder => ({ id: folder.id })),
            { path: '/Users/dev/web' },
        ]);
        await confirmed();

        expect(folderPaths(FIXTURE_EMPTY_PROJECT_ID)).toEqual([
            '/Users/dev/clowdy',
            '/Users/dev/notes',
            '/Users/dev/web',
        ]);
    });

    it('asks before removing the main folder, and makes the next one main', async () => {
        await open(FIXTURE_EMPTY_PROJECT_ID, {}, withFolders(FIXTURE_EMPTY_PROJECT_ID, '/Users/dev/car-rental-api'));
        await click(button('Remove clowdy'));

        expect(lastConfirm()).toMatchObject({ title: 'Remove clowdy?', confirmLabel: 'Remove folder' });
        expect(lastConfirm().message).toContain(
            'Clowdy will work in /Users/dev/car-rental-api from now on, and /Users/dev/clowdy leaves the project'
        );
        expect(folderPaths(FIXTURE_EMPTY_PROJECT_ID)).toHaveLength(2);

        await act(async () => lastConfirm().onConfirm());
        await flush();

        expect(folderPaths(FIXTURE_EMPTY_PROJECT_ID)).toEqual(['/Users/dev/car-rental-api']);
        expect(marked()).toEqual(['/Users/dev/car-rental-api']);
    });

    it('asks before removing a folder that chats work in, saying how many go back to the main folder', async () => {
        const info = {
            projectId: FIXTURE_EMPTY_PROJECT_ID,
            folders: [
                { folderId: 'fld_clowdy', exists: true, chats: 0 },
                { folderId: 'fld_added_1', exists: true, chats: 2 },
            ],
            chats: 2,
            tasks: 0,
            activeRuns: 0,
        };

        await open(
            FIXTURE_EMPTY_PROJECT_ID,
            { getProjectsInfo: async () => [info] },
            withFolders(FIXTURE_EMPTY_PROJECT_ID, '/Users/dev/car-rental-api')
        );
        await click(button('Remove car-rental-api'));

        expect(lastConfirm()).toMatchObject({ title: 'Remove car-rental-api?', confirmLabel: 'Remove folder' });
        expect(lastConfirm().message).toContain('2 chats work in car-rental-api. They move to clowdy, the main folder');
        expect(folderPaths(FIXTURE_EMPTY_PROJECT_ID)).toHaveLength(2);

        await act(async () => lastConfirm().onConfirm());
        await flush();

        expect(folderPaths(FIXTURE_EMPTY_PROJECT_ID)).toEqual(['/Users/dev/clowdy']);
    });

    it('keeps the folder when the person cancels the removal of one that chats work in', async () => {
        const info = {
            projectId: FIXTURE_EMPTY_PROJECT_ID,
            folders: [
                { folderId: 'fld_clowdy', exists: true, chats: 0 },
                { folderId: 'fld_added_1', exists: true, chats: 1 },
            ],
            chats: 1,
            tasks: 0,
            activeRuns: 0,
        };

        await open(
            FIXTURE_EMPTY_PROJECT_ID,
            { getProjectsInfo: async () => [info] },
            withFolders(FIXTURE_EMPTY_PROJECT_ID, '/Users/dev/car-rental-api')
        );
        await click(button('Remove car-rental-api'));
        await closeConfirm();

        expect(lastConfirm().message).toContain('1 chat works in car-rental-api. It moves to clowdy');
        expect(folderPaths(FIXTURE_EMPTY_PROJECT_ID)).toHaveLength(2);
    });

    it('removes another folder at once, and moves the focus to the folder that takes its place', async () => {
        (window as { desktop?: unknown }).desktop = { chooseDirectories: async () => [] };
        await open(
            FIXTURE_EMPTY_PROJECT_ID,
            {},
            withFolders(FIXTURE_EMPTY_PROJECT_ID, '/Users/dev/car-rental-api', '/Users/dev/notes')
        );
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

    it("shows the daemon's refusal of a new main folder in the dialog, and of another change as a toast", async () => {
        const refusal = {
            ok: false as const,
            requestId: 'r',
            error: {
                code: 'conflict' as const,
                message: 'The agents of this project are still working. Stop them first.',
            },
        };

        await open(
            FIXTURE_EMPTY_PROJECT_ID,
            { command: async () => refusal },
            withFolders(FIXTURE_EMPTY_PROJECT_ID, '/Users/dev/car-rental-api', '/Users/dev/notes')
        );
        await move(1, 0);

        await expect(lastConfirm().onConfirm()).rejects.toThrow('Stop them first');

        closeConfirm();
        await flush();
        await move(2, 1);

        expect(toasts.error).toHaveBeenCalledWith({
            message: 'The agents of this project are still working. Stop them first.',
        });
        // The order goes back to the daemon's.
        expect(rowPaths()).toEqual(['/Users/dev/clowdy', '/Users/dev/car-rental-api', '/Users/dev/notes']);
    });

    it('keeps the main folder in place while agents work, but moves, adds and removes the others', async () => {
        (window as { desktop?: unknown }).desktop = { chooseDirectories: async () => ['/Users/dev/notes'] };
        await open(
            FIXTURE_PROJECT_ID,
            {},
            withFolders(FIXTURE_PROJECT_ID, '/Users/dev/car-rental-api', '/Users/dev/car-rental-web')
        );

        expect(button('Remove car-rental').disabled).toBe(true);
        expect(button('Remove car-rental-api').disabled).toBe(false);
        expect(container.textContent).toContain(
            'Agents are working in this project. Stop them before changing the main folder.'
        );

        // A drag neither moves the main folder nor puts another above it; the others change places.
        expect(canDropOn(0, 1)).toBe(false);
        expect(canDropOn(1, 0)).toBe(false);
        expect(canDropOn(2, 1)).toBe(true);

        // A drop that reached the top anyway is put back, with no dialog.
        await move(1, 0);

        expect(confirm).not.toHaveBeenCalled();
        expect(rowPaths()).toEqual(['/Users/dev/car-rental', '/Users/dev/car-rental-api', '/Users/dev/car-rental-web']);

        await move(2, 1);

        expect(folderPaths(FIXTURE_PROJECT_ID)).toEqual([
            '/Users/dev/car-rental',
            '/Users/dev/car-rental-web',
            '/Users/dev/car-rental-api',
        ]);

        await click(named('Add folders…'));
        await flush();

        expect(folderPaths(FIXTURE_PROJECT_ID)).toEqual([
            '/Users/dev/car-rental',
            '/Users/dev/car-rental-web',
            '/Users/dev/car-rental-api',
            '/Users/dev/notes',
        ]);

        await click(button('Remove car-rental-api'));
        await flush();

        expect(folderPaths(FIXTURE_PROJECT_ID)).toEqual([
            '/Users/dev/car-rental',
            '/Users/dev/car-rental-web',
            '/Users/dev/notes',
        ]);
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
        expect(container.textContent).not.toContain('Upload');
        expect(container.querySelector('[aria-label="Agent for new chats"]')).not.toBeNull();
    });

    it('says so when the folders could not be checked', async () => {
        await open(FIXTURE_EMPTY_PROJECT_ID, { getProjectsInfo: () => Promise.reject(new Error('offline')) });

        expect(container.textContent).toContain("Couldn't check the folders");
    });

    it('warns about each folder that is gone: the main one stops the agents, another is left out', async () => {
        const info = {
            projectId: FIXTURE_EMPTY_PROJECT_ID,
            folders: [
                { folderId: 'fld_clowdy', exists: false, chats: 0 },
                { folderId: 'fld_added_1', exists: false, chats: 0 },
                { folderId: 'fld_added_2', exists: true, remoteUrl: 'git@github.com:acme/notes.git', chats: 0 },
            ],
            chats: 0,
            tasks: 0,
            activeRuns: 0,
        };

        await open(
            FIXTURE_EMPTY_PROJECT_ID,
            { getProjectsInfo: async () => [info] },
            withFolders(FIXTURE_EMPTY_PROJECT_ID, '/Users/dev/car-rental-api', '/Users/dev/notes')
        );

        expect(rows()[0]!.textContent).toContain(
            'This folder no longer exists, so the agents of this project cannot work.'
        );
        expect(rows()[1]!.textContent).toContain('This folder no longer exists, so the agents leave it out');
        expect(rows()[2]!.textContent).not.toContain('no longer exists');
        expect(rows()[2]!.querySelector('a[href="https://github.com/acme/notes"]')).not.toBeNull();
    });
});

describe('ProjectsPage, a folder that is gone', () => {
    const info = {
        projectId: FIXTURE_EMPTY_PROJECT_ID,
        folders: [
            { folderId: 'fld_clowdy', exists: true, chats: 0 },
            { folderId: 'fld_added_1', exists: false, chats: 0 },
        ],
        chats: 0,
        tasks: 0,
        activeRuns: 0,
    };

    afterEach(() => {
        (window as { desktop?: unknown }).desktop = undefined;
    });

    it('has a Locate… button on it, which moves the folder to the place that is picked, in its place in the order', async () => {
        const choose = vi.fn(async () => ['/Users/dev/api-moved']);

        (window as { desktop?: unknown }).desktop = { chooseDirectories: choose };
        await open(
            FIXTURE_EMPTY_PROJECT_ID,
            { getProjectsInfo: async () => [info] },
            withFolders(FIXTURE_EMPTY_PROJECT_ID, '/Users/dev/car-rental-api')
        );

        // Only the folder that is gone has it.
        expect(container.querySelectorAll('button[aria-label^="Locate "]')).toHaveLength(1);

        await click(button('Locate car-rental-api'));
        await flush();

        expect(choose).toHaveBeenCalledOnce();
        expect(folderPaths(FIXTURE_EMPTY_PROJECT_ID)).toEqual(['/Users/dev/clowdy', '/Users/dev/api-moved']);
        expect(store.projects.find(project => project.id === FIXTURE_EMPTY_PROJECT_ID)!.folders[1]!.id).toBe(
            'fld_added_1'
        );
    });

    it('moves nothing when the dialog is closed, and has no button where the window has no dialog', async () => {
        (window as { desktop?: unknown }).desktop = { chooseDirectories: async () => [] };
        await open(
            FIXTURE_EMPTY_PROJECT_ID,
            { getProjectsInfo: async () => [info] },
            withFolders(FIXTURE_EMPTY_PROJECT_ID, '/Users/dev/car-rental-api')
        );
        await click(button('Locate car-rental-api'));
        await flush();

        expect(folderPaths(FIXTURE_EMPTY_PROJECT_ID)).toEqual(['/Users/dev/clowdy', '/Users/dev/car-rental-api']);

        (window as { desktop?: unknown }).desktop = undefined;
        await open(
            FIXTURE_EMPTY_PROJECT_ID,
            { getProjectsInfo: async () => [info] },
            withFolders(FIXTURE_EMPTY_PROJECT_ID, '/Users/dev/car-rental-api')
        );

        expect(container.querySelector('button[aria-label^="Locate "]')).toBeNull();
    });
});

describe('ProjectsPage icon', () => {
    const PNG = 'data:image/png;base64,iVBORw0KGgo=';
    const settingsOf = (projectId: ProjectId) => store.projects.find(project => project.id === projectId)!.settings;
    const iconOf = (projectId: ProjectId) => row(projectId)?.querySelector('img')?.getAttribute('src');
    /** The picture in the name field. The project list under the page has pictures too, so this stays on the field. */
    const preview = () =>
        container.querySelector('input[type="file"]')!.parentElement!.querySelector('img')?.getAttribute('src');

    /** Picks a file for the icon. */
    async function pick(file: File) {
        const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;

        Object.defineProperty(input, 'files', { value: [file], configurable: true });
        await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
        await flush();
    }

    it("shows the favicon found in a project's main folder before its name, and the folder icon without one", async () => {
        await open();

        expect(iconOf(FIXTURE_PROJECT_ID)).toMatch(/^blob:/);
        expect(iconOf(FIXTURE_EMPTY_PROJECT_ID)).toBeUndefined();
        expect(iconOf(FIXTURE_PERSONAL_PROJECT_ID)).toBeUndefined();
    });

    it('uploads a picture drawn small, and resets it back to the folder favicon', async () => {
        square.mockResolvedValue(PNG);
        await open(FIXTURE_PROJECT_ID);

        const favicon = preview();

        expect(favicon).toMatch(/^blob:/);
        expect(button('Reset icon')).not.toBeNull();

        const file = new File(['png'], 'logo.png', { type: 'image/png' });

        await pick(file);
        expect(square).toHaveBeenCalledWith(file);
        expect(settingsOf(FIXTURE_PROJECT_ID).icon).toBe(PNG);
        expect(preview()).toBe(PNG);

        await click(button('Reset icon'));
        await flush();
        expect(settingsOf(FIXTURE_PROJECT_ID).icon).toBeUndefined();
        expect(preview()).toBe(favicon);
        expect(button('Reset icon')).not.toBeNull();
    });

    it('hides the favicon from the reset, and offers none where the folder icon already shows', async () => {
        await open(FIXTURE_PROJECT_ID);

        expect(preview()).toMatch(/^blob:/);
        await click(button('Reset icon'));
        await flush();
        expect(settingsOf(FIXTURE_PROJECT_ID).icon).toBe(NO_PROJECT_ICON);
        expect(preview()).toBeUndefined();
        expect(button('Reset icon')).toBeNull();

        await open(FIXTURE_EMPTY_PROJECT_ID);

        expect(preview()).toBeUndefined();
        expect(button('Choose icon')).not.toBeNull();
        expect(button('Reset icon')).toBeNull();
    });

    it('refuses a picture over 5 MB and a file that is not a picture, as toasts', async () => {
        square.mockRejectedValue(new Error('Not a picture'));
        await open(FIXTURE_EMPTY_PROJECT_ID);

        const huge = new File(['x'], 'huge.png', { type: 'image/png' });

        Object.defineProperty(huge, 'size', { value: 5 * 1024 * 1024 + 1 });
        await pick(huge);
        expect(square).not.toHaveBeenCalled();
        expect(toasts.error).toHaveBeenLastCalledWith({ message: 'huge.png is over 5 MB' });

        await pick(new File(['x'], 'notes.txt'));
        expect(toasts.error).toHaveBeenLastCalledWith({ message: "Couldn't read notes.txt as a picture" });
        expect(settingsOf(FIXTURE_EMPTY_PROJECT_ID).icon).toBeUndefined();
    });
});

describe('ProjectsPage workspace', () => {
    const API = 'fld_added_1';
    const NOTES = 'fld_added_2';
    const SETTINGS = { baseBranch: 'dev', setup: { files: ['.env', '.env*'], command: 'bun install\nbun run build' } };

    /** Car Rental with two more folders: `car-rental-api` (a repository) and `notes` (no repository), the first with settings when it is given any. */
    function folders(settings?: FolderSettings): FixtureData {
        const data = withFolders(FIXTURE_PROJECT_ID, '/Users/dev/car-rental-api', '/Users/dev/notes');

        if (settings) data.projects.find(project => project.id === FIXTURE_PROJECT_ID)!.folders[1]!.settings = settings;

        return data;
    }

    const settingsOf = (projectId: ProjectId, folderId: string) =>
        store.projects.find(project => project.id === projectId)?.folders.find(folder => folder.id === folderId)
            ?.settings;
    const openButton = (name: string) =>
        container.querySelector<HTMLButtonElement>(`button[aria-label="Folder settings: ${name}"]`);
    const form = () =>
        document.body.querySelector<HTMLInputElement>('input[aria-label="Base branch"]')?.closest('form') ?? null;
    const field = (label: string) =>
        document.getElementById(
            [...form()!.querySelectorAll('label')].find(candidate => candidate.textContent === label)!.htmlFor
        ) as HTMLTextAreaElement;
    const baseBranch = () => form()!.querySelector<HTMLInputElement>('input[aria-label="Base branch"]')!;
    const save = () =>
        [...form()!.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].find(
            candidate => candidate.textContent === 'Save'
        )!;

    function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
        const prototype =
            element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;

        act(() => {
            element.focus();
            Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
            element.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }

    /** Opens the page of Car Rental, and the Workspace dialog of one of its folders. */
    async function openDialog(name: string, overrides: Parameters<typeof open>[1] = {}, data: FixtureData = folders()) {
        await open(FIXTURE_PROJECT_ID, overrides, data);
        await click(openButton(name)!);
        await flush();
    }

    /** The commands the page sent, passed on to the fixture daemon. */
    function recording(sent: unknown[]) {
        return (base: Transport): Partial<Transport> => ({
            command: async input => {
                sent.push(input);

                return base.command(input);
            },
        });
    }

    it('gives each folder of a project a Workspace button, and the personal space none', async () => {
        await open(FIXTURE_PROJECT_ID, {}, folders());

        expect(
            rows().map(item => item.querySelector('button[aria-label^="Folder settings:"]')?.getAttribute('aria-label'))
        ).toEqual(['Folder settings: car-rental', 'Folder settings: car-rental-api', 'Folder settings: notes']);
        // Beside Open in GitHub, which a folder with a remote has.
        expect(rows()[0]!.querySelector('a[href="https://github.com/acme/car-rental"]')).not.toBeNull();

        await open(FIXTURE_PERSONAL_PROJECT_ID);

        expect(container.querySelector('button[aria-label^="Folder settings:"]')).toBeNull();
    });

    it("opens with what the folder has set, and with the repository's default branch as the placeholder of the base branch", async () => {
        await openDialog('car-rental-api', {}, folders(SETTINGS));

        expect(form()!.textContent).toContain('Settings of car-rental-api');
        expect(baseBranch().value).toBe('dev');
        expect(field('Files to copy').value).toBe('.env\n.env*');
        expect(field('Command').value).toBe('bun install\nbun run build');
        expect(form()!.textContent).toContain('One path per line, such as .env or .env*');

        // A folder with nothing set shows the default the repository has.
        await act(async () => Modal.opened[0]!.close(false));
        await click(openButton('car-rental')!);
        await flush();

        expect(baseBranch().value).toBe('');
        expect(baseBranch().placeholder).toBe('origin/main');
        expect(field('Files to copy').value).toBe('');
        expect(field('Command').value).toBe('');
    });

    it('saves a custom folder name and clears it back to the automatic name', async () => {
        await openDialog('car-rental-api', {}, folders(SETTINGS));
        const nameInput = () => form()!.querySelector<HTMLInputElement>('input[aria-label="Folder name"]')!;
        expect(nameInput().value).toBe('');
        typeInto(nameInput(), '  Backend  ');
        await act(async () => form()!.requestSubmit());
        await flush();
        expect(settingsOf(FIXTURE_PROJECT_ID, API)).toMatchObject({ name: 'Backend', baseBranch: 'dev' });
        expect(openButton('Backend')).not.toBeNull();
        await click(openButton('Backend')!);
        await flush();
        expect(nameInput().value).toBe('Backend');
        expect(nameInput().placeholder).toBe('car-rental-api');
        typeInto(nameInput(), '');
        await act(async () => form()!.requestSubmit());
        await flush();
        expect(settingsOf(FIXTURE_PROJECT_ID, API)).toEqual(SETTINGS);
        expect(openButton('car-rental-api')).not.toBeNull();
    });

    it('saves the three fields for that folder with one command, closes, and the folder keeps them', async () => {
        const sent: unknown[] = [];

        await openDialog('car-rental-api', recording(sent));
        expect(save().disabled).toBe(true);

        typeInto(baseBranch(), '  origin/dev ');
        typeInto(field('Files to copy'), '.env\n\n  .npmrc  \n');
        typeInto(field('Command'), 'bun install\nbun run build:shared\n');
        expect(save().disabled).toBe(false);

        await act(async () => form()!.requestSubmit());
        await flush();

        expect(sent).toEqual([
            {
                type: 'project.updateFolder',
                projectId: FIXTURE_PROJECT_ID,
                folderId: API,
                settings: {
                    baseBranch: 'origin/dev',
                    setup: { files: ['.env', '.npmrc'], command: 'bun install\nbun run build:shared' },
                },
            },
        ]);
        expect(settingsOf(FIXTURE_PROJECT_ID, API)).toEqual({
            baseBranch: 'origin/dev',
            setup: { files: ['.env', '.npmrc'], command: 'bun install\nbun run build:shared' },
        });
        expect(settingsOf(FIXTURE_PROJECT_ID, 'fld_car_rental')).toBeUndefined();
        expect(settingsOf(FIXTURE_PROJECT_ID, NOTES)).toBeUndefined();
        expect(form()).toBeNull();
    });

    it('sends null for what was emptied, and a folder with nothing left has no settings', async () => {
        const sent: unknown[] = [];

        await openDialog('car-rental-api', recording(sent), folders(SETTINGS));
        typeInto(baseBranch(), '');
        typeInto(field('Files to copy'), ' \n');
        typeInto(field('Command'), '');
        await act(async () => form()!.requestSubmit());
        await flush();

        expect(sent).toEqual([
            {
                type: 'project.updateFolder',
                projectId: FIXTURE_PROJECT_ID,
                folderId: API,
                settings: { baseBranch: null, setup: null },
            },
        ]);
        expect(settingsOf(FIXTURE_PROJECT_ID, API)).toBeUndefined();
        expect(form()).toBeNull();
    });

    it('sends a field that changed with the others as they were, and nothing at all while nothing changed', async () => {
        const sent: unknown[] = [];

        await openDialog('car-rental-api', recording(sent), folders(SETTINGS));
        expect(save().disabled).toBe(true);

        // Spaces round the same text are no change.
        typeInto(baseBranch(), ' dev ');
        expect(save().disabled).toBe(true);
        await act(async () => form()!.requestSubmit());
        expect(sent).toEqual([]);

        typeInto(field('Command'), 'make');
        await act(async () => form()!.requestSubmit());
        await flush();

        expect(sent).toEqual([
            {
                type: 'project.updateFolder',
                projectId: FIXTURE_PROJECT_ID,
                folderId: API,
                settings: { baseBranch: 'dev', setup: { files: ['.env', '.env*'], command: 'make' } },
            },
        ]);
        expect(settingsOf(FIXTURE_PROJECT_ID, API)).toEqual({
            baseBranch: 'dev',
            setup: { files: ['.env', '.env*'], command: 'make' },
        });
    });

    it('keeps the dialog and what was typed when the daemon refuses, with its reason as a toast', async () => {
        const refusal = {
            ok: false as const,
            requestId: 'r',
            error: { code: 'invalid' as const, message: 'The file "../x" must not have a . or .. part' },
        };

        await openDialog('car-rental-api', { command: async () => refusal });
        typeInto(field('Files to copy'), '../x');
        await act(async () => form()!.requestSubmit());
        await flush();

        expect(toasts.error).toHaveBeenCalledWith({ message: 'The file "../x" must not have a . or .. part' });
        expect(form()).not.toBeNull();
        expect(field('Files to copy').value).toBe('../x');
        expect(settingsOf(FIXTURE_PROJECT_ID, API)).toBeUndefined();
        expect(save().disabled).toBe(false);
    });

    it('says when the repository has no branch of the typed name, and when the folder is no repository', async () => {
        await openDialog('car-rental-api');
        typeInto(baseBranch(), 'origin/dev');
        expect(form()!.textContent).not.toContain('has no branch');

        typeInto(baseBranch(), 'release');
        expect(form()!.textContent).toContain(
            'The repository has no branch called release, so the default branch is used'
        );
        expect(form()!.textContent).not.toContain('is not one');

        await act(async () => Modal.opened[0]!.close(false));
        await click(openButton('notes')!);
        await flush();

        expect(form()!.textContent).toContain('Worktrees need a git repository, and this folder is not one');
        typeInto(baseBranch(), 'release');
        expect(form()!.textContent).not.toContain('has no branch');
    });

    it('shows a configured base branch the repository has as its own value, and the generic placeholder once it is emptied', async () => {
        await openDialog('car-rental-api', {}, folders({ baseBranch: 'dev' }));

        expect(baseBranch().value).toBe('dev');
        // The answer for this folder is its own base: the repository's default is not known from it.
        expect(baseBranch().placeholder).toBe('Default branch');

        typeInto(baseBranch(), '');
        expect(baseBranch().placeholder).toBe('Default branch');
    });

    it('says that a folder that left the project is gone, and saves nothing for it', async () => {
        const sent: unknown[] = [];

        await openDialog('car-rental-api', recording(sent));
        await store.command({
            type: 'project.update',
            projectId: FIXTURE_PROJECT_ID,
            folders: [{ id: 'fld_car_rental' }, { id: NOTES }],
        });
        await flush();
        // The form is drawn again with the next change to a field.
        typeInto(baseBranch(), 'dev');

        expect(form()!.textContent).toContain('This folder is no longer in the project');
        expect(save().disabled).toBe(true);
        await act(async () => form()!.requestSubmit());
        expect(sent).toEqual([
            {
                type: 'project.update',
                projectId: FIXTURE_PROJECT_ID,
                folders: [{ id: 'fld_car_rental' }, { id: NOTES }],
            },
        ]);
    });

    it('keeps the settings of a folder when the folders are dragged into another order', async () => {
        await open(FIXTURE_PROJECT_ID, {}, folders(SETTINGS));
        await move(2, 1);

        expect(rowPaths()).toEqual(['/Users/dev/car-rental', '/Users/dev/notes', '/Users/dev/car-rental-api']);
        expect(settingsOf(FIXTURE_PROJECT_ID, API)).toEqual(SETTINGS);

        // The dialog of the folder in its new place has them.
        await click(openButton('car-rental-api')!);
        await flush();
        expect(baseBranch().value).toBe('dev');
        expect(field('Files to copy').value).toBe('.env\n.env*');
    });
});
