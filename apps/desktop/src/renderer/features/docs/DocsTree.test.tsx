// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hotkeys, installDispatcher, useHotkeyScope } from '../../hotkeys';
import { DOCS_SCOPE } from './docCommands';
import { DocsTree } from './DocsTree';
import { openNewDocument } from './NewDocumentDialog';
import { docsNodes } from './tree';

import type { DocNode, DocsTree as Tree } from '@clowdy/protocol';
import type { DocsStore } from './DocsStore';

vi.mock('./NewDocumentDialog', () => ({ openNewDocument: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DOCS: DocNode[] = [
    {
        name: 'decisions',
        path: 'decisions',
        kind: 'dir',
        children: [{ name: 'pricing.md', path: 'decisions/pricing.md', kind: 'file' }],
    },
    { name: 'README.md', path: 'README.md', kind: 'file' },
];

const FOLDERS = [{ folderId: 'f1', name: 'app', path: '/work/app' }, { folderId: 'f2', name: 'api', path: '/work/api' }];

let container: HTMLDivElement;
let root: Root;
let uninstall: () => void;

/** What `DocsTree` reads from the store, with every folder open and `README.md` the open document. */
function fakeStore(tree: Tree = [{ folderId: 'f1', nodes: DOCS }]) {
    return {
        visibleTree: docsNodes(tree, new Map(FOLDERS.map(folder => [folder.folderId, folder.name]))),
        removedBuffers: [{ key: 'f1/gone.md', folderId: 'f1', path: 'gone.md' }],
        currentKey: 'f1/README.md',
        query: '',
        buffers: new Map(),
        folders: FOLDERS.slice(0, tree.length),
        multiFolder: tree.length > 1,
        folderName: (folderId: string) => FOLDERS.find(folder => folder.folderId === folderId)?.name ?? folderId,
        isOpen: () => true,
        toggleDir: vi.fn(),
        select: vi.fn(),
    };
}

function Screen({ store }: { store: DocsStore }) {
    useHotkeyScope(DOCS_SCOPE);

    return <DocsTree store={ store } />;
}

const row = (key: string) => container.querySelector<HTMLElement>(`[data-key="${ key }"]`)!;

/** Whether a command took the key. */
function press(key: string, target: Element): boolean {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });

    target.dispatchEvent(event);

    return event.defaultPrevented;
}

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    // The component registers in the app's registry, so the dispatcher listens to that one.
    uninstall = installDispatcher(hotkeys);
});

afterEach(() => {
    act(() => root.unmount());
    uninstall();
    container.remove();
});

async function render(store = fakeStore()) {
    await act(async () => root.render(<Screen store={ store as unknown as DocsStore } />));

    return store;
}

describe('DocsTree', () => {
    it('moves with J and K as with the arrows, through the registry', async () => {
        await render();
        row('f1/decisions').focus();

        expect(press('j', row('f1/decisions'))).toBe(true);
        expect(document.activeElement).toBe(row('f1/decisions/pricing.md'));

        press('ArrowDown', row('f1/decisions/pricing.md'));

        expect(document.activeElement).toBe(row('f1/README.md'));

        press('j', row('f1/README.md'));

        expect(document.activeElement).toBe(row('f1/gone.md'));

        press('k', row('f1/gone.md'));
        press('ArrowUp', row('f1/README.md'));

        expect(document.activeElement).toBe(row('f1/decisions/pricing.md'));
    });

    it('keeps Home, End, Enter and Space on the tree\'s own handler', async () => {
        const store = await render();

        row('f1/decisions/pricing.md').focus();

        expect(press('End', row('f1/decisions/pricing.md'))).toBe(true);
        expect(document.activeElement).toBe(row('f1/gone.md'));
        expect(press('Home', row('f1/gone.md'))).toBe(true);
        expect(document.activeElement).toBe(row('f1/decisions'));

        press('Enter', row('f1/decisions'));
        press(' ', row('f1/decisions'));

        expect(store.toggleDir).toHaveBeenCalledTimes(2);
    });

    it('brings the focus to the open document with the first J while nothing has it', async () => {
        await render();

        (document.activeElement as HTMLElement | null)?.blur();
        press('j', document.body);

        expect(document.activeElement).toBe(row('f1/README.md'));
    });

    it('shows several folders as rows above their documents, with a new document per folder that does not open or close the row', async () => {
        const store = await render(fakeStore([{ folderId: 'f1', nodes: DOCS }, { folderId: 'f2', nodes: [] }]));

        expect([...container.querySelectorAll('[role="treeitem"]')].map(item => [item.getAttribute('data-key'), item.getAttribute('aria-level'), item.textContent])).toEqual([
            ['f1', '1', 'app'],
            ['f1/decisions', '2', 'decisions'],
            ['f1/decisions/pricing.md', '3', 'pricing.md'],
            ['f1/README.md', '2', 'README.md'],
            ['f2', '1', 'api'],
            ['f1/gone.md', '1', 'app/gone.md'],
        ]);
        expect(row('f2').title).toBe('/work/api');

        const add = container.querySelector<HTMLButtonElement>('button[aria-label="New document in api"]')!;

        // In the tab order, so Tab reaches it from its row (the style shows it only while the row is hovered or focused).
        expect(add.tabIndex).toBe(0);
        await act(async () => add.click());

        expect(openNewDocument).toHaveBeenCalledWith(store, 'f2');
        expect(store.toggleDir).not.toHaveBeenCalled();

        await act(async () => row('f2').click());
        expect(store.toggleDir).toHaveBeenCalledWith('f2');
    });

    it('has no folder rows, nor their buttons, for one folder', async () => {
        await render();

        expect(row('f1')).toBeNull();
        expect(container.querySelector('button')).toBeNull();
    });
});
