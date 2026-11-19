// @vitest-environment happy-dom
import { Modal } from '@clowdy/components/Modal';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PROJECT_ID } from '../daemon/fixtureData';
import { FixtureTransport } from '../daemon/fixtureTransport';
import { overrideTransport } from '../daemon/testing';
import { RootStore } from '../stores';
import { openAddProject } from './projectDialogs';

import type { SortableList as SortableListComponent } from '@clowdy/components/SortableList';
import type { Transport } from '../daemon/transport';

const toasts = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }));

vi.mock('@clowdy/components/Toast', () => ({ toast: toasts }));

/**
 * happy-dom cannot drag, so the tests move a folder the way a drop does: through the list's own `onChange`, with the items in their new
 * order. The real list still draws the rows.
 */
const sortable = vi.hoisted(() => ({ items: [] as unknown[], onChange: undefined as ((items: unknown[]) => void) | undefined }));

vi.mock('@clowdy/components/SortableList', async (importOriginal) => {
    const actual = await importOriginal<{ SortableList: typeof SortableListComponent }>();
    const { createElement } = await import('react');

    return {
        ...actual,
        SortableList: (props: Parameters<typeof actual.SortableList>[0]) => {
            sortable.items = [...props.items];
            sortable.onChange = items => props.onChange(items, { item: items[0], index: 0 });

            return createElement(actual.SortableList, props);
        },
    };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

/** The desktop bridge, with what the folder dialog answers each time it is opened (nothing once those run out, as a cancel does). */
function desktop(...answers: string[][]) {
    const chooseDirectories = vi.fn(async () => answers.shift() ?? []);

    (window as { desktop?: unknown }).desktop = { chooseDirectories };

    return chooseDirectories;
}

async function open(overrides: Partial<Transport> = {}) {
    store = new RootStore(overrideTransport(new FixtureTransport(), overrides), { storage: memoryStorage() });
    await store.load();
    act(() => openAddProject(store));
    await settle();
}

const form = () => document.body.querySelector('form');
const button = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent?.trim() === text || candidate.getAttribute('aria-label') === text);
const input = (label: string) => document.body.querySelector<HTMLInputElement>(`input[aria-label="${ label }"]`)!;
const rows = () => [...document.body.querySelectorAll<HTMLElement>('[data-folder-path]')];
const paths = () => rows().map(row => row.dataset.folderPath);
/** The folders marked Main: there is one, the first, whenever there are folders. */
const marked = () => rows().filter(row => row.textContent?.includes('Main')).map(row => row.dataset.folderPath);
const alert = () => document.body.querySelector('[role="alert"]')?.textContent;

async function press(element: HTMLElement | undefined) {
    await act(async () => element!.click());
    await settle();
}

function type(field: HTMLInputElement, value: string) {
    act(() => {
        field.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

/** Drops the folder at `from` at `to`. */
function move(from: number, to: number) {
    const items = [...sortable.items];
    const [moved] = items.splice(from, 1);

    items.splice(to, 0, moved);
    act(() => sortable.onChange!(items));
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
    toasts.info.mockReset();
    store.dispose();
    document.body.innerHTML = '';
});

describe('the Add project form', () => {
    it('says a new folder is made when none is added, needs a name only then, and adds the project in that new folder', async () => {
        desktop();
        await open();

        expect(form()?.textContent).toContain('Without folders, Clowdy creates one named after the project');
        expect(paths()).toEqual([]);
        expect(button('Add project')?.disabled).toBe(true);

        type(input('Name'), 'Garden Planner');
        expect(button('Add project')?.disabled).toBe(false);

        await press(button('Add project'));

        expect(store.selectedProject?.project).toMatchObject({ name: 'Garden Planner', folders: [{ path: '/Users/dev/Clowdy/projects/garden-planner' }] });
        expect(form()).toBeNull();
        expect(toasts.info).not.toHaveBeenCalled();
    });

    it('adds the folders chosen in the system dialog each time it is opened, and a folder the list has once', async () => {
        const choose = desktop(['/Users/dev/web', '/Users/dev/api'], ['/Users/dev/api', '/Users/dev/docs']);

        await open();
        await press(button('Add folders…'));
        await press(button('Add folders…'));

        expect(choose).toHaveBeenCalledTimes(2);
        expect(paths()).toEqual(['/Users/dev/web', '/Users/dev/api', '/Users/dev/docs']);
        expect(marked()).toEqual(['/Users/dev/web']);
        expect(form()?.textContent).not.toContain('Without folders');

        // A dialog closed without a choice changes nothing.
        await press(button('Add folders…'));
        expect(paths()).toEqual(['/Users/dev/web', '/Users/dev/api', '/Users/dev/docs']);
    });

    it('names the project after the main folder until the person types a name', async () => {
        desktop(['/Users/dev/web', '/Users/dev/api']);
        await open();

        expect(input('Name').value).toBe('');

        await press(button('Add folders…'));
        expect(input('Name').value).toBe('web');

        move(1, 0);
        expect(input('Name').value).toBe('api');

        type(input('Name'), 'Storefront');
        move(1, 0);
        await press(button('Remove api'));
        expect(input('Name').value).toBe('Storefront');

        // With folders the name may be left empty: the daemon names the project after the main folder.
        type(input('Name'), '');
        expect(button('Add project')?.disabled).toBe(false);
    });

    it('reorders and removes folders, keeps the first one marked Main, and adds them in that order', async () => {
        desktop(['/Users/dev/web', '/Users/dev/api', '/Users/dev/docs']);
        await open();
        await press(button('Add folders…'));

        move(2, 0);
        expect(paths()).toEqual(['/Users/dev/docs', '/Users/dev/web', '/Users/dev/api']);
        expect(marked()).toEqual(['/Users/dev/docs']);

        await press(button('Remove docs'));
        expect(paths()).toEqual(['/Users/dev/web', '/Users/dev/api']);
        expect(marked()).toEqual(['/Users/dev/web']);

        await press(button('Add project'));

        expect(store.selectedProject?.project).toMatchObject({ name: 'web', folders: [{ path: '/Users/dev/web' }, { path: '/Users/dev/api' }] });
        expect(form()).toBeNull();
    });

    it('keeps the focus in the form when a folder is removed: on the folder in its place, the one above, then Add folders…', async () => {
        desktop(['/Users/dev/web', '/Users/dev/api', '/Users/dev/docs']);
        await open();
        await press(button('Add folders…'));

        for (const [removed, focused] of [['Remove api', 'Remove docs'], ['Remove docs', 'Remove web'], ['Remove web', 'Add folders…']]) {
            act(() => button(removed)!.focus());
            await press(button(removed));

            expect(document.activeElement).toBe(button(focused));
        }
    });

    it('shows the daemon\'s refusal in the form and stays open, until the folders change', async () => {
        desktop(['/Users/dev', '/Users/dev/api']);
        await open({ command: async () => ({ ok: false, requestId: 'r', error: { code: 'invalid', message: '/Users/dev/api is inside /Users/dev' } }) });
        await press(button('Add folders…'));
        await press(button('Add project'));

        expect(alert()).toBe('/Users/dev/api is inside /Users/dev');
        expect(form()).not.toBeNull();
        expect(store.selectedProjectId).toBe(FIXTURE_PROJECT_ID);

        await press(button('Remove api'));
        expect(alert()).toBeUndefined();
    });

    it('switches to the project that has the same folders and says so in a toast', async () => {
        desktop(['/Users/dev/clowdy']);
        await open();
        await press(button('Add folders…'));
        await press(button('Add project'));

        expect(store.selectedProjectId).toBe(FIXTURE_EMPTY_PROJECT_ID);
        expect(store.projects).toHaveLength(3);
        expect(toasts.info).toHaveBeenCalledWith({ message: 'Opened Clowdy, it has the same folders' });
        expect(form()).toBeNull();
    });

    it('takes a typed path in a plain browser, which has no folder dialog', async () => {
        await open();

        expect(button('Add folders…')).toBeUndefined();
        expect(button('Add folder')?.disabled).toBe(true);

        // A separator left at the end is not part of the folder.
        type(input('Folder path'), '/Users/dev/web/');
        await press(button('Add folder'));
        expect(paths()).toEqual(['/Users/dev/web']);
        expect(input('Folder path').value).toBe('');

        // Enter adds what is typed; the folder the list has already is not added again.
        for (const path of ['/Users/dev/web', '/Users/dev/api']) {
            type(input('Folder path'), path);
            await act(async () => input('Folder path').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
        }

        expect(paths()).toEqual(['/Users/dev/web', '/Users/dev/api']);
        expect(store.projects).toHaveLength(3);
        expect(input('Name').value).toBe('web');

        // A root keeps its separator: `D:` alone is not the root of the drive.
        type(input('Folder path'), 'D:\\');
        await press(button('Add folder'));
        expect(paths()).toEqual(['/Users/dev/web', '/Users/dev/api', 'D:\\']);
    });
});
