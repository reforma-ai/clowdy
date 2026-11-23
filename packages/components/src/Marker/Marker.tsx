import { cn } from '@clowdy/lib';

import { Shimmer } from '../Shimmer';
import { Text } from '../Text';
import styles from './Marker.module.css';

import type { HTMLAttributes, ReactNode } from 'react';

export type MarkerVariant = 'default' | 'separator';

export type MarkerProps = {
    /** `separator` is a labeled divider (chat day, section break). */
    variant?: MarkerVariant;
    className?: string;
    children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'color'>;

export type MarkerIconProps = HTMLAttributes<HTMLSpanElement>;

export type MarkerContentProps = {
    /** Sweep the label while a status is live. Only applies to string children. */
    shimmer?: boolean;
    children?: ReactNode;
} & Omit<HTMLAttributes<HTMLSpanElement>, 'children' | 'color'>;

export function Marker({ variant = 'default', className, children, ...props }: MarkerProps) {
    return (
        <div {...props} className={cn(styles.root, className)} data-variant={variant}>
            {children}
        </div>
    );
}

/** Decorative icon / loader slot. Hidden from assistive tech. */
export function MarkerIcon({ className, ...props }: MarkerIconProps) {
    return <span aria-hidden className={cn(styles.icon, className)} {...props} />;
}

export function MarkerContent({ shimmer, className, children, ...props }: MarkerContentProps) {
    return (
        <Text data-inline-links className={cn(styles.content, className)} {...props}>
            {shimmer && typeof children === 'string' ? <Shimmer>{children}</Shimmer> : children}
        </Text>
    );
}

Marker.displayName = 'Marker';
MarkerIcon.displayName = 'MarkerIcon';
MarkerContent.displayName = 'MarkerContent';
