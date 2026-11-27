import { toast } from '@clowdy/components/Toast';
import { useState } from 'react';

import { useRunLabel } from '../../shared/useRunLabel';
import { useRootStore } from '../../stores';

import type { Run } from '@clowdy/protocol';

/**
 * Stop for a run: the message box's, the read-only notice's, a sub-agent's box and a row of the work in progress. `isStopping` holds
 * while the daemon answers; a refusal names the run (`Could not stop Fix login: …`), since the row or box that sent it may be one of several.
 */
export function useStopRun(run: Run | undefined): { stop: () => void; isStopping: boolean } {
    const root = useRootStore();
    const label = useRunLabel();
    const [isStopping, setIsStopping] = useState(false);

    const stop = async () => {
        if (!run || isStopping) return;

        setIsStopping(true);

        try {
            const result = await root.command({ type: 'run.cancel', runId: run.id });

            if (!result.ok) toast.error({ message: `Could not stop ${label(run)}: ${result.error.message}` });
        } finally {
            setIsStopping(false);
        }
    };

    return { stop: () => void stop(), isStopping };
}
