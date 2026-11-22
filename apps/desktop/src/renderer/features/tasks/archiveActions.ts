import { toast } from '@clowdy/components/Toast';

import { undoStack, type UndoStack } from '../../hotkeys/undo';
import { archiveReply, archiveWording, cancelDialog, openWork } from './archiveRules';
import { sendEach } from './commands';
import { TaskTree } from './taskTree';
import { recordUndo, showUndone } from './taskUndo';

import type { OpenConfirmModalOptions } from '@clowdy/components/modals';
import type { CommandResult, Task, TaskId } from '@clowdy/protocol';
import type { CommandInput } from '../../daemon/transport';
import type { ProjectState, ProjectUi, RootStore } from '../../stores';

/** One archive to send: the task, and whether the daemon closes its open work first. */
interface ArchiveItem {
    taskId: TaskId;
    cancel: boolean;
}

/** An archive the daemon took, as far as an undo needs it: the task, and the tasks `cancel` closed with the status each had before. */
interface Archived {
    task: Task;
    canceled: { taskId: TaskId; statusId: string }[];
}

/**
 * Restores what the archives archived, the latest first, so a task archived on its own and then with its parent comes back under it. A task that `cancel` closed goes back
 * to the status it had, but only when this restore brought it back: a task that someone restored since keeps what it holds now. Resolves to whether anything was restored;
 * a refusal (a parent that is archived since) is the daemon's own toast.
 */
async function unarchive(root: RootStore, done: readonly Archived[], label: string): Promise<boolean> {
    let isWhole = true;
    let isRestored = false;

    for (const { task, canceled } of [...done].reverse()) {
        const [result] = await sendEach(root, [{ type: 'task.unarchive', taskId: task.id }]);

        if (!result?.ok) {
            isWhole = false;
            continue;
        }

        const { restored } = archiveReply(result.data);
        const reopen: CommandInput[] = canceled.filter(entry => restored.includes(entry.taskId)).map(entry => ({ type: 'task.update', taskId: entry.taskId, statusId: entry.statusId }));
        const reopened = await sendEach(root, reopen);

        isRestored ||= restored.length > 0;
        isWhole &&= reopened.every(reopening => reopening.ok);
    }

    if (isWhole && isRestored) showUndone(label);
    else if (isWhole) toast.error({ message: 'Already restored, so there is nothing to undo' });

    return isRestored;
}

/**
 * Sends one `task.archive` per item, one after the other, and records one undo entry for the ones the daemon took, with its toast. Undoing restores them
 * (`task.unarchive`) and, for work that `cancel` closed, puts each task back to the status it had: the statuses are read before anything is sent. An item the daemon
 * refuses (a run is active on the task or below it, work that is open without `cancel`) records nothing, and the daemon's reason is the toast; one that was archived already
 * changes nothing and records nothing. Resolves to the results in order, like `sendEach`.
 */
export async function archiveWithUndo(root: RootStore, project: ProjectState, items: readonly ArchiveItem[], stack: UndoStack = undoStack): Promise<CommandResult[]> {
    const tree = new TaskTree(project.taskList, project.statuses);
    const before = items.map(({ taskId, cancel }) => {
        const task = project.tasks.get(taskId);

        return { task, previous: task && cancel ? openWork(task, tree, project.statuses).map(open => ({ taskId: open.id, statusId: open.statusId })) : [] };
    });
    const results = await sendEach(root, items.map(({ taskId, cancel }): CommandInput => ({ type: 'task.archive', taskId, ...(cancel && { cancel }) })));
    const taken = items.flatMap((_, index): Archived[] => {
        const { task, previous } = before[index];
        const result = results[index];
        const reply = result?.ok ? archiveReply(result.data) : undefined;

        // A task that was archived already, or one the board did not hold, changes nothing that an undo could put back.
        if (!task || !reply || reply.archived.length === 0) return [];

        return [{ task, canceled: previous.filter(entry => reply.canceled.includes(entry.taskId)) }];
    });

    if (taken.length > 0) {
        const { done: label } = archiveWording(taken.map(({ task }) => task), taken.some(({ canceled }) => canceled.length > 0));

        recordUndo(stack, project.id, label, () => unarchive(root, taken, label));
    }

    return results;
}

/** The ids of the tasks the results archived: what the daemon says went into the archive, the tasks inside each included. */
const archivedIds = (results: readonly CommandResult[]): Set<TaskId> => new Set(results.flatMap(result => (result.ok ? archiveReply(result.data).archived : [])));

export interface ArchiveContext {
    root: RootStore;
    project: ProjectState;
    /** The window's state: a panel that shows a task the archive took is closed. */
    ui: Pick<ProjectUi, 'taskId' | 'openTask'>;
    /** Asks before work that is open is canceled; `onConfirm` runs when the person agrees, and the dialog stays until it settles. */
    confirm: (request: OpenConfirmModalOptions) => void;
    stack?: UndoStack;
}

/**
 * Archives the tasks, from a key, a menu, the panel's button or a drop: a closed task goes at once with everything inside it, one `task.archive` per task. A task with
 * open work (itself or a task inside it) is archived with `cancel`, after one question that says how many open tasks that cancels, counted from the board; the question
 * covers every task given, so a selection is asked once. The daemon's refusals are the toast `sendEach` shows. The panel of a task that went into the archive closes.
 */
export function archiveTasks({ root, project, ui, confirm, stack }: ArchiveContext, targets: readonly Task[]): void {
    const tree = new TaskTree(project.taskList, project.statuses);
    const plans = targets.map(task => ({ task, open: openWork(task, tree, project.statuses) }));
    const openIds = new Set(plans.flatMap(({ open }) => open.map(task => task.id)));

    const run = async () => {
        const results = await archiveWithUndo(root, project, plans.map(({ task, open }) => ({ taskId: task.id, cancel: open.length > 0 })), stack);

        if (ui.taskId !== null && archivedIds(results).has(ui.taskId)) ui.openTask(null);
    };

    if (plans.length === 0) return;

    if (openIds.size === 0) {
        void run();

        return;
    }

    confirm({ ...cancelDialog(targets, openIds.size), destructive: true, onConfirm: run });
}

/**
 * Restores an archived task with the tasks that were archived with it, and records the undo (`task.archive`) with its toast. The daemon refuses a task whose parent is
 * archived; that reason is the toast. Resolves to whether the daemon took it. A task that was restored already changes nothing and records nothing.
 */
export async function restoreTask(root: RootStore, project: ProjectState, task: Pick<Task, 'id' | 'key'>, stack: UndoStack = undoStack): Promise<boolean> {
    const [result] = await sendEach(root, [{ type: 'task.unarchive', taskId: task.id }]);

    if (!result?.ok) return false;

    if (archiveReply(result.data).restored.length === 0) return true;

    const label = `Restored ${ task.key }`;

    recordUndo(stack, project.id, label, async () => {
        const [archived] = await sendEach(root, [{ type: 'task.archive', taskId: task.id }]);

        if (archived?.ok) showUndone(label);

        return archived?.ok === true;
    });

    return true;
}
