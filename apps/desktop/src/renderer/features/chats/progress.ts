import type { Task, TaskStatus } from '@clowdy/protocol';

const STATUS_LABELS = [
    ['todo', 'to do'],
    ['active', 'in progress'],
    ['review', 'in review'],
    ['backlog', 'in backlog'],
    ['unknown', 'with unknown status'],
    ['done', 'done'],
] as const;

type CountedStatus = (typeof STATUS_LABELS)[number][0];

export interface ChatProgress {
    summary: string;
    /** The tasks that count, grouped by category with their original order inside each group. */
    tasks: Task[];
}

/** Summarize the chat's tasks by status category, excluding canceled tasks. */
export function chatProgress(tasks: Task[], statuses: TaskStatus[]): ChatProgress | undefined {
    const categoryOf = new Map(statuses.map(status => [status.id, status.category]));
    const byCategory = new Map<CountedStatus, Task[]>();

    for (const task of tasks) {
        const category = categoryOf.get(task.statusId) ?? 'unknown';

        if (category === 'canceled') continue;

        const group = byCategory.get(category);

        if (group) group.push(task);
        else byCategory.set(category, [task]);
    }

    if (byCategory.size === 0) return undefined;

    const groups = STATUS_LABELS.flatMap(([status, label]) => {
        const items = byCategory.get(status);

        return items ? [{ items, label }] : [];
    });

    return {
        summary: groups.map(({ items, label }) => `${items.length} ${label}`).join(', '),
        tasks: groups.flatMap(({ items }) => items),
    };
}
