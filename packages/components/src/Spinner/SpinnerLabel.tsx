import { cn } from '@clowdy/lib';

import { SpinnerMark } from './Spinner';
import styles from './Spinner.module.css';

import type { HTMLAttributes, ReactNode } from 'react';
import type { SpinnerSize } from './Spinner';

export interface SpinnerLabelProps extends HTMLAttributes<HTMLSpanElement> {
    children: ReactNode;
    /** Spinner size; default `inherit` (≈1em of the label text). */
    size?: SpinnerSize;
}

/**
 * Inline loading row: spinner + label with the spacing from Spinner stories.
 */
export function SpinnerLabel({
    children,
    size = 'inherit',
    className,
    ...props
}: SpinnerLabelProps) {
    return (
        <span
            role="status"
            data-size={ size }
            className={ cn(styles.labelRoot, className) }
            { ...props }
        >
            <SpinnerMark />
            <span className={ styles.label }>{ children }</span>
        </span>
    );
}

SpinnerLabel.displayName = 'SpinnerLabel';
