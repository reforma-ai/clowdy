import { Chip } from '@clowdy/components/Chip';
import { shownRunReason, shownRunStatus } from '@clowdy/protocol';

import { RUN_STATUS_VIEW } from './runStatus';
import { StatusDot } from './StatusDot';

import type { Run } from '@clowdy/protocol';

export interface RunStatusPillProps {
    /** The run, read as a person reads it (`shownRunStatus`: a card open to them says Waiting whatever the status); why it waits or stopped shows on hover. */
    run: Pick<Run, 'status' | 'statusReason' | 'awaitingUser'>;
    className?: string;
}

/**
 * A run's status as a small pill: Working, Waiting, Background, Blocked, Done, Failed, Cancelled, Interrupted. The reason is a native title: the pill sits inside
 * a row button or a checkbox, where a focusable tooltip would nest one control in another.
 */
export function RunStatusPill({ run, className }: RunStatusPillProps) {
    const status = shownRunStatus(run);
    const { label, tone } = RUN_STATUS_VIEW[status];

    return (
        <Chip
            className={className}
            tone={tone}
            shape="pill"
            icon={<StatusDot status={status} />}
            title={shownRunReason(run)}
        >
            {label}
        </Chip>
    );
}
