// @vitest-environment happy-dom
import { Modal } from '@clowdy/components/Modal';
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PERSONAL_PROJECT_ID, FIXTURE_PROJECT_ID } from '../daemon/fixtureData';
import { FixtureTransport } from '../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../stores';
import { ProjectSelect } from './ProjectSelect';

// The babel plugin that makes the app's components observers does not run under Vitest.
const Select = observer(ProjectSelect);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let store: RootStore;

const storage = () => {
    const data: Record<string, string> = {};

    return { getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => void (data[key] = value) };
};

async function flush() {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
}

async function open(data = createFixtureData()) {
    store = new RootStore(new FixtureTransport({ data }), { storage: storage() });
    await store.load();
    act(() => root.render(<RootStoreProvider value={ store }><Select /></RootStoreProvider>));
    await flush();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Project"]')!.click());
    await flush();
}

const items = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const labels = () => items().map(item => item.textContent);

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    // The modal animates by itself, whatever the motion setting; a test that ends while it moves leaves a cancelled animation behind.
    const create = Modal.create.bind(Modal);

    vi.spyOn(Modal, 'create').mockImplementation(options => create({ ...options, animate: false }));
});

afterEach(async () => {
    for (const modal of Modal.opened) await modal.close(false);

    vi.restoreAllMocks();
    act(() => root.unmount());
    container.remove();
    store.dispose();
    document.body.innerHTML = '';
});

describe('ProjectSelect', () => {
    it('lists the personal space on top, then the projects, then the actions', async () => {
        await open();

        expect(labels()).toEqual([
            expect.stringContaining('Personal'),
            expect.stringContaining('Car Rental'),
            expect.stringContaining('Clowdy'),
            'Add project…',
            'Manage projects…',
        ]);
        // The menu has a separator between the personal space and the projects, and one before the actions.
        expect(document.body.querySelectorAll('[role="separator"]')).toHaveLength(2);
    });

    it('marks the open project and switches to the one chosen', async () => {
        await open();

        // Every project has its icon; the open one has the check after it.
        expect(items()[1].querySelectorAll('svg')).toHaveLength(2);
        expect(items()[2].querySelectorAll('svg')).toHaveLength(1);
        expect(store.selectedProjectId).toBe(FIXTURE_PROJECT_ID);

        await act(async () => items()[2].click());

        expect(store.selectedProjectId).toBe(FIXTURE_EMPTY_PROJECT_ID);
    });

    it('draws an icon before every project and sets it level with the middle of the two lines', async () => {
        await open();

        for (const item of items().slice(0, 3)) {
            expect(item.querySelector('svg')).not.toBeNull();
            expect(item.getAttribute('data-align')).toBe('center');
        }
    });

    it('can switch to the personal space', async () => {
        await open();
        await act(async () => items()[0].click());

        expect(store.selectedProjectId).toBe(FIXTURE_PERSONAL_PROJECT_ID);
        expect(container.querySelector('button[aria-label="Project"]')?.textContent).toBe('Personal');
    });

    it('opens Settings on the list of projects with Manage projects…', async () => {
        await open();
        await act(async () => items().find(item => item.textContent === 'Manage projects…')!.click());

        expect([store.ui.settingsOpen, store.ui.settingsPage, store.ui.settingsProjectId]).toEqual([true, 'projects', null]);
    });

    it('opens the Add project form with Add project…', async () => {
        await open();
        await act(async () => items().find(item => item.textContent === 'Add project…')!.click());
        await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 60));
        });

        const form = document.body.querySelector('form');

        expect(form?.textContent).toContain('Add project');
        expect(form?.querySelector('[aria-label="Name"]')).not.toBeNull();
        expect(form?.textContent).toContain('Folders');
    });

    it('lists no separator before the projects when the personal space is all there is', async () => {
        const data = createFixtureData();

        data.projects = data.projects.filter(project => project.personal);
        await open(data);

        expect(labels()).toEqual([expect.stringContaining('Personal'), 'Add project…', 'Manage projects…']);
        expect(document.body.querySelectorAll('[role="separator"]')).toHaveLength(1);
    });
});
