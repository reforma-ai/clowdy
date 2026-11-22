// @vitest-environment happy-dom
import { mainFolder } from '@clowdy/protocol';
import { observer } from 'mobx-react-lite';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { currentFolder } from './currentFolder';
import { SidePanelCorner } from './SidePanelCorner';
import { SidePanelLayout } from './SidePanelLayout';
import { SidePanelRail } from './SidePanelRail';

import type { Chat, ProjectFolder } from '@clowdy/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The editor and the file tree have tests of their own; here the panel only has to show the tab.
// It is told which of its two tabs it draws, and says when it is built: the two tabs are one component, which stays built when the panel moves between them (the view inside it is made again for the file manager of the tab on show).
const built = vi.hoisted(() => vi.fn());

vi.mock('../files/FilesTab', async () => {
    const { useEffect } = await import('react');

    return {
        default: ({ variant }: { variant?: string }) => {
            useEffect(() => {
                built();
            }, []);

            return <p>{ variant === 'docs' ? 'The docs' : 'The files' }</p>;
        },
    };
});
// So has the terminal.
vi.mock('../terminal/TerminalTab', () => ({ default: () => <p>The terminal</p> }));
// The babel plugin that makes the app's components observers does not run under Vitest: the panel is one, to follow the tab that is chosen.
vi.mock('./SidePanel', async (importOriginal) => ({ SidePanel: observer((await importOriginal<typeof import('./SidePanel')>()).SidePanel) }));

// The babel plugin that makes the app's components observers does not run under Vitest.
const Layout = observer(SidePanelLayout);
const Rail = observer(SidePanelRail);
const Corner = observer(SidePanelCorner);
/** The page with its side panel, and the rail at the window's right edge. */
const Frame = () => (
    <>
        <Layout><p>The page</p></Layout>
        <Rail />
    </>
);

const memory = () => {
    const data = new Map<string, string>();

    return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), removeItem: (key: string) => void data.delete(key) };
};

let container: HTMLDivElement;
let root: Root;
let store: RootStore;

const settle = () => act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
});
const press = (target: HTMLElement) => act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    target.click();
});
/** The two clicks of a double click: the browser counts them in `detail`. */
const doubleClick = (target: HTMLElement) => act(async () => {
    for (const detail of [1, 2]) target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));
});
const panel = () => container.querySelector<HTMLElement>('aside[aria-label="Panel"]');
const rail = () => container.querySelector<HTMLElement>('nav[aria-label="Panel tabs"]');
const tab = (name: string) => [...(rail()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(button => button.textContent === name);
const ui = () => store.ui.forProject(store.selectedProjectId!);
const expandButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Side panel"]');
const settingsItem = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Settings');

/** A window with no project on show: the projects are loaded and there are none. */
async function withoutProjects() {
    const empty = new RootStore(new FixtureTransport({ data: { ...createFixtureData(), projects: [] } }), { storage: memory() });

    await empty.load();
    store.dispose();
    store = empty;
}

async function draw(element: React.ReactElement) {
    act(() => root.render(<RootStoreProvider value={ store }>{ element }</RootStoreProvider>));
    await settle();
}

beforeEach(async () => {
    // Local storage of the test window would carry a width and an open panel from one test to the next.
    store = new RootStore(new FixtureTransport(), { storage: memory() });
    await store.load();
    await settle();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    store.dispose();
});

describe('the corner over the rail', () => {
    // The icon is one, drawn for the state the panel is in and moving to the one a press leads to.
    const icon = () => `${ expandButton()?.querySelector('svg')?.getAttribute('data-state') } > ${ expandButton()?.querySelector('svg')?.getAttribute('data-next') }`;
    const pressed = () => expandButton()?.getAttribute('aria-pressed');

    it('steps the panel through shown, expanded and hidden with one button, which is pressed while the panel is shown and has an icon that draws the panel as it is and moves to what it will be', async () => {
        await draw(<><Layout><p>The page</p></Layout><Corner /></>);

        expect(pressed()).toBe('false');
        expect(icon()).toBe('none > small');

        await press(expandButton()!);

        expect(ui().sidePanelOpen).toBe(true);
        expect(panel()?.hasAttribute('data-expanded')).toBe(false);
        expect(pressed()).toBe('true');
        expect(icon()).toBe('small > large');

        await press(expandButton()!);

        expect(ui().sidePanelExpanded).toBe(true);
        expect(panel()?.hasAttribute('data-expanded')).toBe(true);
        expect(pressed()).toBe('true');
        expect(icon()).toBe('large > none');
        // The edge between the page and the panel lies under the expanded panel.
        expect(container.querySelector<HTMLElement>('[role="separator"]')?.className).toMatch(/edgeCovered/);

        await press(expandButton()!);

        expect([ui().sidePanelOpen, ui().sidePanelExpanded]).toEqual([false, false]);
        expect(panel()).toBeNull();
        // Hidden from the button, the panel comes back beside the chat: the cycle goes round.
        expect(pressed()).toBe('false');
        expect(icon()).toBe('none > small');
    });

    it('opens a panel that was shut while expanded, by another way than the button, expanded again, with the icon moving to the wide panel', async () => {
        act(() => ui().toggleSidePanel());
        await draw(<><Layout><p>The page</p></Layout><Corner /></>);

        act(() => ui().toggleSidePanelExpanded());
        act(() => ui().toggleSidePanel());
        await settle();

        expect(panel()).toBeNull();
        expect(pressed()).toBe('false');
        expect(icon()).toBe('none > large');

        await press(expandButton()!);

        expect(panel()?.hasAttribute('data-expanded')).toBe(true);
        expect(pressed()).toBe('true');
        expect(icon()).toBe('large > none');
    });

    it('is as wide as the rail even with no project, and has no button there', async () => {
        await withoutProjects();
        await draw(<Corner />);

        expect(container.firstElementChild?.className).toMatch(/corner/);
        expect(expandButton()).toBeNull();
    });
});

describe('the side panel of the window', () => {
    it('is not there until the person opens it, and the page it sits beside is', async () => {
        await draw(<Layout><p>The page</p></Layout>);

        expect(container.textContent).toBe('The page');
        expect(panel()).toBeNull();
        expect(container.querySelector('[role="separator"]')).toBeNull();
    });

    it('opens beside the page with the edge to drag it by, and shuts again, with the page kept the whole time', async () => {
        const mounted = vi.fn();
        const unmounted = vi.fn();

        function Page() {
            useEffect(() => {
                mounted();

                return unmounted;
            }, []);

            return <p>The page</p>;
        }

        await draw(<Layout><Page /></Layout>);

        act(() => ui().toggleSidePanel());
        await settle();

        expect(panel()).not.toBeNull();
        expect(container.querySelector('[role="separator"][aria-label="Resize the side panel"]')).not.toBeNull();
        expect(container.textContent).toContain('The page');

        act(() => ui().toggleSidePanel());
        await settle();

        expect(panel()).toBeNull();
        expect(container.textContent).toContain('The page');
        // The page was built once: opening and shutting the panel did not build it again, so a draft in it would have stayed.
        expect(mounted).toHaveBeenCalledOnce();
        expect(unmounted).not.toHaveBeenCalled();
    });

    it('stays where it is while Settings is open over it, which is a window and not a screen in its place', async () => {
        act(() => ui().toggleSidePanel());
        store.ui.openSettings();
        await draw(<Layout><p>The page</p></Layout>);

        expect(panel()).not.toBeNull();

        act(() => store.ui.closeSettings());
        await settle();

        expect(panel()).not.toBeNull();
    });

    it('is drawn only while the window shows a project', async () => {
        await withoutProjects();
        await draw(<Layout><p>The page</p></Layout>);

        expect(store.selectedProjectId).toBeNull();
        expect(panel()).toBeNull();
    });

    it('is open for the project it was opened in, and not for another', async () => {
        await draw(<Layout><p>The page</p></Layout>);

        act(() => ui().toggleSidePanel());
        await settle();

        expect(panel()).not.toBeNull();

        act(() => store.selectProject(store.projects.find(project => project.id !== store.selectedProjectId && !project.personal)!.id));
        await settle();

        expect(panel()).toBeNull();
    });

    it('opens on the Info tab, with the project and the folder the window is working in', async () => {
        act(() => ui().toggleSidePanel());
        await draw(<Frame />);

        const project = store.selectedProject!.project;

        expect(tab('Info')?.getAttribute('aria-current')).toBe('page');
        expect(tab('Files')?.getAttribute('aria-current')).toBeNull();
        expect(panel()?.querySelector('[aria-label="Info"][class*="plate"]')).not.toBeNull();
        expect(panel()?.textContent).toContain('Project');
        expect(panel()?.textContent).toContain(project.name);
        expect(panel()?.textContent).toContain('Folder');
        expect(panel()?.textContent).toContain('car-rental');
        expect(mainFolder(project).path).toBe('/Users/dev/car-rental');
        // The branch checked out in the folder, read from the daemon (the fixture's git has Car Rental on main).
        expect(panel()?.textContent).toContain('Branch');
        expect(panel()?.textContent).toContain('main');
    });

    it('shows the Files tab when it is chosen, and goes back to Info', async () => {
        act(() => ui().toggleSidePanel());
        await draw(<Frame />);

        await press(tab('Files')!);
        await settle();

        expect(ui().sidePanelTab).toBe('files');
        expect(tab('Files')?.getAttribute('aria-current')).toBe('page');
        expect(tab('Info')?.getAttribute('aria-current')).toBeNull();
        expect(panel()?.querySelector('[aria-label="Files"][class*="plate"]')?.textContent).toBe('The files');

        await press(tab('Info')!);

        expect(panel()?.querySelector('[aria-label="Info"][class*="plate"]')).not.toBeNull();
        expect(panel()?.textContent).not.toContain('The files');
    });

    it('has a Docs tab, which is the Files view for the documents: the panel keeps the one component built when it moves between the two', async () => {
        built.mockClear();
        act(() => ui().toggleSidePanel());
        await draw(<Frame />);

        await press(tab('Files')!);
        await settle();

        expect(panel()?.querySelector('[aria-label="Files"][class*="plate"]')?.textContent).toBe('The files');

        await press(tab('Docs')!);
        await settle();

        expect(ui().sidePanelTab).toBe('docs');
        expect(panel()?.querySelector('[aria-label="Docs"][class*="plate"]')?.textContent).toBe('The docs');
        expect(tab('Docs')?.getAttribute('aria-current')).toBe('page');

        await press(tab('Files')!);
        await settle();

        expect(panel()?.textContent).toContain('The files');
        expect(built).toHaveBeenCalledOnce();
    });

    it('has a Terminal tab after Docs, which shows the terminal', async () => {
        await draw(<Frame />);

        act(() => ui().toggleSidePanel());
        await settle();

        const names = [...(rail()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].map(button => button.textContent);

        expect(names).toEqual(['Files', 'Docs', 'Terminal', 'Info']);

        await press(tab('Terminal')!);
        await settle();

        expect(ui().sidePanelTab).toBe('terminal');
        expect(tab('Terminal')?.getAttribute('aria-current')).toBe('page');
        expect(panel()?.querySelector('[aria-label="Terminal"][class*="plate"]')?.textContent).toBe('The terminal');
        expect(panel()?.textContent).not.toContain('The files');
    });

    it('keeps the chosen tab for the project, and starts another project on Info', async () => {
        act(() => ui().toggleSidePanel());
        act(() => ui().showSidePanelTab('files'));
        await draw(<Frame />);
        await settle();

        expect(panel()?.textContent).toContain('The files');

        const other = store.projects.find(project => project.id !== store.selectedProjectId && !project.personal)!.id;

        act(() => store.selectProject(other));
        act(() => ui().toggleSidePanel());
        await settle();

        expect(tab('Info')?.getAttribute('aria-current')).toBe('page');
    });
});

describe('the rail of the side panel', () => {
    it('is there whether the panel is open or not, with an item for each tab, and none is current while the panel is shut', async () => {
        await draw(<Frame />);

        expect(panel()).toBeNull();
        expect([...rail()!.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Files', 'Docs', 'Terminal', 'Info']);
        expect(rail()!.querySelector('[aria-current]')).toBeNull();

        act(() => ui().toggleSidePanel());
        await settle();

        expect(rail()!.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
        expect(tab('Info')?.getAttribute('aria-current')).toBe('page');
    });

    it('opens a shut panel on the tab that is clicked, changes the tab of an open one, and shuts it when the tab that is shown is clicked', async () => {
        await draw(<Frame />);

        await press(tab('Files')!);
        await settle();

        expect(ui().sidePanelOpen).toBe(true);
        expect(ui().sidePanelTab).toBe('files');

        await press(tab('Terminal')!);
        await settle();

        expect(ui().sidePanelOpen).toBe(true);
        expect(ui().sidePanelTab).toBe('terminal');

        await press(tab('Terminal')!);
        await settle();

        expect(ui().sidePanelOpen).toBe(false);
        expect(panel()).toBeNull();
        expect(rail()!.querySelector('[aria-current]')).toBeNull();

        await press(tab('Terminal')!);
        await settle();

        expect(ui().sidePanelOpen).toBe(true);
    });

    it('toggles on every click, however fast they come after one another at one place, so a double click is two toggles', async () => {
        await draw(<Frame />);

        // The browser counts such clicks in `detail`, and every one of them counts.
        for (const detail of [1, 2, 3]) {
            await act(async () => void tab('Files')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail })));
        }

        // Opened, shut, opened.
        expect(ui().sidePanelOpen).toBe(true);

        await doubleClick(tab('Files')!);

        expect(ui().sidePanelOpen).toBe(true);
    });

    it('has Info at the bottom beside Settings, and Settings under it', async () => {
        await draw(<Frame />);

        const items = [...container.querySelectorAll<HTMLButtonElement>('button')];

        expect(items.map(button => button.textContent)).toEqual(['Files', 'Docs', 'Terminal', 'Info', 'Settings']);
        // Info is the one tab that is pushed to the bottom of the column, so that it sits above Settings.
        expect(tab('Info')!.className).toMatch(/bottom/);
        expect(tab('Files')!.className).not.toMatch(/bottom/);
    });

    it('opens the Settings window with its item, which is current while it is open and does not touch the panel', async () => {
        await draw(<Frame />);

        expect(settingsItem()!.getAttribute('aria-current')).toBeNull();

        await press(settingsItem()!);

        expect(store.ui.settingsOpen).toBe(true);
        expect(settingsItem()!.getAttribute('aria-current')).toBe('page');
        expect(ui().sidePanelOpen).toBe(false);
        // The rail stays whole under the window.
        expect(rail()).not.toBeNull();

        act(() => store.ui.closeSettings());
        await settle();

        expect(settingsItem()!.getAttribute('aria-current')).toBeNull();
    });

    it('is drawn where the window shows no project too, with Settings alone: the window has settings and a project has the tabs', async () => {
        await withoutProjects();
        await draw(<Frame />);

        expect(rail()).toBeNull();
        expect(settingsItem()).toBeDefined();
        expect([...container.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Settings']);
        expect(settingsItem()!.className).toMatch(/bottom/);
    });
});

describe('the folder the Info tab names', () => {
    const folders: ProjectFolder[] = [{ id: 'f1', path: '/Users/dev/web' }, { id: 'f2', path: '/Users/dev/api' }];
    const chats = new Map([['c1', { id: 'c1', folderId: 'f2' } as Chat], ['c2', { id: 'c2' } as Chat]]);
    const project = { chats, project: { folders } as never };
    const idle = { section: 'agents', chatId: null, draft: false, draftFolderId: null } as const;

    it('is the folder of the open chat, and the main one for a chat that has none', () => {
        expect(currentFolder(project, { ...idle, chatId: 'c1' }).path).toBe('/Users/dev/api');
        expect(currentFolder(project, { ...idle, chatId: 'c2' }).path).toBe('/Users/dev/web');
    });

    it('is the folder of the new chat that is being made', () => {
        expect(currentFolder(project, { ...idle, draft: true, draftFolderId: 'f2' }).path).toBe('/Users/dev/api');
        expect(currentFolder(project, { ...idle, draft: true }).path).toBe('/Users/dev/web');
    });

    it('is the main folder when no chat is open, and in the sections that belong to the project and not to a folder', () => {
        expect(currentFolder(project, idle).path).toBe('/Users/dev/web');
        expect(currentFolder(project, { ...idle, section: 'tasks', chatId: 'c1' }).path).toBe('/Users/dev/web');
        expect(currentFolder(project, { ...idle, section: 'tasks', draft: true, draftFolderId: 'f2' }).path).toBe('/Users/dev/web');
    });
});
