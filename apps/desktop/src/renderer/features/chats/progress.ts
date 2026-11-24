import type { Task, TaskStatus } from '@clowdy/protocol';

const STATUS_LABELS = [
    ['backlog', 'in backlog'],
    ['todo', 'to do'],
    ['active', 'in progress'],
    ['review', 'in review'],
    ['unknown', 'with unknown status'],
    ['done', 'done'],
] as const;

type CountedStatus = (typeof STATUS_LABELS)[number][0];

export interface ChatProgress {
    summary: string;
    /** The tasks that count, in task order. */
    tasks: Task[];
}

/** Summarize the chat's tasks by status category, excluding canceled tasks. */
export function chatProgress(tasks: Task[], statuses: TaskStatus[]): ChatProgress | undefined {
    const categoryOf = new Map(statuses.map(status => [status.id, status.category]));
    const counted: Task[] = [];
    const counts = new Map<CountedStatus, number>();

    for (const task of tasks) {
        const category = categoryOf.get(task.statusId) ?? 'unknown';

        if (category === 'canceled') continue;

        counted.push(task);
        counts.set(category, (counts.get(category) ?? 0) + 1);
    }

    if (counted.length === 0) return undefined;

    const summary = STATUS_LABELS.flatMap(([status, label]) => {
        const count = counts.get(status);
        return count ? [`${count} ${label}`] : [];
    }).join(', ');

    return { summary, tasks: counted };
}
