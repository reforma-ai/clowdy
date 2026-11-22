// @vitest-environment happy-dom
import { act, use } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { TaskChip } from '../../shared/TaskChip';
import { RootStore, RootStoreProvider } from '../../stores';
import { StreamLinksContext } from '../../stream/StreamLinks';
import { ChatView } from './ChatView';

import type { KeyValueStorage } from '../../stores/storage';

// `Modal` cannot load under the desktop's Vitest (decorators), and no confirmation is opened here.
vi.mock('@clowdy/components/modals', () => ({ openConfirmModal: vi.fn() }));
// Streamdown highlights code with Shiki, whose WebAssembly cannot load under happy-dom. This stand-in writes the words of a message and makes a button of every task key that the
// chat's links resolve, as the real viewer does, so what is checked is what ChatView hands the stream: which keys are tasks, and what a press does.
vi.mock('../../stream/Markdown', () => ({
    Markdown: function Markdown({ text }: { text: string }) {
        const { taskOfKey, onOpenTask } = use(StreamLinksContext);

        return (
            <div>
                { text.split(/(CAR-\d+)/).map((part, index) => {
                    const task = taskOfKey?.(part);

                    return task ? <button key={ index } type="button" data-task-chip={ task.id } onClick={ () => onOpenTask?.(task.id) }>{ part }</button> : part;
                }) }
            </div>
        );
    },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The chats' links to tasks when a task is archived: c-1's first answer names CAR-22, CAR-24 and CAR-25 as the plan. The test build has no MobX observer plugin, so the view is
 * drawn again by hand after a change, as the observer does in the app.
 */

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;

const ui = () => store.ui.forProject(FIXTURE_PROJECT_ID);
const project = () => store.selectedProject!;
const chips = () => [...container.querySelectorAll<HTMLElement>('[data-task-chip]')].map(chip => chip.textContent);

const render = () => act(async () => {
    reactRoot.render(<RootStoreProvider value={ store }><ChatView chat={ project().chats.get('c-1')! } /></RootStoreProvider>);
});

async function draw() {
    await render();
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
    await render();
}

beforeEach(async () => {
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
    store = new RootStore(new FixtureTransport(), { storage: memoryStorage() });
    await store.load();
});

afterEach(() => {
    act(() => reactRoot.unmount());
    container.remove();
    store.dispose();
});

describe('a task key in a message', () => {
    it('is a chip for a task of the board', async () => {
        await draw();

        expect(chips()).toEqual(expect.arrayContaining(['CAR-22', 'CAR-24', 'CAR-25']));
    });

    it('stays a chip when the task is archived and the window saw it archived, and a press opens the archived task in Tasks', async () => {
        await store.command({ type: 'task.archive', taskId: 't-22' });
        await draw();

        expect(project().tasks.has('t-22')).toBe(false);
        expect(chips()).toContain('CAR-22');

        await act(async () => container.querySelector<HTMLElement>('[data-task-chip="t-22"]')!.click());

        expect([ui().section, ui().taskId]).toEqual(['tasks', 't-22']);
        // The window knows it, so Back and Forward may return to it.
        expect(project().archivedKnown.has('t-22')).toBe(true);
    });

    it('is plain words for an archived task the window has not seen yet, which only the daemon can tell, until it has been read', async () => {
        // CAR-22 was archived before the window opened.
        const daemon = new FixtureTransport();

        await daemon.command({ type: 'task.archive', taskId: 't-22' });

        store = new RootStore(daemon, { storage: memoryStorage() });
        await store.load();
        await draw();

        expect(chips()).not.toContain('CAR-22');
        expect(chips()).toContain('CAR-24');

        await project().readTask('t-22');
        await draw();

        expect(chips()).toContain('CAR-22');
    });

    it('goes back to plain words when the task is deleted', async () => {
        await store.command({ type: 'task.archive', taskId: 't-22' });
        await store.command({ type: 'task.delete', taskId: 't-22' });
        await draw();

        expect(chips()).not.toContain('CAR-22');
    });
});

describe('TaskChip', () => {
    it('opens an archived task in Tasks, as it opens any task', async () => {
        const archived = { id: 't-38', key: 'CAR-38', title: 'Clean up the admin pages' };

        await act(async () => {
            reactRoot.render(<RootStoreProvider value={ store }><TaskChip task={ archived } /></RootStoreProvider>);
        });
        await act(async () => container.querySelector('button')!.click());

        expect([ui().section, ui().taskId]).toEqual(['tasks', 't-38']);
    });
});
