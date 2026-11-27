import { cn } from '@clowdy/lib';
import {
    Meter as RACMeter,
    type MeterProps as RACMeterProps,
    ProgressBar as RACProgressBar,
    type ProgressBarProps as RACProgressBarProps,
} from 'react-aria-components';

import styles from './ProgressBar.module.css';

/** The fill's colour. A feature with a colour of its own sets `--clowdy-progress-fill` (and `--clowdy-progress-track`) on `className`. */
export type ProgressTone = 'primary' | 'success' | 'warning' | 'danger';

export interface ProgressBarProps extends Omit<RACProgressBarProps, 'children' | 'className' | 'style'> {
    tone?: ProgressTone;
    className?: string;
}

export interface MeterProps extends Omit<RACMeterProps, 'children' | 'className' | 'style'> {
    tone?: ProgressTone;
    className?: string;
}

/** The part of the track an indeterminate fill covers as it sweeps. */
const INDETERMINATE_WIDTH = 30;

function Fill({ percentage }: { percentage?: number }) {
    return <span className={styles.fill} style={{ width: `${percentage ?? 0}%` }} />;
}

/**
 * A 6px bar of how far a task has come (a clone, a download): `value` of `maxValue` (100 by default), `aria-label` or `aria-labelledby` for its
 * name. Without a value (`isIndeterminate`) the fill sweeps.
 */
export function ProgressBar({ tone = 'primary', className, ...props }: ProgressBarProps) {
    return (
        <RACProgressBar {...props} className={cn(styles.track, className)} data-tone={tone}>
            {({ percentage, isIndeterminate }) => (
                <Fill percentage={isIndeterminate ? INDETERMINATE_WIDTH : percentage} />
            )}
        </RACProgressBar>
    );
}

ProgressBar.displayName = 'ProgressBar';

/** The same bar for a level within a range that is not progress: a usage limit, how full a context is. */
export function Meter({ tone = 'primary', className, ...props }: MeterProps) {
    return (
        <RACMeter {...props} className={cn(styles.track, className)} data-tone={tone}>
            {({ percentage }) => <Fill percentage={percentage} />}
        </RACMeter>
    );
}

Meter.displayName = 'Meter';
