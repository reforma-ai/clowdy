import type { TaskId } from '@clowdy/protocol';
import type { TreeRow } from './taskTree';

/** What Left or Right does on a row of the tree list: fold or open its insides, or move the cursor to another row. */
export type TreeMove =
    | { kind: 'fold'; taskId: TaskId }
    | { kind: 'unfold'; taskId: TaskId }
    | { kind: 'move'; taskId: TaskId };

/**
 * The tree pattern of the arrow keys over the rows the list draws (folded rows are not in them):
 * Right opens a folded row, and on an open one goes to its first task; Left folds an open row, and on a folded row or one with nothing inside goes to its parent row.
 * `undefined` where the key has nothing to do (Right on a row with nothing inside, Left on a row at the top), so the page keeps it.
 */
export function treeMove(rows: readonly TreeRow[], taskId: TaskId | null, key: 'left' | 'right'): TreeMove | undefined {
    const index = rows.findIndex(row => row.task.id === taskId);

    if (index < 0) return undefined;

    const row = rows[index];

    if (key === 'right') {
        if (!row.hasChildren) return undefined;

        if (row.collapsed) return { kind: 'unfold', taskId: row.task.id };

        // An open row is followed by the rows inside it, so the next one, a level deeper, is its first.
        const first = rows[index + 1];

        return first && first.depth > row.depth ? { kind: 'move', taskId: first.task.id } : undefined;
    }

    if (row.hasChildren && !row.collapsed) return { kind: 'fold', taskId: row.task.id };

    const parent = rows.slice(0, index).findLast(candidate => candidate.depth < row.depth);

    return parent ? { kind: 'move', taskId: parent.task.id } : undefined;
}
