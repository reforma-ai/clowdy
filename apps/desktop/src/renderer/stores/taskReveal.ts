import type { Task, TaskId } from '@clowdy/protocol';

/** What the reveal reads of the tasks the project holds. */
export type RevealTasks = ReadonlyMap<TaskId, Pick<Task, 'id' | 'parentId' | 'archivedAt'>>;

/** Where the Tasks screen must be for a task to show: the scope, and the tasks above it that are folded in the tree list and have to be opened. */
export interface Reveal {
    scope: TaskId | null;
    unfold: TaskId[];
}

/**
 * The scope and the folds that make a task visible on the Tasks screen, for a task opened from anywhere (a chip in a chat, a mention, a dependency).
 * `scope` is the one on show (already resolved: a task that is gone counts as the roots) and `oneLevel` says that the screen draws only the tasks directly
 * inside it (a board with the sub-tasks hidden): the through board and the tree list draw every level.
 *
 * - A task inside the scope's subtree, and the scope task itself, keep the scope. The tasks between the scope and the task are returned in `unfold`,
 *   because the tree list hides what is inside a folded task. On a board of one level a task deeper than the first level is no card, so the scope moves to its parent.
 * - A task outside the subtree moves the scope to its parent, the roots when it has none, where it is a task of the first level in every view.
 *
 * A task the project does not hold (archived, deleted) changes nothing: `undefined`. A task whose parent is not held stands as a root, as the views draw it.
 * `madeIn` is for a task that was just made, which the project may not hold yet because the daemon's event can come after the reply to the command that made it:
 * the task they will find is inside `madeIn` (`null`: at the roots), and the reveal is the one that task will need once it arrives. A task the project holds is read as it is.
 */
export function revealTask(
    tasks: RevealTasks,
    scope: TaskId | null,
    taskId: TaskId,
    { oneLevel, madeIn }: { oneLevel: boolean; madeIn?: TaskId | null }
): Reveal | undefined {
    const task =
        tasks.get(taskId) ??
        (madeIn === undefined ? undefined : { id: taskId, parentId: madeIn ?? undefined, archivedAt: undefined });

    if (!task || task.archivedAt !== undefined) return undefined;

    // The tasks above it, the parent first. A cycle in the data (the daemon makes none) ends the walk.
    const above: TaskId[] = [];
    const seen = new Set<TaskId>([taskId]);

    for (
        let parentId = task.parentId;
        parentId !== undefined && tasks.has(parentId) && !seen.has(parentId);
        parentId = tasks.get(parentId)?.parentId
    ) {
        seen.add(parentId);
        above.push(parentId);
    }

    if (scope === taskId) return { scope, unfold: [] };

    // How many tasks lie between the scope and the task: the whole chain when the scope is the roots.
    const between = scope === null ? above.length : above.indexOf(scope);
    const parent = above[0] ?? null;

    if (between < 0 || (between > 0 && oneLevel)) return { scope: parent, unfold: [] };

    return { scope, unfold: above.slice(0, between) };
}
