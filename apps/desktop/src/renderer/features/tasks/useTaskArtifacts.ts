import { useEffect, useState } from 'react';

import { useProjectState, useRootStore } from '../../stores';

import type { Artifact, TaskId } from '@clowdy/protocol';

export type TaskArtifacts =
    | { status: 'loading' }
    | { status: 'ready'; artifacts: Artifact[] }
    | { status: 'failed'; message: string };

/** The task's artifacts from the daemon, fetched again whenever an artifact is added. A refetch keeps showing the old ones. */
export function useTaskArtifacts(taskId: TaskId): { state: TaskArtifacts; retry: () => void } {
    const { transport } = useRootStore();
    const { artifactsRevision } = useProjectState();
    const [state, setState] = useState<TaskArtifacts>({ status: 'loading' });
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let isCurrent = true;

        transport.getTaskDetail(taskId).then(
            detail => isCurrent && setState({ status: 'ready', artifacts: detail.artifacts }),
            error => isCurrent && setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
        );

        return () => {
            isCurrent = false;
        };
    }, [transport, taskId, artifactsRevision, attempt]);

    return {
        state,
        retry: () => {
            setState({ status: 'loading' });
            setAttempt(count => count + 1);
        },
    };
}
