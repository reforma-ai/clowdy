// @vitest-environment happy-dom
import { commitMessageAgent } from '@clowdy/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider, SETTINGS_PAGES } from '../../stores';
import { SourceControlPreferences, sourceControlPreferences } from '../changes/sourceControlPreferences';
import { named } from './accessibleName';
import { SettingsWindow } from './SettingsWindow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let store: RootStore;

const draw = () =>
    act(async () =>
        root.render(
            <RootStoreProvider value={store}>
                <SettingsWindow />
            </RootStoreProvider>
        )
    );
const sidebarPages = () =>
    [...container.querySelectorAll('[aria-label="Settings pages"] [role="option"]')].map(item => item.textContent);

beforeEach(async () => {
    store = new RootStore(new FixtureTransport(), { storage: undefined });
    await store.load();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    store.dispose();
});

const press = (target: Element | null | undefined) =>
    act(async () => {
        target?.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true })
        );
        target?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        target?.dispatchEvent(
            new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true })
        );
        target?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        (target as HTMLElement | null | undefined)?.click();
    });
const option = (name: string) =>
    [...container.querySelectorAll('[aria-label="Settings pages"] [role="option"]')].find(
        item => item.textContent === name
    );
/** The title of the window: the path to the page that is shown, each page above the last one a link. */
const path = () => container.querySelector('nav[aria-label]');
const titleOf = () => path()?.querySelector('[aria-current="page"]')?.textContent;

describe('Settings', () => {
    it('has a sidebar entry for every page the store can show, in the order SETTINGS_PAGES names, under the headings of their groups', async () => {
        await draw();

        expect(sidebarPages()).toEqual([
            'Appearance',
            'Chat',
            'Files',
            'Source Control',
            'Shortcuts',
            'Spaces',
            'Providers',
            'Delegation',
            'Skills',
            'About',
        ]);
        expect(sidebarPages()).toHaveLength(SETTINGS_PAGES.length);

        const text = container.querySelector('[aria-label="Settings pages"]')!.textContent!;

        expect(
            ['General', 'Appearance', 'Workspace', 'Spaces', 'Agents', 'Providers'].map(word => text.indexOf(word))
        ).toEqual([...Array(6)].map((_, index, all) => expect.any(Number)));
        expect(text.indexOf('General')).toBeLessThan(text.indexOf('Appearance'));
        expect(text.indexOf('Workspace')).toBeLessThan(text.indexOf('Spaces'));
        expect(text.indexOf('Agents')).toBeLessThan(text.indexOf('Providers'));
        // About has a group of its own, after the last page of Agents.
        expect(text.indexOf('Skills')).toBeLessThan(text.indexOf('Clowdy'));
        expect(text.indexOf('Clowdy')).toBeLessThan(text.indexOf('About'));
    });

    it('shows the Shortcuts page, titled in the path, when the store points at it, as `?` does', async () => {
        store.ui.openSettings('shortcuts');
        await draw();

        expect(titleOf()).toBe('Shortcuts');
        expect(container.textContent).toContain('Show keyboard shortcuts');
        expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe('Shortcuts');
    });

    it('asks the store for another page when one is chosen in the sidebar, and shows it once the store has it', async () => {
        await draw();
        await press(option('Chat'));

        expect(store.ui.settingsPage).toBe('chat');
        expect(titleOf()).toBe('Chat');
    });

    it('remembers the default diff layout chosen in Source Control', async () => {
        await draw();
        await press(option('Source Control'));

        const toggle = named<HTMLInputElement>(container, 'input', 'Collapse diffs by default')!;

        expect(titleOf()).toBe('Source Control');
        expect(toggle.checked).toBe(true);
        expect(new SourceControlPreferences().collapseDiffs).toBe(true);

        try {
            await press(toggle);
            expect(toggle.checked).toBe(false);
            expect(new SourceControlPreferences(window.localStorage).collapseDiffs).toBe(false);
        } finally {
            act(() => sourceControlPreferences.setCollapseDiffs(true));
        }
    });

    it('enables automatic sync by default and remembers when it is turned off', async () => {
        store.ui.openSettings('source-control');
        await draw();

        const toggle = named<HTMLInputElement>(container, 'input', 'Sync after commit and merge')!;

        expect(new SourceControlPreferences().autoSync).toBe(true);
        expect(toggle.checked).toBe(true);

        try {
            await press(toggle);
            expect(toggle.checked).toBe(false);
            expect(new SourceControlPreferences(window.localStorage).autoSync).toBe(false);
        } finally {
            act(() => sourceControlPreferences.setAutoSync(true));
        }
    });

    it('offers the sleep mode in Chat and saves each choice', async () => {
        store.ui.openSettings('chat');
        await draw();

        const select = () => named(container, 'button', 'Sleep mode');
        expect(select()?.textContent).toBe('Keep awake while agents work');
        const pick = async (name: string) => {
            await press(select());
            const item = [...document.body.querySelectorAll('[role="listbox"] [role="option"]')].find(
                option => option.textContent === name
            );
            expect(item).toBeDefined();
            await press(item);
            await vi.waitFor(() => expect(select()?.textContent).toBe(name));
        };

        await pick('Always keep awake');
        expect(await store.transport.getPowerSettings()).toEqual({ sleepMode: 'always' });
        await pick('Allow sleep');
        expect(await store.transport.getPowerSettings()).toEqual({ sleepMode: 'allow' });
        act(() => store.ui.showSettingsPage('appearance'));
        await draw();
        expect(select()).toBeNull();
        act(() => store.ui.showSettingsPage('chat'));
        await draw();
        expect(select()?.textContent).toBe('Allow sleep');
    });

    it('sets a single commit message provider from Source Control', async () => {
        store.ui.openSettings('source-control');
        await draw();

        const select = () => named(container, 'button', 'Commit message provider');
        const pick = async (name: string) => {
            await press(select());
            const item = [...document.body.querySelectorAll('[role="listbox"] [role="option"]')].find(
                option => option.textContent === name
            );
            expect(item).toBeDefined();
            await press(item);
            await vi.waitFor(() => expect(select()?.textContent).toBe(name));
        };

        expect(select()?.textContent).toBe('Codex');

        await pick('Claude Code');
        expect(commitMessageAgent(await store.transport.getAgents())?.id).toBe('claude');

        await pick('Off');
        expect(commitMessageAgent(await store.transport.getAgents())).toBeUndefined();
    });

    it('has Add space… at the end of the title of Projects, and not on another page', async () => {
        const addProject = () =>
            [...container.querySelectorAll('button')].find(button => button.textContent === 'Add space…');

        store.ui.openSettings('appearance');
        await draw();

        expect(addProject()).toBeUndefined();

        act(() => store.ui.showSettingsPage('projects'));
        await draw();

        expect(addProject()).toBeDefined();
    });

    it('shows the page of a project as a path over Projects, which leads back to the list, and takes Add space… away while it is open', async () => {
        const project = store.projects.find(candidate => !candidate.personal)!;

        store.ui.openProjectSettings(project.id);
        await draw();
        await draw();

        expect(titleOf()).toBe(project.name);
        expect(path()?.querySelector('button')?.textContent).toBe('Spaces');
        expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Add space…')).toBe(
            false
        );

        await press(path()!.querySelector('button'));
        await draw();

        expect(store.ui.settingsProjectId).toBeNull();
        expect(store.ui.settingsPage).toBe('projects');
        expect(titleOf()).toBe('Spaces');
    });
});
