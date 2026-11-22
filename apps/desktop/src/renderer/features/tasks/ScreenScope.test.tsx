// @vitest-environment happy-dom
import { toast } from '@clowdy/components/Toast';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { openCreateTask } from './CreateTaskDialog';
import { buttonNamed, change, click, closePage, columnOf, draw, drawn, focusableOf, focusTask, itemOf, lateTaskEvents, mountScreen, openPage, page, pathText, press, pressKeys, pressOn, project, ui, wait } from './screenHarness';
import { createdTaskId } from './taskView';

// `Modal` cannot load under the desktop's Vitest (decorators), and neither dialog is opened here.
vi.mock('@clowdy/components/modals', () => ({ openConfirmModal: vi.fn() }));
vi.mock('./CreateTaskDialog', () => ({ openCreateTask: vi.fn() }));

/*
 * The scope of the Tasks screen on the demo project: CAR-20 to CAR-30 and the tree of Payments, CAR-31 (active) with CAR-32 (active, holding CAR-33 done and CAR-34 todo),
 * CAR-35 (todo, with a checklist), CAR-36 (review) and CAR-37 (canceled). The archived CAR-38 to CAR-40 are not on the board.
 */

beforeEach(openPage);

afterEach(() => {
    closePage();
    vi.mocked(openCreateTask).mockClear();
});

/** The roll-up chip of a card or row, which opens the task's own scope. */
const chipOf = (taskId: string) => itemOf(taskId)!.querySelector<HTMLElement>('button[aria-label^="Open sub-tasks of"]');

const scopeHeader = (key: string) => page.container.querySelector<HTMLElement>(`section[aria-label="Inside ${ key }"]`);

const panel = (key: string) => page.container.querySelector<HTMLElement>(`aside[aria-label="Task ${ key }"]`);

/** A task at the last level the daemon allows (level 8): CAR-33 is level 3, and five more go under it. Returns its id. */
async function deepestTask() {
    let parentId = 't-33';

    for (let level = 4; level <= 8; level++) {
        const result = await page.store.command({ type: 'task.create', projectId: FIXTURE_PROJECT_ID, title: `Level ${ level }`, parentId });

        expect(result.ok).toBe(true);
        parentId = (result as { ok: true; data: { task: { id: string } } }).data.task.id;
    }

    return parentId;
}

/** The parent the latest dialog was opened for. */
const lastParent = () => vi.mocked(openCreateTask).mock.lastCall?.[0].parentId;

describe('the project root', () => {
    it('is the board of the root tasks, each card once, with no group for tasks that have no parent and no card for a task inside another', async () => {
        await mountScreen();

        expect(drawn()).toHaveLength(12);
        expect(drawn().filter(id => id === 't-31')).toHaveLength(1);
        expect(itemOf('t-32')).toBeNull();
        expect(page.container.textContent).not.toContain('No parent');
        expect(pathText()).toEqual([]);
        expect(scopeHeader('CAR-31')).toBeNull();
        expect(page.container.querySelector('header')?.textContent).toContain('Tasks');
    });

    it('draws the tasks of a deleted task as roots, since the daemon re-attaches them to its parent', async () => {
        await mountScreen();
        await change({ type: 'task.delete', taskId: 't-31' });

        expect(drawn()).toHaveLength(15);
        expect(columnOf('t-32')).toBe('In progress');
    });

    it('does not draw the archived tasks', async () => {
        await mountScreen();

        expect(itemOf('t-38')).toBeNull();
    });
});

describe('going into a task', () => {
    it('opens the scope of a task from the roll-up chip of its card: the path, the header of the task, and the board of what is inside it', async () => {
        await mountScreen();
        await click(chipOf('t-31'));

        expect(ui().tasksScope).toBe('t-31');
        expect(pathText()).toEqual(['Tasks', 'CAR-31']);
        expect(scopeHeader('CAR-31')?.textContent).toContain('Payments');
        expect(drawn()).toEqual(['t-35', 't-32', 't-36', 't-37']);
        expect(columnOf('t-32')).toBe('In progress');
    });

    it('does not select or open the card whose chip was pressed: the chip is a control of the card, not a press on the task', async () => {
        await mountScreen();
        await click(chipOf('t-31'));

        expect(ui().taskId).toBeNull();
        expect(itemOf('t-32')?.hasAttribute('data-open')).toBe(false);
    });

    it('goes deeper from a card inside the scope, and the path grows by a crumb', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-31') });
        await click(chipOf('t-32'));

        expect(pathText()).toEqual(['Tasks', 'CAR-31', 'CAR-32']);
        expect(drawn()).toEqual(['t-34', 't-33']);
    });

    it('goes up from a crumb, and back to the roots from the first one', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-32') });

        expect(pathText()).toEqual(['Tasks', 'CAR-31', 'CAR-32']);

        await click(buttonNamed('CAR-31'));

        expect(ui().tasksScope).toBe('t-31');
        expect(pathText()).toEqual(['Tasks', 'CAR-31']);

        await click(buttonNamed('Tasks'));

        expect(ui().tasksScope).toBeNull();
        expect(pathText()).toEqual([]);
        expect(drawn()).toHaveLength(12);
    });

    it('makes every move a place of the history, so Back returns to the scope it left', async () => {
        await mountScreen();
        await click(chipOf('t-31'));
        await click(buttonNamed('Tasks'));

        page.store.history.back();
        await draw();

        expect(ui().tasksScope).toBe('t-31');
        expect(pathText()).toEqual(['Tasks', 'CAR-31']);

        page.store.history.back();
        await draw();

        expect(ui().tasksScope).toBeNull();
    });
});

describe('the header of a scope', () => {
    it('shows the key, the title, the status and the work inside the task, and edits nothing', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-31') });

        const header = scopeHeader('CAR-31')!;

        expect(header.textContent).toContain('CAR-31');
        expect(header.textContent).toContain('Payments');
        expect(header.textContent).toContain('In progress');
        expect(header.querySelector('[title="1 of 5 sub-tasks done"]')?.textContent).toBe('1/5');
        expect(header.querySelector('input, textarea, select, [contenteditable]')).toBeNull();
        // The work inside the task is not a button here: the screen is inside the task already.
        expect(header.querySelector('button[aria-label^="Open sub-tasks"]')).toBeNull();
    });

    it('opens the New task dialog for a task inside the scope with New sub-task', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-31') });
        await click(buttonNamed('New sub-task', scopeHeader('CAR-31')!));

        expect(openCreateTask).toHaveBeenCalledTimes(1);
        expect(vi.mocked(openCreateTask).mock.calls[0][0]).toMatchObject({ project: project(), parentId: 't-31' });
    });

    it('opens the detail panel of the task itself with Details, and keeps the scope', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-31') });
        await click(buttonNamed('Details', scopeHeader('CAR-31')!));

        expect(ui().taskId).toBe('t-31');
        expect(panel('CAR-31')).not.toBeNull();
        expect(ui().tasksScope).toBe('t-31');
    });

    it('turns New sub-task off on a task at the last level, and says why', async () => {
        await mountScreen();

        ui().setTasksScope(await deepestTask());
        await draw();

        const header = page.container.querySelector<HTMLElement>('section[aria-label^="Inside"]')!;
        const button = [...header.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === 'New sub-task');

        expect(header.textContent).toContain('Level 8');
        expect(button?.hasAttribute('disabled')).toBe(true);
        // The control that says why is a focusable stand-in with the button's name, since a disabled button takes neither the pointer nor the focus.
        expect(header.querySelector('[role="button"][aria-disabled][aria-label="New sub-task"]')).not.toBeNull();
        expect(page.container.textContent).toContain('No sub-tasks yet');
        expect(page.container.textContent).toContain('This task is at the last level');
        expect([...page.container.querySelectorAll('button')].filter(candidate => candidate.textContent?.trim() === 'New sub-task')).toHaveLength(1);
    });

});

describe('making a task from the header and from the key', () => {
    it('makes a task of the roots with + Task and C at the roots', async () => {
        await mountScreen();
        await click(buttonNamed('Task'));

        expect(openCreateTask).toHaveBeenCalledTimes(1);
        expect(lastParent()).toBeUndefined();

        await pressKeys('c');

        expect(openCreateTask).toHaveBeenCalledTimes(2);
        expect(lastParent()).toBeUndefined();
    });

    it('makes a sub-task of the scope with the header button and with C inside a task, and the button says so', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-31') });

        // No "+ Task" beside "+ Sub-task": the button is one, and its name is what it makes.
        expect(buttonNamed('Task')).toBeUndefined();

        await click(buttonNamed('Sub-task'));

        expect(openCreateTask).toHaveBeenCalledTimes(1);
        expect(lastParent()).toBe('t-31');

        await pressKeys('c');

        expect(openCreateTask).toHaveBeenCalledTimes(2);
        expect(lastParent()).toBe('t-31');
    });

    it('makes a task of the roots again once the screen is back at the roots', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-31') });
        await click(buttonNamed('Tasks'));
        await pressKeys('c');

        expect(lastParent()).toBeUndefined();
        expect(buttonNamed('Sub-task')).toBeUndefined();
    });

    it('turns the header button off at the last level, with the reason on a stand-in, and C says the same instead of opening the dialog', async () => {
        await mountScreen();

        ui().setTasksScope(await deepestTask());
        await draw();

        const info = vi.spyOn(toast, 'info');
        const header = page.container.querySelector('header')!;
        const button = [...header.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === 'Sub-task');

        expect(button?.hasAttribute('disabled')).toBe(true);
        expect(header.querySelector('[role="button"][aria-disabled][aria-label="New sub-task"]')).not.toBeNull();

        await click(button);
        await pressKeys('c');

        expect(openCreateTask).not.toHaveBeenCalled();
        expect(info).toHaveBeenCalledTimes(1);
        expect(info).toHaveBeenCalledWith({ message: 'Tasks go only 8 levels deep' });

        info.mockRestore();
    });

    it('shows the new sub-task in the scope and opens it, also when the daemon\'s event comes after the reply', async () => {
        const late = lateTaskEvents();

        await mountScreen({ transport: late.wrap, prepare: window => window.setTasksScope('t-31') });
        late.hold();

        const result = await page.store.command({ type: 'task.create', projectId: FIXTURE_PROJECT_ID, title: 'Late sub-task', parentId: 't-31' });
        const created = createdTaskId(result.ok ? result.data : undefined)!;

        // What the dialog does once the reply is in: the project does not hold the task yet.
        await draw(() => ui().openTask(created, { madeIn: 't-31' }));

        expect(project().tasks.has(created)).toBe(false);
        expect([ui().taskId, ui().tasksScope]).toEqual([created, 't-31']);
        expect(pathText()).toEqual(['Tasks', 'CAR-31']);

        await late.release();
        await draw();

        expect(itemOf(created)?.hasAttribute('data-open')).toBe(true);
        expect(panel(project().tasks.get(created)!.key)).not.toBeNull();
        expect(ui().tasksScope).toBe('t-31');

        // The cursor is on the new task too: a key that acts on it brings the keyboard there.
        await pressKeys('j');

        expect(document.activeElement).toBe(focusableOf(created));
    });
});

describe('an empty scope', () => {
    it('says so, and offers New sub-task', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-28') });

        expect(page.container.textContent).toContain('No sub-tasks yet');
        expect(page.container.querySelector('[data-task-id]')).toBeNull();

        const buttons = [...page.container.querySelectorAll('button')].filter(button => button.textContent?.trim() === 'New sub-task');

        // The one of the header and the one of the empty state.
        expect(buttons).toHaveLength(2);

        await click(buttons[1]);

        expect(vi.mocked(openCreateTask).mock.calls[0][0]).toMatchObject({ parentId: 't-28' });
    });
});

describe('a scope that is gone', () => {
    const archivePayments = () => change({ type: 'task.archive', taskId: 't-31', cancel: true });

    it('shows the roots, and remembers the scope so it comes back with the task', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-31') });
        await archivePayments();

        expect(pathText()).toEqual([]);
        expect(drawn()).toHaveLength(11);
        expect(ui().tasksScope).toBe('t-31');

        await change({ type: 'task.unarchive', taskId: 't-31' });

        expect(pathText()).toEqual(['Tasks', 'CAR-31']);
    });

    it('settles on the roots when the person acts, so Back returns to the place they saw and not to the one that is gone', async () => {
        await mountScreen({
            prepare: (window) => {
                page.store.ui.showSection(window, 'tasks');
                window.setTasksScope('t-31');
            },
        });
        await archivePayments();
        await click(itemOf('t-24')!.querySelector('button'));

        expect(ui().taskId).toBe('t-24');
        expect(ui().tasksScope).toBeNull();
        expect(page.store.history.canGoBack).toBe(true);

        page.store.history.back();
        await draw();

        expect([ui().taskId, ui().tasksScope]).toEqual([null, null]);
        expect(drawn()).toHaveLength(11);
    });

    it('settles before the New task dialog opens, which is the person acting', async () => {
        await mountScreen({
            prepare: (window) => {
                page.store.ui.showSection(window, 'tasks');
                window.setTasksScope('t-32');
            },
        });
        await change({ type: 'task.archive', taskId: 't-32', cancel: true });

        expect(ui().tasksScope).toBe('t-32');

        await click(buttonNamed('Task'));

        expect(ui().tasksScope).toBeNull();
    });
});

describe('opening a task from elsewhere', () => {
    it('keeps the scope for a task inside it, and shows the task open on its card', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-31') });
        await draw(() => ui().openTask('t-32'));

        expect(ui().tasksScope).toBe('t-31');
        expect(itemOf('t-32')?.hasAttribute('data-open')).toBe(true);
        expect(panel('CAR-32')).not.toBeNull();
    });

    it('moves the scope to the parent of a task outside it, and the task shows there', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-35') });
        await draw(() => ui().openTask('t-33'));

        expect(ui().tasksScope).toBe('t-32');
        expect(pathText()).toEqual(['Tasks', 'CAR-31', 'CAR-32']);
        expect(itemOf('t-33')?.hasAttribute('data-open')).toBe(true);
    });

    it('moves to the roots for a root task, with Back returning to the scope it left', async () => {
        await mountScreen({
            prepare: (window) => {
                page.store.ui.showSection(window, 'tasks');
                window.setTasksScope('t-32');
            },
        });
        await draw(() => ui().openTask('t-24'));

        expect(ui().tasksScope).toBeNull();
        expect(itemOf('t-24')?.hasAttribute('data-open')).toBe(true);

        page.store.history.back();
        await draw();

        expect([ui().tasksScope, ui().taskId]).toEqual(['t-32', null]);
    });
});

describe('the keys of the scope', () => {
    it('O then S opens the sub-tasks of the task under the cursor, and the cursor starts on the first of them', async () => {
        await mountScreen();
        await pressOn('t-31', 'o');
        await pressOn('t-31', 's');
        await wait();

        expect(ui().tasksScope).toBe('t-31');
        expect(pathText()).toEqual(['Tasks', 'CAR-31']);
        expect(document.activeElement).toBe(focusableOf('t-35'));
    });

    it('O then S on a task with nothing inside opens an empty scope, where New sub-task starts', async () => {
        await mountScreen();
        await pressOn('t-28', 'o');
        await pressOn('t-28', 's');

        expect(ui().tasksScope).toBe('t-28');
        expect(page.container.textContent).toContain('No sub-tasks yet');
    });

    it('U goes up one level and puts the cursor on the task that was left', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-32') });
        await focusTask('t-33');
        await pressKeys('u');
        await wait();

        expect(ui().tasksScope).toBe('t-31');
        expect(document.activeElement).toBe(focusableOf('t-32'));

        await pressKeys('u');
        await wait();

        expect(ui().tasksScope).toBeNull();
        expect(document.activeElement).toBe(focusableOf('t-31'));
    });

    it('leaves U to the page at the roots', async () => {
        await mountScreen();

        expect(press('u').defaultPrevented).toBe(false);
        expect(ui().tasksScope).toBeNull();
    });
});

describe('the detail panel of a task with tasks inside it', () => {
    it('offers Open sub-tasks, which opens the scope of the task', async () => {
        await mountScreen({ prepare: window => window.openTask('t-31') });

        const button = buttonNamed('Open sub-tasks', panel('CAR-31')!);

        expect(button).toBeDefined();

        await click(button);

        expect(ui().tasksScope).toBe('t-31');
        expect(pathText()).toEqual(['Tasks', 'CAR-31']);
    });

    it('offers nothing for a task with nothing inside it', async () => {
        await mountScreen({ prepare: window => window.openTask('t-28') });

        expect(buttonNamed('Open sub-tasks', panel('CAR-28')!)).toBeUndefined();
    });

    it('offers nothing for the task the screen is inside already, whose sub-tasks are what is drawn', async () => {
        await mountScreen({ prepare: window => window.setTasksScope('t-31') });
        await click(buttonNamed('Details', scopeHeader('CAR-31')!));

        expect(panel('CAR-31')).not.toBeNull();
        expect(buttonNamed('Open sub-tasks', panel('CAR-31')!)).toBeUndefined();

        // A task inside it that has tasks of its own still offers them.
        await click(itemOf('t-32')!.querySelector('button'));

        expect(buttonNamed('Open sub-tasks', panel('CAR-32')!)).toBeDefined();
    });
});
