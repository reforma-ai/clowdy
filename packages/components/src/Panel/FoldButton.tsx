import { ChevronDown, ChevronRight } from '@clowdy/icons/8';
import { cn } from '@clowdy/lib';

import { Button, type ButtonProps } from '../Button';
import styles from './Panel.module.css';

export interface FoldButtonProps
    extends Omit<
        ButtonProps,
        'children' | 'onPress' | 'size' | 'iconOnly' | 'variant' | 'aria-label' | 'aria-expanded'
    > {
    isExpanded: boolean;
    /** What the button does, for a screen reader and the tooltip-less pointer (`Collapse CLO-12`). */
    label: string;
    onToggle: () => void;
    /** `xs` is a 24px button, as a list row's other buttons are; `xxs` is 16px, for a tree or table row. */
    size?: 'xs' | 'xxs';
}

/**
 * The chevron that folds the lines under a row: right when folded, down when open, with `aria-expanded`. Inside a list row put it in `RowControls`, so
 * its press is not the row's.
 */
export function FoldButton({ isExpanded, label, onToggle, size = 'xs', className, ...props }: FoldButtonProps) {
    return (
        <Button
            preventFocusOnPress
            {...props}
            variant="filling"
            size={size === 'xs' ? 'xs' : 'unset'}
            iconOnly
            className={cn(styles.foldButton, className)}
            data-fold-size={size}
            aria-label={label}
            aria-expanded={isExpanded}
            onPress={onToggle}
        >
            {isExpanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
        </Button>
    );
}

FoldButton.displayName = 'FoldButton';
