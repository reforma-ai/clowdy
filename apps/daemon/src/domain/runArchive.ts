import { ACTIVE_RUN_STATUSES } from '@clowdy/protocol';

import { getRun, runDescendants, setRunArchivedAt } from '../db/runs';
import { conflict, invalid, notFound } from '../errors';

import type { Run } from '@clowdy/protocol';
import type { Store } from '../store';

const isActive = (run: Run) => ACTIVE_RUN_STATUSES.includes(run.status);

/** Writes the flag and announces the run as it is now, the way every change of a run is announced. */
function setFlag(store: Store, run: Run, archivedAt: number | undefined): Run {
    setRunArchivedAt(store.db, run.id, archivedAt);

    const { archivedAt: _, ...rest } = run;
    const saved: Run = archivedAt === undefined ? rest : { ...rest, archivedAt };

    store.emit(saved.projectId, { type: 'run.upserted', run: saved });

    return saved;
}

/**
 * Puts a native sub-agent away from the Agents list, or brings it back, as `setChatArchived` does for a chat. Only the flag changes: the run, its stream and its reads stay, and
 * no chat moves in the order of activity, since a person tidying the list is not activity. A sub-agent that works, or that started one that works, cannot be archived: it
 * would drop out of sight while busy. Archiving takes the sub-agents it started along (all of them are over by then); bringing one back brings only that one. Setting what is
 * set already changes nothing: no write and no event. A run that works has no flag, so bringing it back is that case, not a refusal.
 */
export function setRunArchived(store: Store, runId: string, archived: boolean): Run {
    return store.tx(() => {
        const run = getRun(store.db, runId);

        if (!run) {
            throw notFound('Run', runId);
        }

        if (run.origin !== 'native') {
            throw invalid('Only a sub-agent can be archived');
        }

        if ((run.archivedAt !== undefined) === archived) {
            return run;
        }

        if (!archived) {
            return setFlag(store, run, undefined);
        }

        const started = runDescendants(store.db, run.id);

        if (isActive(run)) {
            throw conflict('A working sub-agent cannot be archived');
        }

        if (started.some(isActive)) {
            throw conflict('A sub-agent that started a working sub-agent cannot be archived');
        }

        const now = Date.now();
        const saved = setFlag(store, run, now);

        for (const child of started) {
            if (child.archivedAt === undefined) {
                setFlag(store, child, now);
            }
        }

        return saved;
    });
}
