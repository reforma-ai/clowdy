// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installLongPressContextMenu } from './longPressContextMenu';
import { useContextMenu } from './useContextMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let target: HTMLElement;
let uninstall: () => void;
const contextmenu = vi.fn<(event: MouseEvent) => void>();
const pointercancel = vi.fn();
const clicked = vi.fn();
// Whether the handler opens a menu, as the ones of the app do: it prevents the default.
let handles = true;

const touch = (type: string, init: { x?: number; y?: number; pointerType?: string; isPrimary?: boolean; on?: Element } = {}) => {
    const event = new Event(type, { bubbles: true, cancelable: true });

    Object.assign(event, { pointerType: init.pointerType ?? 'touch', isPrimary: init.isPrimary ?? true, pointerId: 7, clientX: init.x ?? 10, clientY: init.y ?? 10, screenX: 110, screenY: 210 });
    (init.on ?? target).dispatchEvent(event);
};
const hold = (ms: number) => void vi.advanceTimersByTime(ms);
const click = () => target.click();
/** A context menu event as the browser makes it: trusted. */
const nativeContextMenu = () => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });

    Object.defineProperty(event, 'isTrusted', { value: true });
    target.dispatchEvent(event);

    return event;
};

beforeEach(() => {
    vi.useFakeTimers();
    handles = true;
    contextmenu.mockReset();
    pointercancel.mockReset();
    clicked.mockReset();
    container = document.createElement('div');
    container.innerHTML = '<div data-target>row <input data-field /></div>';
    document.body.append(container);
    target = container.querySelector<HTMLElement>('[data-target]')!;
    target.addEventListener('contextmenu', (event) => {
        contextmenu(event);

        if (handles) event.preventDefault();
    });
    target.addEventListener('pointercancel', pointercancel);
    target.addEventListener('click', clicked);
    uninstall = installLongPressContextMenu(document);
});

afterEach(() => {
    uninstall();
    container.remove();
    vi.useRealTimers();
});

describe('a long press as a right-click', () => {
    it('sends a context menu event to the element under a touch held still for half a second, at the touch', () => {
        touch('pointerdown', { x: 12, y: 8 });
        hold(499);

        expect(contextmenu).not.toHaveBeenCalled();

        hold(1);

        expect(contextmenu).toHaveBeenCalledOnce();

        const [event] = contextmenu.mock.calls[0]!;

        expect([event.clientX, event.clientY, event.button, event.bubbles, Boolean(event.isTrusted)]).toEqual([12, 8, 2, true, false]);
    });

    it('cancels the pointer and swallows the click of the release, once, when a handler opened a menu', () => {
        touch('pointerdown');
        hold(500);

        expect(pointercancel).toHaveBeenCalledOnce();

        touch('pointerup');
        click();

        expect(clicked).not.toHaveBeenCalled();

        click();

        expect(clicked).toHaveBeenCalledOnce();
    });

    it('changes nothing when no handler took it: the press stays a press, and the click comes', () => {
        handles = false;
        touch('pointerdown');
        hold(500);

        expect(contextmenu).toHaveBeenCalledOnce();
        expect(pointercancel).not.toHaveBeenCalled();

        touch('pointerup');
        click();

        expect(clicked).toHaveBeenCalledOnce();
    });

    it('is not a long press when the touch is let go early, drifts, is taken over, or is another finger', () => {
        touch('pointerdown');
        hold(200);
        touch('pointerup');
        hold(1000);

        touch('pointerdown', { x: 10, y: 10 });
        touch('pointermove', { x: 10, y: 40 });
        hold(1000);

        touch('pointerdown');
        touch('pointercancel');
        hold(1000);

        touch('pointerdown', { isPrimary: false });
        hold(1000);

        expect(contextmenu).not.toHaveBeenCalled();
    });

    it('keeps a touch that moves a little within the slop', () => {
        touch('pointerdown', { x: 10, y: 10 });
        touch('pointermove', { x: 14, y: 13 });
        hold(500);

        expect(contextmenu).toHaveBeenCalledOnce();
    });

    it('is for a touch only, and leaves a field of text to the browser', () => {
        touch('pointerdown', { pointerType: 'mouse' });
        hold(1000);
        touch('pointerdown', { pointerType: 'pen' });
        hold(1000);
        touch('pointerdown', { on: container.querySelector('[data-field]')! });
        hold(1000);

        expect(contextmenu).not.toHaveBeenCalled();
    });

    it('does not swallow the click of a new press when the release of the long one landed elsewhere', () => {
        touch('pointerdown');
        hold(500);
        touch('pointerdown', { pointerType: 'mouse' });
        click();

        expect(clicked).toHaveBeenCalledOnce();
    });

    it('sends nothing to an element that is gone from the page by then', () => {
        touch('pointerdown');
        target.remove();
        hold(500);

        expect(contextmenu).not.toHaveBeenCalled();
    });

    it('lets the browser\'s own context menu event for a long touch through, and drops its timer', () => {
        touch('pointerdown');
        hold(300);

        const native = nativeContextMenu();

        hold(1000);

        expect(contextmenu).toHaveBeenCalledOnce();
        expect(native.defaultPrevented).toBe(true);
        expect(pointercancel).not.toHaveBeenCalled();
    });

    it('takes the browser\'s own event that comes just after ours for the same press, and not one that comes long after', () => {
        touch('pointerdown');
        hold(500);

        expect(contextmenu).toHaveBeenCalledOnce();

        nativeContextMenu();

        expect(contextmenu).toHaveBeenCalledOnce();

        hold(1500);
        nativeContextMenu();

        expect(contextmenu).toHaveBeenCalledTimes(2);
    });

    it('stops when it is uninstalled', () => {
        uninstall();
        touch('pointerdown');
        hold(1000);

        expect(contextmenu).not.toHaveBeenCalled();
    });
});

describe('with a menu that opens on a right-click', () => {
    let root: Root;

    function Row() {
        const menu = useContextMenu();

        return (
            <>
                <div data-row onContextMenu={ menu.areaProps.onContextMenu }>row</div>
                <output data-open>{ String(menu.isOpen) }</output>
            </>
        );
    }

    beforeEach(() => {
        root = createRoot(container);
        act(() => root.render(<Row />));
    });

    afterEach(() => act(() => root.unmount()));

    it('opens on a long touch with no code of its own', () => {
        const row = container.querySelector<HTMLElement>('[data-row]')!;

        touch('pointerdown', { on: row });
        act(() => hold(500));

        expect(container.querySelector('[data-open]')!.textContent).toBe('true');
    });
});
