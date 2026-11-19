import type { RunStatus } from '@clowdy/protocol';

export type StatusTone = 'success' | 'warning' | 'danger' | 'accent' | 'neutral';

export interface RunStatusView {
    label: string;
    tone: StatusTone;
}

/** How the UI names a run's status, and which color family it takes. */
export const RUN_STATUS_VIEW: Record<RunStatus, RunStatusView> = {
    queued: { label: 'Queued', tone: 'neutral' },
    running: { label: 'Working', tone: 'success' },
    waiting_children: { label: 'Waiting', tone: 'warning' },
    // Not "Waiting": nobody is asked for anything and nothing is stuck, the agent's own work goes on after its turn (green, without the pulse of "Working").
    waiting_background: { label: 'Background', tone: 'success' },
    waiting_user: { label: 'Waiting', tone: 'accent' },
    blocked: { label: 'Blocked', tone: 'warning' },
    succeeded: { label: 'Done', tone: 'neutral' },
    failed: { label: 'Failed', tone: 'danger' },
    cancelled: { label: 'Cancelled', tone: 'neutral' },
    interrupted: { label: 'Interrupted', tone: 'neutral' },
};
