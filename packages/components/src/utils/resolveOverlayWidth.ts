import type { CSSProperties } from 'react';

export type OverlayWidth = string | number | 'trigger';

export function resolveOverlayWidth(width: OverlayWidth | undefined): CSSProperties | undefined {
    if (width == null) {
        return undefined;
    }

    if (width === 'trigger') {
        return {
            width: 'var(--trigger-width)',
            minWidth: 'var(--trigger-width)',
            maxWidth: 'var(--trigger-width)',
        };
    }

    const resolvedWidth = typeof width === 'number' ? `${width}px` : width;

    return { width: resolvedWidth, minWidth: resolvedWidth };
}
