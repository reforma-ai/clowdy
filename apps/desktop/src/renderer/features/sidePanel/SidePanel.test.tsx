// @vitest-environment happy-dom
import { mainFolder } from '@clowdy/protocol';
import { observer } from 'mobx-react-lite';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { currentFolder } from './InfoTab';
import { SidePanelLayout } from './SidePanelLayout';
import { SidePanelToggle } from './SidePanelToggle';
import { useSidePanel } from './useSidePanel';

import type { Chat, ProjectFolder } from '@clowdy/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The babel plugin that makes the app's components observers does not run under Vitest.
const Layout = observer(SidePanelLayout);
const Toggle = observer(SidePanelToggle);
// The title band's place for the button: it is there while the panel is shut, and the panel's header has it while the panel is open.
const Band = observer(function Band() {
    return useSidePanel().open ? null : <Toggle />;
});

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
const pressKey = (target: HTMLElement, key: string) => act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
});
const nextFrame = () => act(async () => {
    await new Promise(resolve => requestAnimationFrame(resolve));
});
const panel = () => container.querySelector<HTMLElement>('aside[aria-label="Panel"]');
const toggle = () => container.querySelector<HTMLButtonElement>('button[aria-label="Side panel"]');
const ui = () => store.ui.forProject(store.selectedProjectId!);

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

    it('is drawn only while the window shows a project, and comes back with Settings shut', async () => {
        act(() => ui().toggleSidePanel());
        store.ui.openSettings();
        await draw(<Layout><p>The page</p></Layout>);

        expect(panel()).toBeNull();

        act(() => store.ui.closeSettings());
        await settle();

        expect(panel()).not.toBeNull();
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

    it('has the one tab, Info, with the project and the folder the window is working in, and the button that shuts it', async () => {
        act(() => ui().toggleSidePanel());
        await draw(<Layout><p>The page</p></Layout>);

        const project = store.selectedProject!.project;

        expect(panel()?.querySelector('button[aria-label="Info"]')?.getAttribute('aria-pressed')).toBe('true');
        expect(panel()?.querySelector('[aria-label="Info"][class*="plate"]')).not.toBeNull();
        expect(panel()?.textContent).toContain('Project');
        expect(panel()?.textContent).toContain(project.name);
        expect(panel()?.textContent).toContain('Folder');
        expect(panel()?.textContent).toContain('car-rental');
        expect(mainFolder(project).path).toBe('/Users/dev/car-rental');

        await press(panel()!.querySelector<HTMLButtonElement>('button[aria-label="Side panel"]')!);

        expect(ui().sidePanelOpen).toBe(false);
    });
});

describe('the button of the side panel', () => {
    it('is pressed while the panel is open, and a press flips it', async () => {
        await draw(<Toggle />);

        expect(toggle()?.getAttribute('aria-pressed')).toBe('false');

        await press(toggle()!);

        expect(ui().sidePanelOpen).toBe(true);
        expect(toggle()?.getAttribute('aria-pressed')).toBe('true');
    });

    it('is not drawn where the window shows no project', async () => {
        store.ui.openSettings();
        await draw(<Toggle />);

        expect(toggle()).toBeNull();
    });

    it('hands the focus to the button that takes its place when a key press flips the panel, in both directions', async () => {
        await draw(<Layout><Band /></Layout>);

        toggle()!.focus();
        await pressKey(toggle()!, 'Enter');
        await nextFrame();

        expect(panel()).not.toBeNull();
        expect(document.activeElement).toBe(panel()!.querySelector('button[aria-label="Side panel"]'));

        await pressKey(document.activeElement as HTMLElement, ' ');
        await nextFrame();

        expect(panel()).toBeNull();
        expect(document.activeElement).toBe(toggle());
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
        expect(currentFolder(project, { ...idle, section: 'docs', draft: true, draftFolderId: 'f2' }).path).toBe('/Users/dev/web');
    });
});
