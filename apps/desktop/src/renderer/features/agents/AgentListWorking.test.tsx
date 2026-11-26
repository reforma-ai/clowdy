// @vitest-environment happy-dom
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
 * The agents that work, in the Agents list of the fixture project. The chat c-1 (orchestrator r-orch-1, at work) has the native sub-agents, oldest first: r-na-04
 * (failed), r-na-01 (done), r-na-03 (General agent, works), r-na-02 (Explore agent, works) with r-na-05 below it (Explore agent, rests for background work).
 * The chat c-6 has the thread c-6a (works, with its finished thread c-6a1), c-6b (done), c-6c (failed) and c-6e (rests for background work). The test build has
 * no MobX observer plugin, so the screen is drawn again by hand after a change, as the observer does in the app.
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
const GROUP = '@finished:c-1';

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
    it('lists the working threads and the working sub-agents, the ones below a sub-agent one level in, and folds the finished away', () => {
        expect(shown('c-1', 'r-na-03', 'r-na-02', 'r-na-05', 'r-na-04', 'r-na-01', GROUP)).toEqual([
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

    it('names a sub-agent by its type and says what it does when the pointer rests on it, never by the daemon’s name', () => {
        expect(titleOf('r-na-03')).toBe('General agent');
        expect(titleOf('r-na-02')).toBe('Explore agent');
        expect(rowOf('r-na-03').querySelector('[title]')?.getAttribute('title')).toBe('Update the booking form');
        expect(rowOf('r-na-03').textContent).not.toContain('general-purpose');
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

    it('lists a sub-agent when it starts and drops it from the list when it ends, into the group of the finished', async () => {
        const run = project().runs.get('r-na-03')!;

        await draw(() => project().runs.set(run.id, { ...run, status: 'succeeded', finishedAt: Date.now() }));

        expect(shown('c-1', 'r-na-03', 'r-na-02')).toEqual(['c-1', 'r-na-02']);

        await draw(() =>
            project().runs.set(run.id, { ...run, id: 'r-na-new', status: 'running', createdAt: Date.now() })
        );

        expect(shown('r-na-new')).toEqual(['r-na-new']);
    });

    it('is a chat with a fold when only sub-agents are below it, and has none when nothing is', () => {
        expect(foldOf('c-1')).not.toBeNull();
        expect(foldOf('c-4')).toBeNull();
    });
});

describe('the group of finished sub-agents', () => {
    it('stands in an opened chat, folded, with the count, after the sub-agents that work and before the threads', async () => {
        await draw(() => ui().toggleChatExpanded('c-1'));

        expect(shown('c-1', 'r-na-03', 'r-na-02', 'r-na-05', GROUP, 'r-na-04', 'r-na-01')).toEqual([
            'c-1',
            'r-na-03',
            'r-na-02',
            'r-na-05',
            GROUP,
        ]);
        expect(titleOf(GROUP)).toBe('Finished sub-agents');
        expect(rowOf(GROUP).textContent).toContain('2');
        expect(foldOf(GROUP)?.getAttribute('aria-expanded')).toBe('false');
    });

    it('folds and unfolds on its own: a press, its chevron, and Right and Left, and opens no page', async () => {
        await draw(() => ui().toggleChatExpanded('c-1'));
        await press(rowOf(GROUP));
        await draw();

        expect(shown(GROUP, 'r-na-04', 'r-na-01')).toEqual([GROUP, 'r-na-04', 'r-na-01']);
        expect(container.querySelector('[data-testid="run"]')).toBeNull();
        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe('c-4');
        expect(isSelected(GROUP)).toBe(false);
        // The newest first, one level in from the group.
        expect(rowOf('r-na-04').getAttribute('data-depth')).toBe('2');

        await press(foldOf(GROUP)!);
        await draw();

        expect(shown(GROUP, 'r-na-04', 'r-na-01')).toEqual([GROUP]);

        await key(rowOf(GROUP), 'ArrowRight');
        await draw();
        expect(shown('r-na-04', 'r-na-01')).toHaveLength(2);

        await key(rowOf(GROUP), 'ArrowLeft');
        await draw();
        expect(shown('r-na-04', 'r-na-01')).toEqual([]);
    });

    it('is not folded again by folding its chat, and is remembered with the chat folds', async () => {
        await draw(() => ['c-1', GROUP].forEach(id => ui().toggleChatExpanded(id)));

        expect(ui().expandedChats).toEqual(['c-1', GROUP]);

        await draw(() => ui().toggleChatExpanded('c-1'));

        expect(shown(GROUP)).toEqual([]);

        await draw(() => ui().toggleChatExpanded('c-1'));

        expect(shown('r-na-04', 'r-na-01')).toHaveLength(2);
    });

    it('is listed only while the finished are, and the check in Filters says so', async () => {
        await draw(() => ui().toggleChatExpanded('c-1'));
        await press(container.querySelector<HTMLElement>('button[aria-label="Filters"]')!);
        await press(menuItem('Show finished sub-threads'));
        await draw();

        expect(chatListPreferences.showFinishedThreads).toBe(false);
        expect(shown(GROUP, 'r-na-04', 'r-na-01')).toEqual([]);
        expect(shown('r-na-03', 'r-na-02')).toEqual(['r-na-03', 'r-na-02']);
    });

    it('has one row for a great many finished sub-agents', async () => {
        const orchestrator = project().runs.get('r-orch-1')!;

        await draw(() => {
            ui().toggleChatExpanded('c-1');

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

        expect(rowOf(GROUP).textContent).toContain('302');
        expect(rowKeys().filter(candidate => candidate?.startsWith('r-many-'))).toEqual([]);
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

    it('opens the folds above a sub-agent opened from elsewhere, its chat and the group when it is over, once per opening', async () => {
        await draw(() => ui().openRun('r-na-04'));
        await draw();

        expect(ui().expandedChats).toEqual(['c-1', GROUP]);
        expect(isSelected('r-na-04')).toBe(true);
        expect(isSelected('c-1')).toBe(false);

        // The person folds the group: the page stays, and so does the fold, with the chat's row marking the place.
        await press(foldOf(GROUP)!);
        await draw();

        expect(shown('r-na-04')).toEqual([]);
        expect(isSelected('c-1')).toBe(true);
    });

    it('keeps a finished sub-agent that is open listed while the finished are not', async () => {
        await draw(() => {
            chatListPreferences.setShowFinishedThreads(false);
            ui().openRun('r-na-04');
        });
        await draw();

        expect(shown(GROUP, 'r-na-04', 'r-na-01')).toEqual(['r-na-04']);
        expect(isSelected('r-na-04')).toBe(true);
    });
});

describe('the keyboard on the list', () => {
    it('steps with J and K, and with the arrows, over the rows of the sub-agents and the group as over the others', async () => {
        await draw(() => ['c-1', GROUP].forEach(id => ui().toggleChatExpanded(id)));

        const uninstall = installDispatcher(hotkeys);
        const focused = () => document.activeElement?.getAttribute('data-key');
        const step = async (name: string) => {
            await key(document.activeElement!, name);

            return focused();
        };

        try {
            rowOf('c-1').focus();

            expect(await step('j')).toBe('r-na-03');
            expect(await step('j')).toBe('r-na-02');
            expect(await step('j')).toBe('r-na-05');
            expect(await step('j')).toBe(GROUP);
            expect(await step('j')).toBe('r-na-04');
            expect(await step('k')).toBe(GROUP);
            expect(await step('k')).toBe('r-na-05');
        } finally {
            uninstall();
        }
    });

    it('opens a sub-agent from its focused row with Enter, and folds a chat that has only sub-agents below it with Left and Right', async () => {
        await key(rowOf('c-1'), 'ArrowRight');
        await draw();

        expect(ui().expandedChats).toContain('c-1');
        expect(shown(GROUP)).toEqual([GROUP]);

        await key(rowOf('c-1'), 'ArrowLeft');
        await draw();

        expect(ui().expandedChats).not.toContain('c-1');

        rowOf('r-na-03').focus();
        await press(rowOf('r-na-03'));
        await draw();

        expect(isSelected('r-na-03')).toBe(true);
    });
});
