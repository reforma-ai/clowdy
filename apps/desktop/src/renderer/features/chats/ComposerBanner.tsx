import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { ChevronDown, ChevronRight } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';

import styles from './ComposerBanner.module.css';

import type { HTMLAttributes, ReactNode } from 'react';

/** The plate above the message box that status rows sit on (Reforma's `ComposerBanner`, dense form): one tight line per row, no rules between. */
export function ComposerBanner({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={ cn(styles.root, className) } { ...props }>{ children }</div>;
}

export interface ComposerBannerStatusProps {
    children: ReactNode;
    icon?: ReactNode;
    /** The words of the row's button, such as `Stop`. No button without it. */
    action?: string;
    onAction?: () => void;
    /** A press anywhere on the row but the button. The button then shows on hover or focus. */
    onPress?: () => void;
    /** What a screen reader hears for the pressable row. */
    pressLabel?: string;
}

/** One row of the plate: an icon, a line of text, and a button at its end. */
export function ComposerBannerStatus({ children, icon, action, onAction, onPress, pressLabel }: ComposerBannerStatusProps) {
    const message = (
        <>
            { icon && <span className={ styles.icon } aria-hidden>{ icon }</span> }
            <Text variant="xs" className={ styles.text }>{ children }</Text>
        </>
    );

    return (
        <div className={ styles.status } data-pressable={ onPress ? true : undefined }>
            { onPress
                ? <button type="button" className={ styles.press } aria-label={ pressLabel } onClick={ onPress }>{ message }</button>
                : message }
            { action && <Button size="xs" variant="ghost" color="secondary" className={ styles.action } isDisabled={ !onAction } onPress={ onAction }>{ action }</Button> }
        </div>
    );
}

export interface ComposerBannerHeaderProps {
    children: ReactNode;
    /** The words of the line's button, such as `Stop all`. No button without it. */
    action?: string;
    onAction?: () => void;
    /** Whether the rows under the line are folded away. With `onToggle`, a chevron at the end of the line folds and unfolds them. */
    collapsed?: boolean;
    onToggle?: () => void;
    /** What the chevron does and a screen reader hears, such as `Hide agents` and `Show agents`. */
    toggleLabel?: string;
}

/** The line above a group of rows: a label in muted words, a button for what applies to the whole group, and a chevron that folds the rows. */
export function ComposerBannerHeader({ children, action, onAction, collapsed = false, onToggle, toggleLabel }: ComposerBannerHeaderProps) {
    return (
        <div className={ styles.status }>
            <Text variant="xs" color="secondary" className={ styles.text }>{ children }</Text>
            { action && <Button size="xs" variant="ghost" color="secondary" className={ styles.action } isDisabled={ !onAction } onPress={ onAction }>{ action }</Button> }
            { onToggle && (
                <Button
                    size="xs"
                    variant="ghost"
                    color="secondary"
                    iconOnly
                    className={ styles.action }
                    aria-label={ toggleLabel }
                    aria-expanded={ !collapsed }
                    onPress={ onToggle }
                >
                    { collapsed ? <ChevronRight /> : <ChevronDown /> }
                </Button>
            ) }
        </div>
    );
}
