import { useEffect, useState } from 'react';

import { useProjectState, useRootStore } from '../../stores';

import type { Artifact, TaskId } from '@clowdy/protocol';

export type TaskArtifacts =
    | { status: 'loading' }
    | { status: 'ready'; artifacts: Artifact[] }
    | { status: 'failed'; message: string };

/**
 * How long the task has to stay open before its artifacts are fetched. Holding `J` opens a task every 30 ms or so, and each one
 * would ask the daemon for a panel that is gone before the answer comes back.
 */
export const FETCH_DELAY_MS = 120;

/**
 * The task's artifacts from the daemon, fetched again whenever an artifact is added, after a short pause so that a task the person is only passing by is not fetched.
 * A refetch keeps showing the old ones.
 */
export function useTaskArtifacts(taskId: TaskId): { state: TaskArtifacts; retry: () => void } {
    const { transport } = useRootStore();
    const { artifactsRevision } = useProjectState();
    const [state, setState] = useState<TaskArtifacts>({ status: 'loading' });
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let isCurrent = true;

        const timer = setTimeout(() => {
            transport.getTaskDetail(taskId).then(
                detail => isCurrent && setState({ status: 'ready', artifacts: detail.artifacts }),
                error =>
                    isCurrent &&
                    setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
            );
        }, FETCH_DELAY_MS);

        return () => {
            isCurrent = false;
            clearTimeout(timer);
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
