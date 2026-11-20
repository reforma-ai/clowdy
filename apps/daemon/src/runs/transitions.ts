import type { RunStatus } from '@clowdy/protocol';

/**
 * Where a run may go next. Every status change goes through `RunService.setStatus`, which refuses anything not listed here.
 *
 * - A run only becomes `running` from `queued`, so the scheduler's cap holds. A run that waited for background work or an answer goes back through
 *   `queued` and takes a slot again.
 * - `queued`, `waiting_background` and `blocked` may repeat to refresh their reason (why the run still waits).
 * - A chat orchestrator whose session outlives its turn (an agent's background work still open) goes `waiting_background`, which holds no slot. It
 *   leaves by `queued` when a message is delivered to the live session, and by a terminal state when the session ends or the person stops it. A session
 *   that fails for a moment while the run waits is retried like a running one's: both go `blocked`.
 * - A running run goes `blocked` when its engine is at a subscription limit or failed for a moment, and comes back through `queued`.
 * - A finished chat orchestrator is resumed by the user's next message: terminal states lead back to `queued`.
 */
export const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
    queued: ['queued', 'running', 'failed', 'cancelled', 'interrupted'],
    running: ['waiting_background', 'waiting_user', 'blocked', 'succeeded', 'failed', 'cancelled', 'interrupted'],
    waiting_background: ['waiting_background', 'queued', 'blocked', 'succeeded', 'failed', 'cancelled', 'interrupted'],
    waiting_user: ['queued', 'failed', 'cancelled', 'interrupted'],
    blocked: ['blocked', 'queued', 'failed', 'cancelled', 'interrupted'],
    succeeded: ['queued'],
    failed: ['queued'],
    cancelled: ['queued'],
    interrupted: ['queued'],
};

/** Why a run waits while its session keeps background work open (`waiting_background`), refreshed whenever the list changes. */
export const BACKGROUND_REASON = 'Waiting for background work';

/**
 * Why an orchestrator whose turn was ended on purpose (`RunDriver.interrupt`) rests as `cancelled`: a message waits to go in its next turn, and the run
 * is neither failed nor paused (`ChatQueue` reads it to tell the agent, `dispatch`).
 */
export const STOPPED_TO_SEND_REASON = 'Stopped to send a message';

/** Statuses that must say why the run is not running. */
export const NEEDS_REASON: readonly RunStatus[] = ['queued', 'waiting_background', 'waiting_user', 'blocked'];

export function canTransition(from: RunStatus, to: RunStatus): boolean {
    return TRANSITIONS[from].includes(to);
}
