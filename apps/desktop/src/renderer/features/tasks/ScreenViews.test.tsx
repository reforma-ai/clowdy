// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { hotkeys } from '../../hotkeys';
import { openCreateTask } from './CreateTaskDialog';
import {
    buttonNamed,
    change,
    click,
    closePage,
    columnOf,
    draw,
    drawn,
    drawnKeys,
    drop,
    focusableOf,
    focusTask,
    isOn,
    itemOf,
    memoryStorage,
    mountScreen,
    openPage,
    page,
    pathText,
    pressOn,
    project,
    reloadScreen,
    search,
    ui,
    wait,
} from './screenHarness';

import type { ProjectUi } from '../../stores';

// `Modal` cannot load under the desktop's Vitest (decorators), and neither dialog is opened here.
vi.mock('@clowdy/components/modals', () => ({ openConfirmModal: vi.fn() }));
vi.mock('./CreateTaskDialog', () => ({ openCreateTask: vi.fn() }));

/*
 * The views of the Tasks screen on the demo project: CAR-20 to CAR-30 and the tree of Payments (CAR-31 with CAR-32, CAR-35, CAR-36, CAR-37, and CAR-33 and CAR-34 inside CAR-32).
 * In workflow order the statuses are Backlog, To do, In progress, Review, Done and Canceled.
 */

beforeEach(openPage);

afterEach(() => {
    closePage();
    vi.mocked(openCreateTask).mockClear();
});

const chipOf = (taskId: string) =>
    itemOf(taskId)!.querySelector<HTMLElement>('button[aria-label^="Open sub-tasks of"]');
const checklistOf = (taskId: string) => itemOf(taskId)!.querySelector<HTMLElement>('[title$="steps done"]');
const rowDepths = () =>
    [...page.container.querySelectorAll<HTMLElement>('tr[data-task-id]')].map(row => [
        row.dataset.taskId,
        Number(row.dataset.depth),
    ]);
const selected = () =>
    [...page.container.querySelectorAll<HTMLElement>('[data-task-id]')]
        .filter(item => item.hasAttribute('data-selected') || item.getAttribute('aria-selected') === 'true')
        .map(item => item.dataset.taskId);
const chevronOf = (taskId: string) => itemOf(taskId)!.querySelector<HTMLElement>('button[aria-expanded]')!;
const isTable = () => page.container.querySelector('table') !== null;

/** A window inside a task, with the list: a task's own page has a view of its own, which `tasksView` of the roots does not set. */
const listInside = (scope: string = 't-31') => ({
    prepare: (window: ProjectUi) => {
        window.setTasksScope(scope);
        window.setTaskPageView('list');
    },
});

describe('the board of one level', () => {
    it('is what the screen starts with, at the roots and inside a task', async () => {
        await mountScreen();

        expect(isTable()).toBe(false);
        expect(isOn('Board')).toBe(true);
        expect(isOn('Sub-tasks')).toBe(false);
        expect(drawn()).toHaveLength(12);

        await click(chipOf('t-31'));

        expect(isTable()).toBe(false);
        expect(drawn()).toEqual(['t-35', 't-32', 't-36', 't-37']);
    });

    it('puts the tasks in the columns of their status', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-31') });

        expect([columnOf('t-35'), columnOf('t-32'), columnOf('t-36'), columnOf('t-37')]).toEqual([
            'To do',
            'In progress',
            'Review',
            'Canceled',
        ]);
    });

    it('moves a card to another column by dropping it, and the status is all it changes', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-31') });

        const before = project().tasks.get('t-35')!;

        await drop('t-35', 'Review');

        expect(columnOf('t-35')).toBe('Review');
        expect(project().tasks.get('t-35')).toMatchObject({
            statusId: 'review',
            parentId: before.parentId,
            title: before.title,
        });
    });
});

describe('the board with the sub-tasks shown', () => {
    it('flattens every task below the scope onto it, a card for each, whatever its depth', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-31') });
        await click(buttonNamed('Sub-tasks'));

        expect(isOn('Sub-tasks')).toBe(true);
        expect(ui().tasksSubtasks).toBe(true);
        expect(drawn().sort()).toEqual(['t-32', 't-33', 't-34', 't-35', 't-36', 't-37']);
        expect([columnOf('t-34'), columnOf('t-33')]).toEqual(['To do', 'Done']);
    });

    it('draws every task of the project at the roots', async () => {
        await mountScreen();
        await click(buttonNamed('Sub-tasks'));

        expect(drawn()).toHaveLength(project().taskList.length);
    });

    it('names the task a card is inside, muted, unless it is the scope', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-31') });
        await click(buttonNamed('Sub-tasks'));

        const parentOf = (taskId: string) => itemOf(taskId)!.querySelector('[title^="Sub-task of"]')?.textContent;

        // CAR-32 is directly inside the scope, which the header names; CAR-33 is inside CAR-32.
        expect(parentOf('t-32')).toBeUndefined();
        expect(parentOf('t-33')).toBe('in CAR-32');
        expect(parentOf('t-34')).toBe('in CAR-32');
    });

    it('names the parent of every card that has one at the roots', async () => {
        await mountScreen();
        await click(buttonNamed('Sub-tasks'));

        expect(itemOf('t-32')!.querySelector('[title^="Sub-task of"]')?.textContent).toBe('in CAR-31');
        expect(itemOf('t-24')!.querySelector('[title^="Sub-task of"]')).toBeNull();
    });

    it('still changes only the status when a card is dropped on a column', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-31') });
        await click(buttonNamed('Sub-tasks'));
        await drop('t-33', 'Review');

        expect(columnOf('t-33')).toBe('Review');
        expect(project().tasks.get('t-33')).toMatchObject({ statusId: 'review', parentId: 't-32' });
    });

    it('turns the toggle off again, back to one level', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-31') });
        await click(buttonNamed('Sub-tasks'));
        await click(buttonNamed('Sub-tasks'));

        expect(ui().tasksSubtasks).toBe(false);
        expect(drawn()).toHaveLength(4);
    });
});

describe('the list as a tree', () => {
    it('draws the tasks of the scope under their parents, each level in workflow order, a status label on every row', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-31') });
        await click(buttonNamed('List'));

        expect(isTable()).toBe(true);
        expect(rowDepths()).toEqual([
            ['t-35', 0],
            ['t-32', 0],
            ['t-34', 1],
            ['t-33', 1],
            ['t-36', 0],
            ['t-37', 0],
        ]);

        const status = (taskId: string) => itemOf(taskId)!.querySelectorAll('td')[2].textContent;

        expect([
            status('t-35'),
            status('t-32'),
            status('t-34'),
            status('t-33'),
            status('t-36'),
            status('t-37'),
        ]).toEqual(['To do', 'In progress', 'To do', 'Done', 'Review', 'Canceled']);
    });

    it("draws the roots with every task inside them at the project's root", async () => {
        await mountScreen({ prepare: window => window.setTasksView('list') });

        const depths = rowDepths();

        expect(depths).toHaveLength(project().taskList.length);
        expect(depths.find(([id]) => id === 't-33')).toEqual(['t-33', 2]);
        expect(depths.find(([id]) => id === 't-24')).toEqual(['t-24', 0]);
    });

    it('says the level of every row to a screen reader, which a table row cannot carry, counted from the first level the list shows', async () => {
        await mountScreen({ prepare: window => window.setTasksView('list') });

        // The first cell of the title is the words for a screen reader: not drawn, before the line the title is on.
        const level = (taskId: string) => itemOf(taskId)!.querySelector<HTMLElement>('td:nth-of-type(2) > span');

        expect([level('t-24'), level('t-31'), level('t-32'), level('t-33')].map(item => item?.textContent)).toEqual([
            'Level 1',
            'Level 1',
            'Level 2',
            'Level 3',
        ]);
        expect(itemOf('t-33')!.querySelector('td:nth-of-type(2) > div')?.textContent).not.toContain('Level');
    });

    it('counts the levels from the scope: the tasks inside a task start at Level 1', async () => {
        await mountScreen(listInside());

        expect(
            ['t-32', 't-33'].map(taskId => itemOf(taskId)!.querySelector('td:nth-of-type(2) > span')?.textContent)
        ).toEqual(['Level 1', 'Level 2']);
    });

    it('has no sub-tasks toggle, since it is always a tree', async () => {
        await mountScreen({ prepare: window => window.setTasksView('list') });

        expect(buttonNamed('Sub-tasks')).toBeUndefined();
    });

    it('folds a row with its chevron, and opens it again', async () => {
        await mountScreen(listInside());

        expect(chevronOf('t-32').getAttribute('aria-expanded')).toBe('true');
        expect(itemOf('t-34')).not.toBeNull();

        await click(chevronOf('t-32'));

        expect(ui().tasksCollapsed).toEqual(['t-32']);
        expect(chevronOf('t-32').getAttribute('aria-expanded')).toBe('false');
        expect(itemOf('t-34')).toBeNull();
        expect(itemOf('t-33')).toBeNull();

        await click(chevronOf('t-32'));

        expect(ui().tasksCollapsed).toEqual([]);
        expect(itemOf('t-34')).not.toBeNull();
    });

    it('hands the keyboard back to the row whose chevron was pressed, so the keys of the list go on working', async () => {
        await mountScreen(listInside());
        await click(chevronOf('t-32'));

        // A pressed button keeps the focus and its own keys; the row is where J, K and the arrows are read.
        expect(document.activeElement).toBe(focusableOf('t-32'));

        await pressOn('t-32', 'j');
        await wait(0);

        expect(document.activeElement).toBe(focusableOf('t-36'));
    });

    it('leaves a row with nothing inside it without a chevron, with the room kept', async () => {
        await mountScreen(listInside());

        expect(itemOf('t-35')!.querySelector('button[aria-expanded]')).toBeNull();
    });

    it('does not open or select the row whose chevron was pressed', async () => {
        await mountScreen(listInside());
        await click(chevronOf('t-32'));

        expect(ui().taskId).toBeNull();
        expect(selected()).toEqual([]);
    });

    it('opens the row when the room of a chevron that is not there is pressed: it is part of the row', async () => {
        await mountScreen(listInside());
        await click(itemOf('t-35')!.querySelector('td:nth-of-type(2) div > span'));

        expect(ui().taskId).toBe('t-35');
    });

    it('opens the scope of a task from the roll-up chip of its row', async () => {
        await mountScreen({ prepare: window => window.setTasksView('list') });
        await click(chipOf('t-31'));

        expect(ui().tasksScope).toBe('t-31');
        expect(ui().taskId).toBeNull();
        // The task has a page of its own, with a view of its own: a board until the person says the list.
        expect(isTable()).toBe(false);
        expect(drawn()).toEqual(['t-35', 't-32', 't-36', 't-37']);
    });

    it('opens a task from a click on its row, as before', async () => {
        await mountScreen({ prepare: window => window.setTasksView('list') });
        await click(itemOf('t-33'));

        expect(ui().taskId).toBe('t-33');
    });
});

describe('the view of each place', () => {
    it("writes the project's view at the roots and the task page's view inside a task", async () => {
        await mountScreen();
        await click(buttonNamed('List'));

        expect([ui().tasksView, ui().taskPageView]).toEqual(['list', 'board']);

        await click(chipOf('t-31'));

        // The task page is still a board: it keeps its own choice.
        expect(isTable()).toBe(false);

        await click(buttonNamed('List'));

        expect([ui().tasksView, ui().taskPageView]).toEqual(['list', 'list']);

        await click(buttonNamed('Board'));

        expect([ui().tasksView, ui().taskPageView]).toEqual(['list', 'board']);
    });

    it('shows each place in its own view when the person goes between them', async () => {
        await mountScreen({
            prepare: window => {
                window.setTasksView('list');
                window.setTaskPageView('board');
            },
        });

        expect(isTable()).toBe(true);

        await click(chipOf('t-31'));

        expect(isTable()).toBe(false);

        await click(buttonNamed('Tasks'));

        expect(isTable()).toBe(true);
    });

    it('has the Cmd+B key switch the view of the place it is in', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-31') });
        await draw();
        await pressOn('t-32', 'b', { mod: true });

        expect([ui().tasksView, ui().taskPageView]).toEqual(['board', 'list']);
        expect(isTable()).toBe(true);
    });

    it('shares the sub-tasks toggle between the roots and the tasks', async () => {
        await mountScreen();
        await click(buttonNamed('Sub-tasks'));
        await draw(() => ui().setTasksScope('t-31'));

        expect(isOn('Sub-tasks')).toBe(true);
        expect(drawn()).toHaveLength(6);
    });
});

describe('persistence', () => {
    it('brings the scope, the view, the toggle and the folds back after a reload, and keeps a project to itself', async () => {
        const storage = memoryStorage();

        await mountScreen({ storage });
        await click(chipOf('t-31'));
        await click(buttonNamed('Sub-tasks'));
        await click(buttonNamed('List'));
        await click(chevronOf('t-32'));

        await reloadScreen(storage);

        expect(ui()).toMatchObject({
            tasksScope: 't-31',
            tasksSubtasks: true,
            taskPageView: 'list',
            tasksView: 'board',
            tasksCollapsed: ['t-32'],
        });
        expect(isTable()).toBe(true);
        expect(rowDepths()).toEqual([
            ['t-35', 0],
            ['t-32', 0],
            ['t-36', 0],
            ['t-37', 0],
        ]);
        expect(page.container.querySelector('nav[aria-label="Task path"]')?.textContent).toContain('CAR-31');
    });

    it("keeps each project's place while the person switches between projects", async () => {
        await mountScreen();
        await click(chipOf('t-31'));
        await click(buttonNamed('Sub-tasks'));

        await draw(() => page.store.selectProject(FIXTURE_EMPTY_PROJECT_ID));

        expect(page.container.textContent).toContain('No tasks yet');
        expect(ui().tasksScope).toBeNull();

        await draw(() => page.store.selectProject(FIXTURE_PROJECT_ID));

        expect(ui().tasksScope).toBe('t-31');
        expect(pathText()).toEqual(['Tasks', 'CAR-31']);
        expect(isOn('Sub-tasks')).toBe(true);
    });

    it('shows the roots in another project, which has its own place', async () => {
        const storage = memoryStorage();

        await mountScreen({ storage });
        await click(chipOf('t-31'));
        await reloadScreen(storage, { projectId: FIXTURE_EMPTY_PROJECT_ID });

        expect(ui().tasksScope).toBeNull();
        expect(page.container.textContent).toContain('No tasks yet');
    });
});

describe('the chips', () => {
    it('shows the work inside a task as done over total, with the canceled ones left out, on a card', async () => {
        await mountScreen();

        expect(chipOf('t-31')?.textContent).toBe('1/5');
        expect(chipOf('t-24')).toBeNull();
    });

    it('shows the steps of the checklist in the description of a task as done over total', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-31') });

        expect(checklistOf('t-35')?.textContent).toBe('2/5');
        expect(chipOf('t-35')).toBeNull();
        expect(checklistOf('t-36')).toBeNull();
    });

    it('names the chips that are not controls for a screen reader, since `3/8` says nothing alone', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-31') });

        const checklist = checklistOf('t-35')!;

        expect(checklist.getAttribute('role')).toBe('img');
        expect(checklist.getAttribute('aria-label')).toBe('2 of 5 steps done');

        // The one in the header of the scope is not a button, and is named the same way.
        const inHeader = page.container.querySelector('section[aria-label="Inside CAR-31"] [title$="sub-tasks done"]')!;

        expect(inHeader.getAttribute('role')).toBe('img');
        expect(inHeader.getAttribute('aria-label')).toBe('1 of 5 sub-tasks done');
    });

    it('shows both on a task that has both, and neither on a task that has none', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-31') });

        expect(chipOf('t-32')?.textContent).toBe('1/2');
        expect(checklistOf('t-32')).toBeNull();

        // The two chips are not the same thing: the checklist chip is no control and does not open a scope.
        await change({ type: 'task.update', taskId: 't-32', description: '- [x] one\n- [ ] two\n- [ ] three' });

        expect(checklistOf('t-32')?.textContent).toBe('1/3');
        expect(chipOf('t-32')?.textContent).toBe('1/2');
    });

    it('follows the work: finishing a task inside changes the chip of the task above it', async () => {
        await mountScreen();
        await change({ type: 'task.update', taskId: 't-34', statusId: 'done' });

        expect(chipOf('t-31')?.textContent).toBe('2/5');
    });

    it('draws the chips on a row of the list too', async () => {
        await mountScreen({
            prepare: window => {
                window.setTasksScope('t-31');
                window.setTasksView('list');
            },
        });

        expect(chipOf('t-32')?.textContent).toBe('1/2');
        expect(checklistOf('t-35')?.textContent).toBe('2/5');
    });

    it('leaves Enter on a focused chip to the chip: the key is not a press on the task, so it does not open it', async () => {
        await mountScreen();
        await act(async () => chipOf('t-31')!.focus());

        const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });

        await act(async () => void chipOf('t-31')!.dispatchEvent(event));

        expect(event.defaultPrevented).toBe(false);
        expect(ui().taskId).toBeNull();

        await click(chipOf('t-31'));

        expect(ui().tasksScope).toBe('t-31');
        expect(ui().taskId).toBeNull();
    });
});

describe('the search and the filters', () => {
    it('find a task inside another from the roots in every mode, whatever its parents are', async () => {
        await mountScreen();
        await search('tokenize');

        // The board of one level: the match comes up to the level, with the task it is inside named.
        expect(drawnKeys()).toEqual(['CAR-33']);
        expect(itemOf('t-33')!.querySelector('[title^="Sub-task of"]')?.textContent).toBe('in CAR-32');

        await click(buttonNamed('Sub-tasks'));

        expect(drawnKeys()).toEqual(['CAR-33']);

        await click(buttonNamed('List'));

        expect(rowDepths()).toEqual([['t-33', 0]]);
    });

    it('open a match that the board draws away from its parent without moving the screen, with a click and with a key', async () => {
        await mountScreen();
        await search('tokenize');
        await click(itemOf('t-33')!.querySelector('button'));

        // The card is drawn already: opening it from the screen does not take the screen into CAR-32.
        expect([ui().taskId, ui().tasksScope]).toEqual(['t-33', null]);
        expect(drawnKeys()).toEqual(['CAR-33']);

        await act(async () => void ui().openTask(null));
        await draw();
        await pressOn('t-33', 'Enter');

        expect([ui().taskId, ui().tasksScope]).toEqual(['t-33', null]);
    });

    it('keep a match under its parent in the list when the parent matches too', async () => {
        await mountScreen({ prepare: window => window.setTasksView('list') });
        await search('card');

        // Payments matches by its description, and so do the tasks inside Card checkout and the one about two cards: each under the task it is inside.
        expect(rowDepths()).toEqual([
            ['t-31', 0],
            ['t-32', 1],
            ['t-34', 2],
            ['t-33', 2],
            ['t-37', 1],
        ]);
    });

    it('apply inside a scope, and only to what the scope holds', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-32') });
        await search('declined');

        expect(drawnKeys()).toEqual(['CAR-34']);

        await search('refund');

        expect(drawn()).toEqual([]);
        expect(page.container.textContent).toContain('No tasks match');
    });

    it('say "No tasks match" when they hide everything, with a way to clear them', async () => {
        await mountScreen();
        await search('no such task');

        expect(page.container.textContent).toContain('No tasks match');
        expect(page.container.textContent).not.toContain('No tasks yet');

        await click(buttonNamed('Clear filters'));

        expect(drawn()).toHaveLength(12);
    });

    it('say it in a scope too, and not that the scope is empty', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-31') });
        await search('no such task');

        expect(page.container.textContent).toContain('No tasks match');
        expect(page.container.textContent).not.toContain('No sub-tasks yet');
    });

    it('keep the roll-up of a task whole while they narrow what is drawn', async () => {
        await mountScreen();
        await search('payments');

        expect(drawnKeys()).toEqual(['CAR-31']);
        expect(chipOf('t-31')?.textContent).toBe('1/5');
    });
});

describe('the empty states', () => {
    it('says there are no tasks in a project without any, and not that a filter hides them', async () => {
        await mountScreen({ projectId: FIXTURE_EMPTY_PROJECT_ID });

        expect(page.container.textContent).toContain('No tasks yet');
        expect(page.container.textContent).toContain('ask the orchestrator');
        expect(buttonNamed('Clear filters')).toBeUndefined();
    });

    it('says a task has no sub-tasks yet, in the board and in the list', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-28') });

        expect(page.container.textContent).toContain('No sub-tasks yet');

        await click(buttonNamed('List'));

        expect(page.container.textContent).toContain('No sub-tasks yet');
    });

    it('does not end its text with a period, as one sentence does not', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-28') });

        expect(page.container.textContent).toContain('Split this task into smaller ones');
        expect(page.container.textContent).not.toContain('Split this task into smaller ones.');
    });
});

describe('the cursor and the keys', () => {
    it('walks the rows of the tree top to bottom with J and K, the rows inside a task included', async () => {
        await mountScreen(listInside());
        await focusTask('t-35');

        for (const [key, expected] of [
            ['j', 't-32'],
            ['j', 't-34'],
            ['j', 't-33'],
            ['j', 't-36'],
            ['k', 't-33'],
        ] as const) {
            await act(
                async () =>
                    void document.activeElement!.dispatchEvent(
                        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
                    )
            );
            await wait(0);

            expect(document.activeElement).toBe(focusableOf(expected));
        }
    });

    it('skips what is folded', async () => {
        await mountScreen({
            prepare: window => {
                window.setTasksScope('t-31');
                window.setTaskPageView('list');
                window.toggleTaskCollapsed('t-32');
            },
        });
        await focusTask('t-32');
        await pressOn('t-32', 'j');

        expect(document.activeElement).toBe(focusableOf('t-36'));
    });

    it('folds with the left arrow, goes to the parent row with it, opens with the right arrow and goes into the row', async () => {
        await mountScreen(listInside());
        await pressOn('t-32', 'ArrowLeft');

        expect(ui().tasksCollapsed).toEqual(['t-32']);
        expect(itemOf('t-34')).toBeNull();

        await pressOn('t-32', 'ArrowRight');

        expect(ui().tasksCollapsed).toEqual([]);
        expect(itemOf('t-34')).not.toBeNull();

        await pressOn('t-32', 'ArrowRight');
        await wait(0);

        expect(document.activeElement).toBe(focusableOf('t-34'));

        await pressOn('t-34', 'ArrowLeft');
        await wait(0);

        expect(document.activeElement).toBe(focusableOf('t-32'));
    });

    it('selects with X, extends with Shift and arrows, and toggles with a Cmd or Ctrl click, in the tree', async () => {
        await mountScreen(listInside());
        await focusTask('t-35');
        await pressOn('t-35', 'x');

        expect(selected()).toEqual(['t-35']);

        await pressOn('t-35', 'ArrowDown', { shiftKey: true });
        await pressOn('t-32', 'ArrowDown', { shiftKey: true });

        expect(selected()).toEqual(['t-35', 't-32', 't-34']);

        await act(async () =>
            itemOf('t-36')!.dispatchEvent(
                new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true, ctrlKey: true })
            )
        );
        await draw();

        expect(selected()).toEqual(['t-35', 't-32', 't-34', 't-36']);
        expect(ui().taskId).toBeNull();
    });

    it('extends the selection from the anchor with a Shift click over the rows between', async () => {
        await mountScreen(listInside());
        await click(itemOf('t-35'));
        await act(async () =>
            itemOf('t-33')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }))
        );
        await draw();

        expect(selected()).toEqual(['t-35', 't-32', 't-34', 't-33']);
    });

    it('walks the columns of the through board: down within one, and across with the arrows', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-31') });
        await click(buttonNamed('Sub-tasks'));
        // To do holds CAR-34 and CAR-35, In progress CAR-32, Review CAR-36, Done CAR-33.
        await focusTask('t-34');
        await pressOn('t-34', 'ArrowDown');
        await wait(0);

        expect(document.activeElement).toBe(focusableOf('t-35'));

        await pressOn('t-35', 'ArrowRight');
        await wait(0);

        expect(document.activeElement).toBe(focusableOf('t-32'));

        await pressOn('t-32', 'ArrowRight');
        await pressOn('t-36', 'ArrowRight');
        await wait(0);

        expect(document.activeElement).toBe(focusableOf('t-33'));
    });

    it('keeps the arrows to the page on a row of the list that has nothing to fold or to go to, and takes them where it has', async () => {
        await mountScreen(listInside());

        const isLive = () =>
            hotkeys
                .listCommands()
                .live.map(command => command.id)
                .filter(id => id === 'tasks.cursor.left' || id === 'tasks.cursor.right');

        // CAR-35 stands at the top with nothing inside it.
        await focusTask('t-35');
        await draw();

        expect(isLive()).toEqual([]);

        await pressOn('t-35', 'ArrowLeft');

        expect(ui().tasksCollapsed).toEqual([]);

        // CAR-32 has two tasks inside it: both keys have a job. CAR-34 is inside it: Left goes up to its parent row.
        await focusTask('t-32');

        expect(isLive()).toEqual(['tasks.cursor.left', 'tasks.cursor.right']);

        await focusTask('t-34');

        expect(isLive()).toEqual(['tasks.cursor.left']);
    });

    it('opens the folds above a task opened from elsewhere in the list, so its row shows', async () => {
        await mountScreen({
            prepare: window => {
                window.setTasksScope(null);
                window.setTasksView('list');
                window.toggleTaskCollapsed('t-31');
                window.toggleTaskCollapsed('t-32');
            },
        });

        expect(itemOf('t-33')).toBeNull();

        await draw(() => ui().openTask('t-33'));

        expect(ui().tasksCollapsed).toEqual([]);
        expect(itemOf('t-33')).not.toBeNull();
        expect(itemOf('t-33')?.hasAttribute('data-open')).toBe(true);
    });
});

describe('a task that is deleted or archived while it is drawn', () => {
    it('leaves the tree, with the rows inside a folded one gone and the folds of tasks that are gone forgotten', async () => {
        await mountScreen({
            prepare: window => {
                window.setTasksScope('t-31');
                window.setTaskPageView('list');
                window.toggleTaskCollapsed('t-32');
            },
        });
        await change({ type: 'task.delete', taskId: 't-32' });

        // The tasks inside CAR-32 go to its parent, and the fold of a task that is gone is let go.
        expect(ui().tasksCollapsed).toEqual([]);
        // All at the top of the scope now, in workflow order: To do, Review, Done, Canceled.
        expect(rowDepths()).toEqual([
            ['t-34', 0],
            ['t-35', 0],
            ['t-36', 0],
            ['t-33', 0],
            ['t-37', 0],
        ]);
    });
});
