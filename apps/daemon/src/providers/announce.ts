import { listProjects } from '../db/projects';

import type { Store } from '../store';

/**
 * Tells every project's clients that the agents changed, so they fetch `GET /v1/agents` again. It opens its own transaction
 * (one that is already open is joined), because the callers that matter most, a read that ended and a login program that
 * printed its link, run from timers and streams, where `store.emit` alone throws.
 */
export function announceAgentsChanged(store: Store): void {
    store.tx(() => {
        for (const project of listProjects(store.db)) {
            store.emit(project.id, { type: 'agents.changed' });
        }
    });
}
