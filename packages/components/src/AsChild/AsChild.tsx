import { cn, mergeRefs } from '@clowdy/lib';
import { Children, cloneElement } from 'react';
import { mergeProps } from 'react-aria';

import type { HTMLAttributes, ReactElement, ReactNode, Ref } from 'react';

export type AsChildElement = ReactElement<{ className?: string; ref?: Ref<HTMLElement> }>;

export type AsChildProps = {
    children: ReactNode;
    ref?: Ref<HTMLElement | null>;
} & Omit<HTMLAttributes<HTMLElement>, 'children' | 'ref'>;

/**
 * AsChild pattern: merge React Aria `mergeProps` with `...rest` onto a single child, then clone.
 * Renders no wrapper DOM node.
 */
export function AsChild({ children, className: outerClassName, ref: outerRef, ...rest }: AsChildProps): ReactElement {
    const child = Children.only(children) as AsChildElement;
    const childProps = child.props;

    return cloneElement(
        child,
        mergeProps(childProps, rest, {
            className: cn(childProps.className, outerClassName),
            ref: mergeRefs(outerRef, childProps.ref),
        })
    );
}

AsChild.displayName = 'AsChild';
