import { cn } from '@clowdy/lib';

import { Button, type ButtonProps } from '../Button';

import type { HTMLAttributes, ReactNode, SyntheticEvent } from 'react';

const stop = (event: SyntheticEvent) => event.stopPropagation();

/** The events a row's own controls must not pass up: React Aria rows take the clicks, keys and menus of their React children as their own. */
const ownEvents = {
    onClick: stop,
    onDoubleClick: stop,
    onPointerDown: stop,
    onKeyDown: stop,
    onContextMenu: stop,
};

/**
 * A span around the buttons inside a list or grid row (`GridListItem`, `ListBoxItem`, a table cell): a press, a double click, a key or a right click
 * on them stays theirs and does not select, open or menu the row.
 */
export function RowControls({
    className,
    children,
    ...props
}: HTMLAttributes<HTMLSpanElement> & { children: ReactNode }) {
    return (
        <span {...props} {...ownEvents} className={cn('inline-flex items-center', className)}>
            {children}
        </span>
    );
}

RowControls.displayName = 'RowControls';

export interface RowActionButtonProps extends Omit<ButtonProps, 'children' | 'aria-label' | 'iconOnly'> {
    icon: ReactNode;
    /** The action's name: the button's `aria-label` and, unless `tooltip` is given (`null` for none), its tooltip. */
    label: string;
}

/** The small icon button of a row (archive, more, remove): `xs`, filling, and it does not take the focus from the row on press. Put it in `RowControls`. */
export function RowActionButton({ icon, label, tooltip = label, ...props }: RowActionButtonProps) {
    return (
        <Button
            variant="filling"
            color="secondary"
            size="xs"
            preventFocusOnPress
            {...props}
            iconOnly
            aria-label={label}
            tooltip={tooltip}
        >
            {icon}
        </Button>
    );
}

RowActionButton.displayName = 'RowActionButton';
