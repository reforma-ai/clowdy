import type { Task } from '@clowdy/protocol';

/**
 * Whether `task` is on the same side of the archive as `like`: both on the board, or both in the archive. A roll-up counts the tasks on its own side, so a
 * task on the board counts the tasks of the board inside it, and an archived one the archived tasks inside it.
 */
export const sameArchiveSide = (task: Task, like: Task) =>
    (task.archivedAt === undefined) === (like.archivedAt === undefined);

/**
 * The parent and child links of a project's tasks, read once and walked in memory. Every walk keeps a set of what it has seen, so a cycle in the data
 * (the domain refuses to make one, but the store would hold it) ends the walk instead of looping.
 */
export class TaskTree {
    private readonly byId: Map<string, Task>;
    private readonly children = new Map<string, Task[]>();

    constructor(tasks: readonly Task[]) {
        this.byId = new Map(tasks.map(task => [task.id, task]));

        for (const task of tasks.toSorted((left, right) => left.number - right.number)) {
            const { parentId } = task;

            if (parentId === undefined) {
                continue;
            }

            const siblings = this.children.get(parentId);

            if (siblings) {
                siblings.push(task);
            } else {
                this.children.set(parentId, [task]);
            }
        }
    }

    parentOf(task: Task): Task | undefined {
        return task.parentId === undefined ? undefined : this.byId.get(task.parentId);
    }

    /** The tasks directly inside `taskId`, in number order. */
    childrenOf(taskId: string): readonly Task[] {
        return this.children.get(taskId) ?? [];
    }

    /** The tasks above `taskId`, the parent first and the root last. */
    ancestorsOf(taskId: string): Task[] {
        const found: Task[] = [];
        const seen = new Set([taskId]);
        let current = this.byId.get(taskId);

        while (current) {
            const parent = this.parentOf(current);

            if (!parent || seen.has(parent.id)) {
                break;
            }

            seen.add(parent.id);
            found.push(parent);
            current = parent;
        }

        return found;
    }

    /** Every task below `taskId`, level by level, each with its level under it (a child is 1). */
    descendantsOf(taskId: string): { task: Task; level: number }[] {
        const found: { task: Task; level: number }[] = [];
        const seen = new Set([taskId]);
        let level = [taskId];

        for (let depth = 1; level.length > 0; depth++) {
            level = level
                .flatMap(id => this.childrenOf(id))
                .filter(child => !seen.has(child.id))
                .map(child => {
                    seen.add(child.id);
                    found.push({ task: child, level: depth });

                    return child.id;
                });
        }

        return found;
    }

    /** The level of `taskId` in its tree: a root is 1. */
    depthOf(taskId: string): number {
        return this.ancestorsOf(taskId).length + 1;
    }

    /** How many levels lie below `taskId`: 0 for a task with no children. */
    heightOf(taskId: string): number {
        return this.descendantsOf(taskId).reduce((height, { level }) => Math.max(height, level), 0);
    }
}
