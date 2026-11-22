// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useContextMenu, type UseContextMenuOptions } from './useContextMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const clicked = vi.fn();

function Area(options: UseContextMenuOptions) {
    const menu = useContextMenu(options);

    return (
        <>
            <button type="button" data-area onClick={ clicked } { ...menu.areaProps }>area</button>
            <output data-open>{ String(menu.isOpen) }</output>
            <button type="button" data-open-at onClick={ () => menu.openAt(30, 40) }>open at</button>
            <button type="button" data-close onClick={ menu.close }>close</button>
        </>
    );
}

const draw = (options: UseContextMenuOptions = {}) => act(() => root.render(<Area { ...options } />));
const area = () => container.querySelector<HTMLElement>('[data-area]')!;
const isOpen = () => container.querySelector('[data-open]')!.textContent === 'true';
const touch = (type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', init: { x?: number; y?: number; pointerType?: string } = {}) => act(() => {
    const event = new Event(type, { bubbles: true, cancelable: true });

    Object.assign(event, { pointerType: init.pointerType ?? 'touch', clientX: init.x ?? 10, clientY: init.y ?? 10 });
    area().dispatchEvent(event);
});
const hold = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const click = () => act(() => area().click());

beforeEach(() => {
    vi.useFakeTimers();
    clicked.mockClear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
});

describe('useContextMenu', () => {
    it('opens at a point with openAt, and closes', () => {
        draw();
        act(() => container.querySelector<HTMLElement>('[data-open-at]')!.click());

        expect(isOpen()).toBe(true);

        act(() => container.querySelector<HTMLElement>('[data-close]')!.click());

        expect(isOpen()).toBe(false);
    });

    it('opens on a right-click and has no touch handlers without longPress', () => {
        draw();
        act(() => void area().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));

        expect(isOpen()).toBe(true);

        touch('pointerdown');
        hold(1000);
        click();

        expect(clicked).toHaveBeenCalledOnce();
    });

    describe('with longPress', () => {
        beforeEach(() => draw({ longPress: true }));

        it('opens when a touch is held still for half a second, and swallows the click that comes with its release', () => {
            touch('pointerdown');
            hold(499);

            expect(isOpen()).toBe(false);

            hold(1);

            expect(isOpen()).toBe(true);

            touch('pointerup');
            click();

            expect(clicked).not.toHaveBeenCalled();

            // Only that one click: the next press is a press.
            click();

            expect(clicked).toHaveBeenCalledOnce();
        });

        it('does not open for a touch that is let go early, which is a click', () => {
            touch('pointerdown');
            hold(200);
            touch('pointerup');
            hold(1000);
            click();

            expect(isOpen()).toBe(false);
            expect(clicked).toHaveBeenCalledOnce();
        });

        it('does not open for a touch that drifts, or is taken over (a scroll), while it is held', () => {
            touch('pointerdown', { x: 10, y: 10 });
            touch('pointermove', { x: 10, y: 40 });
            hold(1000);

            expect(isOpen()).toBe(false);

            touch('pointerdown');
            touch('pointercancel');
            hold(1000);

            expect(isOpen()).toBe(false);
        });

        it('keeps a touch that moves a little within the slop', () => {
            touch('pointerdown', { x: 10, y: 10 });
            touch('pointermove', { x: 14, y: 13 });
            hold(500);

            expect(isOpen()).toBe(true);
        });

        it('is for a touch only: a held mouse button opens nothing', () => {
            touch('pointerdown', { pointerType: 'mouse' });
            hold(1000);
            click();

            expect(isOpen()).toBe(false);
            expect(clicked).toHaveBeenCalledOnce();
        });

        it('does not swallow the click of a new press when the release of the long one landed elsewhere', () => {
            touch('pointerdown');
            hold(500);

            expect(isOpen()).toBe(true);

            // No click came to the area (the menu was under the finger); a mouse press afterwards is its own gesture.
            touch('pointerdown', { pointerType: 'mouse' });
            click();

            expect(clicked).toHaveBeenCalledOnce();
        });
    });
});
