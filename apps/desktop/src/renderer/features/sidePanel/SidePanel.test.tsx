// @vitest-environment happy-dom
import { ArrowDown, ArrowUp, Commit, Merge } from '@clowdy/icons/14';
import { observer } from 'mobx-react-lite';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_PROJECT_ID,
    FIXTURE_WORKSPACE_CHAT_ID,
    type FixtureData,
    withFixtureWorkspace,
} from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { defineCommand } from '../../hotkeys';
import { RootStore, RootStoreProvider } from '../../stores';
import { SIDE_PANEL_COMMAND, SIDE_PANEL_KEYS } from './commands';
import { SidePanelLayout } from './SidePanelLayout';
import { SidePanelRail } from './SidePanelRail';

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

            return <p>{variant === 'docs' ? 'The docs' : 'The files'}</p>;
        },
    };
});
// So has the terminal.
vi.mock('../terminal/TerminalTab', () => ({ default: () => <p>The terminal</p> }));
// And the tasks.
vi.mock('../tasks', () => ({ Screen: () => <p>The tasks</p> }));
// And the changes.
vi.mock('../changes/ChangesTab', () => ({ default: () => <p>The changes</p> }));
// The babel plugin that makes the app's components observers does not run under Vitest: the panel is one, to follow the tab that is chosen.
vi.mock('./SidePanel', async importOriginal => ({
    SidePanel: observer((await importOriginal<typeof import('./SidePanel')>()).SidePanel),
}));

// The babel plugin that makes the app's components observers does not run under Vitest.
const Layout = observer(SidePanelLayout);
const Rail = observer(SidePanelRail);
/** The page with its side panel, and the rail at the window's right edge. */
const Frame = () => (
    <>
        <Layout>
            <p>The page</p>
        </Layout>
        <Rail />
    </>
);

const memory = () => {
    const data = new Map<string, string>();

    return {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => void data.set(key, value),
        removeItem: (key: string) => void data.delete(key),
    };
};

let container: HTMLDivElement;
let root: Root;
let store: RootStore;

const settle = () =>
    act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
const press = (target: HTMLElement) =>
    act(async () => {
        target.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true })
        );
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        target.dispatchEvent(
            new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true })
        );
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        target.click();
    });
/** The two clicks of a double click: the browser counts them in `detail`. */
const doubleClick = (target: HTMLElement) =>
    act(async () => {
        for (const detail of [1, 2])
            target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));
    });
const panel = () => container.querySelector<HTMLElement>('aside[aria-label="Panel"]');
const rail = () => container.querySelector<HTMLElement>('nav[aria-label="Panel tabs"]');
/** The item of a tab, found by the label under its glyph: a badge on the glyph is text of the button too. */
const tab = (name: string) =>
    [...(rail()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        button => button.lastElementChild?.textContent === name
    );
const ui = () => store.ui.forProject(store.selectedProjectId!);
const expandButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Side panel"]');
const settingsItem = () =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Settings');

/** A window with no project on show: the projects are loaded and there are none. */
async function withoutProjects() {
    const empty = new RootStore(new FixtureTransport({ data: { ...createFixtureData(), projects: [] } }), {
        storage: memory(),
    });

    await empty.load();
    store.dispose();
    store = empty;
}

async function draw(element: React.ReactElement) {
    act(() => root.render(<RootStoreProvider value={store}>{element}</RootStoreProvider>));
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

describe('the corner at the top of the rail', () => {
    // The icon is one, drawn for the state the panel is in.
    const icon = () => expandButton()?.querySelector('svg')?.getAttribute('data-state');
    const pressed = () => expandButton()?.getAttribute('aria-pressed');
    // The menu is in the overlay layer of the page, outside the container.
    const sizes = () => document.querySelector('[role="group"][aria-label="Side panel size"]');
    const sizeButtons = () => [...(sizes()?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const size = (name: string) => sizeButtons().find(button => button.textContent?.startsWith(name))!;
    const current = () =>
        sizeButtons()
            .filter(button => button.getAttribute('aria-pressed') === 'true')
            .map(button => button.textContent);
    const pause = (ms: number) =>
        act(async () => {
            await new Promise(resolve => setTimeout(resolve, ms));
        });

    it('opens a menu of the sizes with a press, and a choice sets the panel to that size and shuts the menu', async () => {
        await draw(
            <>
                <Layout>
                    <p>The page</p>
                </Layout>
                <Rail />
            </>
        );

        expect(sizes()).toBeNull();
        expect(pressed()).toBe('false');
        expect(icon()).toBe('none');

        await press(expandButton()!);

        expect(sizeButtons().map(button => button.textContent)).toEqual(['Wide', 'Half', 'Hide']);
        expect(current()).toEqual(['Hide']);

        await press(size('Half'));

        expect(sizes()).toBeNull();
        expect([ui().sidePanelOpen, ui().sidePanelExpanded]).toEqual([true, false]);
        expect(panel()?.hasAttribute('data-expanded')).toBe(false);
        expect(pressed()).toBe('true');
        expect(icon()).toBe('small');

        await press(expandButton()!);
        expect(current()).toEqual(['Half']);

        await press(size('Wide'));

        expect(ui().sidePanelExpanded).toBe(true);
        expect(panel()?.hasAttribute('data-expanded')).toBe(true);
        expect(pressed()).toBe('true');
        expect(icon()).toBe('large');
        // The edge between the page and the panel lies under the expanded panel.
        expect(container.querySelector<HTMLElement>('[role="separator"]')?.className).toMatch(/edgeCovered/);

        await press(expandButton()!);
        expect(current()).toEqual(['Wide']);

        await press(size('Hide'));

        expect([ui().sidePanelOpen, ui().sidePanelExpanded]).toEqual([false, true]);
        expect(panel()).toBeNull();
        expect(pressed()).toBe('false');
        expect(icon()).toBe('none');
    });

    it('titles the menu as the side panel, and tells the key that toggles the panel only while there is one', async () => {
        await draw(
            <>
                <Layout>
                    <p>The page</p>
                </Layout>
                <Rail />
            </>
        );
        await press(expandButton()!);

        const menu = () => sizes()?.parentElement?.textContent;

        expect(menu()).toMatch(/^Side panel/);
        expect(menu()).not.toContain('to toggle the panel');

        const remove = defineCommand({
            id: SIDE_PANEL_COMMAND,
            title: 'Toggle side panel',
            group: 'General',
            keys: SIDE_PANEL_KEYS,
            scope: 'app',
            handler: () => undefined,
        });

        try {
            await settle();

            expect(menu()).toMatch(/^Side panelUse .+ to toggle the panelWide/);
        } finally {
            remove();
        }
    });

    it('shows a panel that was shut while expanded as hidden, and brings it back in the size that is chosen', async () => {
        act(() => ui().toggleSidePanel());
        await draw(
            <>
                <Layout>
                    <p>The page</p>
                </Layout>
                <Rail />
            </>
        );

        act(() => ui().toggleSidePanelExpanded());
        act(() => ui().toggleSidePanel());
        await settle();

        expect(panel()).toBeNull();
        expect(icon()).toBe('none');

        await press(expandButton()!);
        expect(current()).toEqual(['Hide']);

        await press(size('Half'));

        expect(panel()?.hasAttribute('data-expanded')).toBe(false);
        expect(icon()).toBe('small');
    });

    it('keeps Half in the menu, grey and saying why, where the panel cannot be beside the chat: the Tasks tab, and a window too narrow for Files', async () => {
        act(() => ui().showSidePanelTab('tasks'));
        await draw(
            <>
                <Layout>
                    <p>The page</p>
                </Layout>
                <Rail />
            </>
        );

        await press(expandButton()!);

        expect(sizeButtons().map(button => button.textContent)).toEqual(['Wide', 'Half', 'Hide']);
        expect(size('Half').disabled).toBe(true);
        // A disabled button gets no pointer, so a focusable stand-in carries the tooltip that says why.
        expect(size('Half').parentElement?.getAttribute('aria-label')).toBe('Half');

        await press(size('Wide'));

        expect(panel()?.hasAttribute('data-expanded')).toBe(true);
        expect(icon()).toBe('large');

        await press(expandButton()!);
        expect(current()).toEqual(['Wide']);

        await press(size('Hide'));

        expect([ui().sidePanelOpen, ui().sidePanelExpanded]).toEqual([false, false]);
        expect(panel()).toBeNull();

        act(() => {
            ui().showSidePanelTab('files');
            store.ui.setWindowFitsHalf(false);
        });
        await settle();
        await press(expandButton()!);

        expect(sizeButtons().map(button => button.textContent)).toEqual(['Wide', 'Half', 'Hide']);
        expect(size('Half').disabled).toBe(true);
    });

    it('shuts the menu with Escape, and the button is its trigger again', async () => {
        await draw(
            <>
                <Layout>
                    <p>The page</p>
                </Layout>
                <Rail />
            </>
        );

        await press(expandButton()!);
        expect(sizes()).not.toBeNull();
        expect(expandButton()?.getAttribute('aria-expanded')).toBe('true');

        await act(async () => {
            (document.activeElement ?? sizes())?.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
            );
        });
        await pause(100);

        expect(sizes()).toBeNull();
        expect(expandButton()?.getAttribute('aria-expanded')).toBe('false');
        expect(ui().sidePanelOpen).toBe(false);
    });

    it('does not open the menu when the pointer rests on the button: only a press does', async () => {
        await draw(
            <>
                <Layout>
                    <p>The page</p>
                </Layout>
                <Rail />
            </>
        );

        const button = expandButton()!;

        await act(async () => {
            button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
        });
        await pause(400);

        expect(sizes()).toBeNull();
        expect(button.getAttribute('aria-expanded')).toBe('false');

        await press(button);

        expect(sizes()).not.toBeNull();
        expect(button.getAttribute('aria-expanded')).toBe('true');
    });

    it('is the first item of the rail, and the rail keeps its top empty when there is no project, with no button there', async () => {
        await draw(<Rail />);

        expect(container.firstElementChild?.firstElementChild?.className).toMatch(/corner/);
        expect(container.firstElementChild?.firstElementChild?.contains(expandButton())).toBe(true);

        await withoutProjects();
        await draw(<Rail />);

        expect(container.firstElementChild?.firstElementChild?.className).toMatch(/corner/);
        expect(expandButton()).toBeNull();
    });
});

describe('the side panel of the window', () => {
    it('is not there until the person opens it, and the page it sits beside is', async () => {
        await draw(
            <Layout>
                <p>The page</p>
            </Layout>
        );

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

        await draw(
            <Layout>
                <Page />
            </Layout>
        );

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
        await draw(
            <Layout>
                <p>The page</p>
            </Layout>
        );

        expect(panel()).not.toBeNull();

        act(() => store.ui.closeSettings());
        await settle();

        expect(panel()).not.toBeNull();
    });

    it('is drawn only while the window shows a project', async () => {
        await withoutProjects();
        await draw(
            <Layout>
                <p>The page</p>
            </Layout>
        );

        expect(store.selectedProjectId).toBeNull();
        expect(panel()).toBeNull();
    });

    it('is open for the project it was opened in, and not for another', async () => {
        await draw(
            <Layout>
                <p>The page</p>
            </Layout>
        );

        act(() => ui().toggleSidePanel());
        await settle();

        expect(panel()).not.toBeNull();

        act(() =>
            store.selectProject(
                store.projects.find(project => project.id !== store.selectedProjectId && !project.personal)!.id
            )
        );
        await settle();

        expect(panel()).toBeNull();
    });

    it('opens on Files by default and can switch to another tab', async () => {
        act(() => ui().toggleSidePanel());
        await draw(<Frame />);
        await settle();
        expect(tab('Files')?.getAttribute('aria-current')).toBe('page');
        expect(panel()?.querySelector('[aria-label="Files"][class*="plate"]')?.textContent).toBe('The files');
        await press(tab('Changes')!);
        await settle();
        expect(ui().sidePanelTab).toBe('changes');
        expect(panel()?.textContent).toBe('The changes');
    });

    it('has a Docs tab, which is the Files view for the documents: the panel keeps the one component built when it moves between the two', async () => {
        built.mockClear();
        act(() => ui().toggleSidePanel());
        await draw(<Frame />);

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

        const names = [...(rail()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].map(
            button => button.textContent
        );

        expect(names).toEqual(['Files', 'Changes', 'Docs', 'Terminal', 'Tasks']);

        await press(tab('Terminal')!);
        await settle();

        expect(ui().sidePanelTab).toBe('terminal');
        expect(tab('Terminal')?.getAttribute('aria-current')).toBe('page');
        expect(panel()?.querySelector('[aria-label="Terminal"][class*="plate"]')?.textContent).toBe('The terminal');
        expect(panel()?.textContent).not.toContain('The files');
    });

    it('has a Changes tab after Files, which shows the changes beside the chat', async () => {
        await draw(<Frame />);

        await press(tab('Changes')!);
        await settle();

        expect(ui().sidePanelTab).toBe('changes');
        expect(tab('Changes')?.getAttribute('aria-current')).toBe('page');
        expect(panel()?.querySelector('[aria-label="Changes"][class*="plate"]')?.textContent).toBe('The changes');
        // It is a list beside a view: the window fits it beside the chat, and the panel's least width is the one such a view needs.
        expect(panel()?.hasAttribute('data-expanded')).toBe(false);
        expect(ui().sidePanelNoHalf).toBeNull();

        await press(tab('Changes')!);
        await settle();

        expect(ui().sidePanelOpen).toBe(false);
    });

    it('has a Tasks tab after Terminal, which shows the tasks over the chat and leaves the expanded choice as it was', async () => {
        await draw(<Frame />);

        await press(tab('Tasks')!);
        await settle();

        expect(ui().sidePanelTab).toBe('tasks');
        expect(tab('Tasks')?.getAttribute('aria-current')).toBe('page');
        expect(panel()?.querySelector('[aria-label="Tasks"][class*="plate"]')?.textContent).toBe('The tasks');
        expect(panel()?.hasAttribute('data-expanded')).toBe(true);
        expect(ui().sidePanelExpanded).toBe(false);

        await press(tab('Files')!);
        await settle();

        expect(panel()?.hasAttribute('data-expanded')).toBe(false);
    });

    it('keeps the chosen tab for the project, and starts another project on Files', async () => {
        act(() => ui().toggleSidePanel());
        act(() => ui().showSidePanelTab('files'));
        await draw(<Frame />);
        await settle();

        expect(panel()?.textContent).toContain('The files');

        const other = store.projects.find(project => project.id !== store.selectedProjectId && !project.personal)!.id;

        act(() => store.selectProject(other));
        act(() => ui().toggleSidePanel());
        await settle();

        expect(tab('Files')?.getAttribute('aria-current')).toBe('page');
    });
});

describe('the rail of the side panel', () => {
    it('is there whether the panel is open or not, with an item for each tab, and none is current while the panel is shut', async () => {
        await draw(<Frame />);

        expect(panel()).toBeNull();
        expect([...rail()!.querySelectorAll('button')].map(button => button.textContent)).toEqual([
            'Files',
            'Changes',
            'Docs',
            'Terminal',
            'Tasks',
        ]);
        expect(rail()!.querySelector('[aria-current]')).toBeNull();

        act(() => ui().toggleSidePanel());
        await settle();

        expect(rail()!.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
        expect(tab('Files')?.getAttribute('aria-current')).toBe('page');
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
            await act(
                async () =>
                    void tab('Files')!.dispatchEvent(
                        new MouseEvent('click', { bubbles: true, cancelable: true, detail })
                    )
            );
        }

        // Opened, shut, opened.
        expect(ui().sidePanelOpen).toBe(true);

        await doubleClick(tab('Files')!);

        expect(ui().sidePanelOpen).toBe(true);
    });

    it("has the panel's button first and Settings at the bottom", async () => {
        await draw(<Frame />);

        const items = [...container.querySelectorAll<HTMLButtonElement>('button')];

        expect(items[0]).toBe(expandButton());
        expect(items.slice(1).map(button => button.textContent)).toEqual([
            'Files',
            'Changes',
            'Docs',
            'Terminal',
            'Tasks',
            'Settings',
        ]);
        expect(settingsItem()!.className).toMatch(/bottom/);
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

describe('the Changes item of the rail', () => {
    /** The markup of an icon as the rail draws it, to tell which icon an item has. */
    const markupOf = (Icon: typeof Commit) => {
        const host = document.createElement('div');
        const iconRoot = createRoot(host);

        act(() => iconRoot.render(<Icon width={14} height={14} aria-hidden />));
        const markup = host.querySelector('svg')!.innerHTML;

        act(() => iconRoot.unmount());

        return markup;
    };
    const iconOf = () => tab('Changes')!.querySelector('svg')!.innerHTML;
    const dot = () => tab('Changes')!.querySelector('[data-tone]');
    /** The count badge, which is hidden from a reader of the button (its name says it). */
    const pill = () => tab('Changes')!.querySelector('[aria-hidden="true"]:not(svg):not([data-tone])');
    const count = () => pill()?.textContent;
    /** The arrow of the count badge, as markup to set against an icon's. */
    const arrowOf = () => pill()?.querySelector('svg')?.innerHTML;
    /** What the tooltip of the Changes tab says once the keyboard has brought focus to it. */
    async function tooltipText() {
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
            tab('Changes')!.focus();
        });
        await settle();

        return document.querySelector('[role="tooltip"]')?.textContent ?? '';
    }

    /** A window with the chat that works in a worktree open: three uncommitted files, two commits that the base does not have, and the pull request the script says. */
    async function inWorktree(
        script: 'open' | 'none' | 'draft' | 'merged',
        tweak?: (data: FixtureData) => void,
        remote?: 'ahead' | 'behind' | 'level' | 'diverged'
    ) {
        const data = withFixtureWorkspace(createFixtureData());

        data.pullRequests['/Users/dev/car-rental'] = { checkout: 'none', worktree: script };
        tweak?.(data);
        store.dispose();
        store = new RootStore(new FixtureTransport({ data, ...(remote && { gitWrites: { remote } }) }), {
            storage: memory(),
        });
        await store.load();
        store.selectProject(FIXTURE_PROJECT_ID);
        ui().openChat(FIXTURE_WORKSPACE_CHAT_ID);
        await draw(<Frame />);
        await settle();
    }

    it('is the commit icon with no dot while the place has nothing to land and nothing uncommitted', async () => {
        await draw(<Frame />);
        await settle();

        expect(iconOf()).toBe(markupOf(Commit));
        expect(dot()).toBeNull();
        expect(count()).toBeUndefined();
    });

    it('draws a dot that counts the uncommitted files, and the icon of a pull request that is open', async () => {
        await inWorktree('draft');

        expect(iconOf()).toBe(markupOf(Merge));
        expect(dot()?.getAttribute('data-tone')).toBe('warning');
        expect(tab('Changes')!.getAttribute('aria-label')).toBe('Changes, 3 uncommitted files');
    });

    it('draws the merge icon while the branch has a pull request to show, as Source Control lists it: open, a draft, or a merged one', async () => {
        for (const script of ['open', 'draft', 'merged'] as const) {
            await inWorktree(script);

            expect(iconOf()).toBe(markupOf(Merge));
        }
    });

    it('draws the commit icon in every other case: no pull request whether commits wait or not, and a merged one the branch has moved past', async () => {
        const merged = (movedPast?: true) => ({
            number: 9,
            state: 'merged' as const,
            head: 'clowdy/ab12cd34',
            base: 'main',
            title: 'Earlier work',
            url: 'https://github.com/acme/car-rental/pull/9',
            updatedAt: 9,
            ...(movedPast && { movedPast }),
        });
        const history =
            (...rows: ReturnType<typeof merged>[]) =>
            (data: FixtureData) => {
                data.branchPullRequests = { '/Users/dev/car-rental': { 'clowdy/ab12cd34': rows } };
            };

        await inWorktree('none');

        expect(iconOf()).toBe(markupOf(Commit));

        // Only the history knows the pull request here, which Source Control lists as long as the branch has not moved past it.
        await inWorktree('none', history(merged()));

        expect(iconOf()).toBe(markupOf(Merge));

        await inWorktree('none', history(merged(true)));

        expect(iconOf()).toBe(markupOf(Commit));
    });

    it('keeps its badge while the Changes tab is on show, and while the panel is shut', async () => {
        await inWorktree('draft');

        await press(tab('Changes')!);
        await settle();

        expect(tab('Changes')?.getAttribute('aria-current')).toBe('page');
        expect(dot()).not.toBeNull();
        expect(tab('Changes')!.getAttribute('aria-label')).toBe('Changes, 3 uncommitted files');
        expect(iconOf()).toBe(markupOf(Merge));

        await press(tab('Changes')!);
        await settle();

        expect(ui().sidePanelOpen).toBe(false);
        expect(dot()).not.toBeNull();

        // The count is no different.
        await inWorktree('draft', undefined, 'ahead');
        await press(tab('Changes')!);
        await settle();

        expect(tab('Changes')?.getAttribute('aria-current')).toBe('page');
        expect(count()).toBe('2');

        await press(tab('Changes')!);
        await settle();

        expect(ui().sidePanelOpen).toBe(false);
        expect(count()).toBe('2');
    });

    it('draws the count of the sync button, with the arrow of its way, in place of the dot', async () => {
        await inWorktree('draft', undefined, 'ahead');

        expect(markupOf(ArrowUp)).not.toBe(markupOf(ArrowDown));
        expect(count()).toBe('2');
        expect(arrowOf()).toBe(markupOf(ArrowUp));
        expect(dot()).toBeNull();
        expect(tab('Changes')!.getAttribute('aria-label')).toBe('Changes, 2 commits to push');

        await inWorktree('draft', undefined, 'behind');

        expect(count()).toBe('2');
        expect(arrowOf()).toBe(markupOf(ArrowDown));
        expect(tab('Changes')!.getAttribute('aria-label')).toBe('Changes, 2 commits to pull');

        // Level with its upstream, the base has a commit that the branch lacks: the button offers Update from the base, and so does the count.
        await inWorktree('draft', undefined, 'level');

        expect(count()).toBe('1');
        expect(arrowOf()).toBe(markupOf(ArrowDown));
        expect(tab('Changes')!.getAttribute('aria-label')).toMatch(/^Changes, 1 commit to merge from /);
    });

    it('counts the commits to push when the branch has diverged, and names both ways in its name', async () => {
        await inWorktree('draft', undefined, 'diverged');

        expect(count()).toBe('1');
        expect(arrowOf()).toBe(markupOf(ArrowUp));
        expect(tab('Changes')!.getAttribute('aria-label')).toBe('Changes, 2 commits to pull and 1 commit to push');
    });

    it('draws the small dot only while nothing counts', async () => {
        await inWorktree('draft');

        expect(dot()).not.toBeNull();
        expect(count()).toBeUndefined();

        await inWorktree('draft', undefined, 'ahead');

        expect(dot()).toBeNull();
        expect(count()).toBe('2');
    });

    it('says in its tooltip what the icon and the badge say, under its label', async () => {
        await inWorktree('draft', undefined, 'ahead');

        const tip = await tooltipText();

        expect(tip.startsWith('Changes')).toBe(true);
        expect(tip).toMatch(/Draft pull request #\d+, checks are running2 commits to push3 uncommitted files$/);
    });

    it('says in its tooltip that the pull request is merged', async () => {
        await inWorktree('merged');

        expect(await tooltipText()).toMatch(/Pull request #\d+ is merged3 uncommitted files$/);
    });

    it('has no dot on the other tabs', async () => {
        await inWorktree('draft');

        expect([...rail()!.querySelectorAll('[data-tone]')]).toHaveLength(1);
    });
});
