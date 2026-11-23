// @vitest-environment happy-dom
import { emptyComposerDoc } from '@clowdy/components/RichInput';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { newChatDraftKey, saveDraft } from '../chats/composerDrafts';
import { filesOf, setFiles } from '../chats/composerFiles';
import { newChatDefaults } from '../chats/newChatDefaults';
import { chatListPreferences } from './chatListPreferences';
import { Screen } from './Screen';

import type { Editor } from '@tiptap/core';
import type { KeyValueStorage } from '../../stores/storage';

// `Modal` cannot load under the desktop's Vitest (decorators), and no confirmation is opened here.
vi.mock('@clowdy/components/modals', () => ({ openConfirmModal: vi.fn() }));
// Streamdown highlights code with Shiki, whose WebAssembly cannot load under happy-dom and fails after the test that drew a fence; the messages' words are what is checked here.
vi.mock('../../stream/Markdown', () => ({ Markdown: ({ text }: { text: string }) => <div>{ text }</div> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The Fork menu's second item from end to end on the fixture project: on the answer of First version (c-2, which ran on Claude Code, switched on),
 * Fork to another agent opens the new-chat page on the agent picked, with the conversation up to that answer attached, and nothing is made until its
 * first message is sent. The test build has no MobX observer plugin, so the screen is drawn again by hand after a change, as the observer does in the app.
 */

const DRAFT_KEY = newChatDraftKey(FIXTURE_PROJECT_ID);
const FILE_NAME = 'first-version-conversation.md';

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;

const ui = () => store.ui.forProject(FIXTURE_PROJECT_ID);

const draw = () => act(async () => {
    reactRoot.render(<RootStoreProvider value={ store }><Screen /></RootStoreProvider>);
});

/** A press with a mouse: what React Aria opens a menu on and picks an item with. */
const press = (target: Element) => act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    (target as HTMLElement).click();
});

const menuItem = (name: string) => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(row => row.textContent?.startsWith(name))!;
const field = () => container.querySelector<HTMLElement>('[contenteditable="true"]') as (HTMLElement & { editor: Editor }) | null;
const modelLabel = () => container.querySelector('button[aria-label^="Model:"]')?.getAttribute('aria-label');

/** Opens First version, presses Fork on its answer, and picks the agent in the second item. */
async function forkTo(agent: string) {
    await act(async () => ui().openChat('c-2'));
    await draw();
    await draw();
    await press(container.querySelector('button[aria-label="Fork"]')!);
    await press(menuItem('Fork to another agent'));
    await press(menuItem(agent));
    await vi.waitFor(() => expect(ui().draft).toBe(true));
    await draw();
    // The upload of the file ends after the page has drawn.
    await act(async () => undefined);
}

beforeEach(async () => {
    chatListPreferences.setSort('activity');
    saveDraft(DRAFT_KEY, emptyComposerDoc());
    setFiles(DRAFT_KEY, []);
    localStorage.clear();

    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
    store = new RootStore(new FixtureTransport({ data: createFixtureData() }), { storage: memoryStorage() });
    await store.load();
    await store.refreshAgents();
    await draw();
});

afterEach(() => {
    newChatDefaults.setEngine(undefined);
    act(() => reactRoot.unmount());
    container.remove();
    store.dispose();
    setFiles(DRAFT_KEY, []);
    localStorage.clear();
});

describe('Fork to another agent', () => {
    it('opens the new-chat page on the agent picked, on its default model, with the conversation attached and the draft filled', async () => {
        await forkTo('Codex');

        expect(container.textContent).toContain('What should we work on?');
        expect(modelLabel()).toBe('Model: GPT-6.2 Sol · Low');
        expect(container.textContent).toContain(FILE_NAME);
        expect(filesOf(DRAFT_KEY).map(file => file.name)).toEqual([FILE_NAME]);
        expect(field()!.editor.getText()).toBe(`Continue the work from the chat "First version". The conversation so far is attached as ${ FILE_NAME }.`);
        // The page took the file: the window holds none any more.
        expect(ui().pendingFiles).toEqual([]);
    });

    it('starts on the agent picked even when the app\'s new chats ask for another, and the next page opened asks for that other again', async () => {
        newChatDefaults.setEngine('claude');
        await forkTo('Cursor');

        expect(ui().draftEngine).toBe('cursor');
        expect(modelLabel()).toContain('Auto');

        await act(async () => ui().openDraft());
        await draw();

        expect(modelLabel()).toContain('Opus');
    });

    it('sends the first message to the agent picked, with the file, and that makes the chat', async () => {
        const command = vi.spyOn(store, 'command');

        await forkTo('Codex');

        const [held] = filesOf(DRAFT_KEY);

        await act(async () => {
            field()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        });

        await vi.waitFor(() => expect(command.mock.calls.filter(([input]) => input.type === 'chat.send')).toHaveLength(1));

        const sent = command.mock.calls.map(([input]) => input);

        expect(sent.find(input => input.type === 'chat.create')).toMatchObject({ engine: 'codex', model: 'gpt-6.2-sol', projectId: FIXTURE_PROJECT_ID });
        expect(sent.find(input => input.type === 'chat.send')).toMatchObject({ attachmentIds: [held!.attachment!.id] });
    });

    it('leaves nothing behind when the page is closed, and the next new-chat page starts where it always does', async () => {
        const command = vi.spyOn(store, 'command');
        const chats = [...store.selectedProject!.chats.keys()];

        await forkTo('Codex');
        await act(async () => ui().openChat('c-3'));
        await draw();

        expect(command.mock.calls.filter(([input]) => input.type === 'chat.create' || input.type === 'chat.fork')).toEqual([]);
        expect([...store.selectedProject!.chats.keys()]).toEqual(chats);

        await act(async () => ui().openDraft());
        await draw();

        expect(modelLabel()).toContain('Opus');
    });

    it('brings the agent back with the page when the person goes back to it', async () => {
        await forkTo('Cursor');
        await act(async () => ui().openChat('c-3'));
        await draw();
        expect(ui().draftEngine).toBeNull();

        await act(async () => store.history.back());
        await draw();

        expect(ui().draft).toBe(true);
        expect(ui().draftEngine).toBe('cursor');
        expect(modelLabel()).toContain('Auto');
    });
});
