import { TaskTree } from '../tasks/taskTree';

import type { Task, TaskStatus } from '@clowdy/protocol';
import type { TreeRow } from '../tasks/taskTree';

const STATUS_LABELS = [
    ['todo', 'to do'],
    ['active', 'in progress'],
    ['review', 'in review'],
    ['backlog', 'in backlog'],
    ['unknown', 'with unknown status'],
    ['done', 'done'],
] as const;

type CountedStatus = (typeof STATUS_LABELS)[number][0];
const STATUS_ORDER = new Map<string, number>(STATUS_LABELS.map(([status], index) => [status, index]));

export interface ChatProgress {
    summary: string;
    /** The tasks that count, in tree order with siblings grouped by status. */
    rows: TreeRow[];
}

/** Summarize the chat's tasks by status category, excluding canceled tasks. */
export function chatProgress(tasks: Task[], statuses: TaskStatus[]): ChatProgress | undefined {
    const categories = new Map(statuses.map(status => [status.id, status.category]));
    const categoryOf = (task: Task) => categories.get(task.statusId) ?? 'unknown';
    const counts = new Map<CountedStatus, number>();

    for (const task of tasks) {
        const category = categoryOf(task);

        if (category === 'canceled') continue;

        counts.set(category, (counts.get(category) ?? 0) + 1);
    }

    if (counts.size === 0) return undefined;

    const summary = STATUS_LABELS.flatMap(([status, label]) => {
        const count = counts.get(status);

        return count ? [`${count} ${label}`] : [];
    }).join(', ');
    const rank = (task: Task) => STATUS_ORDER.get(categoryOf(task)) ?? STATUS_ORDER.size;
    const tree = new TaskTree(tasks, statuses, (a, b) => rank(a) - rank(b) || a.number - b.number);

    return { summary, rows: tree.rows(null, [], task => categoryOf(task) !== 'canceled') };
}
