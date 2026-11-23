import { Tooltip } from '@clowdy/components/Tooltip';
import { cn } from '@clowdy/lib';

import styles from './Unavailable.module.css';

import type { ReactNode } from 'react';

export interface UnavailableProps {
    /** The control's name, which the focusable stand-in reads out. */
    label: string;
    /** Why the control is off. Without one the control is shown as it is. */
    hint?: string;
    /** The side the hint opens on: away from the nearest edge of the window. */
    placement?: 'top' | 'bottom';
    /** The stand-in's own class, for its place in the layout round it and the corners its focus ring follows. */
    className?: string;
    children: ReactNode;
}

/**
 * A disabled control that still says why. A disabled button gets no pointer events and no focus, so the tooltip sits on a
 * focusable stand-in that does; without a hint the control is shown as it is.
 */
export function Unavailable({ label, hint, placement = 'top', className, children }: UnavailableProps) {
    if (!hint) return children;

    return (
        <Tooltip content={ hint } placement={ placement }>
            <span className={ cn(styles.unavailable, className) } role="button" tabIndex={ 0 } aria-disabled aria-label={ label }>{ children }</span>
        </Tooltip>
    );
}
