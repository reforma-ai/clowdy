// @vitest-environment happy-dom
import { Modal } from '@clowdy/components/Modal';
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_EMPTY_PROJECT_ID,
    FIXTURE_PERSONAL_PROJECT_ID,
    FIXTURE_PROJECT_ID,
} from '../daemon/fixtureData';
import { FixtureTransport } from '../daemon/fixtureTransport';
import { hotkeys } from '../hotkeys';
import { RootStore, RootStoreProvider } from '../stores';
import { ProjectSelect } from './ProjectSelect';
import { shellCommands } from './shellCommands';

// The babel plugin that makes the app's components observers does not run under Vitest: `observer` stands in for it here.
const Select = observer(ProjectSelect);

vi.mock('../shared/ProjectIcon', async importOriginal => {
    const { ProjectIcon } = await importOriginal<typeof import('../shared/ProjectIcon')>();
    const mobx = await import('mobx-react-lite');

    return { ProjectIcon: mobx.observer(ProjectIcon) };
});

vi.mock('../hotkeys/CommandHotkey', async importOriginal => {
    const { CommandHotkey } = await importOriginal<typeof import('../hotkeys/CommandHotkey')>();
    const mobx = await import('mobx-react-lite');

    return { CommandHotkey: mobx.observer(CommandHotkey) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let store: RootStore;

const storage = () => {
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

async function open(data = createFixtureData()) {
    store = new RootStore(new FixtureTransport({ data }), { storage: storage() });
    await store.load();
    act(() =>
        root.render(
            <RootStoreProvider value={store}>
                <Select />
            </RootStoreProvider>
        )
    );
    await flush();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Project"]')!.click());
    await flush();
}

// The projects are the options of one choice (`menuitemradio`), the actions after them plain items.
const items = () => [...document.body.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
const labels = () => items().map(item => item.textContent);
const settingsButton = (name: string) =>
    document.body.querySelector<HTMLButtonElement>(`button[aria-label="${name} settings"]`)!;

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
    it('lists the personal space on top, then the projects, then Manage projects…, with no Add project…', async () => {
        await open();

        expect(labels()).toEqual([
            expect.stringContaining('Personal'),
            expect.stringContaining('Car Rental'),
            expect.stringContaining('Clowdy'),
            'Manage projects…',
        ]);
        // The menu has a separator between the personal space and the projects, and one before the actions.
        expect(document.body.querySelectorAll('[role="separator"]')).toHaveLength(2);
    });

    it('names each project in its row and leaves the folders to the card beside it', async () => {
        const data = createFixtureData();

        data.projects
            .find(project => project.id === FIXTURE_PROJECT_ID)!
            .folders.push({ id: 'fld_api', path: '/Users/dev/car-rental-api' });
        await open(data);

        // The personal space says what it is; a project has no second line, neither a path nor a count of folders.
        expect(items()[0].textContent).toContain('Chats without a project');
        expect(items()[1].textContent).toBe('Car Rental');
        expect(items()[2].textContent).toBe('Clowdy');
    });

    it('marks the open project with a plate and switches to the one chosen', async () => {
        await open();

        // Every project has its icon and its settings button; the open one is the one chosen of the list.
        expect(items()[1].querySelectorAll('svg, img')).toHaveLength(2);
        expect(items()[2].querySelectorAll('svg, img')).toHaveLength(2);
        expect(items().map(item => item.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', null]);
        expect(items()[1].hasAttribute('data-selected')).toBe(true);
        expect(items()[2].hasAttribute('data-selected')).toBe(false);
        expect(store.selectedProjectId).toBe(FIXTURE_PROJECT_ID);

        await act(async () => items()[2].click());

        expect(store.selectedProjectId).toBe(FIXTURE_EMPTY_PROJECT_ID);
        expect(items()).toHaveLength(0);
    });

    it('shows the settings button of a row only while the pointer is over it', async () => {
        await open();

        // The list's own rule (`data-show`) hides it until the row is hovered.
        for (const name of ['Personal', 'Car Rental', 'Clowdy'])
            expect(settingsButton(name).getAttribute('data-show')).toBe('item-hover');
    });

    it('shows a card beside the row the keyboard is on, with the name, the keys and every folder, the main one first', async () => {
        const data = createFixtureData();

        data.projects
            .find(project => project.id === FIXTURE_PROJECT_ID)!
            .folders.push({ id: 'fld_api', path: '/Users/dev/car-rental-api' });
        await open(data);

        let disposers: (() => void)[] = [];

        act(() => {
            disposers = shellCommands(store).map(command => hotkeys.defineCommand({ ...command, scope: 'app' }));
        });

        try {
            items()[0].focus();
            await act(async () =>
                items()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
            );
            await flush();

            const card = document.body.querySelector<HTMLElement>('[role="tooltip"]')!;

            expect(card.querySelector('[class*="tipName"]')!.textContent).toBe('Car Rental');
            // The modifiers depend on the platform the test runs on (`Ctrl Alt`, `⌥ ⌘` on a Mac): the digit is the slot.
            expect(card.querySelector('kbd')!.parentElement!.textContent).toMatch(/1$/);
            // Written as the row writes them: the home folder the fixture daemon names is `~`.
            expect([...card.querySelectorAll('li')].map(item => item.textContent)).toEqual([
                '~/car-rental',
                '~/car-rental-api',
            ]);
        } finally {
            for (const dispose of disposers) dispose();
        }
    });

    it('opens the page of a project in Settings from the button at the end of its row, without switching to it', async () => {
        await open();
        await act(async () => settingsButton('Clowdy').click());

        expect(store.selectedProjectId).toBe(FIXTURE_PROJECT_ID);
        expect([store.ui.settingsOpen, store.ui.settingsPage, store.ui.settingsProjectId]).toEqual([
            true,
            'projects',
            FIXTURE_EMPTY_PROJECT_ID,
        ]);
        expect(items()).toHaveLength(0);
    });

    it('does not switch to the project when the pointer presses the settings button, as it does on a real press', async () => {
        await open();

        const button = settingsButton('Clowdy');
        const press = (type: string) =>
            button.dispatchEvent(
                new PointerEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    button: 0,
                    pointerId: 1,
                    pointerType: 'mouse',
                })
            );

        await act(async () => {
            press('pointerdown');
            press('pointerup');
            button.click();
        });

        expect(store.selectedProjectId).toBe(FIXTURE_PROJECT_ID);
        expect(store.ui.settingsProjectId).toBe(FIXTURE_EMPTY_PROJECT_ID);
    });

    it('has the settings button on the personal space too, and none on the actions', async () => {
        await open();

        expect(document.body.querySelectorAll('button[aria-label$=" settings"]')).toHaveLength(3);

        await act(async () => settingsButton('Personal').click());

        expect(store.ui.settingsProjectId).toBe(FIXTURE_PERSONAL_PROJECT_ID);
    });

    it('leaves the settings button out of the tab order, since the arrow keys move through the rows', async () => {
        await open();

        expect(settingsButton('Clowdy').tabIndex).toBe(-1);
    });

    it('draws an icon before every row and sets the personal space, which has two lines, level with their middle', async () => {
        await open();

        for (const item of items().slice(0, 3)) expect(item.querySelector('svg, img')).not.toBeNull();

        expect(items()[0].getAttribute('data-align')).toBe('center');
        expect(items()[1].hasAttribute('data-align')).toBe(false);
    });

    it("shows a project's picture, uploaded or found in its main folder, on the button and in the menu, and the folder icon without one", async () => {
        const data = createFixtureData();
        const png = 'data:image/png;base64,iVBORw0KGgo=';

        data.projects.find(project => project.id === FIXTURE_EMPTY_PROJECT_ID)!.settings.icon = png;
        await open(data);

        const picture = (label: string) =>
            items()
                .find(item => item.textContent?.includes(label))
                ?.querySelector('img')
                ?.getAttribute('src');

        // Car Rental, the open project, has a favicon in its folder; Clowdy has an uploaded picture.
        expect(container.querySelector('button[aria-label="Project"] img')?.getAttribute('src')).toMatch(/^blob:/);
        expect(picture('Car Rental')).toMatch(/^blob:/);
        expect(picture('Clowdy')).toBe(png);
        expect(picture('Personal')).toBeUndefined();
    });

    it('can switch to the personal space', async () => {
        await open();
        await act(async () => items()[0].click());

        expect(store.selectedProjectId).toBe(FIXTURE_PERSONAL_PROJECT_ID);
        expect(container.querySelector('button[aria-label="Project"]')?.textContent).toBe('Personal');
    });

    it('opens Settings on the list of projects with Manage projects…', async () => {
        await open();
        await act(async () =>
            items()
                .find(item => item.textContent === 'Manage projects…')!
                .click()
        );

        expect([store.ui.settingsOpen, store.ui.settingsPage, store.ui.settingsProjectId]).toEqual([
            true,
            'projects',
            null,
        ]);
    });

    it('lists no separator before the projects when the personal space is all there is', async () => {
        const data = createFixtureData();

        data.projects = data.projects.filter(project => project.personal);
        await open(data);

        expect(labels()).toEqual([expect.stringContaining('Personal'), 'Manage projects…']);
        expect(document.body.querySelectorAll('[role="separator"]')).toHaveLength(1);
    });
});
