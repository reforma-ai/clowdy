import type { Task, TaskId } from '@clowdy/protocol';

/** The tasks that were archived by one call: they share an `archivedAt`, which no other archive of the project has. */
export interface ArchiveBatch {
    archivedAt: number;
    /** In the order the daemon gave them. */
    tasks: Task[];
}

/**
 * Groups the archive's tasks into the batches they were archived in, the newest batch first, as the daemon pages them (latest archived first, a batch's tasks by number).
 * A batch is one group only when its tasks follow each other, which the daemon's order makes true: a batch cut by the end of what is loaded gets its other tasks with the next page.
 */
export function archiveBatches(tasks: readonly Task[]): ArchiveBatch[] {
    const batches = new Map<number, Task[]>();

    for (const task of tasks) {
        if (task.archivedAt === undefined) continue;

        const batch = batches.get(task.archivedAt);

        if (batch) batch.push(task);
        else batches.set(task.archivedAt, [task]);
    }

    return [...batches].map(([archivedAt, members]) => ({ archivedAt, tasks: members }));
}

/**
 * Whether Restore is offered on the top of a batch: always once the whole batch is loaded; while the end of the list cuts it (`isCut`: more pages follow and this is the oldest
 * batch loaded), only when what is above the task is known to be off the archive: it has no parent, or its parent is on the board. A task whose parent is not loaded may have it
 * in the part of the batch that is not here yet, and a restore of such a task is refused, so it waits for the page that shows its parent.
 */
export function offersRestore(top: Pick<Task, 'parentId'>, isCut: boolean, isOnBoard: (taskId: TaskId) => boolean): boolean {
    return !isCut || top.parentId === undefined || isOnBoard(top.parentId);
}
