// @vitest-environment happy-dom
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
});

afterEach(() => {
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
            'Create project',
            'Open existing project…',
            'Manage projects…',
        ]);
        // The menu has a separator between the personal space and the projects, and one before the actions.
        expect(document.body.querySelectorAll('[role="separator"]')).toHaveLength(3);
    });

    it('marks the open project and switches to the one chosen', async () => {
        await open();

        expect(items()[1].querySelector('svg')).not.toBeNull();
        expect(store.selectedProjectId).toBe(FIXTURE_PROJECT_ID);

        await act(async () => items()[2].click());

        expect(store.selectedProjectId).toBe(FIXTURE_EMPTY_PROJECT_ID);
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

    it('lists no separator before the projects when the personal space is all there is', async () => {
        const data = createFixtureData();

        data.projects = data.projects.filter(project => project.personal);
        await open(data);

        expect(labels()).toEqual([expect.stringContaining('Personal'), 'Create project', 'Open existing project…', 'Manage projects…']);
        expect(document.body.querySelectorAll('[role="separator"]')).toHaveLength(2);
    });
});
