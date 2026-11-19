import { cn } from '@clowdy/lib';

import { RUN_STATUS_VIEW } from './runStatus';
import styles from './RunStatusPill.module.css';
import { StatusDot } from './StatusDot';

import type { Run } from '@clowdy/protocol';

export interface RunStatusPillProps {
    status: Run['status'];
    /** Why the run waits or stopped (`run.statusReason`); shown on hover. */
    reason?: string;
    /** Leave out the dot before the label. */
    plain?: boolean;
    className?: string;
}

/** A run's status as a small pill: Working, Waiting, Background, Blocked, Done, Failed, Cancelled, Interrupted. */
export function RunStatusPill({ status, reason, plain, className }: RunStatusPillProps) {
    const { label, tone } = RUN_STATUS_VIEW[status];

    return (
        <span className={ cn(styles.pill, className) } data-tone={ tone } title={ reason }>
            { !plain && <StatusDot status={ status } /> }
            { label }
        </span>
    );
}
