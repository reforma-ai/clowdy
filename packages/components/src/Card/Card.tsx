import { cn } from '@clowdy/lib';

import { Box, type BoxProps } from '../Box';
import styles from './Card.module.css';

import type { ElementType } from 'react';
import type { SemanticColor } from '../types';

export type CardVariant = 'filled' | 'bordered' | 'transparent';
export type CardSize = 'sm' | 'md' | 'lg';

export type CardProps<E extends ElementType = 'div'> = BoxProps<E> & {
    variant?: CardVariant;
    /** Muted surface tint for {@link CardVariant | `filled`} cards. Defaults to `secondary`. */
    color?: SemanticColor;
    size?: CardSize;
    /** `true` tints on hover; `outline` uses a hover and active selection ring. */
    hoverable?: boolean | 'outline';
    isActive?: boolean;
};

const SIZE_TO_PADDING: Record<CardSize, BoxProps['padding']> = {
    sm: 'sm',
    md: 'lg',
    lg: 'xl',
};

export function Card<E extends ElementType = 'div'>({
    variant = 'filled',
    color,
    size = 'md',
    hoverable = false,
    isActive = false,
    className,
    padding,
    paddingX,
    paddingY,
    style,
    ...props
}: CardProps<E>) {
    const resolvedPadding: BoxProps['padding'] = padding ?? SIZE_TO_PADDING[size];
    const resolvedPaddingX: BoxProps['paddingX'] = paddingX;
    const resolvedPaddingY: BoxProps['paddingY'] = paddingY;
    const resolvedColor = (color && color !== 'secondary') ? color : undefined;

    return (
        <Box<E>
            { ...(props as BoxProps<E>) }
            className={ cn(styles.card, className) }
            data-variant={ variant }
            data-color={ resolvedColor }
            data-size={ size }
            data-hoverable={ hoverable || undefined }
            data-active={ isActive || undefined }
            padding={ resolvedPadding }
            paddingX={ resolvedPaddingX }
            paddingY={ resolvedPaddingY }
            style={ style }
        />
    );
}

Card.displayName = 'Card';

