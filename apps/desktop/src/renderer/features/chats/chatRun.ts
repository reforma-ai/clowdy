import { isBusyRunStatus, isTerminalRunStatus } from '@clowdy/protocol';

import type { Run, RunStatus } from '@clowdy/protocol';

/** The orchestrator is still on this chat: it can be stopped, and its mode cannot change. */
export function isRunActive(run: Run | undefined): run is Run {
    return run !== undefined && !isTerminalRunStatus(run.status);
}

/** The orchestrator takes a message only later, so a message waits in the chat's queue (`isBusyRunStatus`, the daemon's own rule). */
export function isRunBusy(run: Run | undefined): run is Run {
    return run !== undefined && isBusyRunStatus(run.status);
}

/** The orchestrator's last turn failed because the conversation no longer fit the model's context window (the daemon's `context_too_long`). */
export function overflowed(run: Run | undefined): boolean {
    return run?.status === 'failed' && run.failureCode === 'context_too_long';
}

/**
 * The live line that ends a chat's stream while the orchestrator works. A run that waits for the person shows its
 * question instead, and a blocked or finished one says so in the header.
 */
export function liveLine(status: RunStatus): boolean | string {
    switch (status) {
        case 'running':
            return true;
        case 'queued':
            return 'Waiting for a free slot…';
        case 'waiting_background':
            return 'Waiting for background work…';
        default:
            return false;
    }
}
