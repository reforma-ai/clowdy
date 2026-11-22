// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useContextMenu } from './useContextMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function Area() {
    const menu = useContextMenu();

    return (
        <>
            <button type="button" data-area { ...menu.areaProps }>area</button>
            <output data-open>{ String(menu.isOpen) }</output>
            <button type="button" data-open-at onClick={ () => menu.openAt(30, 40) }>open at</button>
            <button type="button" data-close onClick={ menu.close }>close</button>
        </>
    );
}

const isOpen = () => container.querySelector('[data-open]')!.textContent === 'true';
const press = (selector: string) => act(() => container.querySelector<HTMLElement>(selector)!.click());

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<Area />));
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('useContextMenu', () => {
    it('opens at a point with openAt, and closes', () => {
        press('[data-open-at]');

        expect(isOpen()).toBe(true);

        press('[data-close]');

        expect(isOpen()).toBe(false);
    });

    it('opens on a right-click, with the virtual trigger where it was made', () => {
        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 8 });

        act(() => void container.querySelector('[data-area]')!.dispatchEvent(event));

        expect(event.defaultPrevented).toBe(true);
        expect(isOpen()).toBe(true);
    });
});
