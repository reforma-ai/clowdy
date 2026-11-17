import { cn } from '@clowdy/lib';

import { RUN_STATUS_VIEW } from './runStatus';
import styles from './StatusDot.module.css';

import type { RunStatus } from '@clowdy/protocol';
import type { StatusTone } from './runStatus';

export interface StatusDotProps {
    /** A run's status, or a tone for anything else. */
    status?: RunStatus;
    tone?: StatusTone;
    className?: string;
}

/** A small colored dot. A working run's dot pulses. */
export function StatusDot({ status, tone, className }: StatusDotProps) {
    return (
        <span
            aria-hidden
            className={ cn(styles.dot, className) }
            data-tone={ tone ?? (status ? RUN_STATUS_VIEW[status].tone : 'neutral') }
            data-live={ status === 'running' || undefined }
        />
    );
}
