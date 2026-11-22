// @vitest-environment happy-dom
import { toast } from '@clowdy/components/Toast';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { overrideTransport } from '../../daemon/testing';
import { undoStack } from '../../hotkeys/undo';
import { RootStore, RootStoreProvider } from '../../stores';
import { ArchiveView } from './ArchiveView';
import { RELOAD_DELAY_MS } from './useArchivedTasks';

import type { ProjectId, TaskArchivePage } from '@clowdy/protocol';
import type { CommandInput, PageQuery, Transport } from '../../daemon/transport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The archive view on its own, over the fixture daemon's archive. The demo project has one batch archived two days ago, CAR-38 with CAR-39 and CAR-40 inside it; a test
 * archives more first, which the daemon stamps with the time of the call, so those batches are newer. The test build has no MobX observer plugin, so the view is drawn again by
 * hand after the project changes, as the observer does in the app.
 */

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;
let daemon: FixtureTransport;
let sent: CommandInput[];
let opened: string[];
let reads: PageQuery[];

const project = () => store.selectedProject!;
const wait = (ms: number) => act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
});

interface Options {
    pageSize?: number;
    projectId?: ProjectId;
    /** Archives before the store loads, so the view's first read finds them. */
    before?: CommandInput[];
    /** Changes how the archive is read. */
    read?: (base: Transport) => Partial<Transport>;
}

/** The page size the view is drawn with, for every draw of the test. */
let size: number | undefined;

const draw = () => act(async () => {
    reactRoot.render(<RootStoreProvider value={ store }><ArchiveView statuses={ project().statuses } openId={ null } onOpen={ id => opened.push(id) } pageSize={ size } /></RootStoreProvider>);
});

async function mount({ pageSize, projectId, before = [], read }: Options = {}) {
    daemon = new FixtureTransport();

    for (const command of before) expect((await daemon.command(command)).ok).toBe(true);

    const transport = overrideTransport(daemon, {
        command: async (input) => {
            sent.push(input);

            return daemon.command(input);
        },
        getArchivedTasks: async (id, page) => {
            reads.push(page ?? {});

            return daemon.getArchivedTasks(id, page);
        },
        ...read?.(daemon),
    });

    store = new RootStore(transport, { storage: { getItem: () => null, setItem: () => undefined } });
    await store.load();

    if (projectId) store.selectProject(projectId);

    size = pageSize;
    await draw();
    await wait(0);
    await draw();
}

beforeEach(() => {
    sent = [];
    opened = [];
    reads = [];
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
    vi.spyOn(toast, 'error');
});

afterEach(() => {
    undoStack.clear();
    act(() => reactRoot.unmount());
    store.dispose();
    container.remove();
    vi.restoreAllMocks();
});

const archive = (taskId: string, cancel = false): CommandInput => ({ type: 'task.archive', taskId, ...(cancel && { cancel }) });

/** The batches drawn, newest first: the heading's count and the keys of its rows with their depths. */
const batches = () => [...container.querySelectorAll<HTMLElement>('section')].map(section => ({
    count: section.querySelector('header')?.lastElementChild?.textContent,
    rows: [...section.querySelectorAll<HTMLElement>('li')].map(row => `${ row.dataset.depth }:${ row.querySelector('button span')?.textContent }`),
}));
const row = (taskId: string) => container.querySelector<HTMLElement>(`[data-archived-task="${ taskId }"]`);
const restoreOf = (taskId: string) => row(taskId)?.querySelector<HTMLButtonElement>('button[aria-label^="Restore"]') ?? null;
const text = () => container.textContent ?? '';

describe('the batches', () => {
    it('shows the archive newest batch first, each a tree, with how many tasks it holds', async () => {
        await mount({ before: [archive('t-20'), archive('t-31', true)] });

        expect(batches()).toEqual([
            // Canceled with the tree, so by number; CAR-33 was done and comes before CAR-34 inside CAR-32.
            { count: '7 tasks', rows: ['0:CAR-31', '1:CAR-32', '2:CAR-33', '2:CAR-34', '1:CAR-35', '1:CAR-36', '1:CAR-37'] },
            { count: '1 task', rows: ['0:CAR-20'] },
            { count: '3 tasks', rows: ['0:CAR-38', '1:CAR-39', '1:CAR-40'] },
        ]);
    });

    it('says when each batch was archived', async () => {
        await mount({ before: [archive('t-20')] });

        expect([...container.querySelectorAll('section header')].map(header => header.firstElementChild?.textContent)).toEqual(['Archived just now', 'Archived 2 days ago']);
    });

    it('puts the children of a task under it, sorted by workflow status within it, with the status of each', async () => {
        await mount();

        expect(row('t-38')!.textContent).toContain('Done');
        expect(row('t-40')!.textContent).toContain('Canceled');
        expect(row('t-39')!.dataset.depth).toBe('1');
    });

    it('folds the insides of a task with its chevron, and opens them again', async () => {
        await mount();

        const chevron = row('t-38')!.querySelector<HTMLButtonElement>('button[aria-expanded]')!;

        expect(chevron.getAttribute('aria-expanded')).toBe('true');
        expect(row('t-39')).not.toBeNull();

        await act(async () => chevron.click());

        expect(row('t-38')!.querySelector('button[aria-expanded]')!.getAttribute('aria-label')).toBe('Expand CAR-38');
        expect(row('t-39')).toBeNull();
        expect(row('t-40')).toBeNull();

        await act(async () => row('t-38')!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());

        expect(row('t-39')).not.toBeNull();
    });

    it('has no chevron on a task with nothing inside it, and keeps the room', async () => {
        await mount();

        expect(row('t-39')!.querySelector('button[aria-expanded]')).toBeNull();
    });

    it('opens a task in the panel when its title is pressed, any task of the tree', async () => {
        await mount();
        await act(async () => row('t-39')!.querySelector<HTMLButtonElement>('button[title]')!.click());
        await act(async () => row('t-38')!.querySelector<HTMLButtonElement>('button[title]')!.click());

        expect(opened).toEqual(['t-39', 't-38']);
    });

    it('is read only: a task has nothing to edit, move or delete', async () => {
        await mount();

        const labels = [...container.querySelectorAll('button')].map(button => button.getAttribute('aria-label') ?? button.textContent);

        expect(labels.some(label => /Delete|Archive$|Start|Cancel/.test(label ?? ''))).toBe(false);
        expect(container.querySelector('input, textarea, [contenteditable]')).toBeNull();
    });

    it('remembers every task it read in the project, so a key or an id of one resolves elsewhere', async () => {
        await mount();

        expect([...project().archivedKnown.keys()].sort()).toEqual(['t-38', 't-39', 't-40']);
        expect(project().taskOfKey('CAR-40')?.id).toBe('t-40');
    });
});

describe('Restore', () => {
    it('is on the top of a batch and on no task inside it', async () => {
        await mount({ before: [archive('t-31', true)] });

        expect([restoreOf('t-31') !== null, restoreOf('t-32') !== null, restoreOf('t-33') !== null, restoreOf('t-38') !== null, restoreOf('t-39') !== null, restoreOf('t-40') !== null]).toEqual([true, false, false, true, false, false]);
    });

    it('is a button that is there for the keyboard and shows with the pointer or the focus', async () => {
        await mount();

        expect(restoreOf('t-38')!.textContent).toBe('Restore');
        expect(restoreOf('t-38')!.getAttribute('aria-label')).toBe('Restore CAR-38');
    });

    it('restores the batch, and the batch leaves the view when the daemon\'s event comes, the others staying', async () => {
        await mount({ before: [archive('t-20')] });
        await act(async () => restoreOf('t-38')!.click());

        expect(sent).toEqual([{ type: 'task.unarchive', taskId: 't-38' }]);
        expect(project().tasks.has('t-39')).toBe(true);

        // The project changed: the screen draws the view again, and the view reads the archive again after its pause.
        await draw();
        await wait(RELOAD_DELAY_MS + 80);

        expect(batches()).toEqual([{ count: '1 task', rows: ['0:CAR-20'] }]);
        expect(project().archivedKnown.has('t-38')).toBe(false);
    });

    it('offers to take it back in a toast, which archives the batch again and brings it back to the view', async () => {
        await mount();
        await act(async () => restoreOf('t-38')!.click());
        await draw();
        await wait(RELOAD_DELAY_MS + 80);

        expect(text()).toContain('Nothing archived');
        expect(undoStack.entries.map(entry => entry.label)).toEqual(['Restored CAR-38']);

        await act(async () => void (await undoStack.undoLatest(FIXTURE_PROJECT_ID)));
        await draw();
        await wait(RELOAD_DELAY_MS + 80);

        expect(batches().map(batch => batch.rows)).toEqual([['0:CAR-38', '1:CAR-39', '1:CAR-40']]);
    });

    it('shows the daemon\'s reason as a toast when it refuses, and the batch stays: its parent was archived by another call', async () => {
        // CAR-33 is archived alone, and later CAR-32 above it: CAR-33 is the top of its own batch and cannot be restored under an archived parent.
        await mount({ before: [archive('t-33'), { type: 'task.update', taskId: 't-34', statusId: 'canceled' }, { type: 'task.update', taskId: 't-32', statusId: 'done' }, archive('t-32')] });

        expect(restoreOf('t-33')).not.toBeNull();

        await act(async () => restoreOf('t-33')!.click());
        await wait(0);

        expect(toast.error).toHaveBeenCalledWith({ message: 'Task CAR-33 is inside CAR-32, which is archived: restore CAR-32 first' });
        expect(project().tasks.has('t-33')).toBe(false);
        expect(row('t-33')).not.toBeNull();
        expect(undoStack.entries).toEqual([]);
        // The button is usable again.
        expect(restoreOf('t-33')!.disabled).toBe(false);
    });

    it('keeps the button from a second press while the daemon works', async () => {
        let release: () => void = () => undefined;

        await mount({ read: base => ({ command: async (input) => {
            sent.push(input);
            await new Promise<void>((resolve) => {
                release = resolve;
            });

            return base.command(input);
        } }) });
        await act(async () => restoreOf('t-38')!.click());
        await act(async () => restoreOf('t-38')!.click());

        expect(sent).toHaveLength(1);

        await act(async () => release());
    });
});

describe('the pages', () => {
    it('reads the archive a page at a time, shows how many of the tasks it holds, and Show more reads the next page', async () => {
        await mount({ pageSize: 2, before: [archive('t-20'), archive('t-31', true)] });

        // 7 + 1 + 3 archived tasks, the newest first: CAR-31 and what is inside it come before CAR-20 and the old batch.
        expect(reads).toEqual([{ limit: 2, cursor: undefined }]);
        expect(text()).toContain('Showing 2 of 11 archived tasks');
        expect(container.querySelectorAll('li')).toHaveLength(2);

        await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Show more')!.click());
        await wait(0);

        expect(reads.at(-1)).toMatchObject({ limit: 2 });
        expect(reads.at(-1)?.cursor).toBeDefined();
        expect(text()).toContain('Showing 4 of 11 archived tasks');
        expect(container.querySelectorAll('li')).toHaveLength(4);
    });

    it('goes on until the end, and then says how many there are and has no button', async () => {
        await mount({ pageSize: 6, before: [archive('t-20'), archive('t-31', true)] });

        await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Show more')!.click());
        await wait(0);

        expect(text()).toContain('11 archived tasks');
        expect(text()).not.toContain('Showing');
        expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Show more')).toBe(false);
        expect(container.querySelectorAll('li')).toHaveLength(11);
    });

    it('says 1 archived task when there is one', async () => {
        await mount({ projectId: FIXTURE_PROJECT_ID, before: [{ type: 'task.unarchive', taskId: 't-38' }, archive('t-21')] });

        expect(text()).toContain('1 archived task');
        expect(text()).not.toContain('1 archived tasks');
    });

    it('shows a batch that a page cuts as what is loaded of it, and the rest comes with the next page', async () => {
        // CAR-20 goes inside CAR-22 and the two are archived together: CAR-20, the lower number, comes first.
        await mount({ pageSize: 1, before: [{ type: 'task.update', taskId: 't-20', parentId: 't-22' }, archive('t-22')] });

        expect(batches()).toEqual([{ count: '1 task', rows: ['0:CAR-20'] }]);
        // CAR-22 is not here yet, and it is the top: a restore of CAR-20 would be refused, so it waits.
        expect(restoreOf('t-20')).toBeNull();

        await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Show more')!.click());
        await wait(0);

        expect(batches()[0]).toEqual({ count: '2 tasks', rows: ['0:CAR-22', '1:CAR-20'] });
        expect(restoreOf('t-22')).not.toBeNull();
        expect(restoreOf('t-20')).toBeNull();
    });

    it('offers Restore on a cut batch where the task has no parent, which no page can change', async () => {
        await mount({ pageSize: 1, before: [archive('t-31', true)] });

        expect(batches()).toEqual([{ count: '1 task', rows: ['0:CAR-31'] }]);
        expect(restoreOf('t-31')).not.toBeNull();
    });

    it('says why more could not be loaded, keeps what it has, and tries again with the same button', async () => {
        let failing = false;

        await mount({ pageSize: 2, before: [archive('t-20')], read: base => ({ getArchivedTasks: async (id, page) => {
            if (failing && page?.cursor) throw new Error('The daemon is not answering');

            return base.getArchivedTasks(id, page);
        } }) });

        failing = true;
        await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Show more')!.click());
        await wait(0);

        expect(text()).toContain('Couldn\'t load more. The daemon is not answering');
        expect(container.querySelectorAll('li')).toHaveLength(2);

        failing = false;
        await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Show more')!.click());
        await wait(0);

        expect(text()).not.toContain('Couldn\'t load more');
        expect(container.querySelectorAll('li')).toHaveLength(4);
    });
});

describe('what the view waits for', () => {
    it('shows the loader while the archive is read', async () => {
        let release: (page: TaskArchivePage) => void = () => undefined;

        await mount({ read: () => ({ getArchivedTasks: () => new Promise<TaskArchivePage>((resolve) => {
            release = resolve;
        }) }) });

        expect(text()).toContain('Loading the archive…');
        expect(container.querySelector('section')).toBeNull();

        await act(async () => release({ tasks: [], total: 0 }));

        expect(text()).toContain('Nothing archived');
    });

    it('says Nothing archived for an archive with nothing in it', async () => {
        await mount({ projectId: FIXTURE_EMPTY_PROJECT_ID });

        expect(text()).toContain('Nothing archived');
        expect(text()).not.toMatch(/Nothing archived\./);
    });

    it('shows why the archive could not be read, with Retry, which reads it again', async () => {
        let failing = true;

        await mount({ read: base => ({ getArchivedTasks: async (id, page) => {
            if (failing) throw new Error('The daemon is not answering');

            return base.getArchivedTasks(id, page);
        } }) });

        expect(text()).toContain('The archive could not be loaded. The daemon is not answering');
        expect(container.querySelector('section')).toBeNull();

        failing = false;
        await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry')!.click());
        await wait(0);

        expect(text()).not.toContain('could not be loaded');
        expect(batches().map(batch => batch.rows)).toEqual([['0:CAR-38', '1:CAR-39', '1:CAR-40']]);
    });
});

describe('following the daemon', () => {
    const settleReload = async () => {
        await draw();
        await wait(RELOAD_DELAY_MS + 80);
    };

    it('shows a batch that is archived from elsewhere, an agent or the command line, at the top, without the person doing anything', async () => {
        await mount();
        await act(async () => void (await daemon.command(archive('t-21'))));
        await settleReload();

        expect(batches().map(batch => batch.rows)).toEqual([['0:CAR-21'], ['0:CAR-38', '1:CAR-39', '1:CAR-40']]);
        expect(project().archivedKnown.has('t-21')).toBe(true);
    });

    it('drops a batch that is restored from elsewhere', async () => {
        await mount();
        await act(async () => void (await daemon.command({ type: 'task.unarchive', taskId: 't-38' })));
        await settleReload();

        expect(text()).toContain('Nothing archived');
    });

    it('drops a task that is deleted, and keeps the rest of its batch', async () => {
        await mount();
        await act(async () => void (await daemon.command({ type: 'task.delete', taskId: 't-40' })));
        await settleReload();

        expect(batches()).toEqual([{ count: '2 tasks', rows: ['0:CAR-38', '1:CAR-39'] }]);
    });

    it('reads once for the events of a whole tree, which come one for each task', async () => {
        await mount();

        const before = reads.length;

        await act(async () => void (await daemon.command(archive('t-31', true))));
        await settleReload();

        expect(reads.length - before).toBe(1);
        expect(batches()[0].count).toBe('7 tasks');
    });

    it('asks for as many tasks as it shows, so a page that was loaded does not shrink', async () => {
        await mount({ pageSize: 2, before: [archive('t-31', true)] });
        await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Show more')!.click());
        await wait(0);

        expect(container.querySelectorAll('li')).toHaveLength(4);

        await act(async () => void (await daemon.command(archive('t-21'))));
        await settleReload();

        // One more task than before, the newest.
        expect(reads.at(-1)).toMatchObject({ limit: 4 });
        expect(container.querySelectorAll('li')).toHaveLength(4);
        expect(row('t-21')).not.toBeNull();
    });

    it('does not leave Show more waiting for a page that was overtaken by a read that failed', async () => {
        let failing = false;
        let release: () => void = () => undefined;

        await mount({ pageSize: 2, before: [archive('t-20'), archive('t-31', true)], read: base => ({ getArchivedTasks: async (id, page) => {
            if (page?.cursor && !failing) {
                // The next page is slow.
                await new Promise<void>((resolve) => {
                    release = resolve;
                });
            }

            if (failing && !page?.cursor) throw new Error('offline');

            return base.getArchivedTasks(id, page);
        } }) });

        const showMore = () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Show more')!;

        await act(async () => showMore().click());

        expect(showMore().hasAttribute('data-pending')).toBe(true);

        failing = true;
        await act(async () => void (await daemon.command(archive('t-21'))));
        await settleReload();
        await act(async () => release());
        await wait(0);

        expect(showMore().hasAttribute('data-pending')).toBe(false);
        // What was shown stays.
        expect(container.querySelectorAll('li')).toHaveLength(2);
    });

    it('keeps what it shows when reading again fails, and shows the change at the next one', async () => {
        let failing = false;

        await mount({ read: base => ({ getArchivedTasks: async (id, page) => {
            if (failing) throw new Error('offline');

            return base.getArchivedTasks(id, page);
        } }) });

        failing = true;
        await act(async () => void (await daemon.command(archive('t-21'))));
        await settleReload();

        expect(batches().map(batch => batch.rows)).toEqual([['0:CAR-38', '1:CAR-39', '1:CAR-40']]);
        expect(text()).not.toContain('could not be loaded');

        failing = false;
        await act(async () => void (await daemon.command(archive('t-22'))));
        await settleReload();

        expect(batches().map(batch => batch.rows[0])).toEqual(['0:CAR-22', '0:CAR-21', '0:CAR-38']);
    });
});
