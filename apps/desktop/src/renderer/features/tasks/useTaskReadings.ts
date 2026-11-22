import { useEffect, useRef, useState } from 'react';

import { useProjectState } from '../../stores';

import type { Task, TaskId } from '@clowdy/protocol';

/** A task asked for by id: the board's, an archived one the window knows or has read, or why there is none. */
export type TaskReading =
    | { status: 'ready'; task: Task }
    | { status: 'loading' }
    /** The daemon has no such task, or it is not archived and the board does not hold it (yet: the event of a task just made can come after the reply). */
    | { status: 'missing' }
    | { status: 'failed'; message: string };

/** What a read came to for a task the board does not hold, kept until the person retries. `read` means the project has remembered it (and asks again if it lets it go). */
type Outcome = 'read' | 'missing' | { failed: string };

/**
 * The tasks with these ids, as `ProjectState.taskById` knows them (on the board, or archived and remembered) and, for an id it does not know, as the daemon says
 * (`ProjectState.readTask`, which asks once for a task however many ask and remembers an archived one). The board answers first and follows its events, so a task
 * that is restored or archived meanwhile changes with them. `retry` asks again for the ids whose read failed.
 */
export function useTaskReadings(ids: readonly TaskId[]): { readings: ReadonlyMap<TaskId, TaskReading>; retry: () => void } {
    const project = useProjectState();
    const [outcomes, setOutcomes] = useState<ReadonlyMap<TaskId, Outcome>>(() => new Map());
    const [attempt, setAttempt] = useState(0);
    // The reads asked for in this window of the project, so a render that comes while one is on its way asks for nothing again.
    const asked = useRef(new Set<TaskId>());
    const unknown = ids.filter(id => project.taskById(id) === undefined);
    const wanted = unknown.join('\n');

    useEffect(() => {
        for (const id of wanted === '' ? [] : wanted.split('\n')) {
            if (asked.current.has(id)) continue;

            asked.current.add(id);
            project.readTask(id).then(
                (task) => {
                    // The project remembers an archived task it read, within its limit: when it lets the task go the id is asked again, so a panel that is open for it stays.
                    if (task?.archivedAt !== undefined) asked.current.delete(id);

                    setOutcomes(current => new Map(current).set(id, task?.archivedAt === undefined ? 'missing' : 'read'));
                },
                error => setOutcomes(current => new Map(current).set(id, { failed: error instanceof Error ? error.message : String(error) }))
            );
        }
    }, [project, wanted, attempt]);

    const readings = new Map<TaskId, TaskReading>();

    for (const id of ids) {
        const task = project.taskById(id);
        const outcome = outcomes.get(id);

        if (task) readings.set(id, { status: 'ready', task });
        else if (typeof outcome === 'object') readings.set(id, { status: 'failed', message: outcome.failed });
        // Read and not known any more: the project let it go, and the effect asks again; the answer is the task, or that it is gone.
        else if (outcome !== undefined && outcome !== 'read') readings.set(id, { status: 'missing' });
        else readings.set(id, { status: 'loading' });
    }

    const retry = () => {
        const failed = [...outcomes].filter(([, outcome]) => typeof outcome === 'object').map(([id]) => id);

        failed.forEach(id => asked.current.delete(id));
        setOutcomes(current => new Map([...current].filter(([id]) => !failed.includes(id))));
        setAttempt(count => count + 1);
    };

    return { readings, retry };
}

/** The task with this id, as `useTaskReadings` says it: `null` for no task, which is `missing`. */
export function useTaskById(taskId: TaskId | null): { reading: TaskReading; retry: () => void } {
    const { readings, retry } = useTaskReadings(taskId === null ? [] : [taskId]);

    return { reading: (taskId === null ? undefined : readings.get(taskId)) ?? { status: 'missing' }, retry };
}
