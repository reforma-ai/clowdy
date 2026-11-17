import { cn } from '@clowdy/lib';
import { isValidElement, useRef, type ReactNode } from 'react';
import { useTooltipTrigger } from 'react-aria';
import {
    Focusable as AriaFocusable,
    Tooltip as AriaTooltip,
    TooltipProps as AriaTooltipProps,
    OverlayArrow,
    Provider,
    TooltipContext,
    TooltipTriggerComponentProps,
    TooltipTriggerStateContext,
} from 'react-aria-components';
import { FocusableProvider } from 'react-aria/private/interactions/useFocusable';

import { Show } from '../Show';
import styles from './Tooltip.module.css';
import { useTooltipTriggerState } from './useTooltipTriggerState';

export interface TooltipContentProps extends AriaTooltipProps {
    children: React.ReactNode;
    /** Show a placement arrow (default false). */
    arrow?: boolean;
}

type TooltipTriggerOptions = Pick<
    TooltipTriggerComponentProps,
    'closeDelay' | 'delay' | 'isDisabled' | 'isOpen' | 'shouldCloseOnPress' | 'trigger'
>;

export interface TooltipTriggerProps extends TooltipTriggerComponentProps {
    /**
     * Spectrum-style global warmup: the first tooltip waits `delay`, then adjacent
     * triggers open immediately until the cooldown expires. Default false — every
     * hover waits the full delay (better for dense rows like chips).
     */
    warmUp?: boolean;
}

export interface TooltipProps extends TooltipContentProps, TooltipTriggerOptions {
    content?: React.ReactNode;
    warmUp?: boolean;
    /** Wrap custom triggers that do not consume React Aria focusable context themselves. */
    wrapTrigger?: boolean;
}

/**
 * TooltipTrigger must attach hover/focus to a DOM node.
 * - Native elements (`div`, `span`, …): wrap in `Focusable` so refs/events reach the DOM.
 * - RAC-backed custom components (`Button`, `Tag`, …): do **not** wrap — RAC merges trigger props; `Focusable` here breaks
 *   ref forwarding and triggers “child must forward ref” / ARIA role warnings.
 * - Other custom components can opt into wrapping so trigger props reach their DOM node.
 */
function makeFocusable(node: ReactNode, wrapTrigger: boolean): ReactNode {
    if (!isValidElement(node)) {
        return node;
    }

    if (wrapTrigger || typeof node.type === 'string') {
        return <AriaFocusable>{node as never}</AriaFocusable>;
    }

    return node;
}

const tooltipTriggerDefaults = {
    delay: 500,
    closeDelay: 150,
    shouldCloseOnPress: false,
} as const;

export function TooltipTrigger({
    children,
    warmUp = false,
    delay = tooltipTriggerDefaults.delay,
    closeDelay = tooltipTriggerDefaults.closeDelay,
    shouldCloseOnPress = tooltipTriggerDefaults.shouldCloseOnPress,
    ...rest
}: TooltipTriggerProps) {
    const state = useTooltipTriggerState({
        warmUp,
        delay,
        closeDelay,
        shouldCloseOnPress,
        ...rest,
    });
    const ref = useRef<HTMLElement>(null);
    const { triggerProps, tooltipProps } = useTooltipTrigger(
        {
            delay,
            closeDelay,
            shouldCloseOnPress,
            ...rest,
        },
        state,
        ref
    );

    return (
        <Provider
            values={ [
                [TooltipTriggerStateContext, state],
                [TooltipContext, { ...tooltipProps, triggerRef: ref }],
            ] }
        >
            <FocusableProvider { ...triggerProps } ref={ ref }>
                { children }
            </FocusableProvider>
        </Provider>
    );
}

export function Tooltip({
    children,
    content,
    closeDelay,
    delay,
    isDisabled,
    isOpen,
    shouldCloseOnPress,
    trigger,
    warmUp = false,
    wrapTrigger = false,
    ...props
}: TooltipProps) {
    return (
        <TooltipTrigger
            closeDelay={ closeDelay }
            delay={ delay }
            isDisabled={ isDisabled }
            isOpen={ isOpen }
            shouldCloseOnPress={ shouldCloseOnPress }
            trigger={ trigger }
            warmUp={ warmUp }
        >
            { makeFocusable(children, wrapTrigger) }
            <Show when={ content != null }>
                <TooltipContent { ...props }>
                    {content}
                </TooltipContent>
            </Show>
        </TooltipTrigger>
    );
}

export function TooltipContent({ children, className, arrow = false, ...props }: TooltipContentProps) {
    return (
        <AriaTooltip
            { ...props }
            className={ cn(styles.tooltip, className) }
        >
            <Show when={ arrow }>
                <OverlayArrow className={ styles.arrow }>
                    <svg width={ 8 } height={ 8 } viewBox="0 0 8 8" aria-hidden>
                        <path d="M0 0 L4 4 L8 0" />
                    </svg>
                </OverlayArrow>
            </Show>
            { children }
        </AriaTooltip>
    );
}
