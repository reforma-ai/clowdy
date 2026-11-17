import { cn } from '@clowdy/lib';
import { ReactNode, type Ref } from 'react';

import listStyles from '../List/ListBox.module.css';
import { Scrollable } from '../Scrollable';


export interface PopoverScrollProps {
    /** When set, constrains height and enables vertical scrolling inside the popover. */
    maxHeight?: number | string;
    /** Optional ref to the scroll viewport (infinite lists, etc.). */
    containerRef?: Ref<HTMLDivElement | null>;
    className?: string;
    children: ReactNode;
}

/**
 * Scroll shell for popover content: vertical {@link Scrollable} with optional `maxHeight`.
 * Wrap {@link ListBox} or {@link Menu} — keyboard focus and selected-item scroll live on those components.
 */
export function PopoverScroll({ maxHeight, containerRef, className, children }: PopoverScrollProps) {
    const style = maxHeight != null
        ? { maxHeight: typeof maxHeight === 'number' ? `${ maxHeight }px` : maxHeight }
        : undefined;

    return (
        <Scrollable
            className={ cn(listStyles.scrollableContainer, className) }
            vertical
            style={ style }
            containerRef={ containerRef }
        >
            { children }
        </Scrollable>
    );
}

PopoverScroll.displayName = 'PopoverScroll';
