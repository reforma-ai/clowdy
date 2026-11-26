// @vitest-environment happy-dom
import { runInAction } from 'mobx';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { hotkeys, installDispatcher } from '../../hotkeys';
import { RootStore, RootStoreProvider } from '../../stores';
import { chatListPreferences } from './chatListPreferences';
import { Screen } from './Screen';

import type { ReactNode } from 'react';
import type { KeyValueStorage } from '../../stores/storage';

// `Modal` cannot load under the desktop's Vitest (decorators), and no confirmation is opened here.
vi.mock('@clowdy/components/modals', () => ({ openConfirmModal: vi.fn() }));

// The pages beside the list are drawn by their own tests; here they only say which one was asked for.
vi.mock('../chats/ChatView', () => ({
    ChatView: ({ chat, controls }: { chat: { id: string; title: string }; controls?: ReactNode }) => (
        <>
            <div data-testid="chat" data-chat-id={chat.id}>
                {chat.title}
            </div>
            {controls}
        </>
    ),
}));
vi.mock('./RunDetail', () => ({
    RunDetail: ({ run }: { run: { id: string; name: string } }) => (
        <div data-testid="run" data-run-id={run.id}>
            {run.name}
        </div>
    ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The agents that work, and the finished ones, in the Agents list of the fixture project. The chat c-1 (orchestrator r-orch-1, at work) has the native
 * sub-agents, oldest first: r-na-01 ("Map the booking flow", done), r-na-04 ("Weekend pricing rules", failed), r-na-03 ("Update the booking form", works), r-na-02 ("Find where the price is computed", works) with
 * r-na-05 below it ("List the callers of the price helper", rests for background work). The chat c-6 has the threads c-6a (works, with its finished thread c-6a1), c-6b (done), c-6c
 * (failed) and c-6e (rests for background work), and between c-6b and c-6c its own sub-agent r-na-07 ("Check the refund rules", done). The test build has no MobX
 * observer plugin, so the screen is drawn again by hand after a change, as the observer does in the app.
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

const draw = (before?: () => void) =>
    act(async () => {
        before?.();
        reactRoot.render(
            <RootStoreProvider value={store}>
                <Screen />
            </RootStoreProvider>
        );
    });

const rowKeys = () => [...container.querySelectorAll('[role="row"]')].map(row => row.getAttribute('data-key'));
const rowOf = (key: string) => container.querySelector<HTMLElement>(`[role="row"][data-key="${key}"]`)!;
const isSelected = (key: string) => rowOf(key).hasAttribute('data-selected');
const titleOf = (key: string) => rowOf(key).querySelector('span[class*="title"]')?.textContent;
const buttonIn = (key: string, label: string) =>
    rowOf(key).querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const foldOf = (key: string) =>
    rowOf(key).querySelector<HTMLButtonElement>('button[aria-label^="Expand"], button[aria-label^="Collapse"]');
const shown = (...keys: string[]) => rowKeys().filter(key => keys.includes(key ?? ''));

/** A press with a mouse: what React Aria opens a menu on, and picks an item with. */
const press = async (target: HTMLElement) =>
    act(async () => {
        target.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true })
        );
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        target.dispatchEvent(
            new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true })
        );
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        target.click();
    });
const menuItem = (name: string) =>
    [...document.body.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(row =>
        row.textContent?.includes(name)
    )!;
const key = (target: Element, name: string) =>
    act(async () => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    });

beforeEach(async () => {
    chatListPreferences.setShowFinishedThreads(true);
    chatListPreferences.setExpandRunningAgents(true);
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
    store = new RootStore(new FixtureTransport(), { storage: memoryStorage() });
    await store.load();
    await draw(() => ui().openChat('c-4'));
});

afterEach(() => {
    act(() => reactRoot.unmount());
    container.remove();
    store.dispose();
    chatListPreferences.setShowFinishedThreads(true);
    chatListPreferences.setExpandRunningAgents(true);
});

describe('the agents that work, under a folded chat', () => {
    it('lists the working threads and the working sub-agents, the ones below a sub-agent one level in, and leaves the finished out', () => {
        expect(shown('c-1', 'r-na-03', 'r-na-02', 'r-na-05', 'r-na-04', 'r-na-01')).toEqual([
            'c-1',
            'r-na-03',
            'r-na-02',
            'r-na-05',
        ]);
        expect(shown('c-6', 'c-6a', 'c-6b', 'c-6c', 'c-6e')).toEqual(['c-6', 'c-6a', 'c-6e']);
        expect(rowOf('r-na-03').getAttribute('data-depth')).toBe('1');
        expect(rowOf('r-na-05').getAttribute('data-depth')).toBe('2');
        expect(foldOf('c-1')?.getAttribute('aria-expanded')).toBe('false');
    });

    it('names a sub-agent by what it was asked to do, as a thread is by its title, never by its type or the daemon’s name', () => {
        expect(titleOf('r-na-03')).toBe('Update the booking form');
        expect(titleOf('r-na-02')).toBe('Find where the price is computed');
        expect(rowOf('r-na-03').querySelector('[title]')?.getAttribute('title')).toBe('Update the booking form');
        expect(rowOf('r-na-03').textContent).not.toContain('General agent');
        expect(rowOf('r-na-03').textContent).not.toContain('general-purpose');
    });

    it('names a sub-agent that was given no purpose by its type', async () => {
        await draw(() => {
            ui().toggleChatExpanded('c-1');
            runInAction(() => project().runs.set('r-na-03', { ...project().runs.get('r-na-03')!, summary: '' }));
        });

        expect(titleOf('r-na-03')).toBe('General agent');
    });

    it('shows the state of a sub-agent as its dot', () => {
        expect(rowOf('r-na-03').querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Working');
        expect(rowOf('r-na-05').querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Background');
    });

    it('lists only what waits for the person with the setting off, which is how the list was', async () => {
        await draw(() => chatListPreferences.setExpandRunningAgents(false));

        expect(shown('c-1', 'r-na-03', 'r-na-02', 'r-na-05', 'c-6a', 'c-6e')).toEqual(['c-1']);

        const run = project().runs.get('r-na-05')!;

        await draw(() => project().runs.set(run.id, { ...run, status: 'waiting_user' }));

        // The one that asks, with the sub-agent it sits below.
        expect(shown('c-1', 'r-na-03', 'r-na-02', 'r-na-05')).toEqual(['c-1', 'r-na-02', 'r-na-05']);
    });

    it('lists a sub-agent when it starts and drops it from a folded chat when it ends', async () => {
        const run = project().runs.get('r-na-03')!;

        await draw(() => project().runs.set(run.id, { ...run, status: 'succeeded', finishedAt: Date.now() }));

        expect(shown('c-1', 'r-na-03', 'r-na-02')).toEqual(['c-1', 'r-na-02']);

        await draw(() =>
            project().runs.set(run.id, { ...run, id: 'r-na-new', status: 'running', createdAt: Date.now() })
        );

        expect(shown('r-na-new')).toEqual(['r-na-new']);
    });

    it('lists the same rows in a list that is not grouped by folder', async () => {
        await draw(() => ui().setGroupByFolder(false));

        expect(rowKeys().some(candidate => candidate?.startsWith('@folder:'))).toBe(false);
        expect(shown('c-1', 'r-na-03', 'r-na-02', 'r-na-05')).toEqual(['c-1', 'r-na-03', 'r-na-02', 'r-na-05']);
        expect(rowOf('r-na-05').getAttribute('data-depth')).toBe('2');
    });

    it('is a chat with a fold when only sub-agents are below it, and has none when nothing is', () => {
        expect(foldOf('c-1')).not.toBeNull();
        expect(foldOf('c-4')).toBeNull();
    });
});

describe('finished sub-agents', () => {
    it('are rows like those of a finished thread: in an opened chat, oldest first with the others, nested below the one that started them', async () => {
        await draw(() => ui().toggleChatExpanded('c-1'));

        expect(shown('c-1', 'r-na-01', 'r-na-04', 'r-na-03', 'r-na-02', 'r-na-05')).toEqual([
            'c-1',
            'r-na-01',
            'r-na-04',
            'r-na-03',
            'r-na-02',
            'r-na-05',
        ]);
        expect(['r-na-01', 'r-na-04', 'r-na-03', 'r-na-02', 'r-na-05'].map(id => rowOf(id).dataset.depth)).toEqual([
            '1',
            '1',
            '1',
            '1',
            '2',
        ]);
        // There is no group row, and no fold but the chat's.
        expect(rowKeys().some(candidate => candidate?.startsWith('@finished'))).toBe(false);
        expect(rowOf('r-na-01').textContent).toBe('Map the booking flow');
        expect(rowOf('c-1').textContent).toBe('Simplify booking');
    });

    it('stand among the threads of their chat by the time each was made, a thread’s own below the thread', async () => {
        await draw(() => ['c-6', 'c-6a'].forEach(id => ui().toggleChatExpanded(id)));

        // c-6b, then the sub-agent of the chat itself, then c-6c; c-6a has its own finished thread below it.
        expect(shown('c-6', 'c-6a', 'c-6a1', 'c-6b', 'r-na-07', 'c-6c', 'c-6e')).toEqual([
            'c-6',
            'c-6a',
            'c-6a1',
            'c-6b',
            'r-na-07',
            'c-6c',
            'c-6e',
        ]);
        expect(rowOf('r-na-07').dataset.depth).toBe('1');
        expect(titleOf('r-na-07')).toBe('Check the refund rules');
    });

    it('show the dot of their run as a finished thread does: red when failed, none when done', async () => {
        await draw(() => ui().toggleChatExpanded('c-1'));

        expect(rowOf('r-na-04').querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Failed');
        expect(rowOf('r-na-04').querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('danger');
        expect(rowOf('r-na-01').querySelector('[role="img"]')).toBeNull();
    });

    it('are left out with the finished threads when Show finished sub-threads is turned off, the ones that work staying', async () => {
        await draw(() => ['c-1', 'c-6'].forEach(id => ui().toggleChatExpanded(id)));
        await press(container.querySelector<HTMLElement>('button[aria-label="Filters"]')!);
        await press(menuItem('Show finished sub-threads'));
        await draw();

        expect(chatListPreferences.showFinishedThreads).toBe(false);
        expect(shown('r-na-01', 'r-na-04', 'r-na-07', 'c-6b', 'c-6c')).toEqual([]);
        expect(shown('r-na-03', 'r-na-02', 'r-na-05')).toEqual(['r-na-03', 'r-na-02', 'r-na-05']);
    });

    it('keep a finished sub-agent below which one that works is nested, with the setting off', async () => {
        const orchestrator = project().runs.get('r-orch-1')!;
        const finished = project().runs.get('r-na-01')!;

        await draw(() => {
            chatListPreferences.setShowFinishedThreads(false);
            ui().toggleChatExpanded('c-1');
            project().runs.set('r-na-08', {
                ...finished,
                id: 'r-na-08',
                parentRunId: finished.id,
                rootRunId: orchestrator.id,
                status: 'running',
                createdAt: finished.createdAt + 1,
            });
        });

        expect(shown('r-na-01', 'r-na-08', 'r-na-04')).toEqual(['r-na-01', 'r-na-08']);
        expect(rowOf('r-na-08').dataset.depth).toBe('2');
    });

    it('have a row each, however many, in a chat that is open, and none in a folded chat', async () => {
        const orchestrator = project().runs.get('r-orch-1')!;
        const rows = () => container.querySelectorAll('[role="row"]').length;
        const before = rows();

        await draw(() => {
            for (let index = 0; index < 300; index++)
                project().runs.set(`r-many-${index}`, {
                    ...orchestrator,
                    id: `r-many-${index}`,
                    role: 'executor',
                    name: 'Explore',
                    origin: 'native',
                    parentRunId: orchestrator.id,
                    rootRunId: orchestrator.id,
                    status: 'succeeded',
                    createdAt: index + 1,
                });
        });

        // The chat is folded: they add no row to it.
        expect(rows()).toBe(before);
        expect(rowOf('c-1').querySelector('button[aria-label^="Expand"]')).not.toBeNull();

        await draw(() => ui().toggleChatExpanded('c-1'));

        expect(rows()).toBe(before + 300 + 2);
        expect(rowKeys().filter(candidate => candidate?.startsWith('r-many-'))).toHaveLength(300);
        // The oldest of them first, before the other sub-agents.
        expect(rowKeys().slice(rowKeys().indexOf('c-1') + 1, rowKeys().indexOf('c-1') + 3)).toEqual([
            'r-many-0',
            'r-many-1',
        ]);
    });

    it('are only listed under a folded chat when they are open', async () => {
        await draw(() => ui().openRun('r-na-04'));
        await draw();

        expect(ui().expandedChats).toEqual([]);
        expect(shown('r-na-01', 'r-na-04')).toEqual(['r-na-04']);
        expect(isSelected('r-na-04')).toBe(true);
    });

    it('opened from elsewhere in a chat whose folder is folded, open the folder and leave the chat folded', async () => {
        await draw(() => {
            ui().toggleFolderCollapsed('fld_car_rental');
            ui().openRun('r-na-04');
        });
        await draw();

        expect(ui().collapsedFolders).toEqual([]);
        expect(ui().expandedChats).toEqual([]);
        expect(shown('r-na-01', 'r-na-04')).toEqual(['r-na-04']);
        expect(isSelected('r-na-04')).toBe(true);
    });
});

describe('the Expand running agents check', () => {
    const filters = () => container.querySelector<HTMLElement>('button[aria-label="Filters"]')!;

    it('stands next to Show finished sub-threads, ticked until it is turned off, and turns the working rows off and on', async () => {
        await press(filters());

        expect([...document.body.querySelectorAll('[role^="menuitem"]')].map(row => row.textContent)).toEqual([
            'Show finished sub-threads',
            'Expand running agents',
            'Group chats by folder',
            'Group chats by worktree',
        ]);
        expect(menuItem('Expand running agents').getAttribute('aria-checked')).toBe('true');

        await press(menuItem('Expand running agents'));
        await draw();

        expect(chatListPreferences.expandRunningAgents).toBe(false);
        expect(shown('r-na-03', 'r-na-02', 'c-6a')).toEqual([]);
        // The other checks are as they were.
        expect(chatListPreferences.showFinishedThreads).toBe(true);
        expect(ui().groupByFolder).toBe(true);

        await press(menuItem('Expand running agents'));
        await draw();

        expect(chatListPreferences.expandRunningAgents).toBe(true);
        expect(shown('r-na-03', 'r-na-02', 'c-6a')).toEqual(['c-6a', 'r-na-03', 'r-na-02']);
    });
});

describe('a sub-agent’s row', () => {
    it('opens the sub-agent’s page and is the selected row, and its chat’s row is not', async () => {
        await press(rowOf('r-na-02'));
        await draw();

        expect(container.querySelector('[data-testid="run"]')?.getAttribute('data-run-id')).toBe('r-na-02');
        expect(ui().runId).toBe('r-na-02');
        expect(isSelected('r-na-02')).toBe(true);
        expect(isSelected('c-1')).toBe(false);
        expect(isSelected('c-4')).toBe(false);
    });

    it('opens the chat again from the chat’s row, and walks back and forward through both', async () => {
        await press(rowOf('r-na-02'));
        await draw();
        await press(rowOf('c-1'));
        await draw();

        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe('c-1');
        expect(isSelected('c-1')).toBe(true);
        expect(isSelected('r-na-02')).toBe(false);

        await draw(() => store.history.back());

        expect(isSelected('r-na-02')).toBe(true);
        expect(isSelected('c-1')).toBe(false);

        await draw(() => store.history.forward());

        expect(isSelected('c-1')).toBe(true);
    });

    it('has no Archive, no `⋯` menu, no rename, no drag and no context menu', async () => {
        expect(buttonIn('r-na-03', 'Archive')).toBeNull();
        expect(buttonIn('r-na-03', 'Chat actions')).toBeNull();
        expect(rowOf('r-na-03').querySelector('[draggable="true"]')).toBeNull();
        // A chat row has all of them: the check means something.
        expect(buttonIn('c-1', 'Chat actions')).not.toBeNull();
        expect(rowOf('c-1').querySelector('[draggable="true"]')).not.toBeNull();

        await act(async () => {
            rowOf('r-na-03').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        });
        await act(async () => {
            rowOf('r-na-03')
                .querySelector('span[class*="title"]')!
                .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        });

        expect(document.body.querySelector('[role="menu"]')).toBeNull();
        expect(document.body.querySelector('input[aria-label="Chat title"]')).toBeNull();
    });

    it('stays out of the guards and the dot of its chat: a chat at rest with a sub-agent that works can be put away', async () => {
        const orchestrator = project().runs.get('r-orch-1')!;

        await draw(() => project().runs.set(orchestrator.id, { ...orchestrator, status: 'succeeded', finishedAt: 1 }));

        expect(project().runs.get('r-na-03')?.status).toBe('running');
        expect(buttonIn('c-1', 'Archive')).not.toBeNull();
        expect(rowOf('c-1').querySelector('[aria-label="Threads working"]')).toBeNull();
    });

    it('keeps the row of a finished sub-agent opened from elsewhere, and unfolds nothing for it', async () => {
        await draw(() => ui().openRun('r-na-04'));
        await draw();

        expect(ui().expandedChats).toEqual([]);
        // Once, among the ones that work, under the folded chat.
        expect(shown('r-na-03', 'r-na-02', 'r-na-04', 'r-na-01')).toEqual(['r-na-04', 'r-na-03', 'r-na-02']);
        expect(isSelected('r-na-04')).toBe(true);
        expect(isSelected('c-1')).toBe(false);

        // The person opens the chat: the others come in, and the sub-agent is still the open one.
        await draw(() => ui().toggleChatExpanded('c-1'));

        expect(shown('r-na-01', 'r-na-04', 'r-na-03')).toEqual(['r-na-01', 'r-na-04', 'r-na-03']);
        expect(isSelected('r-na-04')).toBe(true);

        // The person folds the chat: the page stays, and the sub-agent keeps its row.
        await draw(() => ui().toggleChatExpanded('c-1'));

        expect(shown('r-na-04', 'r-na-01')).toEqual(['r-na-04']);
        expect(isSelected('r-na-04')).toBe(true);
    });

    it('leaves a chat folded when a sub-agent that is listed already is opened: the person did not ask for the rest', async () => {
        await press(rowOf('r-na-03'));
        await draw();

        expect(isSelected('r-na-03')).toBe(true);
        expect(ui().expandedChats).toEqual([]);
        expect(shown('r-na-01', 'r-na-04')).toEqual([]);
    });

    it('opens its page from the end of its row too, where the dot is', async () => {
        await press(rowOf('r-na-03').querySelector<HTMLElement>('[role="img"]')!);
        await draw();

        expect(ui().runId).toBe('r-na-03');
        expect(isSelected('r-na-03')).toBe(true);
    });

    it('keeps the row of the open sub-agent when it ends, and unfolds nothing for it', async () => {
        await press(rowOf('r-na-03'));
        await draw();

        const run = project().runs.get('r-na-03')!;

        await draw(() => project().runs.set(run.id, { ...run, status: 'succeeded', finishedAt: Date.now() }));

        expect(shown('r-na-03')).toEqual(['r-na-03']);
        expect(isSelected('r-na-03')).toBe(true);
        expect(ui().expandedChats).toEqual([]);

        await draw(() => ui().toggleChatExpanded('c-1'));

        expect(shown('r-na-01', 'r-na-04', 'r-na-03')).toEqual(['r-na-01', 'r-na-04', 'r-na-03']);
    });

    it('opens the chat from the chat’s row when that is the open row only because the open run has no row', async () => {
        const orchestrator = project().runs.get('r-orch-1')!;

        // A child run that is no native sub-agent is no row.
        await draw(() => {
            project().runs.set('r-x', {
                ...orchestrator,
                id: 'r-x',
                role: 'executor',
                parentRunId: orchestrator.id,
                rootRunId: orchestrator.id,
                origin: undefined,
            });
            ui().openRun('r-x');
        });
        await draw();

        expect(container.querySelector('[data-testid="run"]')?.getAttribute('data-run-id')).toBe('r-x');
        expect(isSelected('c-1')).toBe(true);

        await press(rowOf('c-1'));
        await draw();

        expect(ui().runId).toBeNull();
        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe('c-1');
    });

    it('keeps a finished sub-agent that is open listed while the finished are not', async () => {
        await draw(() => {
            chatListPreferences.setShowFinishedThreads(false);
            ui().openRun('r-na-04');
        });
        await draw();

        expect(shown('r-na-04', 'r-na-01')).toEqual(['r-na-04']);
        expect(isSelected('r-na-04')).toBe(true);

        await draw(() => ui().toggleChatExpanded('c-1'));

        // The finished one that is not open stays out of the open chat as well.
        expect(shown('r-na-04', 'r-na-01')).toEqual(['r-na-04']);
    });
});

describe('the keyboard on the list', () => {
    it('steps with J and K over the rows of the sub-agents, finished ones too, as over the others', async () => {
        await draw(() => ui().toggleChatExpanded('c-1'));

        const uninstall = installDispatcher(hotkeys);
        const focused = () => document.activeElement?.getAttribute('data-key');
        const step = async (name: string) => {
            await key(document.activeElement!, name);

            return focused();
        };

        try {
            rowOf('c-1').focus();

            expect(await step('j')).toBe('r-na-01');
            expect(await step('j')).toBe('r-na-04');
            expect(await step('j')).toBe('r-na-03');
            expect(await step('j')).toBe('r-na-02');
            expect(await step('j')).toBe('r-na-05');
            expect(await step('k')).toBe('r-na-02');
            expect(await step('k')).toBe('r-na-03');
        } finally {
            uninstall();
        }
    });

    it('folds a chat that has only sub-agents below it with Right and Left', async () => {
        await key(rowOf('c-1'), 'ArrowRight');
        await draw();

        expect(ui().expandedChats).toContain('c-1');
        expect(shown('r-na-01', 'r-na-04')).toEqual(['r-na-01', 'r-na-04']);

        await key(rowOf('c-1'), 'ArrowLeft');
        await draw();

        expect(ui().expandedChats).not.toContain('c-1');
        expect(shown('r-na-01', 'r-na-04')).toEqual([]);
    });

    it('does nothing with Right and Left on a sub-agent’s row, which has no fold', async () => {
        await draw(() => ui().toggleChatExpanded('c-1'));
        await key(rowOf('r-na-02'), 'ArrowLeft');
        await key(rowOf('r-na-02'), 'ArrowRight');

        expect(ui().expandedChats).toEqual(['c-1']);
        expect(
            rowOf('r-na-02').querySelector('button[aria-label^="Expand"], button[aria-label^="Collapse"]')
        ).toBeNull();
    });

    it('opens a sub-agent, a finished one too, from its focused row with Enter', async () => {
        await key(rowOf('r-na-03'), 'Enter');
        await draw();

        expect(ui().runId).toBe('r-na-03');
        expect(isSelected('r-na-03')).toBe(true);

        await draw(() => ui().toggleChatExpanded('c-1'));
        await key(rowOf('r-na-01'), 'Enter');
        await draw();

        expect(ui().runId).toBe('r-na-01');
        expect(isSelected('r-na-01')).toBe(true);
        expect(isSelected('r-na-03')).toBe(false);
    });
});
