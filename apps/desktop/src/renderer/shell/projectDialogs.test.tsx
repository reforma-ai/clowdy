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
const sortable = vi.hoisted(() => ({
    items: [] as unknown[],
    onChange: undefined as ((items: unknown[]) => void) | undefined,
}));

vi.mock('@clowdy/components/SortableList', async importOriginal => {
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
const button = (text: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
        candidate => candidate.textContent?.trim() === text || candidate.getAttribute('aria-label') === text
    );
const input = (label: string) => document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const rows = () => [...document.body.querySelectorAll<HTMLElement>('[data-folder-path]')];
const paths = () => rows().map(row => row.dataset.folderPath);
/** The folders marked Main: there is one, the first, whenever there are folders. */
const marked = () =>
    rows()
        .filter(row => row.textContent?.includes('Main'))
        .map(row => row.dataset.folderPath);
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

describe('the Add space form', () => {
    it('says a new folder is made when none is added, needs a name only then, and adds the project in that new folder', async () => {
        desktop();
        await open();

        expect(form()?.textContent).toContain('Without folders, Clowdy creates one named after the space');
        expect(paths()).toEqual([]);
        expect(button('Add space')?.disabled).toBe(true);

        type(input('Name'), 'Garden Planner');
        expect(button('Add space')?.disabled).toBe(false);

        await press(button('Add space'));

        expect(store.selectedProject?.project).toMatchObject({
            name: 'Garden Planner',
            folders: [{ path: '/Users/dev/Clowdy/projects/garden-planner' }],
        });
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
        expect(button('Add space')?.disabled).toBe(false);
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

        await press(button('Add space'));

        expect(store.selectedProject?.project).toMatchObject({
            name: 'web',
            folders: [{ path: '/Users/dev/web' }, { path: '/Users/dev/api' }],
        });
        expect(form()).toBeNull();
    });

    it('keeps the focus in the form when a folder is removed: on the folder in its place, the one above, then Add folders…', async () => {
        desktop(['/Users/dev/web', '/Users/dev/api', '/Users/dev/docs']);
        await open();
        await press(button('Add folders…'));

        for (const [removed, focused] of [
            ['Remove api', 'Remove docs'],
            ['Remove docs', 'Remove web'],
            ['Remove web', 'Add folders…'],
        ]) {
            act(() => button(removed)!.focus());
            await press(button(removed));

            expect(document.activeElement).toBe(button(focused));
        }
    });

    it("shows the daemon's refusal in the form and stays open, until the folders change", async () => {
        desktop(['/Users/dev', '/Users/dev/api']);
        await open({
            command: async () => ({
                ok: false,
                requestId: 'r',
                error: { code: 'invalid', message: '/Users/dev/api is inside /Users/dev' },
            }),
        });
        await press(button('Add folders…'));
        await press(button('Add space'));

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
        await press(button('Add space'));

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
            await act(async () =>
                input('Folder path').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
            );
        }

        expect(paths()).toEqual(['/Users/dev/web', '/Users/dev/api']);
        expect(store.projects).toHaveLength(3);
        expect(input('Name').value).toBe('web');

        // A root keeps its separator: `D:` alone is not the root of the drive.
        type(input('Folder path'), 'D:\\');
        await press(button('Add folder'));
        expect(paths()).toEqual(['/Users/dev/web', '/Users/dev/api', 'D:\\']);
    });
    describe('Clone repository…', () => {
        const cloneAddress = () =>
            document.body.querySelector<HTMLInputElement>('input[aria-label="Repository address"]')!;
        const afterDelay = () => act(async () => void (await new Promise(resolve => setTimeout(resolve, 450))));

        beforeEach(() => {
            // A window opened over another is anchored to it and closes when its anchor is not on the page: happy-dom lays nothing out, so every element would be gone.
            const box = { x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 400, width: 400, height: 400 };

            vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ ...box, toJSON: () => box });
            vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([box] as unknown as DOMRectList);
        });

        it('sits beside Add folders… in the desktop app, and in a browser under the path field', async () => {
            desktop([]);
            await open();

            expect(button('Add folders…')).not.toBeUndefined();
            expect(button('Clone repository…')).not.toBeUndefined();
            expect(button('Clone repository…')!.parentElement).toBe(button('Add folders…')!.parentElement);

            delete (window as { desktop?: unknown }).desktop;
            await open();

            expect(input('Folder path')).not.toBeNull();
            expect(button('Clone repository…')).not.toBeUndefined();
        });

        it('puts the folder a clone made into the list, like a picked one, and leaves the form open', async () => {
            // The first answer is for Choose folder… in the clone dialog.
            desktop(['/Users/dev/code']);
            const cloneGit = vi.fn(async (request: { path: string }) => request.path);

            await open({ cloneGit: cloneGit as Transport['cloneGit'] });
            await press(button('Clone repository…'));

            expect(document.body.querySelectorAll('form')).toHaveLength(2);

            type(cloneAddress(), 'https://github.com/acme/booking-api.git');
            await press(button('Choose folder…'));
            await afterDelay();
            await press(button('Clone'));

            expect(cloneGit).toHaveBeenCalledWith(
                { url: 'https://github.com/acme/booking-api.git', path: '/Users/dev/code/booking-api' },
                expect.any(Function),
                expect.any(AbortSignal)
            );
            expect(paths()).toEqual(['/Users/dev/code/booking-api']);
            expect(marked()).toEqual(['/Users/dev/code/booking-api']);
            // Only the clone dialog went; the form is where it was, with the folder in its list.
            expect(document.body.querySelectorAll('form')).toHaveLength(1);
            expect(button('Add space')!.disabled).toBe(false);
        });

        it('leaves the list as it was when the clone is cancelled with Escape', async () => {
            desktop([]);
            const cloneGit: Transport['cloneGit'] = (_request, _progress, signal) =>
                new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));

            await open({ cloneGit });
            await press(button('Clone repository…'));
            type(cloneAddress(), 'https://github.com/acme/booking-api.git');
            await afterDelay();
            await press(button('Clone'));
            await act(async () => {
                document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            });
            await settle();

            // The clone dialog closed and the form under it stayed.
            expect(document.body.querySelectorAll('form')).toHaveLength(1);
            expect(paths()).toEqual([]);
        });
    });
});
