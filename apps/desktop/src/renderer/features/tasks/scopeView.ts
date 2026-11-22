import { checklistOf, type Checklist, type Keep, type Rollup, type TaskTree, type TreeRow } from './taskTree';
import { boardColumns, taskGrid } from './taskView';

import type { Task, TaskId, TaskStatus } from '@clowdy/protocol';
import type { TasksView } from '../../stores';

/**
 * How the Tasks screen draws a scope: `board` is one level (the tasks directly inside the scope, in columns), `through` is the board with the sub-tasks shown
 * (every task below the scope, at any depth, flattened onto it), and `tree` is the list (the tasks below the scope indented under their parents).
 */
export type TasksMode = 'board' | 'through' | 'tree';

/** The mode a view and the sub-tasks toggle make. The list is always a tree, so the toggle means nothing there. */
export function tasksMode(view: TasksView, showSubtasks: boolean): TasksMode {
    if (view === 'list') return 'tree';

    return showSubtasks ? 'through' : 'board';
}

export interface ScopeContent {
    mode: TasksMode;
    /** How many tasks the mode could draw for the scope before the filter takes any out: nothing here means the scope is empty, and not that a filter hides it. */
    total: number;
    /** The tasks drawn, in the order they are drawn: a board's tasks by status, the tree's rows top to bottom. */
    tasks: Task[];
    /** The board's columns, a column per status in workflow order. Empty for the tree. */
    columns: { status: TaskStatus; tasks: Task[] }[];
    /** The tree's rows, folded ones left out. Empty for a board. */
    rows: TreeRow[];
    /** What the cursor walks: the columns of a board, or the one column of the tree's rows. */
    grid: TaskId[][];
}

/**
 * What the screen draws for a scope in a mode, with the filter's `keep` and the folded tasks of the tree. A match is never hidden: the filter keeps the tasks it
 * matches whatever their parents are, so a task whose parent it drops stands under the nearest parent it keeps (or at the top of the view).
 */
export function scopeContent(tree: TaskTree, statuses: readonly TaskStatus[], scope: TaskId | null, mode: TasksMode, { collapsed, keep }: { collapsed?: Iterable<TaskId>; keep?: Keep } = {}): ScopeContent {
    if (mode === 'tree') {
        const rows = tree.rows(scope, collapsed, keep);
        const tasks = rows.map(row => row.task);

        return { mode, total: tree.descendantsOf(scope).length, tasks, columns: [], rows, grid: taskGrid('list', tasks, statuses) };
    }

    const tasks = mode === 'board' ? tree.levelOf(scope, keep) : tree.descendantsOf(scope, keep);

    return {
        mode,
        total: mode === 'board' ? tree.childrenOf(scope).length : tree.descendantsOf(scope).length,
        tasks,
        columns: boardColumns(statuses, tasks),
        rows: [],
        grid: taskGrid('board', tasks, statuses),
    };
}

/** What a card or a row says about a task besides its name: how far the work inside it has come, its checklist, and where it lives when that is not the scope. */
export interface TaskNotes {
    rollUp?: Rollup;
    checklist?: Checklist;
    /** The key of the task it is inside, for a board that draws it away from its parent. */
    parentKey?: string;
}

/**
 * The notes of a task. A roll-up and a checklist describe the task and not the view, so the filter does not change them.
 * `withParent` is for a board: its cards sit in columns by status, away from the task they are inside, so a card names it unless it is the scope itself,
 * which the screen's own header already shows. The tree shows the parent by indenting under it.
 */
export function taskNotes(tree: TaskTree, task: Task, { scope, withParent }: { scope: TaskId | null; withParent: boolean }): TaskNotes {
    const parent = withParent ? tree.parentOf(task) : undefined;

    return {
        rollUp: tree.rollUp(task),
        checklist: checklistOf(task),
        parentKey: parent && parent.id !== scope ? parent.key : undefined,
    };
}
