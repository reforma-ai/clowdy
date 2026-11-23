import { cn } from '@clowdy/lib';
import { type ComponentType, type HTMLAttributes, lazy, Suspense } from 'react';

import styles from './Loader.module.css';

import type { SpinnerSize } from '../Spinner/Spinner';

export type LoaderSize = SpinnerSize;

export type LoaderProps = {
    size?: LoaderSize;
    className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, 'children'>;

// The animation and the Lottie player load on first use, so a screen that never waits does not carry them.
// A player that cannot start (no canvas, as in a test environment) leaves the loader empty: a loader must never be what breaks a screen.
const LottieMark = lazy<ComponentType>(async () => {
    try {
        const [{ Lottie }, animation] = await Promise.all([import('../Lottie'), import('./reforma-loader.json')]);
        const animationData = (animation as { default?: unknown }).default ?? animation;

        function Mark() {
            return <Lottie animationData={animationData} loop autoplay aria-hidden />;
        }

        return { default: Mark };
    } catch {
        return { default: () => null };
    }
});

/**
 * The brand mark as a loading animation (Lottie), forked from Reforma: it is the loader for a screen, a page or a panel that waits.
 * For something small and inline (a button, a line of text) use `Spinner`. The animation file is Reforma's mark for now: swap `reforma-loader.json` for Clowdy's.
 */
export function Loader({ size = 'inherit', className, ...props }: LoaderProps) {
    return (
        <div role="status" aria-label="Loading" className={cn(styles.root, className)} data-size={size} {...props}>
            <Suspense fallback={null}>
                <LottieMark />
            </Suspense>
        </div>
    );
}

Loader.displayName = 'Loader';
