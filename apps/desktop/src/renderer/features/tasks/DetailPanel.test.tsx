// @vitest-environment happy-dom
import { toast } from '@clowdy/components/Toast';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { overrideTransport } from '../../daemon/testing';
import { undoStack } from '../../hotkeys/undo';
import { openCreateTask } from './CreateTaskDialog';
import { buttonNamed, click, closePage, draw, mountScreen, openPage, page, press, project, ui, wait } from './screenHarness';
import { DEPTH_LIMIT_HINT } from './taskTree';
import { REFRESH_DELAY_MS } from './useTaskComments';

import type { CommandResult, TaskComment } from '@clowdy/protocol';
import type { Editor } from '@tiptap/core';
import type { CommandInput } from '../../daemon/transport';

// `Modal` cannot load under the desktop's Vitest (decorators), and neither dialog is opened here.
vi.mock('@clowdy/components/modals', () => ({ openConfirmModal: vi.fn() }));
vi.mock('./CreateTaskDialog', () => ({ openCreateTask: vi.fn() }));

/*
 * The detail panel on the demo project, through the Tasks screen: the Payments tree (CAR-31 active, with CAR-32 active holding CAR-33 done and CAR-34 todo, CAR-35 todo with a checklist
 * of five steps and two done, CAR-36 review, CAR-37 canceled) and the roots around it. What the panel sends is read from the commands the daemon was asked.
 */

let sent: CommandInput[];
let refuse: (input: CommandInput) => string | undefined;

/** The fixture daemon, remembering what it was asked and refusing what the test says. */
const daemon = (base: FixtureTransport) => overrideTransport(base, {
    command: async (input) => {
        sent.push(input);

        const message = refuse(input);

        return message ? { ok: false, requestId: 'r', error: { code: 'invalid', message } } satisfies CommandResult : base.command(input);
    },
});

beforeEach(() => {
    sent = [];
    refuse = () => undefined;
    openPage();
});

afterEach(() => {
    closePage();
    document.body.querySelectorAll('[data-modal-clickout-layer]').forEach(layer => layer.remove());
    vi.mocked(openCreateTask).mockClear();
    vi.restoreAllMocks();
});

const panel = (key: string) => page.container.querySelector<HTMLElement>(`aside[aria-label="Task ${ key }"]`)!;

/** A section of the panel, found by its heading. */
const sectionOf = (key: string, title: string) => [...panel(key).querySelectorAll<HTMLElement>('section')].find(section => section.textContent?.startsWith(title))!;

const updates = () => sent.filter(input => input.type === 'task.update');

const task = (taskId: string) => project().tasks.get(taskId)!;

describe('the Parent row', () => {
    it('names the parent by its key and title, and opens it', async () => {
        await mountScreen({ prepare: window => window.openTask('t-34'), transport: daemon });

        const row = sectionOf('CAR-34', 'Parent');

        expect(row.textContent).toContain('CAR-32');
        expect(row.textContent).toContain('Card checkout');
        expect(row.textContent).not.toContain('No parent');

        await click(row.querySelector('button[title="Card checkout"]'));

        expect(ui().taskId).toBe('t-32');
        expect(panel('CAR-32')).not.toBeNull();
    });

    it('says "No parent" for a root, and offers to set one', async () => {
        await mountScreen({ prepare: window => window.openTask('t-28'), transport: daemon });

        const row = sectionOf('CAR-28', 'Parent');

        expect(row.textContent).toContain('No parent');
        expect(buttonNamed('Set parent', row)).toBeDefined();
        expect(buttonNamed('Change parent', row)).toBeUndefined();
    });
});

/** What a picker lists, by the label of each row; the empty-state row has no key. */
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"][data-key]')];
const labels = () => options().map(option => option.textContent);

/** Presses the button that opens the picker, and waits for it to place itself (it takes a frame, and focus goes to its field after 50 ms). */
async function openPicker(key: string, name: 'Set parent' | 'Change parent') {
    await click(buttonNamed(name, sectionOf(key, 'Parent')));
    await wait(100);
}

/** Picks a row of the open picker by its text, as a press does. */
async function pick(text: string) {
    const row = options().find(option => option.textContent?.includes(text));

    if (!row) throw new Error(`No row says ${ text }: ${ labels().join(' | ') }`);

    await act(async () => row.click());
    await draw();
}

const closePicker = () => act(async () => void document.querySelector('input[type="text"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

describe('the Parent picker', () => {
    it('lists "No parent" first and then the tasks it may go under, never itself or a task inside it, and marks the present parent', async () => {
        await mountScreen({ prepare: window => window.openTask('t-32'), transport: daemon });
        await openPicker('CAR-32', 'Change parent');

        const rows = labels();

        expect(rows[0]).toBe('No parent');
        // CAR-31 is the present parent; CAR-33 and CAR-34 are inside CAR-32, and a task cannot go under what it holds.
        expect(rows.some(row => row?.includes('CAR-31'))).toBe(true);
        expect(rows.some(row => row?.includes('CAR-32'))).toBe(false);
        expect(rows.some(row => row?.includes('CAR-33'))).toBe(false);
        expect(rows.some(row => row?.includes('CAR-34'))).toBe(false);
        expect(rows.some(row => row?.includes('CAR-24'))).toBe(true);
        expect(options().filter(option => option.querySelector('[aria-label="Current"]')).map(option => option.textContent)).toEqual([expect.stringContaining('CAR-31')]);

        await closePicker();
    });

    it('marks "No parent" for a root', async () => {
        await mountScreen({ prepare: window => window.openTask('t-28'), transport: daemon });
        await openPicker('CAR-28', 'Set parent');

        expect(options().filter(option => option.querySelector('[aria-label="Current"]')).map(option => option.textContent)).toEqual(['No parent']);

        await closePicker();
    });

    it('does not offer a task that is too deep to hold another: only the last level is left out for a task with nothing inside it', async () => {
        await mountScreen({ prepare: window => window.openTask('t-28'), transport: daemon });

        // CAR-33 is level 3; five more under it make Level 8, the last level.
        let parentId = 't-33';

        for (let level = 4; level <= 8; level++) {
            const result = await page.store.command({ type: 'task.create', projectId: FIXTURE_PROJECT_ID, title: `Level ${ level }`, parentId });

            parentId = (result as { ok: true; data: { task: { id: string } } }).data.task.id;
        }

        await draw();
        await openPicker('CAR-28', 'Set parent');

        expect(labels().some(row => row?.includes('Level 7'))).toBe(true);
        expect(labels().some(row => row?.includes('Level 8'))).toBe(false);

        await closePicker();
    });

    it('sets the parent of a root, which the daemon takes and the row shows, and the undo puts it back as a root', async () => {
        await mountScreen({ prepare: window => window.openTask('t-28'), transport: daemon });
        await openPicker('CAR-28', 'Set parent');
        await pick('CAR-31');
        await wait(0);
        await draw();

        expect(updates()).toEqual([{ type: 'task.update', taskId: 't-28', parentId: 't-31' }]);
        expect(task('t-28').parentId).toBe('t-31');
        expect(sectionOf('CAR-28', 'Parent').textContent).toContain('CAR-31');
        expect(buttonNamed('Change parent', sectionOf('CAR-28', 'Parent'))).toBeDefined();
        expect(undoStack.entries.map(entry => entry.label)).toEqual(['Parent of CAR-28 changed']);

        await act(async () => void (await undoStack.undoLatest(FIXTURE_PROJECT_ID)));
        await draw();

        // A root is put back by detaching it: an absent parent would have left it where it is.
        expect(updates().at(-1)).toEqual({ type: 'task.update', taskId: 't-28', parentId: null });
        expect(task('t-28').parentId).toBeUndefined();
        expect(sectionOf('CAR-28', 'Parent').textContent).toContain('No parent');
    });

    it('changes the parent to another task, and the undo puts the first one back', async () => {
        await mountScreen({ prepare: window => window.openTask('t-34'), transport: daemon });
        await openPicker('CAR-34', 'Change parent');
        await pick('CAR-35');
        await draw();

        expect(updates()).toEqual([{ type: 'task.update', taskId: 't-34', parentId: 't-35' }]);
        expect(task('t-34').parentId).toBe('t-35');
        expect(sectionOf('CAR-34', 'Parent').textContent).toContain('Refund flow');

        await act(async () => void (await undoStack.undoLatest(FIXTURE_PROJECT_ID)));

        expect(updates().at(-1)).toEqual({ type: 'task.update', taskId: 't-34', parentId: 't-32' });
        expect(task('t-34').parentId).toBe('t-32');
    });

    it('detaches a task with "No parent", and the undo moves it back under its parent', async () => {
        await mountScreen({ prepare: window => window.openTask('t-34'), transport: daemon });
        await openPicker('CAR-34', 'Change parent');
        await pick('No parent');
        await draw();

        expect(updates()).toEqual([{ type: 'task.update', taskId: 't-34', parentId: null }]);
        expect(task('t-34').parentId).toBeUndefined();
        expect(sectionOf('CAR-34', 'Parent').textContent).toContain('No parent');

        await act(async () => void (await undoStack.undoLatest(FIXTURE_PROJECT_ID)));

        expect(updates().at(-1)).toEqual({ type: 'task.update', taskId: 't-34', parentId: 't-32' });
        expect(task('t-34').parentId).toBe('t-32');
    });

    it('sends nothing for the parent the task has already, or for "No parent" on a root', async () => {
        await mountScreen({ prepare: window => window.openTask('t-34'), transport: daemon });
        await openPicker('CAR-34', 'Change parent');
        await pick('CAR-32');

        expect(updates()).toEqual([]);

        await act(async () => root().ui.forProject(FIXTURE_PROJECT_ID).openTask('t-28'));
        await draw();
        await openPicker('CAR-28', 'Set parent');
        await pick('No parent');

        expect(updates()).toEqual([]);
        expect(undoStack.entries).toEqual([]);
    });

    it('shows the daemon\'s refusal as a toast, changes nothing and records nothing to undo', async () => {
        const error = vi.spyOn(toast, 'error');

        refuse = input => (input.type === 'task.update' && input.parentId === 't-31' ? 'CAR-31 is archived, restore it first' : undefined);
        await mountScreen({ prepare: window => window.openTask('t-28'), transport: daemon });
        await openPicker('CAR-28', 'Set parent');
        await pick('CAR-31');

        expect(error).toHaveBeenCalledWith({ message: 'CAR-31 is archived, restore it first' });
        expect(task('t-28').parentId).toBeUndefined();
        expect(sectionOf('CAR-28', 'Parent').textContent).toContain('No parent');
        expect(undoStack.entries).toEqual([]);
    });

    it('has no picker to open for the only task of a project, which has nothing to go under', async () => {
        await mountScreen({ prepare: window => window.openTask('t-28'), transport: daemon });

        const tasks = [...project().tasks.keys()].filter(id => id !== 't-28');

        for (const id of tasks) await page.store.command({ type: 'task.delete', taskId: id });

        await draw();

        expect(project().tasks.size).toBe(1);
        expect(buttonNamed('Set parent', sectionOf('CAR-28', 'Parent'))?.hasAttribute('disabled')).toBe(true);
    });
});

const root = () => page.store;

describe('the Sub-tasks section', () => {
    const rowsOf = (key: string) => [...sectionOf(key, 'Sub-tasks').querySelectorAll<HTMLElement>('button[title]')];

    it('lists the tasks directly inside the task with their keys and titles, by workflow status and then number, and not the ones inside those', async () => {
        await mountScreen({ prepare: window => window.openTask('t-31'), transport: daemon });

        const rows = rowsOf('CAR-31');
        const statuses = project().statuses;
        const rank = (taskId: string) => statuses.findIndex(status => status.id === task(taskId).statusId);

        // The workflow's order decides, and the number within a status: CAR-35 is todo, CAR-32 in progress, CAR-36 in review, CAR-37 canceled.
        expect(rows.map(row => /CAR-\d+/.exec(row.textContent ?? '')?.[0])).toEqual(['CAR-35', 'CAR-32', 'CAR-36', 'CAR-37']);
        expect(rank('t-35')).toBeLessThan(rank('t-32'));
        expect(sectionOf('CAR-31', 'Sub-tasks').textContent).not.toContain('CAR-33');
        expect(rows[0].textContent).toContain('Refund flow');
    });

    it('draws a status icon on each row', async () => {
        await mountScreen({ prepare: window => window.openTask('t-31'), transport: daemon });

        expect(rowsOf('CAR-31').every(row => row.querySelector('[data-tone]') !== null)).toBe(true);
    });

    it('shows how far the work inside has come over every level, a canceled task out of the count, in the header', async () => {
        await mountScreen({ prepare: window => window.openTask('t-31'), transport: daemon });

        // CAR-32 to CAR-36 count (CAR-33 is done); CAR-37 is canceled and is in neither number.
        const chip = sectionOf('CAR-31', 'Sub-tasks').querySelector('[role="img"]');

        expect(chip?.getAttribute('aria-label')).toBe('1 of 5 sub-tasks done');
        expect(chip?.textContent).toBe('1/5');
    });

    it('opens a sub-task in the panel, which moves the board to where its card is', async () => {
        await mountScreen({ prepare: window => window.openTask('t-31'), transport: daemon });

        const open = rowsOf('CAR-31').find(row => row.textContent?.includes('CAR-32'))!;

        await click(open);

        expect(ui().taskId).toBe('t-32');
        // The roots draw no card for a task inside another, so the screen goes to the task it is in.
        expect(ui().tasksScope).toBe('t-31');
        expect(panel('CAR-32')).not.toBeNull();
        expect(sectionOf('CAR-32', 'Sub-tasks').textContent).toContain('CAR-33');
    });

    it('opens the task for a grandchild too, from its parent\'s panel', async () => {
        await mountScreen({ prepare: window => window.openTask('t-32'), transport: daemon });
        await click(rowsOf('CAR-32').find(row => row.textContent?.includes('CAR-34')));

        expect(ui().taskId).toBe('t-34');
        expect(ui().tasksScope).toBe('t-32');
        expect(rowsOf('CAR-34')).toEqual([]);
    });

    it('opens the New task dialog for a task inside this one, with this task as its parent', async () => {
        await mountScreen({ prepare: window => window.openTask('t-32'), transport: daemon });
        await click(buttonNamed('New sub-task', sectionOf('CAR-32', 'Sub-tasks')));

        expect(openCreateTask).toHaveBeenCalledTimes(1);
        expect(vi.mocked(openCreateTask).mock.lastCall?.[0].parentId).toBe('t-32');
    });

    it('keeps Open sub-tasks for a task that has tasks inside it, and not for one with nothing inside it', async () => {
        await mountScreen({ prepare: window => window.openTask('t-31'), transport: daemon });

        expect(buttonNamed('Open sub-tasks', panel('CAR-31'))).toBeDefined();

        await click(buttonNamed('Open sub-tasks', panel('CAR-31')));
        await act(async () => ui().openTask('t-28'));
        await draw();

        expect(buttonNamed('Open sub-tasks', panel('CAR-28'))).toBeUndefined();
    });

    it('is there for a task with nothing inside it, which says so, has no roll-up, and makes its first sub-task from the button', async () => {
        await mountScreen({ prepare: window => window.openTask('t-28'), transport: daemon });

        const section = sectionOf('CAR-28', 'Sub-tasks');

        expect(section.textContent).toContain('No sub-tasks yet');
        expect(rowsOf('CAR-28')).toEqual([]);
        expect(section.querySelector('[role="img"]')).toBeNull();

        await click(buttonNamed('New sub-task', section));

        expect(openCreateTask).toHaveBeenCalledTimes(1);
        expect(vi.mocked(openCreateTask).mock.lastCall?.[0].parentId).toBe('t-28');
    });

    it('turns the button off for a task at the last level, and says why where the screen\'s own button does', async () => {
        await mountScreen({ prepare: window => window.openTask('t-28'), transport: daemon });

        // CAR-33 is level 3; five more under it make Level 8, the last level.
        let parentId = 't-33';

        for (let level = 4; level <= 8; level++) {
            const result = await page.store.command({ type: 'task.create', projectId: FIXTURE_PROJECT_ID, title: `Level ${ level }`, parentId });

            parentId = (result as { ok: true; data: { task: { id: string } } }).data.task.id;
        }

        await act(async () => ui().openTask(parentId));
        await draw();

        const section = sectionOf('CAR-45', 'Sub-tasks');
        // The real button is off; the stand-in beside it, which can have the focus, carries the hint.
        const button = [...section.querySelectorAll('button')].find(candidate => candidate.textContent === 'New sub-task');

        expect(section.textContent).toContain('No sub-tasks yet');
        expect(button?.hasAttribute('disabled')).toBe(true);

        await click(button);

        expect(openCreateTask).not.toHaveBeenCalled();

        await act(async () => section.querySelector<HTMLElement>('[role="button"][aria-label="New sub-task"]')!.focus());

        expect(document.body.textContent).toContain(DEPTH_LIMIT_HINT);
    });

    it('leaves out a sub-task that was archived, which the board does not hold', async () => {
        await mountScreen({ prepare: window => window.openTask('t-31'), transport: daemon });
        await act(async () => void (await page.store.command({ type: 'task.archive', taskId: 't-37' })));
        await draw();

        expect(rowsOf('CAR-31').map(row => /CAR-\d+/.exec(row.textContent ?? '')?.[0])).toEqual(['CAR-35', 'CAR-32', 'CAR-36']);
    });
});

describe('the checklist chip', () => {
    it('shows the steps done under the title when the description has a checklist', async () => {
        await mountScreen({ prepare: window => window.openTask('t-35'), transport: daemon });

        const chip = panel('CAR-35').querySelector('[aria-label="2 of 5 steps done"]');

        expect(chip?.textContent).toBe('2/5');
        // Under the title: before the status and the description.
        expect(panel('CAR-35').querySelector('textarea[aria-label="Title"]')!.compareDocumentPosition(chip!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('shows nothing for a description with no checklist, or none', async () => {
        await mountScreen({ prepare: window => window.openTask('t-24'), transport: daemon });

        expect(panel('CAR-24').querySelector('[aria-label$="steps done"]')).toBeNull();

        await act(async () => ui().openTask('t-28'));
        await draw();

        expect(panel('CAR-28').querySelector('[aria-label$="steps done"]')).toBeNull();
    });
});

describe('the description', () => {
    const boxes = (key: string) => [...panel(key).querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];

    it('is a Markdown editor, and a checklist line is a checkbox, ticked as the description says', async () => {
        await mountScreen({ prepare: window => window.openTask('t-35'), transport: daemon });

        expect(panel('CAR-35').querySelector('[contenteditable="true"][aria-label="Description"]')).not.toBeNull();
        expect(boxes('CAR-35').map(box => box.checked)).toEqual([true, true, false, false, false]);
    });

    it('writes a ticked box into the description at once, moves the chip, and takes the whole tick back with one undo', async () => {
        await mountScreen({ prepare: window => window.openTask('t-35'), transport: daemon });

        const was = task('t-35').description;

        await act(async () => boxes('CAR-35')[2].click());
        await wait(0);
        await draw();

        const ticked = was.replace('- [ ] Refund part of a booking', '- [x] Refund part of a booking');

        expect(updates()).toEqual([{ type: 'task.update', taskId: 't-35', description: ticked }]);
        expect(task('t-35').description).toBe(ticked);
        expect(panel('CAR-35').querySelector('[aria-label="3 of 5 steps done"]')).not.toBeNull();

        // A second tick shortly after is the same step for the undo.
        await act(async () => boxes('CAR-35')[3].click());
        await wait(0);
        await draw();

        expect(updates()).toHaveLength(2);
        expect(panel('CAR-35').querySelector('[aria-label="4 of 5 steps done"]')).not.toBeNull();
        expect(undoStack.entries.map(entry => entry.label)).toEqual(['Description of CAR-35 changed']);

        await act(async () => void (await undoStack.undoLatest(FIXTURE_PROJECT_ID)));
        await draw();

        expect(task('t-35').description).toBe(was);
        expect(boxes('CAR-35').map(box => box.checked)).toEqual([true, true, false, false, false]);
    });

    it('shows a line an agent ticked, from outside, at once', async () => {
        await mountScreen({ prepare: window => window.openTask('t-35'), transport: daemon });
        await act(async () => void (await page.store.command({ type: 'task.update', taskId: 't-35', description: task('t-35').description.replace('- [ ] Tell the person by email', '- [x] Tell the person by email') })));
        await draw();

        expect(boxes('CAR-35').map(box => box.checked)).toEqual([true, true, false, true, false]);
    });
});

describe('the Comments section', () => {
    const articles = () => [...panel('CAR-32').querySelectorAll<HTMLElement>('article')];
    const commentIds = () => articles().map(found => found.dataset.commentId);
    const composer = () => panel('CAR-32').querySelector<HTMLElement & { editor: Editor }>('[contenteditable][aria-label="Write a comment"]')!;
    const write = (text: string) => act(async () => void composer().editor.chain().focus('end').insertContent(text).run());
    /** What the section needs to hear a change of the comments and read them again: the screen drawn, the pause that lets a burst of changes be one read, and the read. */
    const refresh = async () => {
        await wait(30);
        await draw();
        await wait(REFRESH_DELAY_MS + 50);
    };
    const scrolled = () => vi.mocked(Element.prototype.scrollIntoView).mock.contexts as Element[];

    /** A daemon that holds the demo's data, to which a test may add comments before the screen is drawn. */
    const withData = (change: (comments: TaskComment[]) => void) => {
        const data = createFixtureData();

        change(data.comments);

        return () => daemon(new FixtureTransport({ data }));
    };

    beforeEach(() => {
        Element.prototype.scrollIntoView = vi.fn();
    });

    it('shows the loader while the comments are read, then the comments of the task oldest first with their count', async () => {
        await mountScreen({ prepare: window => window.openTask('t-32'), transport: daemon });

        expect(panel('CAR-32').querySelector('[role="status"][aria-label="Loading"]')).not.toBeNull();
        expect(panel('CAR-32').textContent).toContain('Loading comments…');

        await wait(250);
        await draw();

        expect(commentIds()).toEqual(['cmt_A001', 'cmt_A002', 'cmt_A003']);
        expect(sectionOf('CAR-32', 'Comments').firstElementChild!.textContent).toBe('Comments3');
        expect(panel('CAR-32').querySelector('[role="status"][aria-label="Loading"]')).toBeNull();
    });

    it('is the last section, under the activity and above the footer', async () => {
        await mountScreen({ prepare: window => window.openTask('t-32'), transport: daemon });

        const sections = [...panel('CAR-32').querySelectorAll('section')].map(found => found.firstElementChild?.textContent?.replace(/\d+$/, ''));

        expect(sections.at(-1)).toBe('Comments');
        expect(sections.at(-2)).toBe('Latest activity');
    });

    it('names the person "You" and an agent by its run, which opens in Agents, and knows when the run is gone', async () => {
        const gone: TaskComment = { id: 'cmt_gone', taskId: 't-32', author: { kind: 'run', runId: 'r-deleted' }, body: 'Done.', createdAt: Date.now() };

        await mountScreen({ prepare: window => window.openTask('t-32'), transport: withData(comments => void comments.push(gone)) });
        await wait(250);
        await draw();

        expect(articles()[0].querySelector('header')!.textContent).toMatch(/^You/);

        const link = articles()[1].querySelector<HTMLElement>('header button')!;

        expect(link.textContent).toBe('Orchestrator 01');
        expect(articles().at(-1)!.querySelector('header')!.textContent).toMatch(/^Agent/);
        expect(articles().at(-1)!.querySelector('header button')).toBeNull();

        await click(link);

        // A chat's orchestrator is its chat: the Agents section opens on it.
        expect(ui().section).toBe('agents');
        expect(ui().runId).toBe('r-orch-1');
    });

    it('offers Edit and Delete on the person\'s comments and not on the agent\'s', async () => {
        await mountScreen({ prepare: window => window.openTask('t-32'), transport: daemon });
        await wait(250);
        await draw();

        const own = (found: HTMLElement) => found.querySelector('button[aria-label="Edit comment"]') !== null;

        expect(articles().map(own)).toEqual([true, false, true]);
    });

    it('adds a comment, reads the comments again, and brings the composer into view', async () => {
        await mountScreen({ prepare: window => window.openTask('t-32'), transport: daemon });
        await wait(250);
        await draw();

        await write('Ship it.');
        await click([...panel('CAR-32').querySelectorAll('button')].find(button => button.textContent === 'Send'));
        await refresh();

        expect(sent.filter(input => input.type === 'task.comment.add')).toEqual([{ type: 'task.comment.add', taskId: 't-32', body: 'Ship it.' }]);
        expect(commentIds()).toHaveLength(4);
        expect(articles().at(-1)!.textContent).toContain('Ship it.');
        expect(sectionOf('CAR-32', 'Comments').firstElementChild!.textContent).toBe('Comments4');
        expect(composer().editor.getMarkdown()).toBe('');
        expect(scrolled()).toHaveLength(1);
        expect(scrolled()[0].contains(composer())).toBe(true);
    });

    it('sends with Cmd/Ctrl+Enter, the key that starts the task from the list, and does not start it', async () => {
        await mountScreen({ prepare: window => window.openTask('t-27'), transport: daemon });
        await wait(250);
        await draw();

        await act(async () => void panel('CAR-27').querySelector<HTMLElement & { editor: Editor }>('[contenteditable][aria-label="Write a comment"]')!.editor.chain().focus('end').insertContent('Looks fine.').run());
        await act(async () => void press('Enter', { mod: true }, panel('CAR-27').querySelector('[contenteditable][aria-label="Write a comment"]')!));
        await wait(30);

        expect(sent.filter(input => input.type === 'task.comment.add')).toEqual([{ type: 'task.comment.add', taskId: 't-27', body: 'Looks fine.' }]);
        expect(sent.filter(input => input.type === 'task.start')).toEqual([]);
    });

    it('shows a comment that comes from elsewhere without moving the list', async () => {
        await mountScreen({ prepare: window => window.openTask('t-32'), transport: daemon });
        await wait(250);
        await draw();

        // Another window: the daemon takes a comment the composer here did not send.
        await act(async () => void (await page.store.command({ type: 'task.comment.add', taskId: 't-32', body: 'From another window.' })));
        await refresh();

        expect(commentIds()).toHaveLength(4);
        expect(articles().at(-1)!.textContent).toContain('From another window.');
        expect(scrolled()).toEqual([]);
    });

    it('edits a comment, and shows it with its new body and "edited" once the daemon says so', async () => {
        await mountScreen({ prepare: window => window.openTask('t-32'), transport: daemon });
        await wait(250);
        await draw();

        const first = () => articles()[0];

        expect(first().textContent).not.toContain('edited');

        await click(first().querySelector('button[aria-label="Edit comment"]'));
        await act(async () => void first().querySelector<HTMLElement & { editor: Editor }>('[contenteditable]')!.editor.chain().focus('end').insertContent(' Always.').run());
        await click([...first().querySelectorAll('button')].find(button => button.textContent === 'Save'));
        await refresh();

        expect(sent.filter(input => input.type === 'task.comment.edit')).toEqual([
            { type: 'task.comment.edit', taskId: 't-32', commentId: 'cmt_A001', body: 'Use the sandbox keys until the checkout is reviewed. Always.' },
        ]);
        expect(first().textContent).toContain('Always.');
        expect(first().textContent).toContain('edited');
        expect(first().querySelector('[contenteditable]')).toBeNull();
    });

    it('deletes a comment after a second press, and the list loses it', async () => {
        await mountScreen({ prepare: window => window.openTask('t-32'), transport: daemon });
        await wait(250);
        await draw();

        const button = () => [...articles()[0].querySelectorAll('button')].find(candidate => candidate.textContent?.includes('Delete'));

        await click(button());

        expect(sent.filter(input => input.type === 'task.comment.delete')).toEqual([]);

        await click(button());
        await refresh();

        expect(sent.filter(input => input.type === 'task.comment.delete')).toEqual([{ type: 'task.comment.delete', taskId: 't-32', commentId: 'cmt_A001' }]);
        expect(commentIds()).toEqual(['cmt_A002', 'cmt_A003']);
        expect(sectionOf('CAR-32', 'Comments').firstElementChild!.textContent).toBe('Comments2');
    });

    it('says there are none for a task without comments, and shows the comments of the task that is open when the person moves on', async () => {
        await mountScreen({ prepare: window => window.openTask('t-32'), transport: daemon });
        await wait(250);
        await draw();
        await act(async () => ui().openTask('t-33'));
        await draw();

        // Not the comments of the task before it, while the new ones are read.
        expect(panel('CAR-33').querySelectorAll('article')).toHaveLength(0);

        await wait(250);
        await draw();

        expect(panel('CAR-33').textContent).toContain('No comments yet');
    });

    it('keeps the comment typed and not sent when another task opens, and puts it back when the task opens again', async () => {
        await mountScreen({ prepare: window => window.openTask('t-32'), transport: daemon });
        await wait(250);
        await draw();
        await write('Half a thought');
        await act(async () => ui().openTask('t-33'));
        await draw();

        const otherComposer = () => panel('CAR-33').querySelector<HTMLElement & { editor: Editor }>('[contenteditable][aria-label="Write a comment"]')!;

        expect(otherComposer().editor.getMarkdown()).toBe('');

        await act(async () => ui().openTask('t-32'));
        await draw();

        expect(composer().editor.getMarkdown()).toBe('Half a thought');
        expect(sent.filter(input => input.type === 'task.comment.add')).toEqual([]);
    });

    it('reads every page of a task with more than a hundred comments', async () => {
        const many = Array.from({ length: 130 }, (_, index): TaskComment => ({ id: `cmt_M${ String(index).padStart(3, '0') }`, taskId: 't-33', author: { kind: 'user' }, body: `Note ${ index }`, createdAt: 1000 + index }));

        await mountScreen({ prepare: window => window.openTask('t-33'), transport: withData(comments => void comments.push(...many)) });
        await wait(300);
        await draw();

        const reads = [...panel('CAR-33').querySelectorAll('article')];

        expect(reads).toHaveLength(130);
        expect(reads[0].textContent).toContain('Note 0');
        expect(reads.at(-1)!.textContent).toContain('Note 129');
        expect(sectionOf('CAR-33', 'Comments').firstElementChild!.textContent).toBe('Comments130');
    });

    it('says the comments did not load, and reads them again on Retry', async () => {
        let isDown = true;

        await mountScreen({
            prepare: window => window.openTask('t-32'),
            transport: base => overrideTransport(daemon(base), {
                getTaskComments: async (taskId, page) => {
                    if (isDown) throw new Error('The daemon cannot be reached');

                    return base.getTaskComments(taskId, page);
                },
            }),
        });
        await wait(250);
        await draw();

        expect(panel('CAR-32').textContent).toContain('Comments did not load');
        expect(articles()).toHaveLength(0);

        isDown = false;
        await click([...panel('CAR-32').querySelectorAll('button')].find(button => button.textContent === 'Retry'));
        await wait(250);
        await draw();

        expect(commentIds()).toHaveLength(3);
    });

    it('does not read the comments of a task the cursor only passes', async () => {
        const reads: string[] = [];

        await mountScreen({
            prepare: window => window.openTask('t-32'),
            transport: base => overrideTransport(daemon(base), {
                getTaskComments: async (taskId, page) => {
                    reads.push(taskId);

                    return base.getTaskComments(taskId, page);
                },
            }),
        });

        for (const taskId of ['t-33', 't-34', 't-35']) {
            await act(async () => ui().openTask(taskId));
            await draw();
            await wait(20);
        }

        await wait(250);

        // Only the one the person stopped on.
        expect(reads).toEqual(['t-35']);
    });
});
