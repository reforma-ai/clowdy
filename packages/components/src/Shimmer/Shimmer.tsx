import { cn } from '@clowdy/lib';
import { type ComponentType, type CSSProperties, createElement, type JSX } from 'react';

import styles from './Shimmer.module.css';

export interface ShimmerProps {
    children: string;
    as?: keyof JSX.IntrinsicElements | ComponentType<any>;
    className?: string;
    style?: CSSProperties;
    duration?: number;
    spread?: number;
}

export function Shimmer({ children, as: tag = 'span', className, style, duration = 2, spread = 2 }: ShimmerProps) {
    return createElement(
        tag,
        {
            className: cn(styles.root, className),
            style: {
                ...style,
                '--spread': `${(children?.length ?? 0) * spread}px`,
                '--shimmer-duration': `${duration}s`,
            } as CSSProperties,
        },
        children
    );
}
