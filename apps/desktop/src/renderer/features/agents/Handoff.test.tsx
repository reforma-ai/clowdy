// @vitest-environment happy-dom
import { emptyComposerDoc, plainTextToDoc } from '@clowdy/components/RichInput';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { newChatDraftKey, saveDraft } from '../chats/composerDrafts';
import { filesOf, setFiles } from '../chats/composerFiles';
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
 * The hand-off from end to end on the fixture project, with Claude Code switched off: the Agents screen opens on chat c-1 (which ran
 * on it), whose message box is a notice, and its button leads to the new-chat page with the conversation attached. The test build has no
 * MobX observer plugin, so the screen is drawn again by hand after a change, as the observer does in the app.
 */

/** The new-chat page of each project: where the hand-off puts its words, and where the page keeps its files. */
const DRAFT_KEY = newChatDraftKey(FIXTURE_PROJECT_ID);
const OTHER_DRAFT_KEY = newChatDraftKey(FIXTURE_EMPTY_PROJECT_ID);
const FILE_NAME = 'simplify-booking-conversation.md';
const SENTENCE = `Continue the work from the chat "Simplify booking". The conversation so far is attached as ${ FILE_NAME }.`;

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;
let transport: FixtureTransport;
/** Draw under React's strict mode, which runs every effect twice on mount. */
let strict = false;

const ui = () => store.ui.forProject(FIXTURE_PROJECT_ID);

const draw = () => act(async () => {
    const screen = <RootStoreProvider value={ store }><Screen /></RootStoreProvider>;

    reactRoot.render(strict ? <StrictMode>{ screen }</StrictMode> : screen);
});

const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent === label);
const field = () => container.querySelector<HTMLElement>('[contenteditable="true"]') as (HTMLElement & { editor: Editor }) | null;

/** Opens the chat that ran on Claude Code, with Claude Code switched off, and presses the hand-off button. */
async function handOff() {
    await act(async () => button('Hand off to a new chat')!.click());
    await draw();
    // The upload of the file ends after the page has drawn.
    await act(async () => undefined);
}

beforeEach(async () => {
    strict = false;
    // The screen opens on the first chat of the list: c-1 is that by last activity, and the list starts in the order the chats were made in.
    chatListPreferences.setSort('activity');
    saveDraft(DRAFT_KEY, emptyComposerDoc());
    setFiles(DRAFT_KEY, []);
    setFiles(OTHER_DRAFT_KEY, []);

    const data = createFixtureData();
    const claude = data.agents.find(agent => agent.id === 'claude')!;

    claude.enabled = false;
    claude.status = 'disabled';

    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
    transport = new FixtureTransport({ data });
    store = new RootStore(transport, { storage: memoryStorage() });
    await store.load();
    await store.refreshAgents();
    // The chat draws once, and again when its messages have come.
    await draw();
    await draw();
});

afterEach(() => {
    act(() => reactRoot.unmount());
    container.remove();
    store.dispose();
    setFiles(DRAFT_KEY, []);
    setFiles(OTHER_DRAFT_KEY, []);
});

describe('handing a read-only chat off', () => {
    it('shows the notice on the chat, and the new-chat page it leads to has the conversation attached and the draft filled', async () => {
        const upload = vi.spyOn(transport, 'uploadAttachment');

        expect(container.querySelector('[aria-label="This chat is read only"]')).not.toBeNull();
        expect(field()).toBeNull();

        await handOff();

        expect(ui().draft).toBe(true);
        expect(container.textContent).toContain('What should we work on?');
        expect(container.querySelector('[aria-label="This chat is read only"]')).toBeNull();

        // The draft says to continue, and names the file.
        expect(field()!.editor.getText()).toBe(SENTENCE);

        // The file is a card in the message box, uploaded to the project like a picked file, and held by the page no more.
        expect(container.textContent).toContain(FILE_NAME);
        expect(ui().pendingFiles).toEqual([]);

        const [held, ...others] = filesOf(DRAFT_KEY);

        expect(others).toEqual([]);
        expect(held).toMatchObject({ name: FILE_NAME, mediaType: 'text/markdown', status: 'ready' });

        const stored = await store.transport.getAttachment(FIXTURE_PROJECT_ID, held!.attachment!.id);

        expect(await stored.text()).toContain('Simplify the booking flow: one form instead of three steps');
        // Uploaded once, to the project the page is in.
        expect(upload).toHaveBeenCalledTimes(1);
        expect(upload.mock.calls[0]![0]).toBe(FIXTURE_PROJECT_ID);
    });

    it('appends the sentence after a blank line to words already in the new-chat draft', async () => {
        saveDraft(DRAFT_KEY, plainTextToDoc('Also check the footer'));

        await handOff();

        expect(field()!.editor.getText()).toBe(`Also check the footer\n\n${ SENTENCE }`);
        expect(filesOf(DRAFT_KEY).map(file => file.name)).toEqual([FILE_NAME]);
    });

    it('leaves the new-chat page empty when it is opened from the list, with no hand-off', async () => {
        await act(async () => ui().openDraft());
        await draw();

        expect(field()!.editor.getText()).toBe('');
        expect(filesOf(DRAFT_KEY)).toEqual([]);
    });

    it('does not attach the file a second time when the page is opened again', async () => {
        const upload = vi.spyOn(transport, 'uploadAttachment');

        await handOff();
        await act(async () => ui().openChat('c-3'));
        await draw();
        await act(async () => ui().openDraft());
        await draw();

        expect(filesOf(DRAFT_KEY).map(file => file.name)).toEqual([FILE_NAME]);
        // The box keeps a file of the same name and size only once, so the number of uploads is what tells a second attach.
        expect(upload).toHaveBeenCalledTimes(1);
    });

    it('attaches the file once when React runs the page\'s effects twice', async () => {
        strict = true;
        await draw();
        await draw();

        const upload = vi.spyOn(transport, 'uploadAttachment');

        await handOff();

        expect(filesOf(DRAFT_KEY).map(file => file.name)).toEqual([FILE_NAME]);
        expect(upload).toHaveBeenCalledTimes(1);
        expect(ui().pendingFiles).toEqual([]);
    });

    it('keeps the file with the project of the chat: another project\'s new-chat page does not get it', async () => {
        const upload = vi.spyOn(transport, 'uploadAttachment');

        await handOff();
        await act(async () => store.selectProject(FIXTURE_EMPTY_PROJECT_ID));
        await draw();
        await draw();

        // The other project has no chats, so its page is the new-chat page, and it has nothing attached and none of the first project's words.
        expect(container.textContent).toContain('What should we work on?');
        expect(filesOf(OTHER_DRAFT_KEY)).toEqual([]);
        expect(field()!.editor.getText()).toBe('');
        expect(store.ui.forProject(FIXTURE_EMPTY_PROJECT_ID).pendingFiles).toEqual([]);

        // Back in the first one, the file is on its page, uploaded there and once.
        await act(async () => store.selectProject(FIXTURE_PROJECT_ID));
        await draw();

        expect(container.textContent).toContain(FILE_NAME);
        expect(filesOf(DRAFT_KEY).map(file => file.name)).toEqual([FILE_NAME]);
        expect(field()!.editor.getText()).toBe(SENTENCE);
        expect(upload).toHaveBeenCalledTimes(1);
        expect(upload.mock.calls[0]![0]).toBe(FIXTURE_PROJECT_ID);
    });

    it('keeps the words and the file when the person leaves the new-chat page and comes back', async () => {
        await handOff();
        await act(async () => ui().openChat('c-3'));
        await draw();
        await act(async () => ui().openDraft());
        await draw();

        expect(field()!.editor.getText()).toBe(SENTENCE);
        expect(container.textContent).toContain(FILE_NAME);
    });
});
