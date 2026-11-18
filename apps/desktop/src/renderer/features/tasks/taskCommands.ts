import { statusOptions, taskOptions } from './pickerOptions';
import { adjacentStatus, blockedByOptions, blockingOptions, toggleDependency } from './taskView';

import type { OpenConfirmModalOptions } from '@clowdy/components/modals';
import type { CommandResult, Task, TaskId, TaskStatus } from '@clowdy/protocol';
import type { CommandInput } from '../../daemon/transport';
import type { Command } from '../../hotkeys';
import type { Direction, ListCursor } from '../../hotkeys/listCursor';
import type { PickerRequest } from '../../shared/PickerPopover';
import type { ProjectUi, TasksView } from '../../stores';

export const TASKS_SCOPE = 'tasks';

const GROUP = 'Tasks';

/**
 * Where the keyboard focus is, which decides whether a key is ours or belongs to the widget that has it.
 * `list`: nothing in particular has focus, or the board or the list does. `nav`: the shell's navigation, whose buttons take no arrows or letters.
 * `other`: anything else on the screen (the header's toggle, a Select in the panel, an agent chip on a card), which keeps its own arrows, letters and Enter.
 */
export type FocusZone = 'list' | 'nav' | 'other';

/** Marks what on a card or row does its own thing when pressed (the agent chips). It is not the task, so the task's keys leave it alone. */
export const TASK_CONTROL = '[data-task-control]';

/** The zone of the element that has focus, given the element that holds the board or the list. */
export function focusZoneOf(active: Element | null, region: Element | null): FocusZone {
    if (!active || active === active.ownerDocument.body || active === active.ownerDocument.documentElement) return 'list';

    if (active.closest(TASK_CONTROL)) return 'other';

    if (region?.contains(active)) return 'list';

    return active.closest('nav') ? 'nav' : 'other';
}

export interface TaskCommandDeps {
    cursor: ListCursor;
    ui: Pick<ProjectUi, 'taskId' | 'openTask'>;
    /** Whether the task still exists. The open task can be one that is gone, and then there is no panel to follow with. */
    hasTask: (taskId: TaskId) => boolean;
    view: () => TasksView;
    focusZone: () => FocusZone;
    /** Whether the keyboard focus is on the cursor item, which is what shows the cursor. */
    isCursorFocused: () => boolean;
    /** Puts keyboard focus on the cursor item and scrolls it into view. */
    revealCursor: () => void;
    /** The project's tasks in task order. Read when a command runs or is asked whether it can, so it always sees the latest. */
    tasks: () => readonly Task[];
    /** The workflow, in order. */
    statuses: () => readonly TaskStatus[];
    /** Why the task cannot be started now (an agent is already on it), or null. */
    startBlocked: (taskId: TaskId) => string | null;
    /** Sends one command per input, in order, and says what the daemon refused in one toast. See `sendEach`. */
    send: (inputs: readonly CommandInput[]) => Promise<CommandResult[]>;
    /** Starts the task with an agent, as the panel's Start button does. */
    start: (taskId: TaskId) => Promise<unknown>;
    /** Opens a picker beside the cursor task. */
    openPicker: (request: PickerRequest) => void;
    /** Asks before something that cannot be undone. `onConfirm` runs when the person agrees, and the dialog stays until it settles. */
    confirm: (request: OpenConfirmModalOptions) => void;
    /** Puts the keyboard in the title of the task's panel, which is open (or opening) when this is called. */
    focusTitle: (taskId: TaskId) => void;
}

/**
 * A key that acts on the cursor item first shows the cursor when focus is somewhere else, and acts on the next press.
 * The cursor starts on the first task before anyone has pressed a key, and the key that moved it past that unseen task would skip one.
 */
function onCursor(deps: TaskCommandDeps, act: () => void) {
    if (deps.isCursorFocused()) act();
    else deps.revealCursor();
}

/**
 * Like `onCursor` for a key that acts on the selection when there is one. A selection is on screen already, so only a lone cursor has to be shown first.
 * Without that, Cmd/Ctrl+A and then `S` would spend a press on showing a cursor nobody needs to see.
 */
function onTargets(deps: TaskCommandDeps, act: () => void) {
    if (deps.cursor.selected.size > 0 || deps.isCursorFocused()) act();
    else deps.revealCursor();
}

/** After the cursor moved: an open panel follows it, and the item shows. */
function settle({ cursor, ui, hasTask, revealCursor }: TaskCommandDeps) {
    if (cursor.cursorId !== null && ui.taskId !== null && hasTask(ui.taskId)) ui.openTask(cursor.cursorId);

    revealCursor();
}

/** Whether the list's keys apply: there is a task, and the focus is not in a widget that keeps its own arrows and letters. */
const reachable = ({ cursor, focusZone }: TaskCommandDeps) => cursor.cursorId !== null && focusZone() !== 'other';

/** The cursor, `Enter` and `Escape`. `Enter` only acts where the list has the focus, so it never takes a key from a widget that uses it. */
function navigationCommands(deps: TaskCommandDeps): Command[] {
    const { cursor, ui, hasTask, view, focusZone, revealCursor } = deps;
    const move = (id: string, title: string, keys: Command['keys'], direction: Direction, extra: Partial<Command> = {}): Command => ({
        id,
        title,
        group: GROUP,
        keys,
        scope: TASKS_SCOPE,
        when: () => reachable(deps),
        repeat: true,
        handler: () => onCursor(deps, () => {
            cursor.move(direction);
            settle(deps);
        }),
        ...extra,
    });

    return [
        move('tasks.cursor.down', 'Move down', ['ArrowDown', 'j'], 'down'),
        move('tasks.cursor.up', 'Move up', ['ArrowUp', 'k'], 'up'),
        move('tasks.cursor.left', 'Move to the column on the left', 'ArrowLeft', 'left', { when: () => view() === 'board' && reachable(deps) }),
        move('tasks.cursor.right', 'Move to the column on the right', 'ArrowRight', 'right', { when: () => view() === 'board' && reachable(deps) }),
        move('tasks.cursor.first', 'Jump to the first task', 'Home', 'first', { repeat: false }),
        move('tasks.cursor.last', 'Jump to the last task', 'End', 'last', { repeat: false }),
        {
            id: 'tasks.open',
            title: 'Open task',
            group: GROUP,
            keys: 'Enter',
            scope: TASKS_SCOPE,
            when: () => cursor.cursorId !== null && focusZone() === 'list',
            handler: () => onCursor(deps, () => {
                if (cursor.cursorId !== null) ui.openTask(cursor.cursorId);
            }),
        },
        {
            id: 'tasks.escape',
            title: 'Close the panel, then clear the selection',
            group: GROUP,
            keys: 'Escape',
            scope: TASKS_SCOPE,
            when: () => ui.taskId !== null || cursor.selected.size > 0,
            handler: () => {
                const panelOpen = ui.taskId !== null && hasTask(ui.taskId);

                // A stale id has no panel to close, so the same press goes on to the selection.
                if (ui.taskId !== null) ui.openTask(null);

                if (panelOpen) revealCursor();
                else cursor.clearSelection();
            },
        },
    ];
}

/** Picking tasks: `X` toggles the cursor task, Shift+arrows grow a range from the anchor, Cmd/Ctrl+A takes every visible task. */
function selectionCommands(deps: TaskCommandDeps): Command[] {
    const { cursor } = deps;
    // The direction is fixed per command: a handler cannot tell `j` from `ArrowDown` by the event on another keyboard layout.
    const extend = (id: string, title: string, keys: string, direction: 'up' | 'down'): Command => ({
        id,
        title,
        group: GROUP,
        keys,
        scope: TASKS_SCOPE,
        when: () => reachable(deps),
        repeat: true,
        handler: () => onCursor(deps, () => {
            cursor.extend(direction);
            settle(deps);
        }),
    });

    return [
        {
            id: 'tasks.select.toggle',
            title: 'Select or deselect task',
            group: GROUP,
            keys: 'x',
            scope: TASKS_SCOPE,
            when: () => reachable(deps),
            handler: () => onCursor(deps, () => cursor.toggle()),
        },
        extend('tasks.select.extend.down', 'Extend the selection down', 'Shift+ArrowDown', 'down'),
        extend('tasks.select.extend.up', 'Extend the selection up', 'Shift+ArrowUp', 'up'),
        {
            id: 'tasks.select.all',
            title: 'Select all tasks',
            group: GROUP,
            keys: '$mod+a',
            scope: TASKS_SCOPE,
            when: () => cursor.cursorId !== null,
            handler: () => cursor.selectAll(),
        },
    ];
}

/** The tasks a command acts on, in the order the person sees them: the selection, or else the cursor's task. A task that is gone is left out. */
function targetTasks({ cursor, tasks }: TaskCommandDeps): Task[] {
    const byId = new Map(tasks().map(task => [task.id, task]));

    return cursor.targets().flatMap(id => byId.get(id) ?? []);
}

/** Moving tasks along the workflow: `S` picks a status, and Opt/Ctrl+arrows step to the neighbour. */
function statusCommands(deps: TaskCommandDeps): Command[] {
    const { tasks, statuses, send, openPicker } = deps;
    const step = (id: string, title: string, keys: Command['keys'], by: 1 | -1): Command => ({
        id,
        title,
        group: GROUP,
        keys,
        scope: TASKS_SCOPE,
        when: () => reachable(deps),
        // One press is one step: a held key would run through the whole workflow before the first move has come back.
        handler: () => onTargets(deps, () => {
            const inputs: CommandInput[] = targetTasks(deps).flatMap((task) => {
                const next = adjacentStatus(statuses(), task.statusId, by);

                return next ? [{ type: 'task.update', taskId: task.id, statusId: next.id }] : [];
            });

            if (inputs.length > 0) void send(inputs);
        }),
    });

    return [
        {
            id: 'tasks.status.pick',
            title: 'Change status…',
            group: GROUP,
            keys: 's',
            scope: TASKS_SCOPE,
            when: () => reachable(deps),
            handler: () => onTargets(deps, () => {
                const targets = targetTasks(deps);

                if (targets.length === 0) return;

                const ids = targets.map(task => task.id);
                const shared = targets.every(task => task.statusId === targets[0].statusId);

                openPicker({
                    'aria-label': 'Change status',
                    placeholder: targets.length === 1 ? 'Change status…' : `Change status of ${ targets.length } tasks…`,
                    options: statusOptions(statuses()),
                    // Tasks that disagree have no current status to mark.
                    selectedIds: shared ? [targets[0].statusId] : [],
                    onPick: (statusId) => {
                        // Read again: the picker was open while events came in, and a task may be gone or already there.
                        const current = new Map(tasks().map(task => [task.id, task]));
                        const inputs: CommandInput[] = ids.flatMap(id => (current.get(id) && current.get(id)?.statusId !== statusId ? [{ type: 'task.update', taskId: id, statusId }] : []));

                        if (inputs.length > 0) void send(inputs);
                    },
                });
            }),
        },
        step('tasks.status.next', 'Move to the next status', { mac: 'Alt+ArrowRight', win: 'Control+ArrowRight' }, 1),
        step('tasks.status.prev', 'Move to the previous status', { mac: 'Alt+ArrowLeft', win: 'Control+ArrowLeft' }, -1),
    ];
}

/**
 * "Blocked by" and "Blocking": a picker over the tasks that may be linked to the cursor task, with the current links marked. Picking toggles the link.
 * It is one task's relation to another, so the selection is not used. `task.update` replaces a task's whole `dependsOn`, so the whole list is sent.
 */
function dependencyCommands(deps: TaskCommandDeps): Command[] {
    const { cursor, tasks, statuses, send, openPicker } = deps;
    const link = (id: string, title: string, keys: string, side: 'blockedBy' | 'blocking'): Command => ({
        id,
        title,
        group: GROUP,
        keys,
        scope: TASKS_SCOPE,
        when: () => reachable(deps),
        handler: () => onCursor(deps, () => {
            const all = tasks();
            const task = all.find(candidate => candidate.id === cursor.cursorId);

            if (!task) return;

            const isBlockedBy = side === 'blockedBy';
            const others = isBlockedBy ? blockedByOptions(all, task) : blockingOptions(all, task);

            openPicker({
                'aria-label': isBlockedBy ? 'Blocked by' : 'Blocking',
                placeholder: isBlockedBy ? `${ task.key } is blocked by…` : `${ task.key } is blocking…`,
                options: taskOptions(others, statuses()),
                selectedIds: others.filter(other => (isBlockedBy ? task.dependsOn.includes(other.id) : other.dependsOn.includes(task.id))).map(other => other.id),
                onPick: (otherId) => {
                    // The task whose list changes is the cursor task for "blocked by" and the picked one for "blocking". Read it again, the list may have changed meanwhile.
                    const ownerId = isBlockedBy ? task.id : otherId;
                    const owner = tasks().find(candidate => candidate.id === ownerId);

                    if (owner) void send([{ type: 'task.update', taskId: owner.id, dependsOn: toggleDependency(owner.dependsOn, isBlockedBy ? otherId : task.id) }]);
                },
            });
        }),
    });

    return [
        link('tasks.deps.blockedBy', 'Mark as blocked by…', 'm b', 'blockedBy'),
        link('tasks.deps.blocking', 'Mark as blocking…', 'm x', 'blocking'),
    ];
}

/** What the person is about to delete, in words: the task by name when it is one. */
function deleteDialog(tasks: readonly Task[]): Pick<OpenConfirmModalOptions, 'title' | 'message'> {
    if (tasks.length === 1) return { title: `Delete ${ tasks[0].key }?`, message: `"${ tasks[0].title }" will be deleted. This cannot be undone.` };

    return { title: `Delete ${ tasks.length } tasks?`, message: `The ${ tasks.length } selected tasks will be deleted. This cannot be undone.` };
}

/** Rename, start and delete. Start and rename are for the cursor task only. Delete takes the selection, after one question. */
function actionCommands(deps: TaskCommandDeps): Command[] {
    const { cursor, ui, hasTask, send, start, confirm, focusTitle, startBlocked } = deps;

    return [
        {
            id: 'tasks.rename',
            title: 'Rename task',
            group: GROUP,
            keys: 'Shift+r',
            scope: TASKS_SCOPE,
            when: () => reachable(deps),
            handler: () => onCursor(deps, () => {
                if (cursor.cursorId === null) return;

                ui.openTask(cursor.cursorId);
                focusTitle(cursor.cursorId);
            }),
        },
        {
            id: 'tasks.start',
            title: 'Start with an agent',
            group: GROUP,
            keys: '$mod+Enter',
            scope: TASKS_SCOPE,
            // Starting spends subscription quota, so it takes the cursor task only, never the selection, and is not offered while an agent is on the task.
            when: () => {
                const { cursorId } = cursor;

                return reachable(deps) && cursorId !== null && hasTask(cursorId) && startBlocked(cursorId) === null;
            },
            handler: () => onCursor(deps, () => {
                if (cursor.cursorId !== null) void start(cursor.cursorId);
            }),
        },
        {
            id: 'tasks.delete',
            title: 'Delete tasks…',
            group: GROUP,
            keys: { mac: '$mod+Backspace', win: '$mod+Delete' },
            scope: TASKS_SCOPE,
            when: () => reachable(deps),
            handler: () => onTargets(deps, () => {
                const targets = targetTasks(deps);

                if (targets.length === 0) return;

                const ids = targets.map(task => task.id);

                confirm({
                    ...deleteDialog(targets),
                    confirmLabel: 'Delete',
                    destructive: true,
                    onConfirm: async () => {
                        const results = await send(ids.map(taskId => ({ type: 'task.delete', taskId })));
                        const deleted = ids.filter((_, index) => results[index]?.ok);

                        // The panel of a task that is gone has nothing to show; the stale id would keep it open for a task that reappears.
                        if (ui.taskId !== null && deleted.includes(ui.taskId)) ui.openTask(null);
                    },
                });
            }),
        },
    ];
}

/** The commands of the Tasks screen, for the `tasks` scope. Stages add their groups here. */
export function taskCommands(deps: TaskCommandDeps): Command[] {
    return [...navigationCommands(deps), ...selectionCommands(deps), ...statusCommands(deps), ...dependencyCommands(deps), ...actionCommands(deps)];
}
