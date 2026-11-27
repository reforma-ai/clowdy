import { cn } from '@clowdy/lib';
import { type PressEvent, Button as RACButton } from 'react-aria-components';

import { Tooltip } from '../Tooltip';
import styles from './Chip.module.css';

import type { HTMLAttributes, ReactNode, Ref } from 'react';

/** The app's status tones. No tone is the plain chat chip: muted stone with the label in the content colour. */
export type ChipTone = 'neutral' | 'primary' | 'accent' | 'success' | 'warning' | 'danger';
/** `xs` is 20px with 11px type, `sm` is 24px with 12px type. */
export type ChipSize = 'xs' | 'sm';
export type ChipShape = 'squircle' | 'pill';

export interface ChipProps extends Omit<HTMLAttributes<HTMLElement>, 'children' | 'color'> {
    ref?: Ref<HTMLElement>;
    tone?: ChipTone;
    size?: ChipSize;
    /** `pill` is fully round, for a status; `squircle` (the default) is the chat chip. */
    shape?: ChipShape;
    /** Shown before the label, in the dim tone of a plain chip or the tone's colour. */
    icon?: ReactNode;
    children?: ReactNode;
    /** Shown on hover and focus. A chip that is not a button becomes focusable for it and is read as its label plus the tip. */
    tooltip?: ReactNode;
    tooltipPlacement?: 'top' | 'bottom' | 'left' | 'right';
    /** Makes the chip a button. */
    onPress?: (event: PressEvent) => void;
    isDisabled?: boolean;
}

/**
 * A short label on a muted plate: a status, a task key, a mention. A `span`, or a button when it has `onPress`. Use it for any chip or pill; `Tag`
 * and `TagGroup` are for lists of selectable or removable tags.
 */
export function Chip({
    ref,
    tone,
    size = 'xs',
    shape = 'squircle',
    icon,
    children,
    tooltip,
    tooltipPlacement,
    onPress,
    isDisabled,
    className,
    ...rest
}: ChipProps) {
    const content = (
        <>
            {icon != null && (
                <span className={styles.icon} aria-hidden="true">
                    {icon}
                </span>
            )}
            {children != null && <span className={styles.label}>{children}</span>}
        </>
    );
    const shared = {
        className: cn(styles.chip, className),
        'data-tone': tone,
        'data-size': size,
        'data-shape': shape,
    };

    if (onPress) {
        const button = (
            <RACButton
                {...(rest as object)}
                {...shared}
                ref={ref as Ref<HTMLButtonElement>}
                data-interactive=""
                isDisabled={isDisabled}
                onPress={onPress}
            >
                {content}
            </RACButton>
        );

        return tooltip == null ? (
            button
        ) : (
            <Tooltip content={tooltip} placement={tooltipPlacement}>
                {button}
            </Tooltip>
        );
    }

    // A static chip with a tip is focusable so the tip can be reached; `img` keeps its label as the name and reads the tip as its description.
    const label = rest['aria-label'] ?? (typeof children === 'string' ? children : undefined);
    const span = (
        <span
            {...rest}
            {...shared}
            ref={ref}
            role={tooltip == null ? rest.role : 'img'}
            aria-label={tooltip == null ? rest['aria-label'] : label}
            aria-disabled={isDisabled || undefined}
        >
            {content}
        </span>
    );

    return tooltip == null ? (
        span
    ) : (
        <Tooltip content={tooltip} placement={tooltipPlacement}>
            {span}
        </Tooltip>
    );
}

Chip.displayName = 'Chip';
