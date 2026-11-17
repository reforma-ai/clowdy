import { cn } from '@clowdy/lib';
import {
    DialogTrigger,
    OverlayTriggerStateContext,
    Popover as RACPopover,
    type DialogTriggerProps,
    type PopoverProps as RACPopoverProps,
} from 'react-aria-components';

import { resolveOverlayWidth, type OverlayWidth } from '../utils/resolveOverlayWidth';
import styles from './Popover.module.css';

import type { CSSProperties } from 'react';
import type { Spacing } from '../types';

const PADDING_CLASSES: Record<PopoverSpacing, string> = {
    none: '',
    xxs: 'p-xxs',
    xs: 'p-xs',
    sm: 'p-sm',
    md: 'p-md',
    lg: 'p-lg',
    xl: 'p-xl',
    xxl: 'p-xxl',
};

export type { DialogTriggerProps as PopoverTriggerProps };
export { OverlayTriggerStateContext };

export type PopoverSpacing = Spacing | 'none';

export interface PopoverProps extends Omit<RACPopoverProps, 'className' | 'style'> {
    className?: string;
    spacing?: PopoverSpacing;
    style?: CSSProperties;
    width?: OverlayWidth;
}

export function PopoverTrigger(props: DialogTriggerProps) {
    return <DialogTrigger { ...props } />;
}

export function Popover({
    className,
    children,
    spacing = 'xs',
    style: styleProp,
    width,
    // Single source of gap — do not also use CSS margins (they stack with Floating UI offset).
    offset = 8,
    // RAC default is 12; keep overlays closer to the viewport edge.
    containerPadding = 8,
    ...props
}: PopoverProps) {
    const widthStyle = resolveOverlayWidth(width);
    const paddingClass = PADDING_CLASSES[spacing as Spacing];

    const style = (widthStyle != null || styleProp != null)
        ? { ...styleProp, ...widthStyle }
        : undefined;

    return (
        <RACPopover
            className={ cn(styles.popover, paddingClass, className) }
            style={ style }
            offset={ offset }
            containerPadding={ containerPadding }
            { ...props }
            data-modal-clickout-layer
        >
            { children }
        </RACPopover>
    );
}
