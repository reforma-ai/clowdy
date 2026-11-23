import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { scopeContent, taskNotes, tasksMode } from './scopeView';
import { taskNav } from './taskNav';
import { keepAmong, TaskTree } from './taskTree';
import { filterTasks, isFiltering } from './taskView';

import type { Run, Task, TaskId } from '@clowdy/protocol';
import type { ListCursor } from '../../hotkeys/listCursor';
import type { TasksView } from '../../stores';
import type { TaskCommandDeps } from './taskCommands';
import type { TaskFilter } from './taskView';

export interface UseTasksScopeOptions {
    cursor: ListCursor;
    filter: TaskFilter;
    runsOfTask: ReadonlyMap<TaskId, readonly Run[]>;
}

/**
 * What the Tasks screen shows and how it moves: the scope (a task, or the project's roots), the view it is drawn in, the content of that view with the filter in it,
 * and the cursor's grid, which follows the content. The view is the project's own at the roots and the task page's inside a task, and the sub-tasks toggle is one for both.
 * While the archive is shown the scope is still the same (it comes back when the archive is left), but the cursor walks nothing.
 */
export function useTasksScope({ cursor, filter, runsOfTask }: UseTasksScopeOptions) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const tasks = project.taskList;
    const tree = useMemo(() => new TaskTree(tasks, project.statuses), [tasks, project.statuses]);
    const scopeId = ui.resolveTasksScope(project.tasks);
    const scope = scopeId === null ? undefined : project.tasks.get(scopeId);
    const view: TasksView = scopeId === null ? ui.tasksView : ui.taskPageView;
    const isArchive = ui.tasksArchive;
    const keep = isFiltering(filter) ? keepAmong(filterTasks(tasks, filter, runsOfTask)) : undefined;
    const content = scopeContent(tree, project.statuses, scopeId, tasksMode(view, ui.tasksSubtasks), {
        collapsed: ui.tasksCollapsed,
        keep,
    });
    // The task whose insides the person just went out of, so the way up puts the cursor on it, as a file manager selects the folder you came out of.
    const left = useRef<TaskId | null>(null);

    // The cursor walks what the view draws. It follows the open task when that changes from elsewhere (a dependency link, a chip in Chats).
    useLayoutEffect(() => {
        // The archive is drawn in place of the scope, and the keys that act on the cursor's tasks must not reach tasks that are not on show.
        cursor.setGrid(isArchive ? [] : content.grid, ui.taskId);

        // Only once the screen shows another scope: a render that comes before the change is not the one.
        if (left.current !== null && left.current !== scopeId) {
            if (cursor.has(left.current)) cursor.setCursor(left.current);

            left.current = null;
        }
    });

    // Folds of tasks that are gone (deleted, archived) are let go, so what is kept stays as small as the folds that matter.
    useEffect(() => ui.forgetCollapsedTasks(project.tasks), [ui, project, tasks]);

    const open = (taskId: TaskId | null) => {
        if (taskId !== scopeId) left.current = scopeId;

        ui.setTasksScope(taskId);
    };

    const setView = (next: TasksView) => (scopeId === null ? ui.setTasksView(next) : ui.setTaskPageView(next));
    const up = () => {
        if (scope) open(tree.parentOf(scope)?.id ?? null);
    };

    // What the Tasks commands ask of the scope: the view, the tree's folds, going into a task and up.
    const commandDeps: Pick<
        TaskCommandDeps,
        'view' | 'setView' | 'scope' | 'isArchive' | 'rows' | 'setFolded' | 'openScope' | 'goUp' | 'canHaveChildren'
    > = {
        view: () => view,
        setView,
        scope: () => scopeId,
        isArchive: () => ui.tasksArchive,
        rows: () => content.rows,
        setFolded: (taskId, folded) => {
            if (ui.tasksCollapsed.includes(taskId) !== folded) ui.toggleTaskCollapsed(taskId);
        },
        openScope: open,
        goUp: up,
        canHaveChildren: taskId => {
            const task = project.tasks.get(taskId);

            return task !== undefined && tree.canHaveChildren(task);
        },
    };

    return {
        /** The archive is shown in place of the scope. */
        isArchive,
        scope,
        /** The tasks above the scope, the root first. */
        ancestors: scope ? tree.ancestorsOf(scope) : [],
        tree,
        view,
        content,
        /** What a card or a row says besides its name. */
        notesOf: (task: Task) => taskNotes(tree, task, { scope: scopeId, withParent: content.mode !== 'tree' }),
        /** Shows the insides of a task, or the roots with `null`. */
        open,
        setView,
        commandDeps,
        /** The store as the screen's own clicks and keys navigate with it: the tasks they open are drawn already, so nothing moves to show them. */
        nav: taskNav(root, project, ui, { reveal: false }),
    };
}
