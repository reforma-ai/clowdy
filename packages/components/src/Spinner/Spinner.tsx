import { cn } from '@clowdy/lib';

import styles from './Spinner.module.css';

import type { HTMLAttributes } from 'react';

export type SpinnerSize = 'xxs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl' | 'inherit' | 'unset';

export interface SpinnerProps extends HTMLAttributes<HTMLDivElement> {
    size?: SpinnerSize;
    className?: string;
}

export function SpinnerMark() {
    return (
        <svg className={styles.spinner} viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <circle className={styles.track} cx="16" cy="16" r="14" />
            <circle className={styles.arc} cx="16" cy="16" r="14" />
        </svg>
    );
}

export function Spinner({ size = 'inherit', className, ...props }: SpinnerProps) {
    return (
        <div role="status" aria-label="Loading" className={cn(styles.root, className)} data-size={size} {...props}>
            <SpinnerMark />
        </div>
    );
}

Spinner.displayName = 'Spinner';
