import { MAX_TASK_DEPTH } from '@clowdy/protocol';

import { listFocusOf } from '../../hotkeys/listNavigation';
import { statusOptions, taskOptions } from './pickerOptions';
import { DEPTH_LIMIT_HINT } from './taskTree';
import { adjacentStatus, blockedByOptions, blockingOptions, newestChat, toggleDependency } from './taskView';
import { treeMove } from './treeNavigation';

import type { OpenConfirmModalOptions } from '@clowdy/components/modals';
import type { Chat, ChatId, CommandResult, Task, TaskId, TaskStatus } from '@clowdy/protocol';
import type { CommandInput } from '../../daemon/transport';
import type { Command } from '../../hotkeys';
import type { Direction, ListCursor } from '../../hotkeys/listCursor';
import type { PickerRequest } from '../../shared/PickerPopover';
import type { ProjectUi, TasksView } from '../../stores';
import type { TreeRow } from './taskTree';

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

/** The id of the task whose card or row holds the element, or null for what is not the task itself: an agent chip, or anything outside a card or row. */
const taskIdOf = (element: Element): TaskId | null => (element.closest(TASK_CONTROL) ? null : element.closest<HTMLElement>('[data-task-id]')?.dataset.taskId ?? null);

/**
 * The zone of the element that has focus, given the element that holds the board or the list.
 * A focusable thing inside the region that is not a card or row (a table's column header) keeps its own keys too.
 */
export function focusZoneOf(active: Element | null, region: Element | null): FocusZone {
    const focus = listFocusOf(region, taskIdOf, active);

    if (focus.zone === 'other') return 'other';

    return focus.zone === 'idle' && active?.closest('nav') ? 'nav' : 'list';
}

export interface TaskCommandDeps {
    cursor: ListCursor;
    ui: Pick<ProjectUi, 'taskId' | 'openTask'> & { openDoc: (path: string) => void };
    /** Shows a chat in the Agents section, bringing it out of the archive first when it is in it. */
    openChat: (chatId: ChatId) => void;
    /** Whether the task still exists. The open task can be one that is gone, and then there is no panel to follow with. */
    hasTask: (taskId: TaskId) => boolean;
    /** The view the screen draws now: the project's own at the roots, a task page's inside a task. The list is a tree. */
    view: () => TasksView;
    /** Sets that view, wherever it is kept. */
    setView: (view: TasksView) => void;
    /** The scope the screen shows: the task whose insides it draws, or `null` for the project's roots. */
    scope: () => TaskId | null;
    /** The screen shows the archive in place of the scope, which has no view, search, filter or new-task button then: their keys are off, as the controls are. */
    isArchive: () => boolean;
    /** The rows of the tree list as drawn, folded ones' insides left out. Read when a key is pressed. Nothing while the screen shows a board. */
    rows: () => readonly TreeRow[];
    /** Folds the insides of a task in the tree list, or opens them. */
    setFolded: (taskId: TaskId, folded: boolean) => void;
    /** Shows the insides of a task: its own scope. */
    openScope: (taskId: TaskId) => void;
    /** Shows the scope above the one on the screen. */
    goUp: () => void;
    /** Whether the task can hold tasks: the daemon refuses a level past `MAX_TASK_DEPTH`. */
    canHaveChildren: (taskId: TaskId) => boolean;
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
    /**
     * Sends one command per input, in order, and says what the daemon refused in one toast. See `sendEach`.
     * The `task.update`s it sends are recorded in `undo` by whoever builds it (`sendWithUndo`), so a command does not know about undoing.
     */
    send: (inputs: readonly CommandInput[]) => Promise<CommandResult[]>;
    /** What `Cmd/Ctrl+Z` takes back: the changes `send` recorded in this project, never those of another project. */
    undo: { canUndo: () => boolean; undoLatest: () => Promise<boolean> };
    /** Starts the task with an agent, as the panel's Start button does. */
    start: (taskId: TaskId) => Promise<unknown>;
    /**
     * Archives the tasks, each with the tasks inside it: a closed one goes at once, and open work is canceled first after a question that says how many open tasks
     * that cancels. The daemon's refusals and the undo are its own (`archiveTasks`).
     */
    archive: (tasks: readonly Task[]) => void;
    /** Opens a picker beside the cursor task. */
    openPicker: (request: PickerRequest) => void;
    /** Asks before something that cannot be undone. `onConfirm` runs when the person agrees, and the dialog stays until it settles. */
    confirm: (request: OpenConfirmModalOptions) => void;
    /** Puts the keyboard in the title of the task's panel, which is open (or opening) when this is called. */
    focusTitle: (taskId: TaskId) => void;
    /** Opens the "New task" dialog, as the header's button does: for a sub-task of the task the screen is inside, or a task of the roots at the roots. */
    create: () => void;
    /** Opens the filter popover, with the keyboard in it. */
    openFilter: () => void;
    /** Puts the keyboard in the search field and selects its text. The key that asked for it is not typed into it. */
    focusSearch: () => void;
    /** The chats that discuss a task. */
    chatsOf: (taskId: TaskId) => readonly Pick<Chat, 'id' | 'updatedAt'>[];
    /** The path of the newest document the task produced, or null when it has none. Asks the daemon, so it can reject. */
    docPathOf: (taskId: TaskId) => Promise<string | null>;
    /** Puts the text on the clipboard and says `message` once it is there, or that it could not be. */
    copy: (text: string, message: string) => void;
    /** Shows a short message to the person. */
    notify: (message: string, tone?: 'info' | 'error') => void;
    /** Runs a change of what the window shows so that it overwrites the current history entry instead of adding one. See `NavHistory.replacing`. */
    replacing: (change: () => void) => void;
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

/**
 * After the cursor moved: an open panel follows it, and the item shows.
 * The following replaces the history entry, so holding `J` does not fill Back with every task it passed. Opening a task on purpose (`Enter`, a click) is an entry.
 */
function settle({ cursor, ui, hasTask, revealCursor, replacing }: TaskCommandDeps) {
    const { cursorId } = cursor;

    if (cursorId !== null && ui.taskId !== null && hasTask(ui.taskId)) replacing(() => ui.openTask(cursorId));

    revealCursor();
}

/** Whether there is a task under the cursor. The key hints ask this too. */
const hasCursor = ({ cursor }: TaskCommandDeps) => cursor.cursorId !== null;

/**
 * Whether the focus is not in a widget that keeps its own arrows and letters. Only the dispatcher asks: the key hints would change with every move of the focus,
 * and show a command as unavailable while a field has it.
 */
const inList = ({ focusZone }: TaskCommandDeps) => focusZone() !== 'other';

/** The gates of a key that acts on the cursor task where the list has the focus. */
const onTheList = (deps: TaskCommandDeps): Pick<Command, 'when' | 'focus'> => ({ when: () => hasCursor(deps), focus: () => inList(deps) });

/** The cursor, `Enter` and `Escape`. `Enter` only acts where the list has the focus, so it never takes a key from a widget that uses it. */
function navigationCommands(deps: TaskCommandDeps): Command[] {
    const { cursor, ui, hasTask, view, rows, setFolded, focusZone, revealCursor } = deps;
    const move = (id: string, title: string, keys: Command['keys'], direction: Direction, extra: Partial<Command> = {}): Command => ({
        id,
        title,
        group: GROUP,
        keys,
        scope: TASKS_SCOPE,
        ...onTheList(deps),
        repeat: true,
        handler: () => onCursor(deps, () => {
            cursor.move(direction);
            settle(deps);
        }),
        ...extra,
    });

    // The arrows are the board's columns, and the tree list's folds: one command each, since two commands cannot share a key. In the list a key with nothing to do
    // (Right on a row with nothing inside, Left on a row at the top) is not ours, and stays the page's.
    const sideways = (id: string, title: string, keys: string, direction: 'left' | 'right'): Command => move(id, title, keys, direction, {
        when: () => hasCursor(deps) && (view() === 'board' || treeMove(rows(), cursor.cursorId, direction) !== undefined),
        handler: () => onCursor(deps, () => {
            if (view() === 'board') {
                cursor.move(direction);
                settle(deps);

                return;
            }

            const step = treeMove(rows(), cursor.cursorId, direction);

            if (step?.kind === 'move') {
                cursor.setCursor(step.taskId);
                settle(deps);
            }
            else if (step) {
                setFolded(step.taskId, step.kind === 'fold');
            }
        }),
    });

    return [
        move('tasks.cursor.down', 'Move down', ['ArrowDown', 'j'], 'down'),
        move('tasks.cursor.up', 'Move up', ['ArrowUp', 'k'], 'up'),
        sideways('tasks.cursor.left', 'Move to the column on the left, or fold the row', 'ArrowLeft', 'left'),
        sideways('tasks.cursor.right', 'Move to the column on the right, or unfold the row', 'ArrowRight', 'right'),
        move('tasks.cursor.first', 'Jump to the first task', 'Home', 'first', { repeat: false }),
        move('tasks.cursor.last', 'Jump to the last task', 'End', 'last', { repeat: false }),
        {
            id: 'tasks.open',
            title: 'Open task',
            group: GROUP,
            keys: 'Enter',
            scope: TASKS_SCOPE,
            when: () => hasCursor(deps),
            // Enter presses a button, so unlike the arrows it is not ours on a rail button either.
            focus: () => focusZone() === 'list',
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
        ...onTheList(deps),
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
            ...onTheList(deps),
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
        ...onTheList(deps),
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
            ...onTheList(deps),
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
        ...onTheList(deps),
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

/** Whether the detail panel shows a task that still exists. */
function isPanelOpen({ ui, hasTask }: TaskCommandDeps): boolean {
    return ui.taskId !== null && hasTask(ui.taskId);
}

/** The task a start is for: the one in the open panel, else the cursor task. */
function startTarget(deps: TaskCommandDeps): TaskId | null {
    return isPanelOpen(deps) ? deps.ui.taskId : deps.cursor.cursorId;
}

/**
 * Rename, start, archive and delete. Rename is for the cursor task only, start for the open task or else the cursor task. Archive and delete take the selection, delete
 * after one question and archive after one only when it would cancel open work. `E` is Archive, as in Gmail and Linear's lists: a letter no other command of the
 * screen uses, a step away from `S` and `X`, and not the delete chord, which is for what cannot be taken back.
 */
function actionCommands(deps: TaskCommandDeps): Command[] {
    const { cursor, ui, hasTask, send, start, confirm, focusTitle, startBlocked, archive } = deps;

    return [
        {
            id: 'tasks.rename',
            title: 'Rename task',
            group: GROUP,
            keys: 'Shift+r',
            scope: TASKS_SCOPE,
            ...onTheList(deps),
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
            // Starting spends subscription quota, so it takes one task, never the selection, and is not offered while an agent is on the task.
            when: () => {
                const taskId = startTarget(deps);

                return taskId !== null && hasTask(taskId) && startBlocked(taskId) === null;
            },
            focus: () => inList(deps),
            handler: () => {
                // The panel is what the person is looking at: hovering another card moves the cursor but must not move a start to it.
                if (isPanelOpen(deps)) {
                    void start(ui.taskId as TaskId);

                    return;
                }

                onCursor(deps, () => {
                    if (cursor.cursorId !== null) void start(cursor.cursorId);
                });
            },
        },
        {
            id: 'tasks.archive',
            title: 'Archive tasks',
            group: GROUP,
            keys: 'e',
            scope: TASKS_SCOPE,
            ...onTheList(deps),
            handler: () => onTargets(deps, () => {
                const targets = targetTasks(deps);

                if (targets.length > 0) archive(targets);
            }),
        },
        {
            id: 'tasks.delete',
            title: 'Delete tasks…',
            group: GROUP,
            keys: { mac: '$mod+Backspace', win: '$mod+Delete' },
            scope: TASKS_SCOPE,
            ...onTheList(deps),
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

/**
 * `C` creates a task, `Cmd/Ctrl+B` switches the view, `F` opens the filter and `/` the search. They belong to the screen, not to a task,
 * so they work wherever the key is not a character of a text field, which the dispatcher already keeps out.
 * Inside a task `C` makes a sub-task of it, as the "+ Sub-task" button does, and at the last level it says why it cannot, as that button does when it is off.
 */
function screenCommands({ view, setView, scope, isArchive, canHaveChildren, create, notify, openFilter, focusSearch }: TaskCommandDeps): Command[] {
    // The controls these keys stand for leave the header while the archive shows, so a key must not act on what is not there (`F` would open the filter for later).
    const inScope = () => !isArchive();

    return [
        {
            id: 'tasks.create',
            title: 'New task',
            group: GROUP,
            keys: 'c',
            scope: TASKS_SCOPE,
            when: inScope,
            handler: () => {
                const inside = scope();

                if (inside !== null && !canHaveChildren(inside)) notify(DEPTH_LIMIT_HINT);
                else create();
            },
        },
        { id: 'tasks.view.toggle', title: 'Switch between board and list', group: GROUP, keys: '$mod+b', scope: TASKS_SCOPE, when: inScope, handler: () => setView(view() === 'board' ? 'list' : 'board') },
        { id: 'tasks.filter', title: 'Filter tasks', group: GROUP, keys: 'f', scope: TASKS_SCOPE, when: inScope, handler: () => openFilter() },
        { id: 'tasks.search', title: 'Search tasks', group: GROUP, keys: '/', scope: TASKS_SCOPE, when: inScope, handler: () => focusSearch() },
    ];
}

/**
 * Copy the key or the title of the target tasks, one per line, with a toast that says what is on the clipboard.
 * A copy changes nothing and its toast names the task, so unlike the actions it needs no cursor on screen first and no focus on the list.
 */
function copyCommands(deps: TaskCommandDeps): Command[] {
    const copy = (id: string, title: string, keys: string, part: 'key' | 'title'): Command => ({
        id,
        title,
        group: GROUP,
        keys,
        scope: TASKS_SCOPE,
        when: () => targetTasks(deps).length > 0,
        handler: () => {
            const targets = targetTasks(deps);

            if (targets.length === 0) return;

            const text = targets.map(task => task[part]).join('\n');
            const [first] = targets;
            const what = targets.length === 1 ? (part === 'key' ? first.key : `the title of ${ first.key }`) : `${ targets.length } task ${ part }s`;

            deps.copy(text, `Copied ${ what }`);
        },
    });

    return [
        copy('tasks.copy.key', 'Copy task key', '$mod+.', 'key'),
        // Shift turns `'` into `"` on a US layout, so this one is the physical key.
        copy('tasks.copy.title', 'Copy task title', '$mod+Shift+Quote', 'title'),
    ];
}

/** The task under the cursor, when it still exists. */
function cursorTask({ cursor, tasks }: TaskCommandDeps): Task | undefined {
    return cursor.cursorId === null ? undefined : tasks().find(task => task.id === cursor.cursorId);
}

/** Opens the task's newest document on the Docs tab, or says why it cannot. Asking the daemon takes a moment, so the task is the one the key was pressed on. */
async function openLatestDoc({ ui, docPathOf, notify }: TaskCommandDeps, task: Task): Promise<void> {
    try {
        const path = await docPathOf(task.id);

        if (path === null) notify(`${ task.key } has no document yet`);
        else ui.openDoc(path);
    }
    catch (error) {
        notify(`Could not load the results of ${ task.key }: ${ error instanceof Error ? error.message : String(error) }`, 'error');
    }
}

/**
 * `O` then `C` opens the cursor task's newest chat and `O` then `D` its newest document. Both take the cursor task only, never the selection.
 * Both exist for every task and say so when there is nothing to open: a `O` that waited for a `C` which then fell through to "New task" would be worse than a toast.
 */
function linkedCommands(deps: TaskCommandDeps): Command[] {
    const { chatsOf, notify } = deps;

    return [
        {
            id: 'tasks.chat.open',
            title: 'Open linked chat',
            group: GROUP,
            keys: 'o c',
            scope: TASKS_SCOPE,
            when: () => cursorTask(deps) !== undefined,
            focus: () => inList(deps),
            handler: () => onCursor(deps, () => {
                const task = cursorTask(deps);

                if (!task) return;

                const chat = newestChat(chatsOf(task.id));

                if (chat) deps.openChat(chat.id);
                else notify(`${ task.key } has no chat yet`);
            }),
        },
        {
            id: 'tasks.doc.open',
            title: 'Open latest document',
            group: GROUP,
            keys: 'o d',
            scope: TASKS_SCOPE,
            when: () => cursorTask(deps) !== undefined,
            focus: () => inList(deps),
            handler: () => onCursor(deps, () => {
                const task = cursorTask(deps);

                if (task) void openLatestDoc(deps, task);
            }),
        },
    ];
}

/**
 * `O` then `S` opens the cursor task's own scope, its sub-tasks (a board or list of what is inside it, empty for a task with nothing inside yet, where "New sub-task" starts),
 * and `U` goes up one level, inside a task only. `O S` is one of the `O` chords for the same reason as `O C` and `O D`: a chord that waits for a key which then falls
 * through to "Change status" would be worse than a toast, so it exists for every task and says so where it cannot open (the last level).
 * `U` exists only inside a task, where the screen can go up; at the roots the key stays the page's.
 */
function scopeCommands(deps: TaskCommandDeps): Command[] {
    const { scope, goUp, openScope, canHaveChildren, notify } = deps;

    return [
        {
            id: 'tasks.subtasks.open',
            title: 'Open sub-tasks',
            group: GROUP,
            keys: 'o s',
            scope: TASKS_SCOPE,
            when: () => cursorTask(deps) !== undefined,
            focus: () => inList(deps),
            handler: () => onCursor(deps, () => {
                const task = cursorTask(deps);

                if (!task) return;

                if (canHaveChildren(task.id)) openScope(task.id);
                else notify(`${ task.key } cannot hold sub-tasks: tasks go only ${ MAX_TASK_DEPTH } levels deep`);
            }),
        },
        { id: 'tasks.scope.up', title: 'Go up one level', group: GROUP, keys: 'u', scope: TASKS_SCOPE, when: () => scope() !== null, handler: () => goUp() },
    ];
}

/**
 * `Cmd/Ctrl+Z` takes back the latest status, title, description or dependency change. The history is the window's, so it needs neither the list's focus nor a cursor;
 * a text field keeps its own undo and a dialog or picker keeps the key, as with every command. It exists only while there is something to take back.
 */
function undoCommands({ undo }: TaskCommandDeps): Command[] {
    return [
        { id: 'tasks.undo', title: 'Undo', group: GROUP, keys: '$mod+z', scope: TASKS_SCOPE, when: () => undo.canUndo(), handler: () => void undo.undoLatest() },
    ];
}

/** The commands of the Tasks screen, for the `tasks` scope. */
export function taskCommands(deps: TaskCommandDeps): Command[] {
    return [
        ...navigationCommands(deps),
        ...selectionCommands(deps),
        ...statusCommands(deps),
        ...dependencyCommands(deps),
        ...actionCommands(deps),
        ...screenCommands(deps),
        ...copyCommands(deps),
        ...linkedCommands(deps),
        ...scopeCommands(deps),
        ...undoCommands(deps),
    ];
}
