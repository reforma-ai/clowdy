import { HelpCircle } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';
import { type ReactNode } from 'react';

import { Button } from '../Button';
import styles from './HelpTip.module.css';
import { Tooltip, type TooltipProps } from './Tooltip';

export interface HelpTipProps {
    /** Help content shown in the tooltip. */
    children: ReactNode;
    className?: string;
    placement?: TooltipProps['placement'];
    delay?: TooltipProps['delay'];
    closeDelay?: TooltipProps['closeDelay'];
    warmUp?: TooltipProps['warmUp'];
}

/**
 * Compact “?” control that reveals help on hover/focus.
 * Spectrum’s analogue is ContextualHelp (popover); this is the tooltip-sized version.
 */
export function HelpTip({ children, className, placement = 'top', delay, closeDelay, warmUp }: HelpTipProps) {
    return (
        <Tooltip content={children} placement={placement} delay={delay} closeDelay={closeDelay} warmUp={warmUp} arrow>
            <Button variant="inline" color="inherit" size="unset" iconOnly className={cn(styles.helpTip, className)}>
                <HelpCircle width={12} height={12} />
            </Button>
        </Tooltip>
    );
}
