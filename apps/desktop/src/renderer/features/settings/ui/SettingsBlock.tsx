import { cn } from '@clowdy/lib';

import styles from './SettingsBlock.module.css';

import type { ComponentPropsWithoutRef, ElementType } from 'react';

export interface SettingsBlockProps extends ComponentPropsWithoutRef<'div'> {
    /** `li` for a block of a card that is a list. */
    as?: 'div' | 'li';
}

/**
 * Anything that sits in a `SettingsCard` and is not a `SettingsRow`: a group of controls, a chart, a sign-in. It brings the card's inset, so every
 * block of a card is padded alike. Lay its content out with a class of the feature's own; do not set padding on it.
 */
export function SettingsBlock({ as: Tag = 'div', className, ...props }: SettingsBlockProps) {
    // `div` and `li` take the same props here; the union of their element types does not.
    const Element = Tag as ElementType;

    return <Element {...props} className={cn(styles.block, className)} />;
}
