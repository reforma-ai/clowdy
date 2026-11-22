import { useEffect, useRef, useState } from 'react';

import { useProjectState, useRootStore } from '../../stores';
import { FETCH_DELAY_MS } from './useTaskArtifacts';

import type { TaskComment, TaskId } from '@clowdy/protocol';
import type { Transport } from '../../daemon/transport';

/** The size of the pages the comments are read in: the most the daemon gives at once. */
export const COMMENTS_PAGE_SIZE = 100;

/** The most comments the panel loads. A task with more shows the first of them and says so; the rest stay in the daemon. */
export const MAX_COMMENTS = 1000;

export type TaskComments =
    | { status: 'loading' }
    | { status: 'ready'; comments: TaskComment[]; /** How many the task has, whatever is loaded. */ total: number; /** The task has more than `MAX_COMMENTS`, and the rest are not loaded. */ isCut: boolean }
    | { status: 'failed'; message: string };

const LOADING: TaskComments = { status: 'loading' };

/** All the pages of the task's comments, oldest first, up to `MAX_COMMENTS`; the pages are read one after the other, and `isCurrent` ends the reading when what it is for has changed. */
async function readComments(
    read: (cursor: string | undefined) => ReturnType<Transport['getTaskComments']>,
    isCurrent: () => boolean
): Promise<Extract<TaskComments, { status: 'ready' }> | null> {
    const comments: TaskComment[] = [];
    let total = 0;
    let cursor: string | undefined;

    do {
        const page = await read(cursor);

        if (!isCurrent()) return null;

        comments.push(...page.comments);
        total = page.total;
        cursor = page.nextCursor;
    } while (cursor !== undefined && comments.length < MAX_COMMENTS);

    return { status: 'ready', comments: comments.slice(0, MAX_COMMENTS), total, isCut: cursor !== undefined };
}

/**
 * The comments of the task, oldest first, read from the daemon when the task is shown and again whenever `ProjectState.commentsRevision` of the task changes
 * (a comment added, edited or deleted by anyone, the task deleted, a snapshot taken in again). Comments are paged: every page is read, `COMMENTS_PAGE_SIZE` at a time,
 * up to `MAX_COMMENTS`. The first read waits a moment, as the artifacts do, so that a task the person is passing by with a held key is not read; a read for
 * a change of the comments does not wait, and the old comments stay on show until the new ones are there. An answer for a task that is no longer the one shown is dropped.
 */
export function useTaskComments(taskId: TaskId): { state: TaskComments; retry: () => void } {
    const { transport } = useRootStore();
    const project = useProjectState();
    const revision = project.commentsRevision(taskId);
    const [result, setResult] = useState<{ taskId: TaskId; state: TaskComments }>();
    const [attempt, setAttempt] = useState(0);
    // The task whose comments are on show: a read for another change of its comments is not worth a pause.
    const shown = useRef<TaskId>(undefined);

    useEffect(() => {
        let isCurrent = true;
        const timer = setTimeout(() => {
            readComments(cursor => transport.getTaskComments(taskId, { limit: COMMENTS_PAGE_SIZE, cursor }), () => isCurrent).then(
                (state) => {
                    if (!state) return;

                    shown.current = taskId;
                    setResult({ taskId, state });
                },
                (error) => {
                    if (isCurrent) setResult({ taskId, state: { status: 'failed', message: error instanceof Error ? error.message : String(error) } });
                }
            );
        }, shown.current === taskId ? 0 : FETCH_DELAY_MS);

        return () => {
            isCurrent = false;
            clearTimeout(timer);
        };
    }, [transport, taskId, revision, attempt]);

    return {
        // What was read for another task is not this task's.
        state: result?.taskId === taskId ? result.state : LOADING,
        retry: () => {
            shown.current = undefined;
            setResult(undefined);
            setAttempt(count => count + 1);
        },
    };
}
