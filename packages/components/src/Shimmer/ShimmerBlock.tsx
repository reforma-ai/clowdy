import { cn } from '@clowdy/lib';

import styles from './Shimmer.module.css';

import type { ComponentPropsWithoutRef, CSSProperties } from 'react';

export type ShimmerBlockVariant = 'sweep' | 'dots';

export type ShimmerBlockProps = Omit<ComponentPropsWithoutRef<'div'>, 'children'> & {
    /**
     * `sweep` — soft band (default).
     * `dots` — peg mesh mask; a soft ball rolls underneath and tints the dots.
     */
    variant?: ShimmerBlockVariant;
    /** Sweep / wander duration in seconds. Defaults: sweep `1.6`, dots `7.5`. */
    duration?: number;
};

/** Block-level loading skeleton (image/card placeholders). Text shine → {@link Shimmer}. */
export function ShimmerBlock({
    className,
    style,
    variant = 'sweep',
    duration,
    ...rest
}: ShimmerBlockProps) {
    const resolvedDuration = duration ?? (variant === 'dots' ? 7.5 : 1.6);

    return (
        <div
            { ...rest }
            aria-hidden
            className={ cn(styles.block, className) }
            data-variant={ variant }
            style={
                {
                    ...style,
                    '--shimmer-block-duration': `${ resolvedDuration }s`,
                } as CSSProperties
            }
        />
    );
}
