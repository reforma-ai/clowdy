import { cn } from '@clowdy/lib';
import { createContext, use, useCallback, useEffect, useMemo, useRef } from 'react';
import { Popover as RACPopover, type PopoverProps as RACPopoverProps } from 'react-aria-components';

import { useControlledState } from '../hooks';
import { type OverlayWidth, resolveOverlayWidth } from '../utils/resolveOverlayWidth';
import styles from './HoverCard.module.css';

import type { CSSProperties, MouseEvent, ReactNode, RefObject } from 'react';
import type { Spacing } from '../types';

const PADDING_CLASSES: Record<Spacing, string> = {
    xxs: 'p-xxs',
    xs: 'p-xs',
    sm: 'p-sm',
    md: 'p-md',
    lg: 'p-lg',
    xl: 'p-xl',
    xxl: 'p-xxl',
};

const SPACING_OFFSET_PX: Record<Spacing, number> = {
    xxs: 2,
    xs: 4,
    sm: 6,
    md: 8,
    lg: 12,
    xl: 16,
    xxl: 18,
};

interface HoverCardContextValue {
    isOpen: boolean;
    setOpen: (open: boolean) => void;
    scheduleOpen: () => void;
    scheduleClose: () => void;
    triggerRef: RefObject<HTMLElement | null>;
}

const HoverCardContext = createContext<HoverCardContextValue | null>(null);

function useHoverCardContext(consumer: string): HoverCardContextValue {
    const ctx = use(HoverCardContext);

    if (!ctx) {
        throw new Error(`${consumer} must be rendered inside <HoverCard>`);
    }

    return ctx;
}

function chain<E>(a?: (e: E) => void, b?: (e: E) => void) {
    return (e: E) => {
        a?.(e);
        b?.(e);
    };
}

// ── Root ────────────────────────────────────────────────────────────────────

export interface HoverCardProps {
    children: ReactNode;
    isOpen?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (isOpen: boolean) => void;
    openDelay?: number; // Delay before the card appears on hover (ms).
    closeDelay?: number; // Delay before the card hides once the pointer leaves trigger + content (ms).
}

export function HoverCard({
    children,
    isOpen: isOpenProp,
    defaultOpen,
    onOpenChange,
    openDelay = 400,
    closeDelay = 200,
}: HoverCardProps) {
    const [isOpen, setOpen] = useControlledState(isOpenProp, defaultOpen ?? false, onOpenChange);

    const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const triggerRef = useRef<HTMLElement | null>(null);

    const clearOpen = () => {
        if (openTimer.current) {
            clearTimeout(openTimer.current);
            openTimer.current = null;
        }
    };

    const clearClose = () => {
        if (closeTimer.current) {
            clearTimeout(closeTimer.current);
            closeTimer.current = null;
        }
    };

    const scheduleOpen = useCallback(() => {
        clearClose();

        if (openTimer.current) {
            return;
        }

        openTimer.current = setTimeout(() => {
            openTimer.current = null;
            setOpen(true);
        }, openDelay);
    }, [openDelay, setOpen]);

    const scheduleClose = useCallback(() => {
        clearOpen();

        if (closeTimer.current) {
            return;
        }

        closeTimer.current = setTimeout(() => {
            closeTimer.current = null;
            setOpen(false);
        }, closeDelay);
    }, [closeDelay, setOpen]);

    useEffect(
        () => () => {
            clearOpen();
            clearClose();
        },
        []
    );

    const ctx = useMemo<HoverCardContextValue>(
        () => ({ isOpen, setOpen, scheduleOpen, scheduleClose, triggerRef }),
        [isOpen, setOpen, scheduleOpen, scheduleClose]
    );

    return <HoverCardContext value={ctx}>{children}</HoverCardContext>;
}

// ── Trigger ─────────────────────────────────────────────────────────────────

export interface HoverCardTriggerProps {
    children: ReactNode;
    className?: string;
}

/**
 * Wraps the trigger element with hover listeners. Rendered as an inline-block
 * span so it owns a real bounding rect for popover positioning.
 */
export function HoverCardTrigger({ children, className }: HoverCardTriggerProps) {
    const { scheduleOpen, scheduleClose, triggerRef } = useHoverCardContext('HoverCardTrigger');

    return (
        <span
            ref={triggerRef}
            className={cn(styles.trigger, className)}
            onMouseEnter={scheduleOpen}
            onMouseLeave={scheduleClose}
        >
            {children}
        </span>
    );
}

// ── Content ─────────────────────────────────────────────────────────────────

export type HoverCardSpacing = Spacing;

export interface HoverCardContentProps
    extends Omit<RACPopoverProps, 'className' | 'style' | 'triggerRef' | 'isOpen' | 'onOpenChange'> {
    className?: string;
    spacing?: HoverCardSpacing;
    style?: CSSProperties;
    width?: OverlayWidth;
    onMouseEnter?: (e: MouseEvent<HTMLElement>) => void;
    onMouseLeave?: (e: MouseEvent<HTMLElement>) => void;
}

export function HoverCardContent({
    className,
    children,
    spacing = 'md',
    style: styleProp,
    width,
    onMouseEnter,
    onMouseLeave,
    containerPadding = 8,
    ...props
}: HoverCardContentProps) {
    const { isOpen, setOpen, scheduleOpen, scheduleClose, triggerRef } = useHoverCardContext('HoverCardContent');

    const widthStyle = resolveOverlayWidth(width);

    const style = widthStyle != null || styleProp != null ? { ...styleProp, ...widthStyle } : undefined;

    return (
        <RACPopover
            triggerRef={triggerRef}
            isOpen={isOpen}
            onOpenChange={setOpen}
            isNonModal
            className={cn(styles.content, PADDING_CLASSES[spacing], className)}
            style={style}
            offset={SPACING_OFFSET_PX[spacing]}
            containerPadding={containerPadding}
            {...props}
            onMouseEnter={chain(onMouseEnter, scheduleOpen)}
            onMouseLeave={chain(onMouseLeave, scheduleClose)}
        >
            {children}
        </RACPopover>
    );
}

HoverCard.displayName = 'HoverCard';
HoverCardTrigger.displayName = 'HoverCardTrigger';
HoverCardContent.displayName = 'HoverCardContent';
