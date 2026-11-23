import { cn } from '@clowdy/lib';
import { shownRunReason, shownRunStatus } from '@clowdy/protocol';

import styles from './RunStatusPill.module.css';
import { RUN_STATUS_VIEW } from './runStatus';
import { StatusDot } from './StatusDot';

import type { Run } from '@clowdy/protocol';

export interface RunStatusPillProps {
    /** The run, read as a person reads it (`shownRunStatus`: a card open to them says Waiting whatever the status); why it waits or stopped shows on hover. */
    run: Pick<Run, 'status' | 'statusReason' | 'awaitingUser'>;
    /** Leave out the dot before the label. */
    plain?: boolean;
    className?: string;
}

/** A run's status as a small pill: Working, Waiting, Background, Blocked, Done, Failed, Cancelled, Interrupted. */
export function RunStatusPill({ run, plain, className }: RunStatusPillProps) {
    const status = shownRunStatus(run);
    const { label, tone } = RUN_STATUS_VIEW[status];

    return (
        <span className={cn(styles.pill, className)} data-tone={tone} title={shownRunReason(run)}>
            {!plain && <StatusDot status={status} />}
            {label}
        </span>
    );
}
