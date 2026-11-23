import { MOTION_TRANSITION_COLLAPSE } from '@clowdy/constants';
import { mergeRefs } from '@clowdy/lib';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Children, createContext, createElement, Fragment, isValidElement, use, useMemo, useRef } from 'react';
import { Focusable, mergeProps, useButton, useDisclosure } from 'react-aria';
import { composeRenderProps } from 'react-aria-components';
import { useDisclosureState } from 'react-stately';

import { AsChild } from '../AsChild';

import type { HTMLAttributes, ReactNode, Ref } from 'react';
import type { DisclosureState } from 'react-stately';

type CollapsibleContextValue = {
    isDisabled: boolean;
    panelProps: HTMLAttributes<HTMLElement>;
    panelRef: React.RefObject<HTMLDivElement | null>;
    state: DisclosureState;
    triggerProps: HTMLAttributes<HTMLElement>;
    triggerRef: React.RefObject<HTMLElement | null>;
};

const CollapsibleContext = createContext<CollapsibleContextValue | null>(null);

/**
 * Access disclosure state, refs, and ARIA props when composing without {@link CollapsibleTrigger}.
 */
export function useCollapsible(): CollapsibleContextValue {
    const ctx = use(CollapsibleContext);

    if (!ctx) {
        throw new Error('useCollapsible must be used within Collapsible');
    }

    return ctx;
}

/** Render props passed when {@link Collapsible} `children` is a function (see `composeRenderProps`). */
export type CollapsibleRenderProps = {
    defaultChildren?: ReactNode;
    state: DisclosureState;
};

export type CollapsibleProps = Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'defaultValue' | 'as'> & {
    as?: 'div' | 'button' | 'span' | 'Fragment';
    /** Root element; unused with `Fragment`. */
    ref?: Ref<HTMLElement | null>;
    children?: ReactNode | ((props: CollapsibleRenderProps) => ReactNode);
    defaultOpen?: boolean;
    isDisabled?: boolean;
    onOpenChange?: (open: boolean) => void;
    open?: boolean;
};

export function Collapsible({
    as = 'div',
    children,
    className,
    defaultOpen,
    isDisabled,
    onOpenChange,
    open,
    ...attributes
}: CollapsibleProps) {
    const panelRef = useRef<HTMLDivElement | null>(null);
    const triggerRef = useRef<HTMLElement | null>(null);

    const state = useDisclosureState({
        defaultExpanded: defaultOpen,
        isExpanded: open,
        onExpandedChange: onOpenChange,
    });

    const { buttonProps: disclosureButtonProps, panelProps } = useDisclosure({ isDisabled }, state, panelRef);
    const { buttonProps: triggerProps } = useButton(disclosureButtonProps, triggerRef);

    const contextValue = useMemo(
        (): CollapsibleContextValue => ({
            isDisabled: Boolean(isDisabled),
            panelProps,
            panelRef,
            state,
            triggerProps,
            triggerRef,
        }),
        [isDisabled, panelProps, state, triggerProps]
    );

    const inner = composeRenderProps(
        children,
        (content): ReactNode => content
    )({
        defaultChildren: undefined,
        state,
    });

    // `Fragment` is not a DOM type: no wrapper node, and `className` / div props do not apply.
    const root =
        as === 'Fragment' ? <Fragment>{inner}</Fragment> : createElement(as, { className, ...attributes }, inner);

    return <CollapsibleContext value={contextValue}>{root}</CollapsibleContext>;
}

export type CollapsibleTriggerProps = Omit<HTMLAttributes<HTMLButtonElement>, 'children' | 'ref'> & {
    as?: 'div' | 'button' | 'span';
    asChild?: boolean;
    children: ReactNode;
    ref?: Ref<HTMLElement | null>;
};

export function CollapsibleTrigger({
    as: Component = 'div',
    asChild: asChildProp,
    children,
    className,
    ref,
    ...rest
}: CollapsibleTriggerProps) {
    const { triggerProps, triggerRef } = useCollapsible();

    const asChild =
        asChildProp ?? (Children.count(children) === 1 && isValidElement(children) && children.type !== Fragment);

    // Omit `slot` here: merged props land on native nodes (`<button asChild>`); React 19 rejects invalid `slot` on DOM. RAC `slot` is not for raw HTML.
    const hostProps = mergeProps(triggerProps, rest, {
        className,
        // eslint-disable-next-line react-hooks/refs -- mergeRefs composes; it does not read `.current`
        ref: mergeRefs(triggerRef, ref),
    });

    if (asChild) {
        return <AsChild {...hostProps}>{children}</AsChild>;
    }

    // By default, trigger is a focusable DIV
    return (
        <Focusable>
            <Component {...(hostProps as object)}>{children}</Component>
        </Focusable>
    );
}

export type CollapsibleContentProps = HTMLAttributes<HTMLDivElement> & {
    asChild?: boolean;
    children: ReactNode;
};

/**
 * Disclosure panel
 */
export function CollapsibleContent({ asChild, children, className, ...rest }: CollapsibleContentProps) {
    const { panelProps, panelRef } = useCollapsible();

    const Component = asChild ? AsChild : 'div';

    return (
        <Component ref={panelRef} {...mergeProps(panelProps, rest, { className })}>
            {children}
        </Component>
    );
}

/** Height panel; skips Aria `hidden` so exit is not `display: none`. */
export function CollapsibleMotionContent({ children, className }: { children: ReactNode; className?: string }) {
    const { panelProps, panelRef, state } = useCollapsible();
    const reduceMotion = useReducedMotion();

    return (
        <AnimatePresence initial={false}>
            {state.isExpanded && (
                <motion.div
                    key="collapsible-panel"
                    id={panelProps.id}
                    ref={panelRef}
                    className={className}
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ height: 0 }}
                    transition={reduceMotion ? { duration: 0 } : MOTION_TRANSITION_COLLAPSE}
                    style={{ overflow: 'hidden' }}
                >
                    {children}
                </motion.div>
            )}
        </AnimatePresence>
    );
}
