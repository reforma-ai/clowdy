import { Tooltip } from '@clowdy/components/Tooltip';

import styles from './DisabledTooltip.module.css';

import type { ReactNode } from 'react';

/**
 * Says why a button cannot be pressed, on hover and on focus. A disabled button takes no pointer or focus events (the design system's button has `pointer-events: none` while it is off),
 * so a tooltip on it never opens: while there is a `reason` the button is wrapped in a stop of its own that takes them, and that stop stands in for the disabled button for the keyboard
 * and a screen reader (`role="button"`, `aria-disabled`, named by the button inside it, described by the reason). Without a reason the button stands as it is, so it is not a second
 * tab stop beside the button once the button can be pressed; the button's own `tooltip` says what it does then. `className` is the wrapper's, for the layout it stands in.
 */
export function DisabledTooltip({ reason, className, children }: { reason: string | undefined; className?: string; children: ReactNode }) {
    if (reason === undefined) return children;

    return (
        <Tooltip content={ reason } placement="top">
            <span role="button" aria-disabled="true" className={ className ? `${ styles.host } ${ className }` : styles.host }>{ children }</span>
        </Tooltip>
    );
}
