import React from 'react';

import type { ReactNode } from 'react';

export type SlotProps = { slot?: string };

/**
 * Returns React elements from `children` that pass the given predicate.
 */
export function filterChildren<P extends object = Record<string, unknown>>(
    children: ReactNode,
    predicate: (child: React.ReactElement<P>) => boolean
): Array<React.ReactElement<P>> {
    return React.Children.toArray(children).filter(
        (child): child is React.ReactElement<P> =>
            React.isValidElement(child) && predicate(child as React.ReactElement<P>)
    );
}
