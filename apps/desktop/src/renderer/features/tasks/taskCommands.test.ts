// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { commandHint, findKeyConflicts } from '../../hotkeys';
import { installDispatcher } from '../../hotkeys/dispatcher';
import { ListCursor, type Grid } from '../../hotkeys/listCursor';
import { createRegistry } from '../../hotkeys/registry';
import { focusZoneOf, taskCommands, TASKS_SCOPE, type FocusZone, type TaskCommandDeps } from './taskCommands';

import type { OpenConfirmModalOptions } from '@clowdy/components/modals';
import type { CommandResult, Task, TaskStatus } from '@clowdy/protocol';
import type { CommandInput } from '../../daemon/transport';
import type { PickerRequest } from '../../shared/PickerPopover';
import type { TasksView } from '../../stores';

const board: Grid = [['a1', 'a2', 'a3'], ['b1'], [], ['c1', 'c2']];
const list: Grid = [['a1', 'a2', 'a3', 'b1', 'c1', 'c2']];

const STATUSES: TaskStatus[] = [
    { id: 'todo', name: 'To do', category: 'todo' },
    { id: 'active', name: 'In progress', category: 'active' },
    { id: 'review', name: 'In review', category: 'review' },
    { id: 'done', name: 'Done', category: 'done' },
];

/** A task with the id, upper-cased, as its key. */
function fakeTask(id: string, rest: Partial<Task> = {}): Task {
    return {
        id,
        projectId: 'p',
        number: 1,
        key: id.toUpperCase(),
        title: `Task ${ id }`,
        description: '',
        statusId: 'todo',
        dependsOn: [],
        createdBy: { kind: 'user' },
        createdAt: 1,
        updatedAt: 1,
        ...rest,
    };
}

interface Harness {
    cursor: ListCursor;
    ui: { taskId: string | null; openTask: Mock<(taskId: string | null) => void> };
    reveal: Mock<() => void>;
    known: Set<string>;
    state: {
        view: TasksView;
        zone: FocusZone;
        focused: boolean;
        /** The tasks the project holds; replace entries to change what the commands read. */
        tasks: Task[];
        /** Task ids the daemon refuses to change. */
        refused: Set<string>;
        /** Why the task cannot be started, by task id. */
        blocked: Map<string, string>;
    };
    /** What the commands sent, one array per call. */
    sent: CommandInput[][];
    pickers: PickerRequest[];
    confirms: OpenConfirmModalOptions[];
    started: string[];
    titles: string[];
    deps: TaskCommandDeps;
}

let uninstall: (() => void) | undefined;

/**
 * The commands in an isolated registry with the dispatcher on `document`, and the scope pushed as `Screen` does.
 * The focus zone is `state.zone` unless `zoneOf` reads it from the DOM.
 */
function setup(grid: Grid, view: TasksView = 'board', zoneOf?: () => FocusZone, tasks: Task[] = grid.flat().map((id, index) => fakeTask(id, { number: index + 1 }))): Harness {
    // A test that sets up twice must not leave the first dispatcher listening.
    uninstall?.();

    const registry = createRegistry('darwin');
    const cursor = new ListCursor();
    const ui: Harness['ui'] = {
        taskId: null,
        openTask: vi.fn<(taskId: string | null) => void>((id) => {
            ui.taskId = id;
        }),
    };
    const known = new Set(grid.flat());
    const state: Harness['state'] = { view, zone: 'list', focused: true, tasks, refused: new Set(), blocked: new Map() };
    const reveal = vi.fn<() => void>();
    const sent: CommandInput[][] = [];
    const pickers: PickerRequest[] = [];
    const confirms: OpenConfirmModalOptions[] = [];
    const started: string[] = [];
    const titles: string[] = [];
    const deps: TaskCommandDeps = {
        cursor,
        ui,
        hasTask: id => known.has(id),
        view: () => state.view,
        focusZone: zoneOf ?? (() => state.zone),
        isCursorFocused: () => state.focused,
        revealCursor: reveal,
        tasks: () => state.tasks,
        statuses: () => STATUSES,
        startBlocked: id => state.blocked.get(id) ?? null,
        send: async (inputs) => {
            sent.push([...inputs]);

            return inputs.map((input): CommandResult => ('taskId' in input && state.refused.has(input.taskId)
                ? { ok: false, requestId: 'r', error: { code: 'invalid', message: 'No' } }
                : { ok: true, requestId: 'r', data: {} }));
        },
        start: async (id) => {
            started.push(id);
        },
        openPicker: request => pickers.push(request),
        confirm: options => confirms.push(options),
        focusTitle: id => titles.push(id),
    };

    cursor.setGrid(grid);
    registry.pushScope(TASKS_SCOPE);

    for (const command of taskCommands(deps)) registry.defineCommand(command);

    uninstall = installDispatcher(registry);

    return { cursor, ui, reveal, known, state, sent, pickers, confirms, started, titles, deps };
}

/** Returns whether a command took the key (the dispatcher calls `preventDefault`). */
function press(key: string, init: KeyboardEventInit = {}, target: Element = document.body): boolean {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });

    target.dispatchEvent(event);

    return event.defaultPrevented;
}

beforeEach(() => {
    document.body.innerHTML = '';
});

afterEach(() => {
    uninstall?.();
    uninstall = undefined;
});

describe('cursor movement', () => {
    it('moves down and up with the arrows and with J and K, and holding a key keeps moving', () => {
        const { cursor } = setup(list, 'list');

        press('ArrowDown');
        press('j');
        press('j', { repeat: true });

        expect(cursor.cursorId).toBe('b1');

        press('ArrowUp');
        press('k');

        expect(cursor.cursorId).toBe('a2');
    });

    it('moves between board columns with the left and right arrows', () => {
        const { cursor } = setup(board);

        cursor.setCursor('a2');
        press('ArrowRight');

        expect(cursor.cursorId).toBe('b1');

        press('ArrowRight');

        expect(cursor.cursorId).toBe('c1');

        press('ArrowLeft');

        expect(cursor.cursorId).toBe('b1');
    });

    it('leaves the left and right arrows to the page in the list view', () => {
        const { cursor } = setup(list, 'list');

        expect(press('ArrowRight')).toBe(false);
        expect(press('ArrowLeft')).toBe(false);
        expect(cursor.cursorId).toBe('a1');
    });

    it('jumps to the first and last task of the column', () => {
        const { cursor } = setup(board);

        press('End');

        expect(cursor.cursorId).toBe('a3');

        press('Home');

        expect(cursor.cursorId).toBe('a1');
    });

    it('does not repeat Home and End while the key is held', () => {
        const { cursor } = setup(board);

        press('End', { repeat: true });

        expect(cursor.cursorId).toBe('a1');
    });

    it('shows the cursor task after every move', () => {
        const { reveal } = setup(list, 'list');

        press('j');
        press('k');

        expect(reveal).toHaveBeenCalledTimes(2);
    });
});

describe('an unseen cursor', () => {
    it('is shown by the first key and not moved, so the first J does not skip the first task', () => {
        const { cursor, ui, state, reveal } = setup(list, 'list');

        state.focused = false;
        press('j');

        expect(cursor.cursorId).toBe('a1');
        expect(reveal).toHaveBeenCalledTimes(1);

        state.focused = true;
        press('j');

        expect(cursor.cursorId).toBe('a2');
        expect(ui.openTask).not.toHaveBeenCalled();
    });

    it('is also what X, Enter and Shift+arrows show first', () => {
        const { cursor, ui, state, reveal } = setup(list, 'list');

        state.focused = false;
        press('x');
        press('Enter');
        press('ArrowDown', { shiftKey: true });

        expect(reveal).toHaveBeenCalledTimes(3);
        expect(cursor.selected.size).toBe(0);
        expect(ui.openTask).not.toHaveBeenCalled();
    });

    it('does not stop Select all', () => {
        const { cursor, state } = setup(list, 'list');

        state.focused = false;
        press('a', { metaKey: true });

        expect(cursor.selected.size).toBe(6);
    });
});

describe('the open panel', () => {
    it('Enter opens the cursor task, and the cursor stays where it is', () => {
        const { cursor, ui } = setup(list, 'list');

        press('j');
        press('Enter');

        expect(ui.openTask).toHaveBeenLastCalledWith('a2');
        expect(cursor.cursorId).toBe('a2');
    });

    it('does not open anything while the panel is closed and the cursor moves', () => {
        const { ui } = setup(list, 'list');

        press('j');

        expect(ui.openTask).not.toHaveBeenCalled();
    });

    it('follows the cursor while it is open, with the arrows, J and K, the ends and Shift+arrows', () => {
        const { ui } = setup(list, 'list');

        ui.taskId = 'a1';
        press('j');

        expect(ui.openTask).toHaveBeenLastCalledWith('a2');

        press('ArrowDown');

        expect(ui.openTask).toHaveBeenLastCalledWith('a3');

        press('End');

        expect(ui.openTask).toHaveBeenLastCalledWith('c2');

        press('ArrowDown', { shiftKey: true });
        press('ArrowUp', { shiftKey: true });

        expect(ui.taskId).toBe('c1');
    });

    it('does not follow when the open task is gone', () => {
        const { ui } = setup(list, 'list');

        ui.taskId = 'deleted';
        press('j');

        expect(ui.openTask).not.toHaveBeenCalled();
    });
});

describe('Escape', () => {
    it('closes the panel first, then clears the selection, then leaves the key alone', () => {
        const { cursor, ui } = setup(list, 'list');

        ui.taskId = 'a1';
        press('x');

        expect(press('Escape')).toBe(true);
        expect(ui.taskId).toBeNull();
        expect(cursor.selected.size).toBe(1);

        expect(press('Escape')).toBe(true);
        expect(cursor.selected.size).toBe(0);

        expect(press('Escape')).toBe(false);
    });

    it('takes the cursor back to the list when it closes the panel', () => {
        const { ui, reveal } = setup(list, 'list');

        ui.taskId = 'a1';
        press('Escape');

        expect(reveal).toHaveBeenCalledTimes(1);
    });

    it('clears a stale open id and the selection in one press', () => {
        const { cursor, ui } = setup(list, 'list');

        ui.taskId = 'deleted';
        press('x');
        press('Escape');

        expect(ui.taskId).toBeNull();
        expect(cursor.selected.size).toBe(0);
    });
});

describe('selection', () => {
    it('X toggles the cursor task', () => {
        const { cursor } = setup(list, 'list');

        press('x');
        press('j');
        press('x');

        expect([...cursor.selected]).toEqual(['a1', 'a2']);

        press('x');

        expect([...cursor.selected]).toEqual(['a1']);
    });

    it('Shift+arrows select a range from the anchor', () => {
        const { cursor } = setup(list, 'list');

        press('ArrowDown', { shiftKey: true });
        press('ArrowDown', { shiftKey: true });

        expect([...cursor.selected]).toEqual(['a1', 'a2', 'a3']);

        press('ArrowUp', { shiftKey: true });

        expect([...cursor.selected]).toEqual(['a1', 'a2']);
    });

    it('Cmd+A selects every visible task on macOS', () => {
        const { cursor } = setup(board);

        expect(press('a', { metaKey: true })).toBe(true);
        expect(cursor.selected.size).toBe(6);
    });

    it('does not take a plain A', () => {
        const { cursor } = setup(board);

        expect(press('a')).toBe(false);
        expect(cursor.selected.size).toBe(0);
    });
});

describe('where the keys apply', () => {
    it('leaves arrows and Enter to a widget that has the focus, such as the header toggle or a Select in the panel', () => {
        const { cursor, ui, state } = setup(list, 'list');

        state.zone = 'other';

        expect(press('ArrowDown')).toBe(false);
        expect(press('j')).toBe(false);
        expect(press('Enter')).toBe(false);
        expect(press('ArrowDown', { shiftKey: true })).toBe(false);
        expect(press('x')).toBe(false);
        expect(cursor.cursorId).toBe('a1');
        expect(cursor.selected.size).toBe(0);
        expect(ui.openTask).not.toHaveBeenCalled();
    });

    it('takes arrows but not Enter while a navigation button has the focus, so the button still works', () => {
        const { cursor, state } = setup(list, 'list');

        state.zone = 'nav';

        expect(press('Enter')).toBe(false);
        expect(press('ArrowDown')).toBe(true);
        expect(cursor.cursorId).toBe('a2');
    });

    describe('read from the focused element', () => {
        function mount() {
            document.body.innerHTML = `
                <nav><button id="rail"></button></nav>
                <header><button id="toggle"></button></header>
                <div id="region"><article data-task-id="a1"><button id="title"></button><div data-task-control><button id="chip"></button></div></article></div>
                <aside><button id="panel"></button></aside>`;

            const region = document.getElementById('region')!;
            const element = (id: string) => document.getElementById(id)!;

            return { region, element, zone: () => focusZoneOf(document.activeElement, region) };
        }

        it('is the list on the page, the card and the row, the nav on the rail, and other anywhere else', () => {
            const { element, zone } = mount();
            const zoneOn = (id: string) => {
                element(id).focus();

                return zone();
            };

            expect(zone()).toBe('list');
            expect(zoneOn('title')).toBe('list');
            expect(zoneOn('rail')).toBe('nav');
            expect(zoneOn('toggle')).toBe('other');
            expect(zoneOn('panel')).toBe('other');
        });

        it('leaves an agent chip to its own keys, so Enter on it still opens the run and not the task', () => {
            const { element, zone } = mount();
            const { cursor, ui } = setup(list, 'list', zone);

            element('chip').focus();

            expect(zone()).toBe('other');
            expect(press('Enter', {}, element('chip'))).toBe(false);
            expect(press('ArrowDown', {}, element('chip'))).toBe(false);
            expect(press('j', {}, element('chip'))).toBe(false);
            expect(cursor.cursorId).toBe('a1');
            expect(ui.openTask).not.toHaveBeenCalled();

            element('title').focus();

            expect(press('Enter', {}, element('title'))).toBe(true);
            expect(ui.openTask).toHaveBeenCalledWith('a1');
        });
    });

    it('stays off in a text field', () => {
        const { cursor } = setup(list, 'list');
        const input = document.createElement('input');

        document.body.append(input);

        expect(press('x', {}, input)).toBe(false);
        expect(press('j', {}, input)).toBe(false);
        expect(cursor.selected.size).toBe(0);
        expect(cursor.cursorId).toBe('a1');
    });

    it('does nothing and takes no key when there is no task', () => {
        const { cursor, ui } = setup([[]], 'list');

        for (const key of ['ArrowDown', 'j', 'k', 'x', 'Enter', 'Home', 'End']) expect(press(key)).toBe(false);

        expect(press('a', { metaKey: true })).toBe(false);
        expect(cursor.targets()).toEqual([]);
        expect(ui.openTask).not.toHaveBeenCalled();
    });

    it('leaves Escape alone when there is no panel and no selection', () => {
        setup(list, 'list');

        expect(press('Escape')).toBe(false);
    });
});

describe('Change status', () => {
    const open = (grid: Grid = list) => {
        const harness = setup(grid, 'list');

        press('s');

        return harness;
    };

    it('opens a picker with every status in workflow order, with the cursor task current', () => {
        const harness = setup(list, 'list');

        harness.state.tasks = harness.state.tasks.map(task => (task.id === 'a1' ? { ...task, statusId: 'review' } : task));
        press('s');

        const [picker] = harness.pickers;

        expect(picker.options.map(option => [option.id, option.label])).toEqual([['todo', 'To do'], ['active', 'In progress'], ['review', 'In review'], ['done', 'Done']]);
        expect(picker.selectedIds).toEqual(['review']);
    });

    it('sets the status of the cursor task when one is picked', () => {
        const harness = open();

        harness.pickers[0].onPick('done');

        expect(harness.sent).toEqual([[{ type: 'task.update', taskId: 'a1', statusId: 'done' }]]);
    });

    it('acts on the selection, in the order of the list, and marks no status when the tasks disagree', () => {
        const harness = setup(list, 'list');

        harness.state.tasks = harness.state.tasks.map(task => (task.id === 'a3' ? { ...task, statusId: 'active' } : task));
        press('x');
        press('j');
        press('j');
        press('x');
        press('s');

        expect(harness.pickers[0].selectedIds).toEqual([]);

        harness.pickers[0].onPick('done');

        expect(harness.sent).toEqual([[
            { type: 'task.update', taskId: 'a1', statusId: 'done' },
            { type: 'task.update', taskId: 'a3', statusId: 'done' },
        ]]);
    });

    it('marks the status the selected tasks share', () => {
        const harness = setup(list, 'list');

        press('x');
        press('j');
        press('x');
        press('s');

        expect(harness.pickers[0].selectedIds).toEqual(['todo']);
    });

    it('skips the tasks that are already in the status', () => {
        const harness = setup(list, 'list');

        harness.state.tasks = harness.state.tasks.map(task => (task.id === 'a2' ? { ...task, statusId: 'done' } : task));
        press('a', { metaKey: true });
        press('s');
        harness.pickers[0].onPick('done');

        expect(harness.sent[0].map(input => 'taskId' in input && input.taskId)).toEqual(['a1', 'a3', 'b1', 'c1', 'c2']);
    });

    it('sends nothing when every task is already there', () => {
        const harness = open();

        harness.pickers[0].onPick('todo');

        expect(harness.sent).toEqual([]);
    });

    it('reads the tasks again when one is picked, so a task that went away while the picker was open is left alone', () => {
        const harness = setup(list, 'list');

        press('a', { metaKey: true });
        press('s');
        harness.state.tasks = harness.state.tasks.filter(task => task.id !== 'a2');
        harness.pickers[0].onPick('done');

        expect(harness.sent[0].map(input => 'taskId' in input && input.taskId)).toEqual(['a1', 'a3', 'b1', 'c1', 'c2']);
    });

    it('shows the cursor first when it is not in view and nothing is selected, and acts at once on a selection', () => {
        const harness = setup(list, 'list');

        harness.state.focused = false;
        press('s');

        expect(harness.pickers).toEqual([]);
        expect(harness.reveal).toHaveBeenCalledTimes(1);

        press('a', { metaKey: true });
        press('s');

        expect(harness.pickers).toHaveLength(1);
    });

    it('is off in a text field and while another widget has the focus', () => {
        const harness = setup(list, 'list');
        const input = document.createElement('input');

        document.body.append(input);
        press('s', {}, input);
        harness.state.zone = 'other';
        press('s');

        expect(harness.pickers).toEqual([]);
    });
});

describe('Move to the next or previous status', () => {
    it('moves the cursor task one status on, with Option+Right on macOS, and one back with Option+Left', () => {
        const harness = setup(list, 'list');

        harness.state.tasks = harness.state.tasks.map(task => (task.id === 'a1' ? { ...task, statusId: 'active' } : task));

        expect(press('ArrowRight', { altKey: true })).toBe(true);
        expect(harness.sent).toEqual([[{ type: 'task.update', taskId: 'a1', statusId: 'review' }]]);

        press('ArrowLeft', { altKey: true });

        expect(harness.sent[1]).toEqual([{ type: 'task.update', taskId: 'a1', statusId: 'todo' }]);
    });

    it('moves every selected task, each from its own status, and leaves the ones at the end where they are', () => {
        const harness = setup(list, 'list');

        harness.state.tasks = harness.state.tasks.map(task => ({ ...task, statusId: ({ a1: 'todo', a2: 'active', a3: 'done' } as Record<string, string>)[task.id] ?? 'todo' }));
        press('x');
        press('j');
        press('x');
        press('j');
        press('x');
        press('ArrowRight', { altKey: true });

        expect(harness.sent).toEqual([[
            { type: 'task.update', taskId: 'a1', statusId: 'active' },
            { type: 'task.update', taskId: 'a2', statusId: 'review' },
        ]]);
    });

    it('does nothing at the ends of the workflow, and takes the key all the same', () => {
        const harness = setup(list, 'list');

        expect(press('ArrowLeft', { altKey: true })).toBe(true);

        harness.state.tasks = harness.state.tasks.map(task => ({ ...task, statusId: 'done' }));

        expect(press('ArrowRight', { altKey: true })).toBe(true);
        expect(harness.sent).toEqual([]);
    });

    it('does nothing for a task whose status the workflow no longer has', () => {
        const harness = setup(list, 'list');

        harness.state.tasks = harness.state.tasks.map(task => ({ ...task, statusId: 'removed' }));
        press('ArrowRight', { altKey: true });

        expect(harness.sent).toEqual([]);
    });

    it('moves one step for one press, however long the key is held', () => {
        const harness = setup(list, 'list');

        press('ArrowRight', { altKey: true });
        press('ArrowRight', { altKey: true, repeat: true });
        press('ArrowRight', { altKey: true, repeat: true });

        expect(harness.sent).toHaveLength(1);
    });

    it('works in the list and on the board, and the plain arrows still move the cursor on the board', () => {
        const harness = setup(board);

        press('ArrowRight', { altKey: true });

        expect(harness.sent).toHaveLength(1);
        expect(harness.cursor.cursorId).toBe('a1');

        press('ArrowRight');

        expect(harness.cursor.cursorId).toBe('b1');
        expect(harness.sent).toHaveLength(1);
    });

    it('does not take a modified arrow from a text field', () => {
        const harness = setup(list, 'list');
        const input = document.createElement('input');

        document.body.append(input);

        expect(press('ArrowRight', { altKey: true }, input)).toBe(false);
        expect(harness.sent).toEqual([]);
    });

    it('uses Ctrl+arrows on Windows', () => {
        const registry = createRegistry('win32');
        const harness = setup(list, 'list');
        const commands = taskCommands(harness.deps);

        // The dispatcher `setup` installed listens for the macOS keys.
        uninstall?.();
        registry.pushScope(TASKS_SCOPE);
        commands.forEach(command => registry.defineCommand(command));
        uninstall = installDispatcher(registry);

        expect(press('ArrowRight', { altKey: true })).toBe(false);
        expect(press('ArrowRight', { ctrlKey: true })).toBe(true);
        expect(harness.sent).toEqual([[{ type: 'task.update', taskId: 'a1', statusId: 'active' }]]);
    });
});

describe('Blocked by and blocking', () => {
    // a2 depends on a1, a3 on a2.
    const chain = () => [fakeTask('a1', { number: 1 }), fakeTask('a2', { number: 2, dependsOn: ['a1'] }), fakeTask('a3', { number: 3, dependsOn: ['a2'] }), fakeTask('b1', { number: 4 })];
    const open = (keys: string, cursorOn: string) => {
        const harness = setup([['a1', 'a2', 'a3', 'b1']], 'list', undefined, chain());

        harness.cursor.setCursor(cursorOn);
        press('m');
        press(keys);

        return harness;
    };

    it('M then B lists what the task depends on and what it may still depend on, and marks the links', () => {
        const harness = open('b', 'a2');
        const [picker] = harness.pickers;

        expect(picker.options.map(option => option.id)).toEqual(['a1', 'b1']);
        expect(picker.selectedIds).toEqual(['a1']);
    });

    it('M then X lists what depends on the task and what may start to', () => {
        const harness = open('x', 'a2');
        const [picker] = harness.pickers;

        expect(picker.options.map(option => option.id)).toEqual(['a3', 'b1']);
        expect(picker.selectedIds).toEqual(['a3']);
    });

    it('shows each row as the key and the title, with the status icon', () => {
        const harness = open('b', 'a3');
        const [option] = harness.pickers[0].options;

        expect(option.label).toBe('A1  Task a1');
        expect(option.icon).toBeTruthy();
    });

    it('adds a dependency, sending the whole list', () => {
        const harness = open('b', 'a2');

        harness.pickers[0].onPick('b1');

        expect(harness.sent).toEqual([[{ type: 'task.update', taskId: 'a2', dependsOn: ['a1', 'b1'] }]]);
    });

    it('removes a dependency that is there', () => {
        const harness = open('b', 'a2');

        harness.pickers[0].onPick('a1');

        expect(harness.sent).toEqual([[{ type: 'task.update', taskId: 'a2', dependsOn: [] }]]);
    });

    it('"blocking" changes the list of the picked task, not the cursor task', () => {
        const harness = open('x', 'a2');

        harness.pickers[0].onPick('b1');
        harness.pickers[0].onPick('a3');

        expect(harness.sent).toEqual([
            [{ type: 'task.update', taskId: 'b1', dependsOn: ['a2'] }],
            [{ type: 'task.update', taskId: 'a3', dependsOn: [] }],
        ]);
    });

    it('never offers a loop', () => {
        const blockedBy = open('b', 'a1');

        expect(blockedBy.pickers[0].options.map(option => option.id)).toEqual(['b1']);

        const blocking = open('x', 'a3');

        expect(blocking.pickers[0].options.map(option => option.id)).toEqual(['b1']);
    });

    it('acts on the cursor task and leaves the selection alone', () => {
        const harness = setup([['a1', 'a2', 'a3', 'b1']], 'list', undefined, chain());

        press('a', { metaKey: true });
        press('m');
        press('b');

        expect(harness.pickers).toHaveLength(1);
        expect(harness.cursor.selected.size).toBe(4);
        expect(harness.pickers[0].selectedIds).toEqual([]);
    });

    it('is a chord: M alone opens nothing, and the HUD can say what follows', () => {
        const harness = setup(list, 'list');

        press('m');

        expect(harness.pickers).toEqual([]);

        press('q');

        expect(harness.pickers).toEqual([]);
    });

    it('shows the cursor first when it is not in view', () => {
        const harness = setup(list, 'list');

        harness.state.focused = false;
        press('m');
        press('b');

        expect(harness.pickers).toEqual([]);
        expect(harness.reveal).toHaveBeenCalledTimes(1);
    });

    it('is off for a stale cursor', () => {
        const harness = setup([[]], 'list');

        press('m');
        press('b');

        expect(harness.pickers).toEqual([]);
    });
});

describe('Rename', () => {
    it('opens the cursor task in the panel and asks for its title', () => {
        const harness = setup(list, 'list');

        press('j');

        expect(press('R', { shiftKey: true })).toBe(true);
        expect(harness.ui.openTask).toHaveBeenCalledWith('a2');
        expect(harness.titles).toEqual(['a2']);
    });

    it('takes the cursor task and not the selection', () => {
        const harness = setup(list, 'list');

        press('a', { metaKey: true });
        press('R', { shiftKey: true });

        expect(harness.titles).toEqual(['a1']);
    });

    it('does not take a plain R, and is off in a text field', () => {
        const harness = setup(list, 'list');
        const input = document.createElement('input');

        document.body.append(input);

        expect(press('r')).toBe(false);
        expect(press('R', { shiftKey: true }, input)).toBe(false);
        expect(harness.titles).toEqual([]);
    });

    it('shows the cursor first when it is not in view', () => {
        const harness = setup(list, 'list');

        harness.state.focused = false;
        press('R', { shiftKey: true });

        expect(harness.titles).toEqual([]);
        expect(harness.reveal).toHaveBeenCalledTimes(1);
    });
});

describe('Start', () => {
    it('starts the cursor task on Cmd+Enter', () => {
        const harness = setup(list, 'list');

        press('j');

        expect(press('Enter', { metaKey: true })).toBe(true);
        expect(harness.started).toEqual(['a2']);
        expect(harness.ui.openTask).not.toHaveBeenCalled();
    });

    it('starts the cursor task only, whatever is selected', () => {
        const harness = setup(list, 'list');

        press('a', { metaKey: true });
        press('Enter', { metaKey: true });

        expect(harness.started).toEqual(['a1']);
    });

    it('is off while an agent is working on the task, and does not take the key', () => {
        const harness = setup(list, 'list');

        harness.state.blocked.set('a1', 'Executor 01 is already working on this task.');

        expect(press('Enter', { metaKey: true })).toBe(false);
        expect(harness.started).toEqual([]);

        press('j');

        expect(press('Enter', { metaKey: true })).toBe(true);
        expect(harness.started).toEqual(['a2']);
    });

    it('has no key hint while it is off', () => {
        const registry = createRegistry('darwin');
        const harness = setup(list, 'list');

        registry.pushScope(TASKS_SCOPE);

        for (const command of taskCommands(harness.deps)) registry.defineCommand(command);

        expect(commandHint('tasks.start', registry)).toEqual([['meta', 'enter']]);

        harness.state.blocked.set('a1', 'Busy');

        expect(commandHint('tasks.start', registry)).toBeUndefined();
    });

    it('does not collide with Enter, which opens the task', () => {
        const harness = setup(list, 'list');

        press('Enter');

        expect(harness.started).toEqual([]);
        expect(harness.ui.openTask).toHaveBeenCalledWith('a1');
    });

    it('shows the cursor first when it is not in view, so a start never lands on a task nobody saw', () => {
        const harness = setup(list, 'list');

        harness.state.focused = false;
        press('Enter', { metaKey: true });

        expect(harness.started).toEqual([]);
        expect(harness.reveal).toHaveBeenCalledTimes(1);
    });
});

describe('Delete', () => {
    it('asks once for the whole selection, with the count, before sending anything', () => {
        const harness = setup(list, 'list');

        press('x');
        press('j');
        press('x');
        press('j');
        press('x');

        expect(press('Backspace', { metaKey: true })).toBe(true);
        expect(harness.confirms).toHaveLength(1);
        expect(harness.confirms[0]).toMatchObject({ title: 'Delete 3 tasks?', confirmLabel: 'Delete', destructive: true });
        expect(harness.confirms[0].message).toContain('3 selected tasks');
        expect(harness.sent).toEqual([]);
    });

    it('names the task when it is one', () => {
        const harness = setup(list, 'list');

        press('j');
        press('Backspace', { metaKey: true });

        expect(harness.confirms[0]).toMatchObject({ title: 'Delete A2?' });
        expect(harness.confirms[0].message).toContain('"Task a2"');
    });

    it('deletes every target, in the order of the list, once the person agrees, and closes the panel of a deleted task', async () => {
        const harness = setup(list, 'list');

        press('x');
        press('j');
        press('x');
        harness.ui.taskId = 'a2';
        press('Backspace', { metaKey: true });
        await harness.confirms[0].onConfirm();

        expect(harness.sent).toEqual([[{ type: 'task.delete', taskId: 'a1' }, { type: 'task.delete', taskId: 'a2' }]]);
        expect(harness.ui.openTask).toHaveBeenCalledTimes(1);
        expect(harness.ui.openTask).toHaveBeenCalledWith(null);
    });

    it('leaves the panel of another task open', async () => {
        const harness = setup(list, 'list');

        press('Backspace', { metaKey: true });
        harness.ui.taskId = 'c1';
        await harness.confirms[0].onConfirm();

        expect(harness.ui.openTask).not.toHaveBeenCalled();
    });

    it('keeps the panel open for a task the daemon refused to delete', async () => {
        const harness = setup(list, 'list');

        harness.state.refused.add('a2');
        press('x');
        press('j');
        press('x');
        harness.ui.taskId = 'a2';
        press('Backspace', { metaKey: true });
        await harness.confirms[0].onConfirm();

        expect(harness.ui.openTask).not.toHaveBeenCalled();
    });

    it('uses Ctrl+Delete on Windows', () => {
        const registry = createRegistry('win32');
        const harness = setup(list, 'list');

        uninstall?.();
        registry.pushScope(TASKS_SCOPE);
        taskCommands(harness.deps).forEach(command => registry.defineCommand(command));
        uninstall = installDispatcher(registry);

        expect(press('Backspace', { ctrlKey: true })).toBe(false);
        expect(press('Delete', { ctrlKey: true })).toBe(true);
        expect(harness.confirms).toHaveLength(1);
    });

    it('does not take a plain Backspace or Delete, and is off in a text field', () => {
        const harness = setup(list, 'list');
        const input = document.createElement('input');

        document.body.append(input);

        expect(press('Backspace')).toBe(false);
        expect(press('Delete')).toBe(false);
        expect(press('Backspace', { metaKey: true }, input)).toBe(false);
        expect(harness.confirms).toEqual([]);
    });

    it('acts on a selection at once even when the cursor is out of view, and reveals a lone cursor first', () => {
        const harness = setup(list, 'list');

        harness.state.focused = false;
        press('Backspace', { metaKey: true });

        expect(harness.confirms).toEqual([]);
        expect(harness.reveal).toHaveBeenCalledTimes(1);

        press('a', { metaKey: true });
        press('Backspace', { metaKey: true });

        expect(harness.confirms).toHaveLength(1);
    });
});

describe('while a picker or a dialog is open, or a text field has focus', () => {
    const keys: [string, KeyboardEventInit][] = [
        ['s', {}],
        ['ArrowRight', { altKey: true }],
        ['m', {}],
        ['R', { shiftKey: true }],
        ['Enter', { metaKey: true }],
        ['Backspace', { metaKey: true }],
    ];

    it('leaves every key of Stage 5 alone in a text field', () => {
        const harness = setup(list, 'list');
        const input = document.createElement('input');

        document.body.append(input);

        for (const [key, init] of keys) expect(press(key, init, input)).toBe(false);

        expect([harness.sent, harness.pickers, harness.confirms, harness.started, harness.titles]).toEqual([[], [], [], [], []]);
    });

    it('leaves every key of Stage 5 alone, because the dispatcher treats them as an overlay', () => {
        const harness = setup(list, 'list');
        const popover = document.createElement('div');

        popover.setAttribute('data-modal-clickout-layer', '');
        popover.innerHTML = '<input />';
        document.body.append(popover);

        for (const [key, init] of keys) expect(press(key, init, popover.querySelector('input')!)).toBe(false);

        popover.remove();

        const dialog = document.createElement('div');

        dialog.setAttribute('data-modal-overlay', '');
        document.body.append(dialog);

        for (const [key, init] of keys) expect(press(key, init)).toBe(false);

        expect(harness.pickers).toEqual([]);
        expect(harness.confirms).toEqual([]);
        expect(harness.sent).toEqual([]);
        expect(harness.started).toEqual([]);
        expect(harness.titles).toEqual([]);
    });
});

describe('the keymap', () => {
    it('has no key collisions inside the scope', () => {
        const { deps } = setup(list);

        expect(findKeyConflicts(taskCommands(deps))).toEqual([]);
    });

    it('registers every command of Stages 4 and 5 in the Tasks group', () => {
        const { deps } = setup(list);
        const commands = taskCommands(deps);

        expect(commands.map(command => command.id)).toEqual([
            'tasks.cursor.down',
            'tasks.cursor.up',
            'tasks.cursor.left',
            'tasks.cursor.right',
            'tasks.cursor.first',
            'tasks.cursor.last',
            'tasks.open',
            'tasks.escape',
            'tasks.select.toggle',
            'tasks.select.extend.down',
            'tasks.select.extend.up',
            'tasks.select.all',
            'tasks.status.pick',
            'tasks.status.next',
            'tasks.status.prev',
            'tasks.deps.blockedBy',
            'tasks.deps.blocking',
            'tasks.rename',
            'tasks.start',
            'tasks.delete',
        ]);
        expect(new Set(commands.map(command => command.group))).toEqual(new Set(['Tasks']));
        expect(new Set(commands.map(command => command.scope))).toEqual(new Set([TASKS_SCOPE]));
    });
});
