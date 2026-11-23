import { useEffect, useRef, useState } from 'react';

import { useProjectState, useRootStore } from '../../stores';
import { FETCH_DELAY_MS } from './useTaskArtifacts';

import type { TaskComment, TaskId } from '@clowdy/protocol';
import type { Transport } from '../../daemon/transport';

/** The size of the pages the comments are read in: the most the daemon gives at once. */
export const COMMENTS_PAGE_SIZE = 100;

/** The most comments the panel loads. A task with more shows the first of them and says so; the rest stay in the daemon. */
export const MAX_COMMENTS = 1000;

/** How long a change of the comments waits for the next one before they are read again: a burst of events (one per comment) makes one read. */
export const REFRESH_DELAY_MS = 150;

export type TaskComments =
    | { status: 'loading' }
    | {
          status: 'ready';
          comments: TaskComment[];
          /** How many the task has, whatever is loaded. */
          total: number;
          /** The task has more than `MAX_COMMENTS`, and the rest are not loaded. */
          isCut: boolean;
          /** Why the last read for a change of the comments failed. These are the comments as they were before it, and may be out of date. */
          refreshError?: string;
      }
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
 * a change of the comments waits `REFRESH_DELAY_MS` after the last change, so a burst of events (one per comment) is one read. The old comments stay on show until
 * the new ones are there, and after a read that fails (`refreshError` says so). An answer for a task that is no longer the one shown is dropped.
 */
export function useTaskComments(taskId: TaskId): { state: TaskComments; retry: () => void } {
    const { transport } = useRootStore();
    const project = useProjectState();
    const revision = project.commentsRevision(taskId);
    const [result, setResult] = useState<{ taskId: TaskId; state: TaskComments }>();
    const [attempt, setAttempt] = useState(0);
    // The task whose comments are on show: a read for another change of its comments waits less than the first read.
    const shown = useRef<TaskId>(undefined);

    useEffect(() => {
        let isCurrent = true;
        const timer = setTimeout(
            () => {
                readComments(
                    cursor => transport.getTaskComments(taskId, { limit: COMMENTS_PAGE_SIZE, cursor }),
                    () => isCurrent
                ).then(
                    state => {
                        if (!state) return;

                        shown.current = taskId;
                        setResult({ taskId, state });
                    },
                    error => {
                        if (!isCurrent) return;

                        const message = error instanceof Error ? error.message : String(error);

                        // Comments that are on show stay, with the failure beside them: only a first read that fails takes their place.
                        setResult(current =>
                            current?.taskId === taskId && current.state.status === 'ready'
                                ? { taskId, state: { ...current.state, refreshError: message } }
                                : { taskId, state: { status: 'failed', message } }
                        );
                    }
                );
            },
            shown.current === taskId ? REFRESH_DELAY_MS : FETCH_DELAY_MS
        );

        return () => {
            isCurrent = false;
            clearTimeout(timer);
        };
    }, [transport, taskId, revision, attempt]);

    return {
        // What was read for another task is not this task's.
        state: result?.taskId === taskId ? result.state : LOADING,
        retry: () => {
            if (result?.taskId === taskId && result.state.status === 'ready') {
                // The comments on show stay, without the failure of the read that is tried again.
                setResult({ taskId, state: { ...result.state, refreshError: undefined } });
            } else {
                shown.current = undefined;
                setResult(undefined);
            }

            setAttempt(count => count + 1);
        },
    };
}
