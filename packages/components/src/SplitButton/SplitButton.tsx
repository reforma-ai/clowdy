import { ChevronDown } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';

import { Button, type ButtonProps } from '../Button';
import { MenuTrigger } from '../List';
import { Popover, type PopoverProps } from '../Popover';
import styles from './SplitButton.module.css';

import type { ReactNode } from 'react';

export interface SplitButtonProps
    extends Pick<
        ButtonProps,
        | 'children'
        | 'onPress'
        | 'variant'
        | 'color'
        | 'size'
        | 'isDisabled'
        | 'disabledReason'
        | 'isPending'
        | 'spinnerPlacement'
        | 'tooltip'
        | 'tooltipPlacement'
        | 'contentClassName'
        | 'aria-label'
        | 'aria-describedby'
    > {
    /** The menu of the other actions: a `Menu` with its items. */
    menu: ReactNode;
    /** The name of the menu button (`More source control actions`). */
    menuLabel: string;
    menuTooltip?: ReactNode;
    isMenuDisabled?: boolean;
    menuPlacement?: PopoverProps['placement'];
    menuWidth?: PopoverProps['width'];
    /** The menu button's icon; a chevron by default. */
    menuIcon?: ReactNode;
    /** A label of more than one line: it wraps and both buttons grow with it. */
    wrap?: boolean;
    /** Take the row's width; the main button gets what the menu button leaves. */
    fullWidth?: boolean;
    className?: string;
}

/** A main action and a menu of related ones, drawn as one button split in two: the corners between them are square and a hairline gap parts them. */
export function SplitButton({
    menu,
    menuLabel,
    menuTooltip,
    isMenuDisabled,
    menuPlacement = 'bottom end',
    menuWidth,
    menuIcon,
    wrap = false,
    fullWidth = false,
    className,
    variant = 'filled',
    color,
    size = 'md',
    tooltipPlacement,
    ...main
}: SplitButtonProps) {
    return (
        <div
            className={cn(styles.split, className)}
            data-wrap={wrap || undefined}
            data-full-width={fullWidth || undefined}
        >
            <Button
                {...main}
                variant={variant}
                color={color}
                size={size}
                tooltipPlacement={tooltipPlacement}
                fullWidth={fullWidth}
                className={styles.main}
            />
            <MenuTrigger>
                <Button
                    variant={variant}
                    color={color}
                    size={size}
                    iconOnly
                    isDisabled={isMenuDisabled}
                    className={styles.more}
                    aria-label={menuLabel}
                    tooltip={menuTooltip}
                    tooltipPlacement={tooltipPlacement}
                >
                    {menuIcon ?? <ChevronDown aria-hidden="true" />}
                </Button>
                <Popover placement={menuPlacement} width={menuWidth}>
                    {menu}
                </Popover>
            </MenuTrigger>
        </div>
    );
}

SplitButton.displayName = 'SplitButton';
