// @vitest-environment happy-dom
import { toast } from '@clowdy/components/Toast';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { overrideTransport } from '../../daemon/testing';
import { undoStack } from '../../hotkeys/undo';
import { ARCHIVED_MEMORY_LIMIT } from '../../stores/ProjectState';
import { OPENING_DELAY_MS } from './OpeningTask';
import {
    buttonNamed,
    change,
    click,
    closePage,
    draw,
    drawn,
    isOn,
    itemOf,
    mountScreen,
    openPage,
    page,
    pathText,
    press,
    project,
    search,
    ui,
    wait,
} from './screenHarness';
import { parentCandidates } from './taskTree';
import { dependencyCandidates } from './taskView';
import { RELOAD_DELAY_MS } from './useArchivedTasks';

import type { TaskComment, TaskDetail } from '@clowdy/protocol';
import type { CommandInput } from '../../daemon/transport';

// `Modal` cannot load under the desktop's Vitest (decorators), and neither dialog is opened here.
vi.mock('@clowdy/components/modals', () => ({ openConfirmModal: vi.fn() }));
vi.mock('./CreateTaskDialog', () => ({ openCreateTask: vi.fn() }));

/*
 * The archive on the Tasks screen: the header's toggle and the view it shows, the read-only panel of an archived task and what it offers, and how an archived task is opened
 * from a dependency, from the history and by its id. The demo project has CAR-38 (with CAR-39 and CAR-40 inside it) in the archive; the board has CAR-20 to CAR-37.
 */

let sent: CommandInput[];

beforeEach(() => {
    sent = [];
    vi.spyOn(toast, 'error');
    openPage();
});

afterEach(() => {
    closePage();
    vi.restoreAllMocks();
});

const panel = (key: string) => page.container.querySelector<HTMLElement>(`aside[aria-label="Task ${key}"]`);
const archiveRows = () =>
    [...page.container.querySelectorAll<HTMLElement>('[data-archived-task]')].map(row => row.dataset.archivedTask);
const rowOf = (taskId: string) => page.container.querySelector<HTMLElement>(`[data-archived-task="${taskId}"]`)!;
const titleOf = (taskId: string) => rowOf(taskId).querySelector<HTMLButtonElement>('button[title]')!;
const openArchive = () => ui().setTasksArchive(true);
const sectionOf = (key: string, title: string) =>
    [...panel(key)!.querySelectorAll<HTMLElement>('section')].find(section => section.textContent?.startsWith(title))!;
/** The labels of the buttons in a part of the page: a button with a second press (Delete asks again) has the words of both. */
const buttonTexts = (within: ParentNode) =>
    [...within.querySelectorAll('button')].map(button => button.textContent ?? '');
const recording = (base: Parameters<NonNullable<Parameters<typeof mountScreen>[0]>['transport'] & {}>[0]) =>
    overrideTransport(base, {
        command: async input => {
            sent.push(input);

            return base.command(input);
        },
    });

/** Draws what the archive view found, once the daemon has answered. */
async function settleArchive() {
    await wait(0);
    await draw();
}

/** The project changed, and the view reads the archive again after its pause. */
async function settleReload() {
    await draw();
    await wait(RELOAD_DELAY_MS + 80);
    await draw();
}

describe("the header's Archive toggle", () => {
    it('is off at first, and shows the archive in place of the board when it is pressed', async () => {
        await mountScreen();

        expect(isOn('Archive')).toBe(false);
        expect(drawn()).toHaveLength(12);

        await click(buttonNamed('Archive'));
        await settleArchive();

        expect(isOn('Archive')).toBe(true);
        expect(ui().tasksArchive).toBe(true);
        expect(drawn()).toEqual([]);
        expect(archiveRows()).toEqual(['t-38', 't-39', 't-40']);
        expect(page.container.querySelector('header')?.textContent).toContain('Archived tasks');
    });

    it("takes the scope's own controls off the header and leaves the toggle: the path, the view, the sub-tasks, the search, the filter and the new task button", async () => {
        await mountScreen({
            prepare: window => {
                window.setTasksScope('t-31');
                window.setTasksArchive(true);
            },
        });
        await settleArchive();

        expect(pathText()).toEqual([]);
        expect(page.container.querySelector('section[aria-label="Inside CAR-31"]')).toBeNull();
        expect(page.container.querySelector('input[aria-label="Search tasks"]')).toBeNull();

        for (const name of ['Board', 'List', 'Sub-tasks', 'Filter', 'Task', 'Sub-task'])
            expect(buttonNamed(name)).toBeUndefined();

        expect(buttonNamed('Archive')).toBeDefined();
    });

    it('is project-wide, so it shows the whole archive whatever the scope, and leaving it returns to the same scope and view', async () => {
        await mountScreen({
            prepare: window => {
                window.setTasksScope('t-31');
                window.setTaskPageView('list');
            },
        });

        expect(pathText()).toEqual(['Tasks', 'CAR-31']);

        await click(buttonNamed('Archive'));
        await settleArchive();

        expect(archiveRows()).toEqual(['t-38', 't-39', 't-40']);

        await click(buttonNamed('Archive'));

        expect(ui().tasksArchive).toBe(false);
        expect(ui().tasksScope).toBe('t-31');
        expect(pathText()).toEqual(['Tasks', 'CAR-31']);
        expect(isOn('List')).toBe(true);
        expect(page.container.querySelector('table')).not.toBeNull();
        expect(drawn()).toContain('t-32');
    });

    it('gives the board its own search back after the archive, as it was typed', async () => {
        await mountScreen();
        await search('booking');

        const before = drawn();

        await click(buttonNamed('Archive'));
        await settleArchive();
        await click(buttonNamed('Archive'));

        expect(page.container.querySelector<HTMLInputElement>('input[aria-label="Search tasks"]')!.value).toBe(
            'booking'
        );
        expect(drawn()).toEqual(before);
    });

    it('leaves the keys of the board inert while it shows, so nothing acts on tasks that are not on show', async () => {
        await mountScreen({ transport: recording });
        await click(buttonNamed('Archive'));
        await settleArchive();

        for (const key of ['j', 'x', 'e', 's']) press(key);

        await draw();

        expect(sent).toEqual([]);
        expect(page.store.selectedProject?.tasks.size).toBeGreaterThan(0);
    });

    it('shows the archive of the project it is on after a switch between two projects that both show theirs, and not the list of the one it left', async () => {
        await mountScreen();
        page.store.ui.forProject(FIXTURE_EMPTY_PROJECT_ID).setTasksArchive(true);
        await click(buttonNamed('Archive'));
        await settleArchive();

        expect(archiveRows()).toEqual(['t-38', 't-39', 't-40']);

        // The screen is the same element for both projects: the view must start again, or it would stand on the first project's list while the second one is read.
        await draw(() => page.store.selectProject(FIXTURE_EMPTY_PROJECT_ID));

        expect(archiveRows()).toEqual([]);

        await settleArchive();

        expect(page.container.textContent).toContain('Nothing archived');

        await draw(() => page.store.selectProject(FIXTURE_PROJECT_ID));
        await settleArchive();

        expect(archiveRows()).toEqual(['t-38', 't-39', 't-40']);
    });

    it('is a view option and no place: the history does not step into it and out of it', async () => {
        await mountScreen();
        await click(buttonNamed('Archive'));
        await click(buttonNamed('Archive'));

        expect(page.store.history.canGoBack).toBe(false);
    });
});

describe('the panel of an archived task', () => {
    it('opens read only when a task of the archive is pressed, with its archive status and Restore, and nothing to edit', async () => {
        await mountScreen({ prepare: openArchive });
        await settleArchive();
        await click(titleOf('t-38'));

        const aside = panel('CAR-38')!;

        expect(ui().taskId).toBe('t-38');
        expect(aside.hasAttribute('data-archived')).toBe(true);
        expect(aside.textContent).toContain('Clean up the admin pages');
        expect(aside.textContent).toContain('Archived 2 days ago');
        expect(aside.querySelector('textarea, input, [contenteditable="true"]')).toBeNull();
        expect(buttonTexts(aside)).toContain('Restore');
        expect(
            buttonTexts(aside).filter(
                label =>
                    /Start|Delete|Cancel and archive|New sub-task|Set parent|Change/.test(label) || label === 'Archive'
            )
        ).toEqual([]);

        expect(rowOf('t-38').hasAttribute('data-open')).toBe(true);
    });

    it('has Restore on the top of a batch, and on a task inside it a note that says which task to restore, with the button off', async () => {
        await mountScreen({ prepare: window => window.openTask('t-39') });
        await wait(0);
        await draw();

        const aside = panel('CAR-39')!;

        expect(aside.textContent).toContain('It was archived with CAR-38. Restore CAR-38 to bring it back');
        expect(buttonNamed('Restore', aside)!.hasAttribute('disabled')).toBe(true);
        // The parent opens, which is where the restore is.
        expect(sectionOf('CAR-39', 'Parent').textContent).toContain('CAR-38');

        await click(sectionOf('CAR-39', 'Parent').querySelector('button'));
        await wait(0);
        await draw();

        expect(ui().taskId).toBe('t-38');
        expect(buttonNamed('Restore', panel('CAR-38')!)!.hasAttribute('disabled')).toBe(false);
    });

    it('offers Restore for a top whose parent is on the board, since the daemon takes it', async () => {
        // CAR-33 goes to the archive alone; CAR-32, which it is inside, stays on the board.
        await mountScreen({ transport: recording });
        await change({ type: 'task.archive', taskId: 't-33' });
        await wait(0);
        ui().openTask('t-33');
        await draw();
        await wait(0);
        await draw();

        expect(buttonNamed('Restore', panel('CAR-33')!)!.hasAttribute('disabled')).toBe(false);
        expect(panel('CAR-33')!.textContent).not.toContain('It was archived with');
    });

    it('has no Restore for a top whose parent was archived in a later batch, and says which task to restore first', async () => {
        // CAR-33 goes to the archive alone, then CAR-32 that it is inside: they are two batches, and the daemon takes CAR-33 back only after CAR-32.
        await mountScreen({ transport: recording });
        await change({ type: 'task.archive', taskId: 't-33' });
        await change({ type: 'task.archive', taskId: 't-32', cancel: true });
        await wait(0);
        ui().openTask('t-33');
        await draw();
        await wait(0);
        await draw();

        const aside = panel('CAR-33')!;

        expect(buttonNamed('Restore', aside)!.hasAttribute('disabled')).toBe(true);
        expect(aside.textContent).toContain('Its parent CAR-32 is in the archive, restore it first');
        expect(aside.textContent).not.toContain('It was archived with');
    });

    it('restores the batch: the task is back on the board, the panel is the one of a task of the board, and the undo offers to archive it again', async () => {
        await mountScreen({ prepare: window => window.openTask('t-38'), transport: recording });
        await wait(0);
        await draw();
        await click(buttonNamed('Restore', panel('CAR-38')!));
        await wait(0);
        await draw();

        expect(sent).toEqual([{ type: 'task.unarchive', taskId: 't-38' }]);
        expect(project().tasks.has('t-38')).toBe(true);
        expect(panel('CAR-38')!.hasAttribute('data-archived')).toBe(false);
        expect(buttonTexts(panel('CAR-38')!).some(label => label.includes('Delete'))).toBe(true);
        expect(undoStack.entries.map(entry => entry.label)).toEqual(['Restored CAR-38']);
    });

    it('goes back to read only when the restore is undone', async () => {
        await mountScreen({ prepare: window => window.openTask('t-38'), transport: recording });
        await wait(0);
        await draw();
        await click(buttonNamed('Restore', panel('CAR-38')!));
        await wait(0);
        await draw();
        await act(async () => void press('z', { mod: true }));
        await wait(0);
        await draw();

        expect(sent.at(-1)).toEqual({ type: 'task.archive', taskId: 't-38' });
        expect(project().tasks.has('t-38')).toBe(false);
        expect(panel('CAR-38')!.hasAttribute('data-archived')).toBe(true);
    });

    it("shows the daemon's reason when a restore is refused", async () => {
        await mountScreen({
            prepare: window => window.openTask('t-38'),
            transport: base =>
                overrideTransport(base, {
                    command: async input =>
                        input.type === 'task.unarchive'
                            ? {
                                  ok: false,
                                  requestId: 'r',
                                  error: { code: 'invalid', message: 'Nothing can be restored today' },
                              }
                            : base.command(input),
                }),
        });
        await wait(0);
        await draw();
        await click(buttonNamed('Restore', panel('CAR-38')!));

        expect(toast.error).toHaveBeenCalledWith({ message: 'Nothing can be restored today' });
        expect(panel('CAR-38')!.hasAttribute('data-archived')).toBe(true);
    });

    it('reads its comments, and has no composer and no Edit or Delete on them', async () => {
        await mountScreen({ prepare: window => window.openTask('t-38'), transport: recording });
        await wait(0);
        await draw();

        const comments = sectionOf('CAR-38', 'Comments');

        expect(comments).toBeDefined();
        expect(comments.querySelector('[contenteditable="true"]')).toBeNull();
        expect(buttonNamed('Send', comments)).toBeUndefined();
    });

    it('opens the agent that wrote one of its comments in Agents, as the panel of a task on the board does', async () => {
        const agent: TaskComment = {
            id: 'cmt_agent',
            taskId: 't-38',
            author: { kind: 'run', runId: 'r-orch-1' },
            body: 'Archived once the reports moved.',
            createdAt: Date.now(),
        };

        await mountScreen({
            prepare: window => window.openTask('t-38'),
            transport: base =>
                overrideTransport(base, { getTaskComments: async () => ({ comments: [agent], total: 1 }) }),
        });
        await wait(250);
        await draw();

        const link = sectionOf('CAR-38', 'Comments').querySelector<HTMLElement>('header button')!;

        expect(link.textContent).toBe('Simplify booking');

        await click(link);
        expect(ui().runId).toBe('r-orch-1');
    });

    it('goes when the task is deleted from elsewhere, and nothing stands in its place', async () => {
        await mountScreen({ prepare: window => window.openTask('t-40') });
        await wait(0);
        await draw();

        expect(panel('CAR-40')).not.toBeNull();

        await change({ type: 'task.delete', taskId: 't-40' });
        await wait(0);
        await draw();

        expect(panel('CAR-40')).toBeNull();
        expect(page.container.querySelector('aside')).toBeNull();
    });

    it('follows a change of the archived task from elsewhere, such as a new title', async () => {
        await mountScreen({ prepare: window => window.openTask('t-40') });
        await wait(0);
        await draw();
        // The daemon lets an archived task be renamed; the event carries it with its archive time.
        await change({ type: 'task.update', taskId: 't-40', title: 'Drop the dark theme switch' });
        await draw();

        expect(panel('CAR-40')!.textContent).toContain('Drop the dark theme switch');
        expect(panel('CAR-40')!.hasAttribute('data-archived')).toBe(true);
    });

    it('closes with its button or Escape, as any panel does', async () => {
        await mountScreen({ prepare: window => window.openTask('t-38') });
        await wait(0);
        await draw();
        await click(buttonNamed('Close', panel('CAR-38')!));

        expect(ui().taskId).toBeNull();
        expect(panel('CAR-38')).toBeNull();

        ui().openTask('t-38');
        await draw();
        await act(async () => void press('Escape'));
        await draw();

        expect(ui().taskId).toBeNull();
    });
});

describe('an archived task opened by its id', () => {
    it('waits with the loader while the daemon reads it, then shows it read only', async () => {
        let release: () => void = () => undefined;

        await mountScreen({
            prepare: window => window.openTask('t-38'),
            transport: base =>
                overrideTransport(base, {
                    getTaskDetail: async taskId => {
                        await new Promise<void>(resolve => {
                            release = resolve;
                        });

                        return base.getTaskDetail(taskId);
                    },
                }),
        });

        // Not at once: a task that comes in a moment makes no panel of waiting.
        expect(page.container.querySelector('aside')).toBeNull();

        await wait(OPENING_DELAY_MS + 50);
        await draw();

        const waiting = page.container.querySelector<HTMLElement>('aside[aria-busy="true"]');

        expect(waiting).not.toBeNull();
        expect(waiting!.textContent).toContain('Loading the task…');
        expect(panel('CAR-38')).toBeNull();

        await act(async () => release());
        await wait(0);
        await draw();

        expect(page.container.querySelector('aside[aria-busy="true"]')).toBeNull();
        expect(panel('CAR-38')!.hasAttribute('data-archived')).toBe(true);
        // The project remembers it now, so the next time is immediate.
        expect(project().archivedKnown.has('t-38')).toBe(true);
    });

    it('stays on show when the project lets the task go from its memory, since it is read again', async () => {
        await mountScreen({ prepare: window => window.openTask('t-38') });
        await wait(0);
        await draw();

        expect(panel('CAR-38')).not.toBeNull();

        // The memory is bounded, and the task read longest ago goes first: the archive view's pages push it out.
        const archived = project().archivedKnown.get('t-38')!;

        act(() =>
            project().rememberArchived(
                Array.from({ length: ARCHIVED_MEMORY_LIMIT }, (_, index) => ({
                    ...archived,
                    id: `t-extra-${index}`,
                    key: `CAR-${900 + index}`,
                }))
            )
        );

        expect(project().archivedKnown.has('t-38')).toBe(false);

        await draw();
        await wait(0);
        await draw();

        expect(panel('CAR-38')).not.toBeNull();
    });

    it('shows nothing for a task the daemon does not have, as it did for a task that is gone', async () => {
        await mountScreen({ prepare: window => window.openTask('t-404') });
        await wait(0);
        await draw();

        expect(page.container.querySelector('aside')).toBeNull();
    });

    it('says why when the daemon cannot be asked, with Retry', async () => {
        let failing = true;

        await mountScreen({
            prepare: window => window.openTask('t-38'),
            transport: base =>
                overrideTransport(base, {
                    getTaskDetail: async (taskId): Promise<TaskDetail> => {
                        if (failing) throw new Error('The daemon is not answering');

                        return base.getTaskDetail(taskId);
                    },
                }),
        });
        await wait(0);
        await draw();

        expect(page.container.querySelector('aside')!.textContent).toContain(
            'The task could not be loaded. The daemon is not answering'
        );

        failing = false;
        await click(buttonNamed('Retry'));
        await wait(0);
        await draw();

        expect(panel('CAR-38')!.hasAttribute('data-archived')).toBe(true);
    });

    it('closes from the panel that waits', async () => {
        await mountScreen({
            prepare: window => window.openTask('t-38'),
            transport: base =>
                overrideTransport(base, {
                    getTaskDetail: () => new Promise<TaskDetail>(() => undefined),
                }),
        });
        await wait(OPENING_DELAY_MS + 50);
        await draw();
        await click(buttonNamed('Close', page.container.querySelector('aside')!));

        expect(ui().taskId).toBeNull();
        expect(page.container.querySelector('aside')).toBeNull();
    });

    it('is not shown for a task of another project', async () => {
        await mountScreen({ projectId: FIXTURE_EMPTY_PROJECT_ID, prepare: window => window.openTask('t-38') });
        await wait(0);
        await draw();

        expect(page.container.querySelector('aside')).toBeNull();
    });
});

describe('a dependency on an archived task', () => {
    /** CAR-26 waits for CAR-24 and CAR-21, and CAR-21, which is done, goes to the archive. */
    async function archivedDependency() {
        await mountScreen({ transport: recording, prepare: window => window.openTask('t-26') });
        await change({ type: 'task.update', taskId: 't-26', dependsOn: ['t-24', 't-21'] });
        await change({ type: 'task.archive', taskId: 't-21' });
        await wait(0);
        await draw();
    }

    const dependencies = () => sectionOf('CAR-26', 'Dependencies');
    const dependencyRow = (key: string) =>
        [...dependencies().querySelectorAll<HTMLElement>('button[title]')].find(button =>
            button.textContent?.includes(key)
        )!;
    const tickOf = (key: string) =>
        dependencyRow(key).parentElement!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

    it('is shown as resolved, with its key and title, and not as a removed task', async () => {
        await archivedDependency();

        const row = dependencyRow('CAR-21').parentElement!;

        expect(row.textContent).toContain('CAR-21');
        expect(row.textContent).toContain('Set up the booking schema');
        expect(row.textContent).toContain('Archived');
        expect(dependencies().textContent).not.toContain('Removed task');
        expect(tickOf('CAR-21').checked).toBe(true);
        expect(tickOf('CAR-24').checked).toBe(false);
    });

    it('is read from the daemon when the window did not see it archived, and the panel waits with "Loading…" until then', async () => {
        let release: () => void = () => undefined;

        // CAR-26 depends on CAR-38, which was archived before the window opened.
        await mountScreen({
            prepare: window => window.openTask('t-26'),
            transport: base =>
                overrideTransport(base, {
                    getTaskDetail: async taskId => {
                        if (taskId === 't-38') {
                            await new Promise<void>(resolve => {
                                release = resolve;
                            });
                        }

                        return base.getTaskDetail(taskId);
                    },
                }),
        });
        await page.store.command({ type: 'task.update', taskId: 't-26', dependsOn: ['t-24', 't-38'] });
        await wait(0);
        await draw();

        expect(dependencies().textContent).toContain('Loading…');

        await act(async () => release());
        await wait(0);
        await draw();

        expect(dependencies().textContent).toContain('CAR-38');
        expect(dependencies().textContent).toContain('Clean up the admin pages');
        expect(dependencies().textContent).not.toContain('Loading…');
        expect(tickOf('CAR-38').checked).toBe(true);
    });

    it('says it could not be read when the daemon cannot be asked', async () => {
        await mountScreen({
            prepare: window => window.openTask('t-26'),
            transport: base =>
                overrideTransport(base, {
                    getTaskDetail: async taskId => {
                        if (taskId === 't-38') throw new Error('offline');

                        return base.getTaskDetail(taskId);
                    },
                }),
        });
        await page.store.command({ type: 'task.update', taskId: 't-26', dependsOn: ['t-24', 't-38'] });
        await wait(0);
        await draw();

        expect(dependencies().textContent).toContain("Couldn't read the task");
        expect(dependencies().textContent).not.toContain('Removed task');
    });

    it('opens the archived task in the panel when it is pressed', async () => {
        await archivedDependency();
        await click(dependencyRow('CAR-21'));
        await wait(0);
        await draw();

        expect(ui().taskId).toBe('t-21');
        expect(panel('CAR-21')!.hasAttribute('data-archived')).toBe(true);
        expect(panel('CAR-26')).toBeNull();
    });

    it('shows the dependencies of an archived task in its own panel, read only and resolved the same way', async () => {
        await mountScreen({ transport: recording });
        // CAR-39 waits for CAR-40; both go to the archive with CAR-38.
        await change({ type: 'task.unarchive', taskId: 't-38' });
        await change({ type: 'task.update', taskId: 't-39', dependsOn: ['t-40'] });
        await change({ type: 'task.archive', taskId: 't-38' });
        ui().openTask('t-39');
        await wait(0);
        await draw();

        const dependsOn = sectionOf('CAR-39', 'Dependencies');

        expect(dependsOn.textContent).toContain('CAR-40');
        expect(dependsOn.textContent).toContain('Drop the admin theme switch');
        expect(dependsOn.querySelector('button[aria-label^="Remove dependency"]')).toBeNull();
        expect(dependsOn.querySelector('[aria-label="Add dependency"]')).toBeNull();
    });
});

describe('archived tasks appear in no other view', () => {
    async function archiveTree() {
        await mountScreen({ transport: recording });
        await change({ type: 'task.archive', taskId: 't-31', cancel: true });
        await wait(0);
        await draw();
    }

    it('are not cards of the board, and not rows of the list', async () => {
        await archiveTree();

        expect(drawn()).not.toContain('t-31');
        expect(drawn()).toHaveLength(11);

        ui().setTasksView('list');
        await draw();

        expect(page.container.querySelector('table')).not.toBeNull();
        expect(drawn()).toHaveLength(11);
        expect(drawn().some(id => ['t-31', 't-32', 't-33', 't-37'].includes(id!))).toBe(false);
    });

    it('are not in the through board either, where the sub-tasks of the project are drawn', async () => {
        await archiveTree();
        ui().setTasksSubtasks(true);
        await draw();

        expect(drawn()).toHaveLength(11);
    });

    it('make the scope that was archived the roots again, and bring it back with the restore', async () => {
        await mountScreen({ transport: recording, prepare: window => window.setTasksScope('t-31') });
        await change({ type: 'task.archive', taskId: 't-31', cancel: true });
        await wait(0);
        await draw();

        expect(pathText()).toEqual([]);
        expect(drawn()).toHaveLength(11);
        // The remembered scope is kept, as for any scope that is gone.
        expect(ui().tasksScope).toBe('t-31');

        await change({ type: 'task.unarchive', taskId: 't-31' });

        expect(pathText()).toEqual(['Tasks', 'CAR-31']);
    });

    it('are not offered as a dependency or a parent', async () => {
        await archiveTree();

        const candidates = dependencyCandidates(project().taskList, { taskId: 't-26', taken: [] }).map(task => task.id);

        expect(candidates).not.toContain('t-31');
        expect(parentCandidates(project().taskList, project().tasks.get('t-26')).map(task => task.id)).not.toContain(
            't-32'
        );
    });

    it('are in the archive view, and a restore of the tree puts them back on the board', async () => {
        await archiveTree();
        openArchive();
        await draw();
        await settleArchive();

        expect(archiveRows().slice(0, 7)).toEqual(['t-31', 't-32', 't-33', 't-34', 't-35', 't-36', 't-37']);

        await click(rowOf('t-31').querySelector('button[aria-label="Restore CAR-31"]'));
        await settleReload();

        expect(archiveRows()).toEqual(['t-38', 't-39', 't-40']);

        ui().setTasksArchive(false);
        await draw();

        expect(drawn()).toHaveLength(12);
        expect(itemOf('t-31')).not.toBeNull();
    });
});
