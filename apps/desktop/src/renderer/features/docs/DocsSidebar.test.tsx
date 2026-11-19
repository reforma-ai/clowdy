// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hotkeys, installDispatcher, useHotkeyScope } from '../../hotkeys';
import { DOCS_SCOPE } from './docCommands';
import { DocsSidebar } from './DocsSidebar';
import { docsNodes } from './tree';

import type { DocNode, DocsTree as Tree } from '@clowdy/protocol';
import type { DocsStore } from './DocsStore';

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

const TREE: Tree = [{ folderId: 'f1', nodes: DOCS }];
const NODES = docsNodes(TREE, new Map([['f1', 'app']]));

let container: HTMLDivElement;
let root: Root;
let uninstall: () => void;

/** What the sidebar reads, with the tree always listed: the query only drives the field. */
function fakeStore(query: string, setQuery: (query: string) => void) {
    return {
        query,
        setQuery,
        treeStatus: 'ready',
        treeError: '',
        nodes: NODES,
        visibleTree: NODES,
        removedBuffers: [],
        currentKey: 'f1/README.md',
        buffers: new Map(),
        folders: [{ folderId: 'f1', name: 'app', path: '/work/app' }],
        multiFolder: false,
        folderName: () => 'app',
        isOpen: () => true,
        toggleDir: () => undefined,
        select: () => undefined,
    };
}

function Page() {
    const [query, setQuery] = useState('');

    useHotkeyScope(DOCS_SCOPE);

    return <DocsSidebar store={ fakeStore(query, setQuery) as unknown as DocsStore } />;
}

const search = () => container.querySelector<HTMLInputElement>('input[aria-label="Find document"]')!;
const hint = () => container.querySelector('[slot="suffix"] kbd');
const entry = () => container.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')!;

function press(key: string, target: Element = document.body) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });

    target.dispatchEvent(event);

    return event;
}

/** Types into the field the way a person does: the value, then the input event React listens to. */
async function type(text: string) {
    await act(async () => {
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;

        setValue.call(search(), text);
        search().dispatchEvent(new Event('input', { bubbles: true }));
    });
}

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    uninstall = installDispatcher(hotkeys);
});

afterEach(() => {
    act(() => root.unmount());
    uninstall();
    container.remove();
});

/** The command registers in an effect, so the first draw has no hint; the second has it. */
async function draw() {
    await act(async () => root.render(<Page />));
    await act(async () => root.render(<Page />));
}

describe('document search', () => {
    it('shows / while the field is empty, and the clear button takes its place once there is text', async () => {
        await draw();

        expect(hint()?.textContent).toBe('/');

        await type('pricing');

        expect(search().value).toBe('pricing');
        expect(hint()).toBeNull();
    });

    it('/ puts the keyboard in the field and the slash is not typed into it', async () => {
        await draw();

        expect(press('/').defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(search());
        expect(search().value).toBe('');

        expect(press('/', search()).defaultPrevented).toBe(false);
    });

    it('Esc clears the text first and leaves for the tree when there is none, and Enter leaves at once', async () => {
        await draw();
        await act(async () => search().focus());
        await type('pricing');
        await act(async () => press('Escape', search()));

        expect(search().value).toBe('');
        expect(document.activeElement).toBe(search());

        await act(async () => press('Escape', search()));

        expect(document.activeElement).toBe(entry());
        expect(entry().getAttribute('data-key')).toBe('f1/README.md');

        await act(async () => search().focus());

        const enter = await act(async () => press('Enter', search()));

        expect(enter.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(entry());
    });
});
