import { parseChecklist, type Checklist } from '@clowdy/lib/checklist';
import { MAX_TASK_DEPTH } from '@clowdy/protocol';

import type { Task, TaskId, TaskStatus, TaskStatusCategory } from '@clowdy/protocol';

/*
 * The tasks of a project as a tree, for the views of the Tasks screen. Every function is pure and works on the tasks it is given: the store's tasks are the
 * ones on the board, so an archived task is in none of these, and a task whose parent the set does not hold stands as a root rather than vanishing.
 * A scope is the task whose insides a view shows, or `null` for the project's roots.
 *
 * The filter of the screen (`filterTasks`) is a predicate here, `Keep`, which every function that lists tasks takes: `keepAmong(filterTasks(...))` makes one
 * from the filter's result. A roll-up and a checklist describe a task, not the view, so a filter does not change them.
 */

export type { Checklist };

/** Whether a task is wanted: what the screen's filter lets through. */
export type Keep = (task: Task) => boolean;

/** The predicate that keeps exactly the tasks of `tasks`, for composing the filter with the tree: `keepAmong(filterTasks(all, filter, runs))`. */
export function keepAmong(tasks: readonly Task[]): Keep {
    const ids = new Set(tasks.map(task => task.id));

    return task => ids.has(task.id);
}

/** One line of the tree list. */
export interface TreeRow {
    task: Task;
    /** 0 for a task directly inside the scope, 1 for one inside that, and so on: the indent of the row. */
    depth: number;
    /** The row has tasks below it in this list (after the filter), so it can be folded. */
    hasChildren: boolean;
    /** Its tasks are folded away: the rows after it are not its own. Only a row with children is collapsed. */
    collapsed: boolean;
}

/** How far the work inside a task has come: the tasks done out of the tasks that count. */
export interface Rollup {
    done: number;
    total: number;
}

/** What `checklistOf` reads: the description of a task. */
export const checklistOf = (task: Pick<Task, 'description'>): Checklist | undefined => parseChecklist(task.description);

/** The parent and child links of a set of tasks, read once and walked in memory. Every walk keeps a set of what it has seen, so a cycle in the data (the daemon never makes one) ends the walk. */
export class TaskTree {
    readonly #byId: Map<TaskId, Task>;
    readonly #children = new Map<TaskId, Task[]>();
    readonly #roots: Task[] = [];
    readonly #categories: Map<string, TaskStatusCategory>;
    readonly #compare: (a: Task, b: Task) => number;

    constructor(tasks: readonly Task[], statuses: readonly TaskStatus[]) {
        const rank = new Map(statuses.map((status, index) => [status.id, index]));

        // A task whose status the workflow no longer has comes after every status.
        this.#compare = (a, b) => (rank.get(a.statusId) ?? rank.size) - (rank.get(b.statusId) ?? rank.size) || a.number - b.number;
        this.#categories = new Map(statuses.map(status => [status.id, status.category]));
        this.#byId = new Map(tasks.map(task => [task.id, task]));

        for (const task of [...tasks].sort(this.#compare)) {
            const parent = this.parentOf(task);

            if (!parent) {
                this.#roots.push(task);
                continue;
            }

            const siblings = this.#children.get(parent.id);

            if (siblings) siblings.push(task);
            else this.#children.set(parent.id, [task]);
        }
    }

    get(taskId: TaskId): Task | undefined {
        return this.#byId.get(taskId);
    }

    /** The task `task` is inside, when the set holds it. */
    parentOf(task: Pick<Task, 'id' | 'parentId'>): Task | undefined {
        return task.parentId === undefined || task.parentId === task.id ? undefined : this.#byId.get(task.parentId);
    }

    /** The tasks directly inside the scope, in workflow status order and then number: what a board of one level shows. */
    childrenOf(scope: TaskId | null, keep?: Keep): Task[] {
        const children = scope === null ? this.#roots : this.#children.get(scope) ?? [];

        return keep ? children.filter(keep) : [...children];
    }

    /** Every task below the scope at any depth, in workflow status order and then number: what a board that shows the sub-tasks flattens onto itself. */
    descendantsOf(scope: TaskId | null, keep?: Keep): Task[] {
        const found: Task[] = [];
        const seen = new Set<TaskId>(scope === null ? [] : [scope]);

        for (let index = -1; index < found.length; index++) {
            for (const child of this.childrenOf(index < 0 ? scope : found[index].id)) {
                if (seen.has(child.id)) continue;

                seen.add(child.id);
                found.push(child);
            }
        }

        return (keep ? found.filter(keep) : found).sort(this.#compare);
    }

    /**
     * The rows of the tree list under the scope, in the order they are drawn: a task, then everything inside it, before the next of its siblings, siblings
     * in workflow status order and then number. The ids in `collapsed` hide what is inside them. With a filter, a task it keeps whose parent it hides moves up
     * to the nearest parent it keeps (or to the top), so the list never hides a match nor shows what the filter dropped.
     */
    rows(scope: TaskId | null, collapsed: Iterable<TaskId> = [], keep?: Keep): TreeRow[] {
        const folded = new Set(collapsed);
        const rows: TreeRow[] = [];
        const seen = new Set<TaskId>(scope === null ? [] : [scope]);
        const walk = (parent: TaskId | null, depth: number) => {
            for (const task of this.#shown(parent, keep)) {
                if (seen.has(task.id)) continue;

                seen.add(task.id);

                const inside = this.#shown(task.id, keep);
                const isCollapsed = inside.length > 0 && folded.has(task.id);

                rows.push({ task, depth, hasChildren: inside.length > 0, collapsed: isCollapsed });

                if (!isCollapsed) walk(task.id, depth + 1);
            }
        };

        walk(scope, 0);

        return rows;
    }

    /** The tasks a list shows directly under `parent` once the filter has taken out what it drops: the kept children, and the kept tasks below a child that is dropped. */
    #shown(parent: TaskId | null, keep: Keep | undefined, guard = new Set<TaskId>()): Task[] {
        const direct = this.childrenOf(parent);

        if (!keep) return direct;

        if (parent !== null) guard.add(parent);

        return direct.flatMap(child => (keep(child) ? [child] : guard.has(child.id) ? [] : this.#shown(child.id, keep, guard))).sort(this.#compare);
    }

    /** The tasks above `task`, the root first and the parent last: the breadcrumbs. Not the task itself. */
    ancestorsOf(task: Pick<Task, 'id' | 'parentId'>): Task[] {
        const chain: Task[] = [];
        const seen = new Set([task.id]);

        for (let parent = this.parentOf(task); parent && !seen.has(parent.id); parent = this.parentOf(parent)) {
            seen.add(parent.id);
            chain.push(parent);
        }

        return chain.reverse();
    }

    /** The level of the task: a root is 1, as `MAX_TASK_DEPTH` counts. */
    depthOf(task: Pick<Task, 'id' | 'parentId'>): number {
        return this.ancestorsOf(task).length + 1;
    }

    /** How many levels lie below the task: 0 for one with nothing inside it. */
    heightOf(taskId: TaskId): number {
        let height = 0;
        const seen = new Set([taskId]);
        let level = this.childrenOf(taskId);

        while (level.length > 0) {
            height++;
            level = level.filter(child => !seen.has(child.id)).flatMap((child) => {
                seen.add(child.id);

                return this.childrenOf(child.id);
            });
        }

        return height;
    }

    /** Whether the task can hold tasks at all: the daemon refuses a level past `MAX_TASK_DEPTH`. */
    canHaveChildren(task: Pick<Task, 'id' | 'parentId'>): boolean {
        return this.depthOf(task) < MAX_TASK_DEPTH;
    }

    /**
     * The work inside the task over everything below it, at any depth: a task in the Done category is done, and a canceled one is not part of the work
     * (it is in neither number), as the progress of a chat counts. Nothing when nothing counts: a task with no tasks inside it, or only canceled ones.
     */
    rollUp(task: Pick<Task, 'id'>): Rollup | undefined {
        const counted = this.descendantsOf(task.id).filter(below => this.#categories.get(below.statusId) !== 'canceled');

        if (counted.length === 0) return undefined;

        return { done: counted.filter(below => this.#categories.get(below.statusId) === 'done').length, total: counted.length };
    }
}

/**
 * The tasks `task` may be moved under, in the order given: not itself, not a task inside it (that would close a loop), not an archived task, and none that
 * would put the task, with everything inside it, past `MAX_TASK_DEPTH` levels. The task's present parent is among them, so a picker can show it chosen.
 * Without a task (one that is not made yet) only the depth of the candidate counts. The archived tasks inside the task are not in the set, so a move the
 * daemon would refuse for its archived levels can still be offered: the daemon's refusal says why.
 */
export function parentCandidates(tasks: readonly Task[], task?: Pick<Task, 'id'>): Task[] {
    const tree = new TaskTree(tasks, []);
    const inside = task ? new Set(tree.descendantsOf(task.id).map(({ id }) => id)) : new Set<TaskId>();
    const height = task ? tree.heightOf(task.id) : 0;

    return tasks.filter(candidate => candidate.id !== task?.id && candidate.archivedAt === undefined && !inside.has(candidate.id) && tree.depthOf(candidate) + 1 + height <= MAX_TASK_DEPTH);
}
