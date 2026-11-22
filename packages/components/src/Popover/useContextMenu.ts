import { useCallback, useEffect, useRef, useState } from 'react';

import type { MouseEvent, PointerEvent, RefObject } from 'react';
import type { PopoverProps } from './Popover';

/** How long a touch is held still before it opens the menu, as a long press does elsewhere. */
const LONG_PRESS_MS = 500;
/** How far a held touch may drift, in px, before it is a drag or a scroll and not a long press. */
const LONG_PRESS_SLOP = 10;

export interface UseContextMenuOptions {
    /**
     * A touch held still for half a second opens the menu where it is, and the click that follows its release is swallowed (it would otherwise do what a plain
     * press does). Only a touch: a mouse has its right button. Off by default.
     */
    longPress?: boolean;
}

export interface UseContextMenuResult {
    /** Spread onto the element that should respond to right-click (and to a long touch, with `longPress`). */
    areaProps: {
        onContextMenu: (e: MouseEvent) => void;
        onPointerDown?: (e: PointerEvent) => void;
        onPointerMove?: (e: PointerEvent) => void;
        onPointerUp?: (e: PointerEvent) => void;
        onPointerCancel?: (e: PointerEvent) => void;
        onClickCapture?: (e: MouseEvent) => void;
    };

    /** Opens the menu at a point of the window, for a press that is not a right-click (a click with ⌘ or Ctrl held, say). */
    openAt: (clientX: number, clientY: number) => void;

    /** Spread onto `<Popover>` to control open state and positioning. */
    popoverProps: Pick<PopoverProps, 'isOpen' | 'onOpenChange'> & {
        triggerRef: RefObject<Element | null>;
    };

    /** Whether the context menu is currently open. */
    isOpen: boolean;

    /** Programmatically close the context menu. */
    close: () => void;
}

/**
 * Creates a minimal virtual DOM element at the given coordinates.
 * RAC Popover uses ResizeObserver on the trigger, so the object
 * must satisfy the Element interface enough for `observe()` to work.
 */
function createVirtualTrigger(x: number, y: number): Element {
    const rect = new DOMRect(x, y, 0, 0);
    const element = document.createElement('div');

    element.getBoundingClientRect = () => rect;
    element.style.position = 'fixed';
    element.style.top = `${ y }px`;
    element.style.left = `${ x }px`;
    element.style.width = '0';
    element.style.height = '0';
    element.style.pointerEvents = 'none';

    document.body.appendChild(element);

    return element;
}

/**
 * Hook for opening a `<Popover>` as a context menu (right-click, and a long touch with `longPress`).
 *
 * Uses a real zero-size DOM element positioned at the cursor so
 * React Aria's ResizeObserver and positioning work correctly.
 *
 * **Important:** Only render the `<Popover>` when `isOpen` is `true`.
 *
 * @example
 * ```tsx
 * const contextMenu = useContextMenu();
 *
 * <div { ...contextMenu.areaProps }>
 *   <Card />
 * </div>
 *
 * <Show when={ contextMenu.isOpen }>
 *   <Popover { ...contextMenu.popoverProps } placement="bottom start">
 *     <Menu onAction={ handleAction } aria-label="Actions">
 *       <MenuItem>Edit</MenuItem>
 *       <MenuItem isDanger>Delete</MenuItem>
 *     </Menu>
 *   </Popover>
 * </Show>
 * ```
 */
export function useContextMenu({ longPress = false }: UseContextMenuOptions = {}): UseContextMenuResult {
    const triggerRef = useRef<Element>(null);
    const [isOpen, setIsOpen] = useState(false);
    // The touch being held, until it opens the menu or ends: its timer and where it started.
    const holding = useRef<{ timer: number; x: number; y: number } | null>(null);
    // The long press opened the menu, so the click that comes with its release is not a press.
    const swallowClick = useRef(false);

    const openAt = useCallback((clientX: number, clientY: number) => {
        // Remove previous virtual trigger if any
        if (triggerRef.current?.parentNode) {
            triggerRef.current.parentNode.removeChild(triggerRef.current);
        }

        (triggerRef as { current: Element }).current = createVirtualTrigger(clientX, clientY);
        setIsOpen(true);
    }, []);

    const onContextMenu = useCallback((e: MouseEvent) => {
        e.preventDefault();
        openAt(e.clientX, e.clientY);
    }, [openAt]);

    const stopHolding = useCallback(() => {
        if (holding.current) window.clearTimeout(holding.current.timer);

        holding.current = null;
    }, []);

    useEffect(() => stopHolding, [stopHolding]);

    const onPointerDown = useCallback((e: PointerEvent) => {
        // A new gesture: a click that was left over from the last one (the release landed on the menu) is not its own.
        swallowClick.current = false;
        stopHolding();

        if (e.pointerType !== 'touch') return;

        const { clientX: x, clientY: y } = e;

        holding.current = {
            x,
            y,
            timer: window.setTimeout(() => {
                holding.current = null;
                swallowClick.current = true;
                openAt(x, y);
            }, LONG_PRESS_MS),
        };
    }, [openAt, stopHolding]);

    const onPointerMove = useCallback((e: PointerEvent) => {
        if (holding.current && Math.hypot(e.clientX - holding.current.x, e.clientY - holding.current.y) > LONG_PRESS_SLOP) stopHolding();
    }, [stopHolding]);

    const onClickCapture = useCallback((e: MouseEvent) => {
        if (!swallowClick.current) return;

        swallowClick.current = false;
        e.preventDefault();
        e.stopPropagation();
    }, []);

    const close = useCallback(() => {
        setIsOpen(false);

        // Cleanup virtual trigger
        if (triggerRef.current?.parentNode) {
            triggerRef.current.parentNode.removeChild(triggerRef.current);
            (triggerRef as { current: Element | null }).current = null;
        }
    }, []);

    const handleOpenChange = useCallback((open: boolean) => {
        if (!open) {
            close();
        }
        else {
            setIsOpen(true);
        }
    }, [close]);

    return {
        areaProps: longPress ? { onContextMenu, onPointerDown, onPointerMove, onPointerUp: stopHolding, onPointerCancel: stopHolding, onClickCapture } : { onContextMenu },
        openAt,
        popoverProps: { triggerRef, isOpen, onOpenChange: handleOpenChange },
        isOpen,
        close,
    };
}
