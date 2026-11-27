import { Button } from '@clowdy/components/Button';
import { ChevronDown } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';

import styles from './ComposerPill.module.css';

import type { ReactNode } from 'react';

export interface ComposerPillProps {
    /** What the pill says before its chevron: the mode's name, the provider's mark and the model. */
    children: ReactNode;
    /** What a screen reader says of the pill: its kind and the label (`Mode: Hands-off`). */
    'aria-label': string;
    isDisabled?: boolean;
    className?: string;
}

/**
 * A pill of the line under the message box that opens a menu or a popover: its words and a chevron. It goes inside a `MenuTrigger`
 * or a `PopoverTrigger`, which keeps the button pressed while what it opens is there; the pressed pill keeps its plate, mutes its
 * label and turns its chevron over.
 */
export function ComposerPill({ children, className, ...props }: ComposerPillProps) {
    return (
        <Button size="sm" variant="filling" rounded truncate className={cn(styles.pill, className)} {...props}>
            {children}
            <ChevronDown aria-hidden="true" className={styles.chevron} />
        </Button>
    );
}
