// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { findKeyConflicts } from '../../hotkeys';
import { installDispatcher } from '../../hotkeys/dispatcher';
import { ListCursor, type Grid } from '../../hotkeys/listCursor';
import { createRegistry } from '../../hotkeys/registry';
import { focusZoneOf, taskCommands, TASKS_SCOPE, type FocusZone, type TaskCommandDeps } from './taskCommands';

import type { TasksView } from '../../stores';

const board: Grid = [['a1', 'a2', 'a3'], ['b1'], [], ['c1', 'c2']];
const list: Grid = [['a1', 'a2', 'a3', 'b1', 'c1', 'c2']];

interface Harness {
    cursor: ListCursor;
    ui: { taskId: string | null; openTask: Mock<(taskId: string | null) => void> };
    reveal: Mock<() => void>;
    known: Set<string>;
    state: { view: TasksView; zone: FocusZone; focused: boolean };
    deps: TaskCommandDeps;
}

let uninstall: (() => void) | undefined;

/**
 * The commands in an isolated registry with the dispatcher on `document`, and the scope pushed as `Screen` does.
 * The focus zone is `state.zone` unless `zoneOf` reads it from the DOM.
 */
function setup(grid: Grid, view: TasksView = 'board', zoneOf?: () => FocusZone): Harness {
    const registry = createRegistry('darwin');
    const cursor = new ListCursor();
    const ui: Harness['ui'] = {
        taskId: null,
        openTask: vi.fn<(taskId: string | null) => void>((id) => {
            ui.taskId = id;
        }),
    };
    const known = new Set(grid.flat());
    const state = { view, zone: 'list' as FocusZone, focused: true };
    const reveal = vi.fn<() => void>();
    const deps: TaskCommandDeps = { cursor, ui, hasTask: id => known.has(id), view: () => state.view, focusZone: zoneOf ?? (() => state.zone), isCursorFocused: () => state.focused, revealCursor: reveal };

    cursor.setGrid(grid);
    registry.pushScope(TASKS_SCOPE);

    for (const command of taskCommands(deps)) registry.defineCommand(command);

    uninstall = installDispatcher(registry);

    return { cursor, ui, reveal, known, state, deps };
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

describe('the keymap', () => {
    it('has no key collisions inside the scope', () => {
        const { deps } = setup(list);

        expect(findKeyConflicts(taskCommands(deps))).toEqual([]);
    });

    it('registers every Stage 4 command in the Tasks group', () => {
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
        ]);
        expect(new Set(commands.map(command => command.group))).toEqual(new Set(['Tasks']));
        expect(new Set(commands.map(command => command.scope))).toEqual(new Set([TASKS_SCOPE]));
    });
});
