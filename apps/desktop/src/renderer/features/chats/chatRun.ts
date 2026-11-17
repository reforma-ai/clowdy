import { isTerminalRunStatus } from '@clowdy/protocol';

import type { Run, RunStatus } from '@clowdy/protocol';

/** The orchestrator is still on this chat: it can be stopped, and its mode cannot change. */
export function isRunActive(run: Run | undefined): run is Run {
    return run !== undefined && !isTerminalRunStatus(run.status);
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
        case 'waiting_children':
            return 'Waiting for the executors…';
        default:
            return false;
    }
}
