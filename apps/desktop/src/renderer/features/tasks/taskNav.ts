import { openDocument } from '../files/openDocument';

import type { FolderId, TaskId } from '@clowdy/protocol';
import type { ProjectState, ProjectUi, RootStore } from '../../stores';

/** What `taskNav` gives: `openTask` takes no options, since `reveal` is its own. */
export interface TaskNav extends Pick<ProjectUi, 'taskId'> {
    openTask: (taskId: TaskId | null) => void;
    /** Opens a document of the project on the Docs tab (a path under the docs folder of `folderId`, the main folder's by default). */
    openDoc: (path: string, folderId?: FolderId | null) => void;
}

/**
 * The window state the Tasks screen and its detail panel navigate with (open a task, open a document). `reveal` is whether opening a task also puts the screen where
 * the task shows (`ProjectUi.openTask`): the screen turns it off for the tasks it draws itself, and the panel keeps it for the tasks its links name, which may be anywhere.
 */
export function taskNav(root: RootStore, project: ProjectState, ui: ProjectUi, { reveal }: { reveal: boolean }): TaskNav {
    return {
        get taskId() {
            return ui.taskId;
        },
        openTask: taskId => ui.openTask(taskId, { reveal }),
        openDoc: (path, folderId = null) => void openDocument(root, project, path, folderId),
    };
}
