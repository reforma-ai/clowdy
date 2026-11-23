import { cn } from '@clowdy/lib';

import styles from './SettingsCard.module.css';

import type { ComponentPropsWithoutRef, ElementType } from 'react';

export interface SettingsCardProps extends ComponentPropsWithoutRef<'div'> {
    /** `ul` for a card of `li` rows, `section` for a card that is a landmark of its own. */
    as?: 'div' | 'ul' | 'section';
    /** Puts a hairline between the card's blocks. A card that draws its own dividers leaves it off. */
    divided?: boolean;
}

/** The surface settings sit on, in every Settings page. Its children bring their own padding (`SettingsRow` does). */
export function SettingsCard({ as: Tag = 'div', divided = false, className, ...props }: SettingsCardProps) {
    // `div`, `ul` and `section` take the same props here; the union of their element types does not.
    const Element = Tag as ElementType;

    return <Element {...props} className={cn(styles.card, className)} data-divided={divided || undefined} />;
}
