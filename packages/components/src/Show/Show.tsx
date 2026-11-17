import type { ReactNode } from 'react';

/** Values treated as falsy by `Show` (aligned with `if (value)` in JavaScript; `NaN` is still `number` at the type level). */
export type ShowFalsy = false | null | undefined | 0 | 0n | '';

/** `when` narrowed to values that pass the `Show` truthiness check. */
export type ShowTruthy<T> = T extends ShowFalsy ? never : T;

export interface ShowProps<T = unknown> {
    when: T;
    fallback?: ReactNode;
    children: ReactNode | ((when: ShowTruthy<T>) => ReactNode);
}

export function Show<T>({ when, fallback = null, children }: ShowProps<T>): ReactNode {
    if (when) {
        if (typeof children === 'function') {
            return (children as (value: ShowTruthy<T>) => ReactNode)(when as ShowTruthy<T>);
        }

        return children;
    }

    return fallback;
}

Show.displayName = 'Show';
