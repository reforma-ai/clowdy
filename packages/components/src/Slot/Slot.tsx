import React, { createContext, Fragment, type ReactElement, ReactNode } from 'react';
import { ContextValue, DEFAULT_SLOT, useContextProps, useSlottedContext } from 'react-aria-components';

import type { SlotProps } from 'react-aria-components';

export { DEFAULT_SLOT } from 'react-aria-components';

type SlotFilter = ((slot: string) => boolean) | readonly string[] | string;

function toPredicate(filter: SlotFilter): (slot: string) => boolean {
    if (typeof filter === 'string') {
        return slot => slot === filter;
    }

    if (Array.isArray(filter)) {
        return slot => filter.includes(slot);
    }

    return filter as (slot: string) => boolean;
}

export const SlotContext = createContext<ContextValue<any, HTMLElement>>({});

export function useSlotContext<T>(slot?: string | null): T | null | undefined {
    return useSlottedContext(SlotContext, slot) as T | null | undefined;
}

/**
 * React 19 adapter for RAC's useContextProps. Merges props (including ref) from SlotContext.
 * Slots must include DEFAULT_SLOT for components used without an explicit slot.
 *
 * Returns props WITHOUT the `slot` property — `slot` is consumed by this hook to look up
 * the matching SlotContext entry, and should not be forwarded to the rendered element.
 */
export function useSlotContextProps<T extends SlotProps & { ref?: React.Ref<any> }>({
    ref,
    slot,
    ...rest
}: T): Omit<T, 'slot'> {
    const [mergedProps, mergedRef] = useContextProps(
        {
            ...rest,
            slot: slot ?? DEFAULT_SLOT,
        } as T & SlotProps,
        ref,
        SlotContext
    );

    const { slot: _slot, ...mergedRest } = mergedProps as T & SlotProps;

    return { ...mergedRest, ref: mergedRef };
}

export function filterSlots(children: ReactNode, filter: SlotFilter, defaultChildren?: ReactNode): ReactNode {
    const predicate = toPredicate(filter);
    const isFragment = React.isValidElement(children) && children.type === Fragment;
    const content: ReactNode = isFragment
        ? (children as React.ReactElement<{ children?: ReactNode }>).props.children
        : children;

    const slots = React.Children.toArray(content).filter(child =>
        predicate(React.isValidElement(child) ? ((child.props as SlotProps)?.slot as string) : '')
    );

    return slots.length ? slots : defaultChildren;
}

/**
 * Renders content as a named slot, merging it with slot-specific props from the parent Provider
 * (e.g. className from slots.label). Use when passing prop-based content that should participate
 * in the slot system—e.g. <Slot as="div" slot="startAffix">{ startAffix }</Slot>.
 */
export function Slot({
    as = Fragment,
    children,
    slot,
    ...rest
}: { as?: React.ElementType; slot?: string; children?: React.ReactNode } & React.HTMLAttributes<HTMLElement>) {
    const context = useSlottedContext(SlotContext, slot);
    const mergedProps = { ...context, ...rest, ...(slot != null && { slot }) };

    if (as === Fragment) {
        return React.Children.toArray(children).map(child => React.cloneElement(child as ReactElement, mergedProps));
    }

    return React.createElement(as, mergedProps, children);
}
