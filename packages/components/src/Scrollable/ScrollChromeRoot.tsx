import { cn, mergeRefs } from '@clowdy/lib';
import { useMemo } from 'react';
import { mergeProps } from 'react-aria';

import styles from './Scrollable.module.css';

import type { HTMLAttributes, ReactNode, Ref } from 'react';

export type ScrollChromeRootProps = {
    children: ReactNode;
    className?: string;
    vertical?: boolean;
    horizontal?: boolean;
    edgeFade?: boolean;
    ref?: Ref<HTMLDivElement | null>;
    rootPointerHandlers: {
        onPointerEnter: () => void;
        onPointerLeave: () => void;
    };
} & Omit<HTMLAttributes<HTMLDivElement>, 'children'>;

export function ScrollChromeRoot({
    children,
    className,
    vertical,
    horizontal,
    edgeFade,
    ref: userRef,
    rootPointerHandlers,
    rootRef,
    ...attrs
}: ScrollChromeRootProps & { rootRef: Ref<HTMLDivElement | null> }) {
    const isVerticalEnabled = vertical ?? true;
    const isHorizontalEnabled = horizontal ?? false;

    // mergeRefs() returns a new callback every call — memoize so React does not
    // detach/reattach (e.g. motion mid-animation) on every parent render.
    const rootMergedRef = useMemo(
        () => mergeRefs(rootRef, userRef),
        [rootRef, userRef]
    );

    return (
        <div
            { ...mergeProps(attrs as HTMLAttributes<HTMLDivElement>, {
                ref: rootMergedRef,
                className: cn(styles.root, className, {
                    [styles.scrollV]: isVerticalEnabled,
                    [styles.scrollH]: isHorizontalEnabled,
                    [styles.edgeFade]: edgeFade,
                }),
                onPointerEnter: rootPointerHandlers.onPointerEnter,
                onPointerLeave: rootPointerHandlers.onPointerLeave,
            }) }
        >
            { children }
        </div>
    );
}

ScrollChromeRoot.displayName = 'ScrollChromeRoot';
