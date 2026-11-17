import { useCallback, useRef, useState } from 'react';

import type { MouseEvent, RefObject } from 'react';
import type { PopoverProps } from './Popover';

export interface UseContextMenuResult {
    /** Spread onto the element that should respond to right-click. */
    areaProps: {
        onContextMenu: (e: MouseEvent) => void;
    };

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
 * Hook for opening a `<Popover>` as a context menu (right-click).
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
export function useContextMenu(): UseContextMenuResult {
    const triggerRef = useRef<Element>(null);
    const [isOpen, setIsOpen] = useState(false);

    const onContextMenu = useCallback((e: MouseEvent) => {
        e.preventDefault();

        // Remove previous virtual trigger if any
        if (triggerRef.current?.parentNode) {
            triggerRef.current.parentNode.removeChild(triggerRef.current);
        }

        (triggerRef as { current: Element }).current = createVirtualTrigger(e.clientX, e.clientY);
        setIsOpen(true);
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
        areaProps: { onContextMenu },
        popoverProps: { triggerRef, isOpen, onOpenChange: handleOpenChange },
        isOpen,
        close,
    };
}
