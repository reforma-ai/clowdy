import type { TaskId } from '@clowdy/protocol';
import type { ProjectState, ProjectUi, RootStore } from '../../stores';

/**
 * Makes the history entry the person is on say what the screen shows. The remembered scope can name a task that is gone or archived, which the screen shows as the
 * roots (`ProjectUi.resolveTasksScope`, read only, so the scope comes back with a task that is restored). Back and forward skip an entry whose scope is gone,
 * so before the person does anything that makes a new entry (opens a task, a chat or a document, goes into another scope) the entry they are on is overwritten with the
 * roots, and Back returns to the place they saw. Called by whatever acts, at the start; nothing happens while the remembered scope is on the board.
 */
export function settleScope(root: RootStore, project: ProjectState, ui: ProjectUi): void {
    const scope = ui.resolveTasksScope(project.tasks);

    if (ui.tasksScope !== scope) root.history.replacing(() => ui.setTasksScope(scope));
}

/** Shows the insides of a task on the Tasks screen, or the project's roots with `null`: a new place in the history. */
export function openScope(root: RootStore, project: ProjectState, ui: ProjectUi, scope: TaskId | null): void {
    settleScope(root, project, ui);
    ui.setTasksScope(scope);
}

/** What `settledUi` gives: `openTask` takes no options, since `reveal` is its own. */
export interface SettledUi extends Pick<ProjectUi, 'taskId' | 'openDoc'> {
    openTask: (taskId: TaskId | null) => void;
}

/**
 * The window state the Tasks screen and its detail panel navigate with (open a task, open a document), each settling the scope first, so no place they add to the
 * history carries a scope that is gone. `reveal` is whether opening a task also puts the screen where the task shows (`ProjectUi.openTask`): the screen turns it off for
 * the tasks it draws itself, and the panel keeps it for the tasks its links name, which may be anywhere.
 */
export function settledUi(root: RootStore, project: ProjectState, ui: ProjectUi, { reveal }: { reveal: boolean }): SettledUi {
    return {
        get taskId() {
            return ui.taskId;
        },
        openTask: (taskId) => {
            settleScope(root, project, ui);
            ui.openTask(taskId, { reveal });
        },
        openDoc: (path, folderId) => {
            settleScope(root, project, ui);
            ui.openDoc(path, folderId);
        },
    };
}
