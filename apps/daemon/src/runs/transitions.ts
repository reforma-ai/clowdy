import type { RunStatus } from '@clowdy/protocol';

/**
 * Where a run may go next. Every status change goes through `RunService.setStatus`, which refuses anything not listed here.
 *
 * - A run only becomes `running` from `queued`, so the scheduler's cap holds. A run that waited for children or
 *   an answer goes back through `queued` and takes a slot again.
 * - `queued`, `waiting_children` and `blocked` may repeat to refresh their reason (why the run still waits).
 * - A running run goes `blocked` when its engine is at a subscription limit or failed for a moment, and comes back through `queued`.
 * - A finished chat orchestrator is resumed by the user's next message: terminal states lead back to `queued`.
 */
export const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
    queued: ['queued', 'running', 'failed', 'cancelled', 'interrupted'],
    running: ['waiting_children', 'waiting_user', 'blocked', 'succeeded', 'failed', 'cancelled', 'interrupted'],
    waiting_children: ['waiting_children', 'queued', 'failed', 'cancelled', 'interrupted'],
    waiting_user: ['queued', 'failed', 'cancelled', 'interrupted'],
    blocked: ['blocked', 'queued', 'failed', 'cancelled', 'interrupted'],
    succeeded: ['queued'],
    failed: ['queued'],
    cancelled: ['queued'],
    interrupted: ['queued'],
};

/** Statuses that must say why the run is not running. */
export const NEEDS_REASON: readonly RunStatus[] = ['queued', 'waiting_children', 'waiting_user', 'blocked'];

export function canTransition(from: RunStatus, to: RunStatus): boolean {
    return TRANSITIONS[from].includes(to);
}
