// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { Screen } from './Screen';

import type { Editor } from '@tiptap/core';
import type { KeyValueStorage } from '../../stores/storage';

// `Modal` cannot load under the desktop's Vitest (decorators), and no confirmation is opened here.
vi.mock('@clowdy/components/modals', () => ({ openConfirmModal: vi.fn() }));

// The pages beside the list are drawn by their own tests; here they only say which one was asked for.
vi.mock('../chats/ChatView', () => ({ ChatView: ({ chat }: { chat: { id: string; title: string } }) => <div data-testid="chat" data-chat-id={ chat.id }>{ chat.title }</div> }));
vi.mock('./RunDetail', () => ({ RunDetail: ({ run }: { run: { id: string; name: string } }) => <div data-testid="run" data-run-id={ run.id }>{ run.name }</div> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The Agents screen on the fixture project. Chats by activity: c-1 (Simplify booking, orchestrator r-orch-1), c-4 (empty), c-3, c-2.
 * Below r-orch-1: Executor 07 (r-ex-07), with Verifier 02 (r-ver-02) under it, and more. The test build has no MobX observer plugin,
 * so the screen is drawn again by hand after a change, as the observer does in the app.
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

const draw = (before?: () => void) => act(async () => {
    before?.();
    reactRoot.render(<RootStoreProvider value={ store }><Screen /></RootStoreProvider>);
});

const rowKeys = () => [...container.querySelectorAll('[role="row"]')].map(row => row.getAttribute('data-key'));
const rowOf = (key: string) => container.querySelector<HTMLElement>(`[role="row"][data-key="${ key }"]`)!;
const isSelected = (key: string) => rowOf(key).hasAttribute('data-selected');

beforeEach(async () => {
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
    store = new RootStore(new FixtureTransport(), { storage: memoryStorage() });
    await store.load();
    await draw();
});

afterEach(() => {
    act(() => reactRoot.unmount());
    container.remove();
    store.dispose();
});

describe('the list', () => {
    it('starts with the new-chat row, then the chats, and nests the runs of a chat below it', () => {
        const keys = rowKeys();

        expect(keys[0]).toBe('@new-chat');
        expect(keys.filter(key => key?.startsWith('c-'))).toEqual(['c-1', 'c-4', 'c-3', 'c-2']);

        // The orchestrator is the chat, so it has no row; its runs follow the chat, and a run's own runs follow it.
        const below = keys.slice(keys.indexOf('c-1') + 1, keys.indexOf('c-4'));

        expect(keys).not.toContain('r-orch-1');
        expect(below).toContain('r-ex-07');
        // Native sub-agents are cards on the calls that started them, not rows.
        expect(keys).not.toContain('r-na-01');
        expect(keys).not.toContain('r-na-02');
        expect(below.indexOf('r-ver-02')).toBe(below.indexOf('r-ex-07') + 1);
    });

    it('marks a chat that started with the provider it runs on, and one that has not with the speech bubble', async () => {
        const providerOf = (key: string) => rowOf(key).querySelector('[data-provider]')?.getAttribute('data-provider');

        // c-1 has an orchestrator on Claude; c-4 never got a message.
        expect(providerOf('c-1')).toBe('claude');
        expect(providerOf('c-4')).toBeUndefined();

        // A chat on another agent shows that agent's mark: the chat's own choice, else its orchestrator's.
        await draw(() => {
            project().chats.set('c-1', { ...project().chats.get('c-1')!, engine: 'codex' });
        });
        expect(providerOf('c-1')).toBe('codex');

        // An agent with no mark of its own keeps the speech bubble.
        await draw(() => {
            project().chats.set('c-1', { ...project().chats.get('c-1')!, engine: 'fake' });
        });
        expect(providerOf('c-1')).toBeUndefined();
    });

    it('selects the first chat when nothing was opened', () => {
        expect(isSelected('c-1')).toBe(true);
        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe('c-1');
    });

    it('folds the runs of a chat away and brings them back', async () => {
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Collapse Simplify booking"]')!.click());

        expect(rowKeys()).not.toContain('r-ex-07');
        expect(rowKeys()).toContain('c-1');

        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Expand Simplify booking"]')!.click());

        expect(rowKeys()).toContain('r-ex-07');
    });

    it('shows no runs at all when subthreads are switched off, and no finished ones when only those are', async () => {
        const all = rowKeys().filter(key => key?.startsWith('r-'));

        await draw(() => ui().setShowFinished(false));

        const active = rowKeys().filter(key => key?.startsWith('r-'));

        expect(active.length).toBeLessThan(all.length);
        expect(active).toContain('r-ex-07');

        await draw(() => ui().setShowSubthreads(false));

        expect(rowKeys().filter(key => key?.startsWith('r-'))).toEqual([]);
        expect(rowKeys().filter(key => key?.startsWith('c-'))).toEqual(['c-1', 'c-4', 'c-3', 'c-2']);
    });
});

describe('what is open', () => {
    it('opens a run below its chat: the run is selected and its page shows, whichever chat was open', async () => {
        await draw(() => {
            ui().openChat('c-3');
            ui().openRun('r-ver-02');
        });

        expect(container.querySelector('[data-testid="run"]')?.getAttribute('data-run-id')).toBe('r-ver-02');
        expect(container.querySelector('[data-testid="chat"]')).toBeNull();
        expect(isSelected('r-ver-02')).toBe(true);
        expect(isSelected('c-1')).toBe(false);
    });

    it('takes the orchestrator for its chat', async () => {
        await draw(() => ui().openRun('r-orch-1'));

        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe('c-1');
        expect(isSelected('c-1')).toBe(true);
    });

    it('unfolds the chat of a run that is opened from elsewhere', async () => {
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Collapse Simplify booking"]')!.click());

        expect(rowKeys()).not.toContain('r-ex-07');

        await draw(() => ui().openRun('r-ver-02'));

        expect(rowKeys()).toContain('r-ver-02');
        expect(isSelected('r-ver-02')).toBe(true);
    });

    it('opens a native sub-agent beside its chat, which stays selected since the sub-agent has no row', async () => {
        await draw(() => ui().openRun('r-na-02'));

        expect(container.querySelector('[data-testid="run"]')?.getAttribute('data-run-id')).toBe('r-na-02');
        expect(isSelected('c-1')).toBe(true);
    });

    it('falls back to a chat when the remembered run is gone', async () => {
        await draw(() => ui().openRun('r-gone'));

        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe('c-1');
    });
});

describe('the new-chat row', () => {
    const field = () => container.querySelector<HTMLElement>('[contenteditable="true"]');
    const editor = () => (field() as HTMLElement & { editor: Editor }).editor;

    function type(value: string) {
        act(() => {
            editor().commands.insertContent(value);
        });
    }

    const pressEnter = () => act(async () => {
        field()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });

    it('opens a page with a message box, and makes no chat by being opened', async () => {
        const before = project().chats.size;

        await draw(() => ui().openDraft());

        expect(isSelected('@new-chat')).toBe(true);
        expect(container.querySelector('[data-testid="chat"]')).toBeNull();
        expect(field()).not.toBeNull();
        expect(container.textContent).toContain('What should we work on?');

        await draw(() => ui().openDraft());

        expect(project().chats.size).toBe(before);
    });

    it('makes the chat and sends the message when it is sent, and then shows that chat', async () => {
        const before = new Set(project().chats.keys());

        await draw(() => ui().openDraft());
        type('Build the thing');
        await pressEnter();
        await draw();

        const made = [...project().chats.keys()].filter(id => !before.has(id));

        expect(made).toHaveLength(1);
        expect(ui().draft).toBe(false);
        expect(ui().chatId).toBe(made[0]);
        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe(made[0]);
    });

    it('sends nothing for a message of spaces, and keeps what was typed when the row is left and opened again', async () => {
        const before = project().chats.size;

        await draw(() => ui().openDraft());
        type('   ');
        await pressEnter();

        expect(project().chats.size).toBe(before);

        type('half a thought');
        await draw(() => ui().openChat('c-3'));
        await draw(() => ui().openDraft());

        expect(editor().getText()).toContain('half a thought');
    });

    it('is what shows, and the only row, when the project has no chat', async () => {
        store.selectProject(FIXTURE_EMPTY_PROJECT_ID);
        await vi.waitFor(() => expect(store.selectedProject?.status).toBe('ready'));
        await draw();

        expect(rowKeys()).toEqual(['@new-chat']);
        expect(isSelected('@new-chat')).toBe(true);
        expect(field()).not.toBeNull();
    });
});

describe('archived chats', () => {
    async function archive(chatId: string, archived: boolean) {
        await act(async () => {
            await store.command({ type: 'chat.setArchived', chatId, archived });
        });
        // The change comes back on the event feed, a moment after the answer.
        await vi.waitFor(() => expect(project().chats.get(chatId)?.archivedAt !== undefined).toBe(archived));
        await draw();
    }

    it('are left out of the list until they are asked for, and listed again, unchanged, when they are', async () => {
        await archive('c-4', true);

        expect(rowKeys()).not.toContain('c-4');
        expect(rowKeys().filter(key => key?.startsWith('c-'))).toEqual(['c-1', 'c-3', 'c-2']);

        await draw(() => ui().setShowArchived(true));

        expect(rowKeys().filter(key => key?.startsWith('c-'))).toEqual(['c-1', 'c-3', 'c-2', 'c-4']);

        await archive('c-4', false);
        await draw(() => ui().setShowArchived(false));

        expect(rowKeys()).toContain('c-4');
    });

    it('are a group of their own, headed Archived, below every other chat, and with no header when there are none', async () => {
        await draw(() => ui().setShowArchived(true));

        expect(container.textContent).not.toContain('Archived');

        await archive('c-4', true);
        await draw(() => ui().setShowArchived(true));

        const text = container.textContent ?? '';
        const keys = rowKeys();

        expect(text).toContain('Archived');
        expect(keys.at(-1)).toBe('c-4');
        expect(keys.indexOf('c-4')).toBeGreaterThan(keys.indexOf('c-2'));
        // The header sits between the two groups, not above the new-chat row.
        expect(container.querySelector('[role="row"][data-key="c-4"]')?.closest('[role="rowgroup"]')?.textContent).toContain('Archived');
        expect(rowOf('c-2').closest('[role="rowgroup"]')?.textContent).not.toContain('Archived');
    });

    it('give the other chats a header of their own, Active, once the Archived group is there, below the new-chat row', async () => {
        const headers = () => [...container.querySelectorAll('[role="rowgroup"]')].map(group => group.textContent?.startsWith('Active') ? 'Active' : group.textContent?.startsWith('Archived') ? 'Archived' : 'none');

        await draw(() => ui().setShowArchived(true));

        expect(container.textContent).not.toContain('Active');
        expect(headers()).toEqual(['none']);

        await archive('c-4', true);
        await draw(() => ui().setShowArchived(true));

        expect(headers()).toEqual(['none', 'Active', 'Archived']);
        expect(rowOf('c-2').closest('[role="rowgroup"]')?.textContent).toContain('Active');
        expect(rowOf('c-2').closest('[role="rowgroup"]')).not.toBe(rowOf('@new-chat').closest('[role="rowgroup"]'));
    });

    it('keep their subthreads below them, inside the group', async () => {
        await archive('c-2', true);
        await draw(() => ui().setShowArchived(true));

        const keys = rowKeys();

        expect(keys.indexOf('c-2')).toBeGreaterThan(keys.indexOf('c-3'));
        expect(keys[keys.indexOf('c-2') + 1]).toBe('r-ex-15');
        expect(rowOf('r-ex-15').closest('[role="rowgroup"]')).toBe(rowOf('c-2').closest('[role="rowgroup"]'));
    });

    it('still show their page, and their row, when one is opened from elsewhere', async () => {
        await archive('c-4', true);
        await draw(() => ui().openChat('c-4'));

        expect(rowKeys()).toContain('c-4');
        expect(isSelected('c-4')).toBe(true);
        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe('c-4');

        await draw(() => ui().openChat('c-3'));

        expect(rowKeys()).not.toContain('c-4');
    });

    it('keep the runs of an archived chat opening below it', async () => {
        await archive('c-2', true);
        await draw(() => ui().openRun('r-orch-2'));

        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe('c-2');
    });

    it('cannot be archived while an agent of the chat works, and the list says so', async () => {
        const result = await store.command({ type: 'chat.setArchived', chatId: 'c-1', archived: true });

        expect(result.ok).toBe(false);

        await draw();

        expect(rowKeys()).toContain('c-1');
    });

    it('fall back to the first listed chat when the one that was open is archived and nothing asks for it', async () => {
        await draw(() => ui().openChat('c-2'));
        await archive('c-2', true);
        await draw(() => ui().openChat(null));

        expect(container.querySelector('[data-testid="chat"]')?.getAttribute('data-chat-id')).toBe('c-1');
    });
});
