import { isClosedCategory } from '@clowdy/protocol';

import type { Task, TaskId, TaskStatus } from '@clowdy/protocol';
import type { TaskTree } from './taskTree';

/*
 * What the archive asks of a task, as pure functions over the tasks the board holds: which open work an archive has to cancel, how the actions are worded, and what the
 * daemon's answers to `task.archive` and `task.unarchive` say. The daemon decides what it accepts (a task with an active run, or one below it, is refused whatever the
 * call says); nothing here guesses at that, and its reason reaches the person as the toast it gave.
 */

/**
 * The task and every task inside it that is not closed (a status the workflow no longer has counts as open, as the daemon reads it): what `task.archive` with `cancel`
 * moves to Canceled before it archives them. Empty for a task that can be archived as it is. Read from the tree of the board, so it is what the person sees now.
 */
export function openWork(task: Task, tree: TaskTree, statuses: readonly TaskStatus[]): Task[] {
    const closed = new Set(statuses.filter(status => isClosedCategory(status.category)).map(status => status.id));

    return [task, ...tree.descendantsOf(task.id)].filter(candidate => !closed.has(candidate.statusId));
}

/** What a task is called in a sentence: its key for one task, a count for several. */
const subject = (tasks: readonly Pick<Task, 'key'>[]) => (tasks.length === 1 ? tasks[0].key : `${ tasks.length } tasks`);

/** The wording of the archive action over some tasks: a menu item, a button, the offer to undo. `isOpen` is whether any of them has open work, which the archive cancels. */
export function archiveWording(tasks: readonly Pick<Task, 'key'>[], isOpen: boolean) {
    return {
        /** The menu item and the panel's button: "Archive", with the count for several tasks. */
        action: `${ isOpen ? 'Cancel and archive' : 'Archive' }${ tasks.length > 1 ? ` ${ tasks.length } tasks` : '' }`,
        /** The offer to undo, after the archive. */
        done: `${ isOpen ? 'Canceled and archived' : 'Archived' } ${ subject(tasks) }`,
    };
}

/** The question before work that is open is canceled: what goes to the archive and how many open tasks are canceled, as the daemon will do it. */
export function cancelDialog(tasks: readonly Pick<Task, 'key' | 'title'>[], openCount: number): { title: string; message: string; confirmLabel: string } {
    const what = tasks.length === 1 ? `"${ tasks[0].title }" and everything inside it` : `The ${ tasks.length } selected tasks and everything inside them`;
    const open = openCount === 1 ? '1 open task' : `${ openCount } open tasks`;

    return {
        title: `Cancel and archive ${ subject(tasks) }?`,
        message: `${ what } will go to the archive. ${ open } will be canceled first.`,
        confirmLabel: 'Cancel and archive',
    };
}

/** What the daemon answers to `task.archive` and `task.unarchive`: the task asked for, and the ids of the tasks the call archived, canceled or restored. */
export interface ArchiveReply {
    archived: TaskId[];
    canceled: TaskId[];
    restored: TaskId[];
}

const idsOf = (value: unknown): TaskId[] => (Array.isArray(value) ? value.filter((id): id is TaskId => typeof id === 'string') : []);

/** The lists of an answer; nothing for what is not there. The daemon and the fixture daemon answer `{ task, archived, canceled }` and `{ task, restored }`. */
export function archiveReply(data: unknown): ArchiveReply {
    const reply = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;

    return { archived: idsOf(reply.archived), canceled: idsOf(reply.canceled), restored: idsOf(reply.restored) };
}

/**
 * Whether the task is the top of its archive batch, the one a restore is offered on: nothing above it was archived with it. A restore of a task whose parent is still
 * archived is refused, so it is not offered below the top. `parentOf` gives the task above, `undefined` for a root or a parent the caller does not know.
 */
export function isBatchTop(task: Pick<Task, 'parentId' | 'archivedAt'>, parentOf: (parentId: TaskId) => Pick<Task, 'archivedAt'> | undefined): boolean {
    if (task.parentId === undefined) return true;

    const parent = parentOf(task.parentId);

    return parent === undefined || parent.archivedAt !== task.archivedAt;
}
