import { cn } from '@clowdy/lib';
import { Separator as RACSeparator, type SeparatorProps as RACSeparatorProps } from 'react-aria-components';

import styles from './Separator.module.css';

import type { Spacing } from '../types.ts';

export interface SeparatorProps extends RACSeparatorProps {
    orientation?: 'horizontal' | 'vertical';
    spacing?: Spacing | 0 | '0';
    className?: string;
}

const ORIENTATION_SPACING_CLASS: Record<
    NonNullable<SeparatorProps['orientation']>,
    Record<NonNullable<SeparatorProps['spacing']>, string>
> = {
    horizontal: {
        0: 'my-0',
        xxs: 'my-xxs',
        xs: 'my-xs',
        sm: 'my-sm',
        md: 'my-md',
        lg: 'my-lg',
        xl: 'my-xl',
        xxl: 'my-xl',
    },
    vertical: {
        0: 'mx-0',
        xxs: 'mx-xxs',
        xs: 'mx-xs',
        sm: 'mx-sm',
        md: 'mx-md',
        lg: 'mx-lg',
        xl: 'mx-xl',
        xxl: 'mx-xl',
    },
};

export function Separator({
    orientation = 'horizontal',
    spacing = 'md',
    className,
    ...props
}: SeparatorProps) {
    return (
        <RACSeparator
            { ...props }
            orientation={ orientation }
            className={ cn(styles.separator, styles[orientation], ORIENTATION_SPACING_CLASS[orientation][spacing], className) }
        />
    );
}

Separator.displayName = 'Separator';
