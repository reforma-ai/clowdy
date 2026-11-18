import type { TaskId } from '@clowdy/protocol';
import type { Command } from '../../hotkeys';
import type { Direction, ListCursor } from '../../hotkeys/listCursor';
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
}

/**
 * A key that acts on the cursor item first shows the cursor when focus is somewhere else, and acts on the next press.
 * The cursor starts on the first task before anyone has pressed a key, and the key that moved it past that unseen task would skip one.
 */
function onCursor(deps: TaskCommandDeps, act: () => void) {
    if (deps.isCursorFocused()) act();
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

/** The commands of the Tasks screen, for the `tasks` scope. Stages add their groups here. */
export function taskCommands(deps: TaskCommandDeps): Command[] {
    return [...navigationCommands(deps), ...selectionCommands(deps)];
}
