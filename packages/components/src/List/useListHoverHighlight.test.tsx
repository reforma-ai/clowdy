// @vitest-environment happy-dom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useListHoverHighlight } from './useListHoverHighlight';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOPS: Record<string, number> = { a: 10, b: 50, c: 90 };

function Rows() {
    const ref = useRef<HTMLDivElement>(null);

    useListHoverHighlight(ref, true, '[data-row]');

    return (
        <div ref={ ref } data-testid="list">
            { Object.keys(TOPS).map(id => <div key={ id } id={ id } data-row tabIndex={ -1 }>{ id }</div>) }
        </div>
    );
}

let host: HTMLDivElement;
let root: Root;

const row = (id: string) => document.getElementById(id)!;
const list = () => host.firstElementChild as HTMLElement;
const plate = () => ({
    shown: list().style.getPropertyValue('--clowdy-listbox-highlight-opacity') === '1',
    top: list().style.getPropertyValue('--clowdy-listbox-highlight-top'),
});
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

/** React Aria marks the row that has keyboard focus `data-focus-visible`; the test marks it by hand, as it would be at the next frame. */
function focusByKeyboard(id: string) {
    for (const other of document.querySelectorAll('[data-row]')) other.removeAttribute('data-focus-visible');

    row(id).setAttribute('data-focus-visible', '');
    row(id).focus();
}

beforeEach(async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    await act(async () => root.render(<Rows />));

    for (const [id, top] of Object.entries(TOPS)) {
        row(id).getBoundingClientRect = () => ({ top, left: 0, width: 100, height: 30, right: 100, bottom: top + 30 }) as DOMRect;
    }
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe('useListHoverHighlight', () => {
    it('slides the plate to the row a keydown on the list moved the keyboard focus to', async () => {
        focusByKeyboard('b');
        list().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        await frame();

        expect(plate()).toEqual({ shown: true, top: '50px' });
    });

    it('slides the plate to a row that took the keyboard focus without the list seeing a key, as a command that owns J and K does', async () => {
        // The command stops the keydown at the document, so the list's own `keydown` never runs.
        const swallow = (event: Event) => event.stopPropagation();

        document.addEventListener('keydown', swallow, true);

        try {
            row('a').dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }));
            focusByKeyboard('c');
            await frame();

            expect(plate()).toEqual({ shown: true, top: '90px' });

            focusByKeyboard('a');
            await frame();

            expect(plate()).toEqual({ shown: true, top: '10px' });
        }
        finally {
            document.removeEventListener('keydown', swallow, true);
        }
    });

    it('leaves the plate on the hovered row when the focus came from the pointer', async () => {
        row('a').dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 5, clientY: 15 }));

        expect(plate()).toEqual({ shown: true, top: '10px' });

        row('c').focus();
        await frame();

        expect(plate()).toEqual({ shown: true, top: '10px' });
    });

    it('shows no plate for a selected row, which has its own fill', async () => {
        focusByKeyboard('a');
        await frame();

        expect(plate().shown).toBe(true);

        row('b').setAttribute('data-selected', '');
        focusByKeyboard('b');
        await frame();

        expect(plate().shown).toBe(false);
    });
});
