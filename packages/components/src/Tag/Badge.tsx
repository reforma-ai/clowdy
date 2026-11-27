import { Chip } from '../Chip';

import type { ReactNode } from 'react';
import type { SemanticColor } from '../types';
import type { TagSize } from './Tag.types';

export interface BadgeProps {
    /** Label inside the badge. */
    children?: ReactNode;
    /** `secondary` (the default) is the plain chip. */
    color?: SemanticColor;
    /** `xs` is 20px; the larger sizes are 24px. */
    size?: TagSize;
    /** Pill shape. */
    rounded?: boolean;
    icon?: ReactNode;
    tooltip?: ReactNode;
    /** The badge's name for a screen reader when it has a tooltip and its label is not plain text. */
    textValue?: string;
    className?: string;
}

/** A static label: a `Chip` with the `Tag` colour names. New code uses `Chip` directly; `TagGroup` is for lists of tags. */
export function Badge({
    children,
    color = 'secondary',
    size = 'md',
    rounded,
    icon,
    tooltip,
    textValue,
    className,
}: BadgeProps) {
    return (
        <Chip
            tone={color === 'secondary' ? undefined : color}
            size={size === 'xs' ? 'xs' : 'sm'}
            shape={rounded ? 'pill' : 'squircle'}
            icon={icon}
            tooltip={tooltip}
            aria-label={tooltip == null ? undefined : textValue}
            className={className}
        >
            {children}
        </Chip>
    );
}

Badge.displayName = 'Badge';
