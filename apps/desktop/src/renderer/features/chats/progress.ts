import type { Task, TaskStatus } from '@clowdy/protocol';

export interface ChatProgress {
    done: number;
    total: number;
    /** The tasks that count, in task order. */
    tasks: Task[];
}

/**
 * How far the tasks a chat works on have come. A canceled task is not part of the work, so it counts in neither
 * `done` nor `total`. A chat without such tasks has no progress.
 */
export function chatProgress(tasks: Task[], statuses: TaskStatus[]): ChatProgress | undefined {
    const categoryOf = new Map(statuses.map(status => [status.id, status.category]));
    const counted = tasks.filter(task => categoryOf.get(task.statusId) !== 'canceled');

    if (counted.length === 0) return undefined;

    return { done: counted.filter(task => categoryOf.get(task.statusId) === 'done').length, total: counted.length, tasks: counted };
}
