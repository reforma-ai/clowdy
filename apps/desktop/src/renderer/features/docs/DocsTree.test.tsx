// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hotkeys, installDispatcher, useHotkeyScope } from '../../hotkeys';
import { DOCS_SCOPE } from './docCommands';
import { DocsTree } from './DocsTree';

import type { DocNode } from '@clowdy/protocol';
import type { DocsStore } from './DocsStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TREE: DocNode[] = [
    {
        name: 'decisions',
        path: 'decisions',
        kind: 'dir',
        children: [{ name: 'pricing.md', path: 'decisions/pricing.md', kind: 'file' }],
    },
    { name: 'README.md', path: 'README.md', kind: 'file' },
] as DocNode[];

let container: HTMLDivElement;
let root: Root;
let uninstall: () => void;

/** What `DocsTree` reads from the store, with the folder open and `README.md` the open document. */
function fakeStore() {
    return {
        visibleTree: TREE,
        removedBuffers: [{ path: 'gone.md' }],
        currentPath: 'README.md',
        query: '',
        buffers: new Map(),
        isOpen: () => true,
        toggleDir: vi.fn(),
        select: vi.fn(),
    };
}

function Screen({ store }: { store: DocsStore }) {
    useHotkeyScope(DOCS_SCOPE);

    return <DocsTree store={ store } />;
}

const row = (path: string) => container.querySelector<HTMLElement>(`[data-path="${ path }"]`)!;

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
        row('decisions').focus();

        expect(press('j', row('decisions'))).toBe(true);
        expect(document.activeElement).toBe(row('decisions/pricing.md'));

        press('ArrowDown', row('decisions/pricing.md'));

        expect(document.activeElement).toBe(row('README.md'));

        press('j', row('README.md'));

        expect(document.activeElement).toBe(row('gone.md'));

        press('k', row('gone.md'));
        press('ArrowUp', row('README.md'));

        expect(document.activeElement).toBe(row('decisions/pricing.md'));
    });

    it('keeps Home, End, Enter and Space on the tree\'s own handler', async () => {
        const store = await render();

        row('decisions/pricing.md').focus();

        expect(press('End', row('decisions/pricing.md'))).toBe(true);
        expect(document.activeElement).toBe(row('gone.md'));
        expect(press('Home', row('gone.md'))).toBe(true);
        expect(document.activeElement).toBe(row('decisions'));

        press('Enter', row('decisions'));
        press(' ', row('decisions'));

        expect(store.toggleDir).toHaveBeenCalledTimes(2);
    });

    it('brings the focus to the open document with the first J while nothing has it', async () => {
        await render();

        (document.activeElement as HTMLElement | null)?.blur();
        press('j', document.body);

        expect(document.activeElement).toBe(row('README.md'));
    });
});
