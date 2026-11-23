import type { ReactNode } from 'react';

export interface ForProps<T> {
    each: readonly T[];
    fallback?: ReactNode;
    children: (item: T, index: number, { isFirst, isLast }: { isFirst: boolean; isLast: boolean }) => ReactNode;
}

export function For<T>({ each, children, fallback }: ForProps<T>): ReactNode {
    if (each.length === 0) {
        return fallback;
    }

    const total = each.length;

    return each.map((item, index) => children(item, index, { isFirst: index === 0, isLast: index === total - 1 }));
}

For.displayName = 'For';
