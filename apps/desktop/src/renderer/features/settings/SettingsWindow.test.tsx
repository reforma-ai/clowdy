// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider, SETTINGS_PAGES } from '../../stores';
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
            'Shortcuts',
            'Projects',
            'Providers',
            'Skills',
            'About',
        ]);
        expect(sidebarPages()).toHaveLength(SETTINGS_PAGES.length);

        const text = container.querySelector('[aria-label="Settings pages"]')!.textContent!;

        expect(
            ['General', 'Appearance', 'Workspace', 'Projects', 'Agents', 'Providers'].map(word => text.indexOf(word))
        ).toEqual([...Array(6)].map((_, index, all) => expect.any(Number)));
        expect(text.indexOf('General')).toBeLessThan(text.indexOf('Appearance'));
        expect(text.indexOf('Workspace')).toBeLessThan(text.indexOf('Projects'));
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

    it('has Add project… at the end of the title of Projects, and not on another page', async () => {
        const addProject = () =>
            [...container.querySelectorAll('button')].find(button => button.textContent === 'Add project…');

        store.ui.openSettings('appearance');
        await draw();

        expect(addProject()).toBeUndefined();

        act(() => store.ui.showSettingsPage('projects'));
        await draw();

        expect(addProject()).toBeDefined();
    });

    it('shows the page of a project as a path over Projects, which leads back to the list, and takes Add project… away while it is open', async () => {
        const project = store.projects.find(candidate => !candidate.personal)!;

        store.ui.openProjectSettings(project.id);
        await draw();
        await draw();

        expect(titleOf()).toBe(project.name);
        expect(path()?.querySelector('button')?.textContent).toBe('Projects');
        expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Add project…')).toBe(
            false
        );

        await press(path()!.querySelector('button'));
        await draw();

        expect(store.ui.settingsProjectId).toBeNull();
        expect(store.ui.settingsPage).toBe('projects');
        expect(titleOf()).toBe('Projects');
    });
});
