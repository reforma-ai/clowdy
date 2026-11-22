// @vitest-environment happy-dom
import { openConfirmModal } from '@clowdy/components/modals';
import { toast } from '@clowdy/components/Toast';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { overrideTransport } from '../../daemon/testing';
import { undoStack } from '../../hotkeys/undo';
import { buttonNamed, click, closePage, columnOf, draw, drawn, focusableOf, focusTask, itemOf, mountScreen, openPage, page, press, pressOn, project, ui, wait } from './screenHarness';

import type { OpenConfirmModalOptions } from '@clowdy/components/modals';
import type { CommandResult } from '@clowdy/protocol';
import type { CommandInput } from '../../daemon/transport';

// `Modal` cannot load under the desktop's Vitest (decorators), and neither dialog is opened here: what is asked is read from the mock.
vi.mock('@clowdy/components/modals', () => ({ openConfirmModal: vi.fn() }));
vi.mock('./CreateTaskDialog', () => ({ openCreateTask: vi.fn() }));

/*
 * The ways to archive on the Tasks screen: the menu of a card and of a row, the key, the panel's button and the target a card is dropped on.
 * The demo project at its roots: CAR-20 21 22 done, 23 review, 24 active (an agent works on it), 25 active, 26 27 todo, 28 backlog, 29 canceled, 30 backlog, and Payments (CAR-31)
 * with its tree. The archived CAR-38 to CAR-40 are not on the board.
 */

let sent: CommandInput[];

const daemon = (base: Parameters<NonNullable<Parameters<typeof mountScreen>[0]>['transport'] & {}>[0]) => overrideTransport(base, {
    command: async (input) => {
        sent.push(input);

        return base.command(input);
    },
});

beforeEach(() => {
    sent = [];
    vi.mocked(openConfirmModal).mockClear();
    vi.spyOn(toast, 'error');
    openPage();
});

afterEach(() => {
    closePage();
    document.body.querySelectorAll('[data-modal-clickout-layer]').forEach(layer => layer.remove());
    vi.restoreAllMocks();
});

const archives = () => sent.filter(input => input.type === 'task.archive');
const onBoard = (...ids: string[]) => ids.map(id => project().tasks.has(id));
const panel = (key: string) => page.container.querySelector<HTMLElement>(`aside[aria-label="Task ${ key }"]`);

/** The question the screen asked, which the person has not answered. */
const asked = () => vi.mocked(openConfirmModal).mock.lastCall![0] as OpenConfirmModalOptions;

/** The person agrees to it. */
const agree = () => act(async () => {
    await asked().onConfirm();
});

/** What a right-click on the card or row sends the page. */
const rightClick = (taskId: string, init: MouseEventInit = {}) => act(async () => void itemOf(taskId)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 8, ...init })));
const menuItems = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const menuLabels = () => menuItems().map(row => row.textContent);

/** Presses an item of the menu, and draws what came of it. */
async function choose(label: string) {
    await act(async () => menuItems().find(row => row.textContent === label)!.click());
    await wait(0);
    await draw();
}

describe('the menu of a card', () => {
    it('offers Archive on a closed task, and archives it with what is inside it, with no question', async () => {
        await mountScreen({ transport: daemon });
        await rightClick('t-20');

        expect(menuLabels()).toEqual(['Archive']);

        await choose('Archive');

        expect(vi.mocked(openConfirmModal)).not.toHaveBeenCalled();
        expect(archives()).toEqual([{ type: 'task.archive', taskId: 't-20' }]);
        expect(itemOf('t-20')).toBeNull();
        expect(undoStack.entries.map(entry => entry.label)).toEqual(['Archived CAR-20']);
        expect(document.body.querySelector('[role="menu"]')).toBeNull();
    });

    it('offers Cancel and archive on an open task, and asks first, naming how many open tasks it cancels', async () => {
        await mountScreen({ transport: daemon });
        await rightClick('t-31');

        expect(menuLabels()).toEqual(['Cancel and archive']);

        await choose('Cancel and archive');

        expect(archives()).toEqual([]);
        expect(asked()).toMatchObject({ title: 'Cancel and archive CAR-31?', destructive: true });
        expect(asked().message).toContain('5 open tasks will be canceled first.');

        await agree();
        await draw();

        expect(archives()).toEqual([{ type: 'task.archive', taskId: 't-31', cancel: true }]);
        expect(itemOf('t-31')).toBeNull();
    });

    it('acts on the selection when the card is in it, with the count in the label', async () => {
        await mountScreen({ transport: daemon });
        await pressOn('t-20', 'x');
        await pressOn('t-21', 'x');
        await rightClick('t-21');

        expect(menuLabels()).toEqual(['Archive 2 tasks']);

        await choose('Archive 2 tasks');

        expect(archives()).toEqual([{ type: 'task.archive', taskId: 't-20' }, { type: 'task.archive', taskId: 't-21' }]);
        expect(onBoard('t-20', 't-21')).toEqual([false, false]);
    });

    it('acts on the card alone when it is not in the selection, and says Cancel and archive when any of them is open', async () => {
        await mountScreen({ transport: daemon });
        await pressOn('t-20', 'x');
        await rightClick('t-28');

        expect(menuLabels()).toEqual(['Cancel and archive']);

        await choose('Cancel and archive');

        expect(asked().title).toBe('Cancel and archive CAR-28?');
        expect(onBoard('t-20', 't-28')).toEqual([true, true]);
    });

    it('opens from a row of the list as well, and not from an agent chip, which keeps its own click', async () => {
        await mountScreen({ prepare: window => window.setTasksView('list'), transport: daemon });
        await rightClick('t-22');

        expect(menuLabels()).toEqual(['Archive']);

        await choose('Archive');

        expect(archives()).toEqual([{ type: 'task.archive', taskId: 't-22' }]);
        expect(itemOf('t-22')).toBeNull();
    });

    it('opens from the keyboard\'s menu key, which sends the event to the card that has the focus', async () => {
        await mountScreen({ transport: daemon });
        await focusTask('t-21');
        await act(async () => void focusableOf('t-21').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 })));

        expect(menuLabels()).toEqual(['Archive']);

        await choose('Archive');

        expect(archives()).toEqual([{ type: 'task.archive', taskId: 't-21' }]);
    });

    it('is not offered over the agent chips of a task, which are controls of their own', async () => {
        await mountScreen({ transport: daemon });

        const chip = itemOf('t-24')!.querySelector<HTMLElement>('[data-task-control]');

        expect(chip).not.toBeNull();

        await act(async () => void chip!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 4, clientY: 4 })));

        expect(menuItems()).toEqual([]);
    });

    it('shows what the daemon refuses as the toast, and the task stays', async () => {
        await mountScreen({ transport: daemon });
        await rightClick('t-24');
        await choose('Cancel and archive');
        await agree();
        await draw();

        expect(toast.error).toHaveBeenCalledWith({ message: expect.stringMatching(/^Task CAR-24 has an active run/) });
        expect(itemOf('t-24')).not.toBeNull();
    });
});

describe('the key', () => {
    it('archives the task the keyboard is on', async () => {
        await mountScreen({ transport: daemon });
        await pressOn('t-20', 'e');
        await wait(0);
        await draw();

        expect(archives()).toEqual([{ type: 'task.archive', taskId: 't-20' }]);
        expect(itemOf('t-20')).toBeNull();
        // The keyboard is on the neighbour that took its place.
        expect(document.activeElement).toBe(itemOf('t-21')!.querySelector('button'));
    });

    it('archives the selection, after one question when anything in it is open', async () => {
        await mountScreen({ transport: daemon });
        await pressOn('t-20', 'x');
        await pressOn('t-28', 'x');
        await pressOn('t-28', 'e');

        expect(asked().title).toBe('Cancel and archive 2 tasks?');
        expect(archives()).toEqual([]);

        await agree();
        await draw();

        // In the order the person sees them: the backlog column is before the done column.
        expect(archives()).toEqual([{ type: 'task.archive', taskId: 't-28', cancel: true }, { type: 'task.archive', taskId: 't-20' }]);
    });

    it('is not a key of a text field: typing an e in the search does not archive', async () => {
        await mountScreen({ transport: daemon });
        await focusTask('t-20');

        const field = page.container.querySelector<HTMLInputElement>('input[aria-label="Search tasks"]')!;

        await act(async () => field.focus());

        expect(press('e', {}, field).defaultPrevented).toBe(false);
        expect(archives()).toEqual([]);
        expect(onBoard('t-20')).toEqual([true]);
    });
});

describe('the panel', () => {
    it('has Archive for a closed task, which archives it and closes the panel', async () => {
        await mountScreen({ prepare: window => window.openTask('t-20'), transport: daemon });

        expect(panel('CAR-20')).not.toBeNull();

        await click(buttonNamed('Archive', panel('CAR-20')!));
        await wait(0);
        await draw();

        expect(archives()).toEqual([{ type: 'task.archive', taskId: 't-20' }]);
        expect(onBoard('t-20')).toEqual([false]);
        expect(ui().taskId).toBeNull();
        expect(panel('CAR-20')).toBeNull();
    });

    it('has Cancel and archive for an open task, which asks first with the count and archives the tree once the person agrees', async () => {
        await mountScreen({ prepare: window => window.openTask('t-32'), transport: daemon });

        // CAR-32 is active and holds CAR-33 (done) and CAR-34 (to do): two open tasks, itself and one inside it.
        await click(buttonNamed('Cancel and archive', panel('CAR-32')!));

        expect(archives()).toEqual([]);
        expect(asked().title).toBe('Cancel and archive CAR-32?');
        expect(asked().message).toContain('2 open tasks will be canceled first.');

        await agree();
        await draw();

        expect(archives()).toEqual([{ type: 'task.archive', taskId: 't-32', cancel: true }]);
        expect(onBoard('t-32', 't-33', 't-34')).toEqual([false, false, false]);
        expect(panel('CAR-32')).toBeNull();
    });

    it('keeps the panel and shows the daemon\'s reason when it refuses', async () => {
        await mountScreen({ prepare: window => window.openTask('t-24'), transport: daemon });
        await click(buttonNamed('Cancel and archive', panel('CAR-24')!));
        await agree();
        await draw();

        expect(toast.error).toHaveBeenCalledWith({ message: expect.stringMatching(/^Task CAR-24 has an active run/) });
        expect(panel('CAR-24')).not.toBeNull();
    });
});

/** What a card is dragged with: the transfer carries the task's id under the app's own type. */
const transfer = (taskId: string) => ({ types: ['application/x-clowdy-task'], getData: () => taskId, setData: vi.fn(), effectAllowed: 'none', dropEffect: 'none' });

function dragEvent(type: string, taskId: string) {
    const event = new Event(type, { bubbles: true, cancelable: true });

    Object.defineProperty(event, 'dataTransfer', { value: transfer(taskId) });

    return event;
}

const target = () => page.container.querySelector<HTMLElement>('[data-archive-drop]');
const startDrag = (taskId: string) => act(async () => void itemOf(taskId)!.dispatchEvent(dragEvent('dragstart', taskId)));
const endDrag = (taskId: string) => act(async () => void itemOf(taskId)?.dispatchEvent(dragEvent('dragend', taskId)));

describe('the Archive target of the board', () => {
    it('is not there until a card is dragged, and goes when the drag ends', async () => {
        await mountScreen({ transport: daemon });

        expect(target()).toBeNull();

        await startDrag('t-20');

        expect(target()).not.toBeNull();
        expect(target()!.textContent).toBe('Archive');

        await endDrag('t-20');

        expect(target()).toBeNull();
    });

    describe('when the card is rebuilt mid-drag and its dragend never comes', () => {
        /** An event moves the task to another column: the card that was dragged leaves the page and a new one is drawn, so the browser's `dragend` goes to a node that is gone. */
        async function rebuildCard(taskId: string) {
            const dragged = itemOf(taskId)!;

            await act(async () => void (await page.store.command({ type: 'task.update', taskId, statusId: 'todo' })));
            await draw();

            expect(itemOf(taskId)).not.toBe(dragged);
            expect(dragged.isConnected).toBe(false);

            await act(async () => void dragged.dispatchEvent(dragEvent('dragend', taskId)));
        }

        const pointer = (type: 'pointermove' | 'pointerdown', buttons: number) => act(async () => void document.body.dispatchEvent(new MouseEvent(type, { bubbles: true, buttons })));

        it('goes with the first pointer move that has no button down, which only comes when the drag is over', async () => {
            await mountScreen({ transport: daemon });
            await startDrag('t-20');
            await rebuildCard('t-20');

            expect(target()).not.toBeNull();

            // A move with a button down is not past the drag.
            await pointer('pointermove', 1);

            expect(target()).not.toBeNull();

            await pointer('pointermove', 0);

            expect(target()).toBeNull();
        });

        it('goes with the first press', async () => {
            await mountScreen({ transport: daemon });
            await startDrag('t-20');
            await rebuildCard('t-20');
            await pointer('pointerdown', 1);

            expect(target()).toBeNull();
        });

        it('goes with a dragend or a drop that reaches the window', async () => {
            await mountScreen({ transport: daemon });
            await startDrag('t-20');
            await act(async () => void document.body.dispatchEvent(dragEvent('dragend', 't-20')));

            expect(target()).toBeNull();

            await startDrag('t-21');
            await act(async () => void document.body.dispatchEvent(dragEvent('drop', 't-21')));

            expect(target()).toBeNull();
        });

        it('lets a drop on the strip archive the card first, so the window\'s end of the drag does not cost it', async () => {
            await mountScreen({ transport: daemon });
            await startDrag('t-20');
            await act(async () => void target()!.dispatchEvent(dragEvent('drop', 't-20')));
            await wait(0);

            expect(archives()).toEqual([{ type: 'task.archive', taskId: 't-20' }]);
            expect(target()).toBeNull();
        });
    });

    it('is on the through board too, which draws every level of the scope', async () => {
        await mountScreen({ prepare: (window) => {
            window.setTasksSubtasks(true);
        }, transport: daemon });
        await startDrag('t-20');

        expect(target()).not.toBeNull();
    });

    it('archives a closed task dropped on it, with no question, and goes', async () => {
        await mountScreen({ transport: daemon });
        await startDrag('t-20');
        await act(async () => void target()!.dispatchEvent(dragEvent('drop', 't-20')));
        await wait(0);
        await draw();

        expect(archives()).toEqual([{ type: 'task.archive', taskId: 't-20' }]);
        expect(vi.mocked(openConfirmModal)).not.toHaveBeenCalled();
        expect(itemOf('t-20')).toBeNull();
        expect(target()).toBeNull();
    });

    it('asks first for an open task dropped on it, names how many open tasks it cancels, and archives it once the person agrees', async () => {
        await mountScreen({ transport: daemon });
        await startDrag('t-31');
        await act(async () => void target()!.dispatchEvent(dragEvent('drop', 't-31')));

        expect(archives()).toEqual([]);
        expect(asked().message).toContain('5 open tasks will be canceled first.');
        // The card is still where it was until the person has said yes.
        expect(itemOf('t-31')).not.toBeNull();

        await agree();
        await draw();

        expect(archives()).toEqual([{ type: 'task.archive', taskId: 't-31', cancel: true }]);
        expect(itemOf('t-31')).toBeNull();
    });

    it('takes only the app\'s own drag: a file over it does nothing', async () => {
        await mountScreen({ transport: daemon });
        await startDrag('t-20');

        const over = new Event('dragover', { bubbles: true, cancelable: true });

        Object.defineProperty(over, 'dataTransfer', { value: { types: ['Files'], dropEffect: 'none' } });
        await act(async () => void target()!.dispatchEvent(over));

        expect(over.defaultPrevented).toBe(false);
        expect(target()!.hasAttribute('data-over')).toBe(false);

        const drop = new Event('drop', { bubbles: true, cancelable: true });

        Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], getData: () => 't-20' } });
        await act(async () => void target()!.dispatchEvent(drop));

        expect(archives()).toEqual([]);
    });

    it('is lit while a card is over it, and not any more once the card leaves', async () => {
        await mountScreen({ transport: daemon });
        await startDrag('t-20');
        await act(async () => void target()!.dispatchEvent(dragEvent('dragover', 't-20')));

        expect(target()!.hasAttribute('data-over')).toBe(true);

        await act(async () => void target()!.dispatchEvent(dragEvent('dragleave', 't-20')));

        expect(target()!.hasAttribute('data-over')).toBe(false);
    });

    it('does not change what a drop on a column does: the card moves to that status', async () => {
        await mountScreen({ transport: daemon });
        await startDrag('t-26');

        const column = page.container.querySelector('section[aria-label="Done"]')!;

        await act(async () => void column.dispatchEvent(dragEvent('drop', 't-26')));
        await draw();

        expect(sent).toEqual([{ type: 'task.update', taskId: 't-26', statusId: 'done' }]);
        expect(columnOf('t-26')).toBe('Done');
        expect(archives()).toEqual([]);
        expect(target()).toBeNull();
    });

    it('archives only the card that was dragged, whatever else is selected', async () => {
        await mountScreen({ transport: daemon });
        await pressOn('t-21', 'x');
        await startDrag('t-20');
        await act(async () => void target()!.dispatchEvent(dragEvent('drop', 't-20')));
        await wait(0);
        await draw();

        expect(archives()).toEqual([{ type: 'task.archive', taskId: 't-20' }]);
        expect(drawn()).toContain('t-21');
    });
});
