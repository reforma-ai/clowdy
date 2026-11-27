// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useRowContextMenu } from './useRowContextMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function List() {
    const menu = useRowContextMenu({ rowSelector: '[role="row"][data-key]', isKnown: key => key !== 'gone.ts' });

    return (
        <div {...menu.areaProps}>
            <div role="grid" aria-label="Files">
                <div role="row" data-key="a.ts" tabIndex={0}>
                    a.ts
                </div>
                <div role="row" data-key="gone.ts" tabIndex={0}>
                    gone.ts
                </div>
            </div>
            <output>{menu.isOpen ? `open ${menu.rowKey}` : 'closed'}</output>
        </div>
    );
}

const state = () => container.querySelector('output')!.textContent;
const row = (key: string) => container.querySelector<HTMLElement>(`[data-key="${key}"]`)!;
const key = (target: HTMLElement, init: KeyboardEventInit) =>
    act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    });

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<List />));
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('useRowContextMenu', () => {
    it('opens the menu of the focused row on Shift+F10', async () => {
        await key(row('a.ts'), { key: 'F10', shiftKey: true });

        expect(state()).toBe('open a.ts');
    });

    it('opens the menu of a row on right click', () => {
        act(() => {
            row('a.ts').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        });

        expect(state()).toBe('open a.ts');
    });

    it('opens nothing on a row the menu does not know', async () => {
        await key(row('gone.ts'), { key: 'ContextMenu' });

        expect(state()).toBe('closed');
    });
});
