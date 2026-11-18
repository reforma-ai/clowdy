// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { commandHint, findKeyConflicts } from '../../hotkeys';
import { installDispatcher } from '../../hotkeys/dispatcher';
import { groupHelpEntries, helpEntries } from '../../hotkeys/helpEntries';
import { ListCursor, type Grid } from '../../hotkeys/listCursor';
import { createRegistry, type HotkeyRegistry } from '../../hotkeys/registry';
import { createUndoStack, type UndoStack } from '../../hotkeys/undo';
import { focusZoneOf, taskCommands, TASKS_SCOPE, type FocusZone, type TaskCommandDeps } from './taskCommands';

import type { OpenConfirmModalOptions } from '@clowdy/components/modals';
import type { CommandResult, Task, TaskStatus } from '@clowdy/protocol';
import type { CommandInput } from '../../daemon/transport';
import type { PickerRequest } from '../../shared/PickerPopover';
import type { TasksView } from '../../stores';

/** The project the harness's undo entries belong to. */
const UNDO_SCOPE = 'p';

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
    ui: {
        taskId: string | null;
        openTask: Mock<(taskId: string | null) => void>;
        openChat: Mock<(chatId: string | null) => void>;
        openDoc: Mock<(path: string | null) => void>;
        setTasksView: Mock<(view: TasksView) => void>;
    };
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
        /** The chats that discuss each task, by task id. */
        chats: Map<string, { id: string; updatedAt: number }[]>;
        /** The newest document of each task, by task id; a task not in it has none. Resolves later than the key, as the daemon does. */
        docs: Map<string, string>;
        /** Makes the lookup of a task's documents fail. */
        docsFail: boolean;
    };
    /** What the commands sent, one array per call. */
    sent: CommandInput[][];
    pickers: PickerRequest[];
    confirms: OpenConfirmModalOptions[];
    started: string[];
    titles: string[];
    registry: HotkeyRegistry;
    /** The history `Cmd/Ctrl+Z` takes back from. */
    undo: UndoStack;
    /** What the commands asked the screen to do. */
    asked: { created: number; filter: number; search: number };
    copied: { text: string; message: string }[];
    notices: { message: string; tone?: 'info' | 'error' }[];
    /** The tasks opened inside `replacing`, which overwrites the history entry. */
    replaced: (string | null)[];
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
    const replaced: Harness['replaced'] = [];
    let isReplacing = false;
    const ui: Harness['ui'] = {
        taskId: null,
        openTask: vi.fn<(taskId: string | null) => void>((id) => {
            ui.taskId = id;

            if (isReplacing) replaced.push(id);
        }),
        openChat: vi.fn<(chatId: string | null) => void>(),
        openDoc: vi.fn<(path: string | null) => void>(),
        setTasksView: vi.fn<(view: TasksView) => void>((next) => {
            state.view = next;
        }),
    };
    const known = new Set(grid.flat());
    const state: Harness['state'] = { view, zone: 'list', focused: true, tasks, refused: new Set(), blocked: new Map(), chats: new Map(), docs: new Map(), docsFail: false };
    const reveal = vi.fn<() => void>();
    const sent: CommandInput[][] = [];
    const pickers: PickerRequest[] = [];
    const confirms: OpenConfirmModalOptions[] = [];
    const started: string[] = [];
    const titles: string[] = [];
    const asked = { created: 0, filter: 0, search: 0 };
    const copied: Harness['copied'] = [];
    const notices: Harness['notices'] = [];
    const undo = createUndoStack();
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
        undo: { canUndo: () => undo.canUndo(UNDO_SCOPE), undoLatest: () => undo.undoLatest(UNDO_SCOPE) },
        start: async (id) => {
            started.push(id);
        },
        openPicker: request => pickers.push(request),
        confirm: options => confirms.push(options),
        focusTitle: id => titles.push(id),
        create: () => void asked.created++,
        openFilter: () => void asked.filter++,
        focusSearch: () => void asked.search++,
        chatsOf: id => state.chats.get(id) ?? [],
        docPathOf: async (id) => {
            if (state.docsFail) throw new Error('No answer');

            return state.docs.get(id) ?? null;
        },
        copy: (text, message) => copied.push({ text, message }),
        notify: (message, tone) => notices.push({ message, tone }),
        replacing: (change) => {
            isReplacing = true;

            try {
                change();
            }
            finally {
                isReplacing = false;
            }
        },
    };

    cursor.setGrid(grid);
    registry.pushScope(TASKS_SCOPE);

    for (const command of taskCommands(deps)) registry.defineCommand(command);

    uninstall = installDispatcher(registry);

    return { cursor, ui, reveal, known, state, sent, pickers, confirms, started, titles, registry, undo, asked, copied, notices, replaced, deps };
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

    it('follows as a replacement of the history entry, and opens on purpose as a new one', () => {
        const { ui, replaced } = setup(list, 'list');

        ui.taskId = 'a1';
        press('j');
        press('ArrowDown');

        expect(replaced).toEqual(['a2', 'a3']);

        press('Enter');

        expect(ui.openTask).toHaveBeenLastCalledWith('a3');
        expect(replaced).toEqual(['a2', 'a3']);
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
                <div id="region"><button id="column"></button><article data-task-id="a1"><button id="title"></button><div data-task-control><button id="chip"></button></div></article></div>
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

        it('is other for a control in the region that is not a card or row, such as a column header, which keeps its own arrows', () => {
            const { element, zone } = mount();

            element('column').focus();

            expect(zone()).toBe('other');
        });

        it('is the nav only for the shell\'s navigation, and other for a nav inside the screen', () => {
            document.body.innerHTML = '<nav><button id="rail"></button></nav><main><nav><button id="crumb"></button></nav><div id="region"></div></main>';

            const region = document.getElementById('region');

            document.getElementById('rail')!.focus();

            expect(focusZoneOf(document.activeElement, region)).toBe('nav');

            document.getElementById('crumb')!.focus();

            expect(focusZoneOf(document.activeElement, region)).toBe('other');
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

    it('starts the task the panel shows, not the one the pointer moved the cursor to', () => {
        const harness = setup(list, 'list');

        harness.ui.taskId = 'a1';
        harness.deps.cursor.setCursor('a2');

        expect(press('Enter', { metaKey: true })).toBe(true);
        expect(harness.started).toEqual(['a1']);
    });

    it('asks about the open task, not the cursor task, while the panel is open', () => {
        const registry = createRegistry('darwin');
        const harness = setup(list, 'list');

        registry.pushScope(TASKS_SCOPE);

        for (const command of taskCommands(harness.deps)) registry.defineCommand(command);

        harness.ui.taskId = 'a1';
        harness.deps.cursor.setCursor('a2');
        harness.state.blocked.set('a2', 'Busy');

        expect(commandHint('tasks.start', registry)).toEqual([['meta', 'enter']]);

        harness.state.blocked.set('a1', 'Busy');

        expect(commandHint('tasks.start', registry)).toBeUndefined();
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

describe('New task, view, filter and search', () => {
    it('C opens the New task dialog', () => {
        const harness = setup(list, 'list');

        expect(press('c')).toBe(true);
        expect(harness.asked.created).toBe(1);
    });

    it('C is a plain key: not with a modifier, not in a text field, and not while the key is held', () => {
        const harness = setup(list, 'list');
        const input = document.createElement('input');

        document.body.append(input);

        expect(press('c', { metaKey: true })).toBe(false);
        expect(press('c', {}, input)).toBe(false);
        expect(press('c', { repeat: true })).toBe(true);
        expect(harness.asked.created).toBe(0);
    });

    it('C, F and / work with no task, and while a widget of the screen has the focus', () => {
        const empty = setup([[]], 'list');

        press('c');
        press('f');
        press('/');

        expect(empty.asked).toEqual({ created: 1, filter: 1, search: 1 });

        const harness = setup(list, 'list');

        harness.state.zone = 'other';
        press('c');
        press('f');
        press('/');

        expect(harness.asked).toEqual({ created: 1, filter: 1, search: 1 });
    });

    it('F opens the filter and / puts the keyboard in the search field', () => {
        const harness = setup(list, 'list');

        press('f');

        expect(harness.asked).toEqual({ created: 0, filter: 1, search: 0 });

        press('/');

        expect(harness.asked).toEqual({ created: 0, filter: 1, search: 1 });
    });

    it('takes the / key, so it is not typed into the search field it focuses', () => {
        setup(list, 'list');

        // The dispatcher calls `preventDefault` on a key a command takes, which cancels the character the keypress would have inserted.
        expect(press('/')).toBe(true);
        expect(press('/', {}, document.createElement('input'))).toBe(false);
    });

    it('keeps / and ? apart: a ? is the help key, not a search', () => {
        const harness = setup(list, 'list');

        expect(press('?', { shiftKey: true })).toBe(false);
        expect(harness.asked.search).toBe(0);
    });

    it('Cmd+B switches between the board and the list, whichever it shows', () => {
        const harness = setup(board);

        expect(press('b', { metaKey: true })).toBe(true);
        expect(harness.ui.setTasksView).toHaveBeenLastCalledWith('list');

        press('b', { metaKey: true });

        expect(harness.ui.setTasksView).toHaveBeenLastCalledWith('board');
    });

    it('Cmd+B does not take a plain B, and is off in a text field', () => {
        const harness = setup(board);
        const input = document.createElement('input');

        document.body.append(input);

        expect(press('b')).toBe(false);
        expect(press('b', { metaKey: true }, input)).toBe(false);
        expect(harness.ui.setTasksView).not.toHaveBeenCalled();
    });

    it('uses Ctrl+B on Windows', () => {
        const registry = createRegistry('win32');
        const harness = setup(board);

        uninstall?.();
        registry.pushScope(TASKS_SCOPE);
        taskCommands(harness.deps).forEach(command => registry.defineCommand(command));
        uninstall = installDispatcher(registry);

        expect(press('b', { metaKey: true })).toBe(false);
        expect(press('b', { ctrlKey: true })).toBe(true);
        expect(harness.ui.setTasksView).toHaveBeenCalledTimes(1);
    });

    it('is off while a dialog or a popover is open', () => {
        const harness = setup(list, 'list');
        const dialog = document.createElement('div');

        dialog.setAttribute('data-modal-overlay', '');
        document.body.append(dialog);

        for (const [key, init] of [['c', {}], ['f', {}], ['/', {}], ['b', { metaKey: true }]] as [string, KeyboardEventInit][]) expect(press(key, init)).toBe(false);

        expect(harness.asked).toEqual({ created: 0, filter: 0, search: 0 });
    });
});

describe('Copy the key or the title', () => {
    it('Cmd+. copies the key of the cursor task and says so', () => {
        const harness = setup(list, 'list');

        press('j');

        expect(press('.', { metaKey: true })).toBe(true);
        expect(harness.copied).toEqual([{ text: 'A2', message: 'Copied A2' }]);
    });

    it('Cmd+Shift+\' copies the title, by the physical key because Shift types a double quote', () => {
        const harness = setup(list, 'list');

        press('j');

        expect(press('"', { metaKey: true, shiftKey: true, code: 'Quote' })).toBe(true);
        expect(harness.copied).toEqual([{ text: 'Task a2', message: 'Copied the title of A2' }]);
    });

    it('copies a line per task of the selection, in the order of the list, and says how many', () => {
        const harness = setup(list, 'list');

        press('ArrowDown');
        press('ArrowDown');
        press('x');
        press('ArrowUp');
        press('ArrowUp');
        press('x');
        press('.', { metaKey: true });
        press('"', { metaKey: true, shiftKey: true, code: 'Quote' });

        expect(harness.copied).toEqual([
            { text: 'A1\nA3', message: 'Copied 2 task keys' },
            { text: 'Task a1\nTask a3', message: 'Copied 2 task titles' },
        ]);
    });

    it('does not take the key it cannot write: a plain period, a Shift-only quote, and a text field', () => {
        const harness = setup(list, 'list');
        const input = document.createElement('input');

        document.body.append(input);

        expect(press('.')).toBe(false);
        expect(press('"', { shiftKey: true, code: 'Quote' })).toBe(false);
        expect(press('.', { metaKey: true }, input)).toBe(false);
        expect(harness.copied).toEqual([]);
    });

    it('acts at once: a copy changes nothing, so it needs neither the cursor on screen nor the focus on the list', () => {
        const harness = setup(list, 'list');

        harness.state.focused = false;
        harness.state.zone = 'other';
        press('.', { metaKey: true });

        expect(harness.copied).toEqual([{ text: 'A1', message: 'Copied A1' }]);
        expect(harness.reveal).not.toHaveBeenCalled();
    });

    it('is off, with no key hint, when there is no task to copy', () => {
        const harness = setup([[]], 'list');

        expect(press('.', { metaKey: true })).toBe(false);
        expect(commandHint('tasks.copy.key', harness.registry)).toBeUndefined();
    });

    it('shows the keys as the capsules read them', () => {
        const { registry } = setup(list, 'list');

        expect(commandHint('tasks.copy.key', registry)).toEqual([['meta', '.']]);
        expect(commandHint('tasks.copy.title', registry)).toEqual([['shift', 'meta', '\'']]);
    });
});

describe('Open the linked chat and document', () => {
    it('O then C opens the newest chat of the cursor task', () => {
        const harness = setup(list, 'list');

        harness.state.chats.set('a2', [{ id: 'older', updatedAt: 5 }, { id: 'newest', updatedAt: 9 }, { id: 'middle', updatedAt: 7 }]);
        press('j');
        press('o');

        expect(press('c')).toBe(true);
        expect(harness.ui.openChat).toHaveBeenCalledTimes(1);
        expect(harness.ui.openChat).toHaveBeenCalledWith('newest');
    });

    it('takes the cursor task and not the selection', () => {
        const harness = setup(list, 'list');

        harness.state.chats.set('a1', [{ id: 'mine', updatedAt: 1 }]);
        harness.state.chats.set('a2', [{ id: 'other', updatedAt: 2 }]);
        press('a', { metaKey: true });
        press('o');
        press('c');

        expect(harness.ui.openChat).toHaveBeenCalledWith('mine');
    });

    it('is offered for every task with a cursor, with its hint, whether or not the task has a chat', () => {
        const harness = setup(list, 'list');

        expect(commandHint('tasks.chat.open', harness.registry)).toEqual([['o'], ['c']]);
        expect(harness.registry.listCommands().live.map(command => command.id)).toContain('tasks.chat.open');

        const empty = setup([[]], 'list');

        expect(commandHint('tasks.chat.open', empty.registry)).toBeUndefined();
    });

    it('says so, and opens nothing, for a task that has no chat, and does not fall through to New task', () => {
        const harness = setup(list, 'list');

        press('o');

        expect(press('c')).toBe(true);
        expect(harness.ui.openChat).not.toHaveBeenCalled();
        expect(harness.notices).toEqual([{ message: 'A1 has no chat yet', tone: undefined }]);
        expect(harness.asked.created).toBe(0);
    });

    it('O then D opens the newest document the daemon lists for the cursor task, in Documents', async () => {
        const harness = setup(list, 'list');

        harness.state.docs.set('a2', 'decisions/pricing.md');
        press('j');
        press('o');
        press('d');

        // Nothing happens before the daemon answers.
        expect(harness.ui.openDoc).not.toHaveBeenCalled();

        await vi.waitFor(() => expect(harness.ui.openDoc).toHaveBeenCalledWith('decisions/pricing.md'));

        expect(harness.notices).toEqual([]);
    });

    it('says so, and opens nothing, when the task has no document', async () => {
        const harness = setup(list, 'list');

        press('o');
        press('d');
        await vi.waitFor(() => expect(harness.notices).toHaveLength(1));

        expect(harness.notices[0]).toEqual({ message: 'A1 has no document yet', tone: undefined });
        expect(harness.ui.openDoc).not.toHaveBeenCalled();
    });

    it('says so when the daemon does not answer', async () => {
        const harness = setup(list, 'list');

        harness.state.docsFail = true;
        press('o');
        press('d');
        await vi.waitFor(() => expect(harness.notices).toHaveLength(1));

        expect(harness.notices[0]).toEqual({ message: 'Could not load the results of A1: No answer', tone: 'error' });
        expect(harness.ui.openDoc).not.toHaveBeenCalled();
    });

    it('O D is offered for every task with a cursor, because only the daemon knows whether it has a document', () => {
        const harness = setup(list, 'list');

        expect(commandHint('tasks.doc.open', harness.registry)).toEqual([['o'], ['d']]);

        const empty = setup([[]], 'list');

        expect(commandHint('tasks.doc.open', empty.registry)).toBeUndefined();
    });

    it('shows the cursor first when it is not in view, like the other keys that act on the cursor task', () => {
        const harness = setup(list, 'list');

        harness.state.chats.set('a1', [{ id: 'c1', updatedAt: 1 }]);
        harness.state.focused = false;
        press('o');
        press('c');

        expect(harness.ui.openChat).not.toHaveBeenCalled();
        expect(harness.reveal).toHaveBeenCalledTimes(1);
    });

    it('stays off while another widget of the screen has the focus', () => {
        const harness = setup(list, 'list');

        harness.state.chats.set('a1', [{ id: 'c1', updatedAt: 1 }]);
        harness.state.zone = 'other';

        expect(press('o')).toBe(false);
        expect(harness.ui.openChat).not.toHaveBeenCalled();
    });
});

describe('Undo', () => {
    /** An entry that counts its runs, and resolves to `worked`. */
    const entryOf = (label: string, worked = true) => ({ scope: UNDO_SCOPE, label, undo: vi.fn<() => Promise<boolean>>(async () => worked) });

    it('leaves the changes of another project alone: no key, no hint, nothing taken back', async () => {
        const harness = setup(list, 'list');
        const elsewhere = { ...entryOf('in another project'), scope: 'another-project' };

        harness.undo.push(elsewhere);

        expect(press('z', { metaKey: true })).toBe(false);
        await Promise.resolve();

        expect(elsewhere.undo).not.toHaveBeenCalled();
        expect(harness.undo.canUndo('another-project')).toBe(true);
    });

    it('takes back the latest change with Cmd+Z, and claims the key', async () => {
        const harness = setup(list, 'list');
        const first = entryOf('first');
        const second = entryOf('second');

        harness.undo.push(first);
        harness.undo.push(second);

        expect(press('z', { metaKey: true })).toBe(true);
        await Promise.resolve();

        expect(second.undo).toHaveBeenCalledTimes(1);
        expect(first.undo).not.toHaveBeenCalled();
        expect(harness.undo.entries).toEqual([first]);
    });

    it('is Ctrl+Z on Windows', async () => {
        const registry = createRegistry('win32');
        const harness = setup(list, 'list');
        const entry = entryOf('change');

        // The harness registry is the Mac one; the command's keys are the same string, which the Windows registry reads as Ctrl.
        registry.pushScope(TASKS_SCOPE);
        taskCommands(harness.deps).forEach(command => registry.defineCommand(command));
        uninstall?.();
        uninstall = installDispatcher(registry);
        harness.undo.push(entry);

        expect(press('z', { metaKey: true })).toBe(false);
        expect(press('z', { ctrlKey: true })).toBe(true);
        await Promise.resolve();

        expect(entry.undo).toHaveBeenCalledTimes(1);
    });

    it('is off, and leaves the key to the page, while there is nothing to take back', () => {
        const harness = setup(list, 'list');

        expect(press('z', { metaKey: true })).toBe(false);
        expect(harness.registry.listCommands().live.map(command => command.id)).not.toContain('tasks.undo');
        expect(commandHint('tasks.undo', harness.registry)).toBeUndefined();
    });

    it('turns on with the first change and off again when the history is empty, for the hint and for what the overlay marks as available', async () => {
        const harness = setup(list, 'list');
        const isLive = () => harness.registry.listCommands().live.some(command => command.id === 'tasks.undo');

        expect(isLive()).toBe(false);

        harness.undo.push(entryOf('change'));

        expect(isLive()).toBe(true);
        expect(commandHint('tasks.undo', harness.registry)).toEqual([['meta', 'z']]);

        await harness.undo.undoLatest(UNDO_SCOPE);

        expect(isLive()).toBe(false);
        expect(commandHint('tasks.undo', harness.registry)).toBeUndefined();
        expect(press('z', { metaKey: true })).toBe(false);
    });

    it('does not need the list to have the focus: the history is the window\'s', async () => {
        const harness = setup(list, 'list');
        const entry = entryOf('change');

        harness.state.zone = 'other';
        harness.undo.push(entry);

        expect(press('z', { metaKey: true })).toBe(true);
        await Promise.resolve();

        expect(entry.undo).toHaveBeenCalledTimes(1);
    });

    it('leaves Cmd+Z to a text field, which undoes its own typing', () => {
        const harness = setup(list, 'list');
        const entry = entryOf('change');
        const input = document.createElement('input');
        const area = document.createElement('textarea');

        document.body.append(input, area);
        harness.undo.push(entry);

        expect(press('z', { metaKey: true }, input)).toBe(false);
        expect(press('z', { metaKey: true }, area)).toBe(false);
        expect(entry.undo).not.toHaveBeenCalled();
        expect(harness.undo.canUndo(UNDO_SCOPE)).toBe(true);
    });

    it('leaves Cmd+Z alone while a picker, a popover or a dialog is open', () => {
        const harness = setup(list, 'list');
        const entry = entryOf('change');
        const popover = document.createElement('div');

        popover.setAttribute('data-modal-clickout-layer', '');
        popover.innerHTML = '<input />';
        document.body.append(popover);
        harness.undo.push(entry);

        expect(press('z', { metaKey: true }, popover.querySelector('input')!)).toBe(false);

        popover.remove();

        const dialog = document.createElement('div');

        dialog.setAttribute('data-modal-overlay', '');
        document.body.append(dialog);

        expect(press('z', { metaKey: true })).toBe(false);
        expect(entry.undo).not.toHaveBeenCalled();
        expect(harness.undo.canUndo(UNDO_SCOPE)).toBe(true);
    });

    it('does not take Cmd+Shift+Z, which is redo to the menu', () => {
        const harness = setup(list, 'list');

        harness.undo.push(entryOf('change'));

        expect(press('z', { metaKey: true, shiftKey: true })).toBe(false);
    });
});

describe('where the focus is, and the help overlay and the key hints', () => {
    it('keeps a key off while a widget has the focus, but the command is still listed and still has its hint', () => {
        const harness = setup(list, 'list');

        harness.state.zone = 'other';

        expect(press('j')).toBe(false);
        expect(harness.registry.listCommands().live.map(command => command.id)).toContain('tasks.cursor.down');
        expect(commandHint('tasks.cursor.down', harness.registry)).toEqual([['down']]);
        expect(commandHint('tasks.start', harness.registry)).toEqual([['meta', 'enter']]);
        expect(commandHint('tasks.delete', harness.registry)).toEqual([['meta', 'backspace']]);
    });

    it('lists every Tasks command as live for the screen, wherever the focus is', () => {
        const harness = setup(list, 'list');

        harness.state.zone = 'other';

        const dead = harness.registry.listCommands().all.filter(command => !harness.registry.listCommands().live.includes(command)).map(command => command.id);

        // Only what has nothing to act on: the board's column keys in a list, Escape with nothing open or selected, and Undo with nothing to take back.
        expect(dead.sort()).toEqual(['tasks.cursor.left', 'tasks.cursor.right', 'tasks.escape', 'tasks.undo'].sort());
    });
});

describe('the help overlay', () => {
    it('shows every command under Tasks with a title that says what it does', () => {
        const harness = setup(list, 'list');
        const groups = groupHelpEntries(helpEntries(harness.registry));

        expect(groups.map(group => group.name)).toEqual(['Tasks']);

        const titles = groups[0].entries.map(entry => entry.command.title);

        expect(new Set(titles).size).toBe(titles.length);
        expect(titles.every(title => title.trim().length >= 4 && !title.endsWith('.'))).toBe(true);
        expect(titles).toEqual(expect.arrayContaining(['New task', 'Switch between board and list', 'Filter tasks', 'Search tasks', 'Copy task key', 'Copy task title', 'Open linked chat', 'Open latest document']));
    });

    it('writes the new keys as the capsules read them', () => {
        const harness = setup(list, 'list');
        const keysOf = (id: string) => helpEntries(harness.registry).find(entry => entry.command.id === id)?.sequences;

        expect(keysOf('tasks.create')).toEqual([[['c']]]);
        expect(keysOf('tasks.view.toggle')).toEqual([[['meta', 'b']]]);
        expect(keysOf('tasks.filter')).toEqual([[['f']]]);
        expect(keysOf('tasks.search')).toEqual([[['/']]]);
        expect(keysOf('tasks.chat.open')).toEqual([[['o'], ['c']]]);
        expect(keysOf('tasks.doc.open')).toEqual([[['o'], ['d']]]);
    });
});

describe('the keymap', () => {
    it('has no key collisions inside the scope', () => {
        const { deps } = setup(list);

        expect(findKeyConflicts(taskCommands(deps))).toEqual([]);
    });

    it('registers every Tasks command in the Tasks group', () => {
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
            'tasks.create',
            'tasks.view.toggle',
            'tasks.filter',
            'tasks.search',
            'tasks.copy.key',
            'tasks.copy.title',
            'tasks.chat.open',
            'tasks.doc.open',
            'tasks.undo',
        ]);
        expect(new Set(commands.map(command => command.group))).toEqual(new Set(['Tasks']));
        expect(new Set(commands.map(command => command.scope))).toEqual(new Set([TASKS_SCOPE]));
    });
});
