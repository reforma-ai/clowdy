// @vitest-environment happy-dom
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PERSONAL_PROJECT_ID, FIXTURE_PROJECT_ID } from '../../../daemon/fixtureData';
import { FixtureTransport } from '../../../daemon/fixtureTransport';
import { overrideTransport } from '../../../daemon/testing';
import { RootStore, RootStoreProvider } from '../../../stores';
import { ProjectsPage } from './ProjectsPage';

import type { OpenConfirmModalOptions } from '@clowdy/components/modals';
import type { Transport } from '../../../daemon/transport';

const confirm = vi.hoisted(() => vi.fn());

vi.mock('@clowdy/components/modals', () => ({ openConfirmModal: confirm }));

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

async function open(projectId: string | null = null, overrides: Partial<Transport> = {}) {
    store = new RootStore(overrideTransport(new FixtureTransport(), overrides), { storage: memoryStorage() });
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

function type(input: HTMLInputElement, value: string) {
    act(() => {
        input.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

beforeEach(() => {
    confirm.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
});

afterEach(() => {
    delete (window as { desktop?: unknown }).desktop;
    act(() => reactRoot.unmount());
    container.remove();
    store.dispose();
    document.body.innerHTML = '';
});

describe('ProjectsPage list', () => {
    it('lists the personal space first, then the projects, with where they are and what they hold', async () => {
        await open();

        const rows = [...container.querySelectorAll('button[data-project-id]')].map(item => item.textContent);

        expect(rows).toEqual([
            expect.stringContaining('Personal'),
            expect.stringContaining('Car Rental'),
            expect.stringContaining('Clowdy'),
        ]);
        expect(rows[1]).toContain('/Users/dev/car-rental');
        expect(rows[1]).toContain('4 chats · 11 tasks');
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

    it('does not offer removal while agents work in the project', async () => {
        await open();
        await click(button('Car Rental actions'));

        const remove = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Remove…')!;

        expect(remove.getAttribute('aria-disabled')).toBe('true');
    });
});

describe('ProjectsPage project', () => {
    it('shows where the project is, its git remote as a link, and its branch', async () => {
        await open(FIXTURE_PROJECT_ID);

        expect(container.textContent).toContain('/Users/dev/car-rental');
        expect(container.querySelector<HTMLAnchorElement>('a[href="https://github.com/acme/car-rental"]')?.textContent).toContain('github.com/acme/car-rental');
        expect(container.textContent).toContain('main');
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

    it('saves the agent and the mode of new chats, and clears the agent with Default', async () => {
        await open(FIXTURE_EMPTY_PROJECT_ID);

        const settings = () => store.projects.find(project => project.id === FIXTURE_EMPTY_PROJECT_ID)!.settings;
        const radio = (group: string, label: string) => [...container.querySelectorAll<HTMLElement>(`[aria-label="${ group }"] [role="radio"]`)].find(item => item.textContent === label)!;

        await click(radio('Agent for new chats', 'Codex'));
        await flush();
        expect(settings().engine).toBe('codex');

        await click(radio('Mode for new chats', 'Semi-manual'));
        await flush();
        expect(settings().chatMode).toBe('semi');

        await click(radio('Agent for new chats', 'Default'));
        await flush();
        expect(settings()).not.toHaveProperty('engine');
        expect(settings().chatMode).toBe('semi');
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

    it('points the project at another folder after the person chose it and confirmed', async () => {
        (window as { desktop?: unknown }).desktop = { chooseDirectory: async () => '/Users/dev/moved' };
        await open(FIXTURE_EMPTY_PROJECT_ID);
        await click(named('Change folder…'));
        await flush();

        expect(lastConfirm()).toMatchObject({ title: 'Use another folder?', confirmLabel: 'Use this folder' });
        expect(lastConfirm().message).toContain('/Users/dev/moved');

        await act(async () => lastConfirm().onConfirm());
        await flush();

        expect(store.projects.find(project => project.id === FIXTURE_EMPTY_PROJECT_ID)?.path).toBe('/Users/dev/moved');
        expect(container.textContent).toContain('/Users/dev/moved');
    });

    it('shows the daemon\'s reason in the dialog when it refuses the folder', async () => {
        (window as { desktop?: unknown }).desktop = { chooseDirectory: async () => '/Users/dev/car-rental' };
        await open(FIXTURE_EMPTY_PROJECT_ID);
        await click(named('Change folder…'));
        await flush();

        await expect(lastConfirm().onConfirm()).rejects.toThrow('already a project');
    });

    it('does nothing when the folder dialog is closed without a choice', async () => {
        (window as { desktop?: unknown }).desktop = { chooseDirectory: async () => null };
        await open(FIXTURE_EMPTY_PROJECT_ID);
        await click(named('Change folder…'));
        await flush();

        expect(confirm).not.toHaveBeenCalled();
    });

    it('keeps Remove and Change folder off while agents work, and says why', async () => {
        await open(FIXTURE_PROJECT_ID);

        expect(named('Remove project').disabled).toBe(true);
        expect(named('Change folder…').disabled).toBe(true);
        expect(container.textContent).toContain('Agents are working in this project');
    });

    it('shows the personal space with its folder and new-chat settings only', async () => {
        await open(FIXTURE_PERSONAL_PROJECT_ID);

        expect(container.querySelector('input[aria-label="Project name"]')).toBeNull();
        expect(container.textContent).not.toContain('Remove project');
        expect(container.textContent).not.toContain('Change folder');
        expect(container.textContent).not.toContain('Git');
        expect(container.querySelector('[aria-label="Agent for new chats"]')).not.toBeNull();
    });

    it('says so when the repository could not be read, instead of waiting for it', async () => {
        await open(FIXTURE_EMPTY_PROJECT_ID, { getProjectsInfo: () => Promise.reject(new Error('offline')) });

        expect(container.textContent).toContain('The repository could not be read.');
        expect(container.textContent).not.toContain('Reading the repository…');
    });

    it('warns when the folder is gone', async () => {
        await open(FIXTURE_EMPTY_PROJECT_ID, { getProjectsInfo: async () => [{ projectId: FIXTURE_EMPTY_PROJECT_ID, folderExists: false, chats: 0, tasks: 0, activeRuns: 0 }] });

        expect(container.textContent).toContain('This folder no longer exists');
        expect(named('Choose folder…')).toBeDefined();
    });
});
