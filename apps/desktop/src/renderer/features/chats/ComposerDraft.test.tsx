// @vitest-environment happy-dom
import { emptyComposerDoc } from '@clowdy/components/RichInput';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RootStoreProvider, type RootStore } from '../../stores';
import { Composer } from './Composer';
import { draftOf, messageOf, newChatDraftKey, saveDraft } from './composerDrafts';
import { modelStore } from './modelTestKit';

import type { Chat, CommandResult } from '@clowdy/protocol';
import type { Editor } from '@tiptap/core';
import type { CommandInput } from '../../daemon/transport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The Composer on the new-chat page: there is no chat yet, and the first message makes it. */

const made: Chat = { id: 'c-new', projectId: 'p', title: 'New chat', mode: 'autopilot', createdAt: 0, updatedAt: 0 };
const accepted = (data: unknown = {}): CommandResult => ({ ok: true, requestId: 'request-1', data });
const refused: CommandResult = { ok: false, requestId: 'request-1', error: { code: 'unavailable', message: 'The daemon cannot be reached' } };

const transport = {
    getDocsTree: vi.fn(async () => []),
    getProjectFiles: vi.fn(async () => []),
    getSkills: vi.fn(async () => ({ entries: [], tokens: 0, warnings: [] })),
};

let container: HTMLDivElement;
let root: Root;
let sent: CommandInput[];
let started: string[];

/** `answer` says what the daemon answers to each command, in the order they are sent. Drawn again for another `projectId`, it is the same composer on another project's page. */
async function mount(answer: (input: CommandInput) => CommandResult | Promise<CommandResult>, minLines?: number, projectId = 'p') {
    const command = vi.fn(async (input: CommandInput) => {
        sent.push(input);

        return answer(input);
    });
    const store = { command, transport, skillsRevision: 0, selectedProject: { project: { id: 'p' }, taskList: [] }, ...await modelStore() };

    await act(async () => {
        root.render(
            <RootStoreProvider value={ store as unknown as RootStore }>
                <Composer chat={ undefined } run={ undefined } minLines={ minLines } start={ { projectId, onStarted: chatId => started.push(chatId) } } />
            </RootStoreProvider>
        );
    });
}

const field = () => container.querySelector<HTMLElement>('[contenteditable="true"]')!;
const editor = () => (field() as HTMLElement & { editor: Editor }).editor;
const text = () => editor().getText();

function type(value: string) {
    act(() => {
        editor().commands.insertContent(value);
    });
}

const pressEnter = () => act(async () => {
    field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
});

beforeEach(() => {
    // What is typed on the new-chat page is remembered for the whole session, so each test starts it empty.
    for (const projectId of ['p', 'p-one', 'p-two']) saveDraft(newChatDraftKey(projectId), emptyComposerDoc());

    sent = [];
    started = [];
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('Composer without a chat', () => {
    it('makes the chat with the first message, sends the message to it, and hands the chat over', async () => {
        await mount(input => (input.type === 'chat.create' ? accepted({ chat: made }) : accepted()));
        type('Build the thing');
        await pressEnter();

        expect(sent).toEqual([
            { type: 'chat.create', projectId: 'p', mode: 'autopilot', engine: 'claude', model: 'opus', effort: 'high' },
            { type: 'chat.send', chatId: 'c-new', text: 'Build the thing', mode: 'steer' },
        ]);
        expect(started).toEqual(['c-new']);
        expect(text()).toBe('');
    });

    it('makes nothing for an empty or blank message', async () => {
        await mount(() => accepted({ chat: made }));
        await pressEnter();
        type('   ');
        await pressEnter();

        expect(sent).toEqual([]);
        expect(started).toEqual([]);
    });

    it('gives the words back, and sends nothing, when the chat cannot be made', async () => {
        await mount(() => refused);
        type('Build the thing');
        await pressEnter();

        expect(sent.map(input => input.type)).toEqual(['chat.create']);
        expect(started).toEqual([]);
        expect(text()).toContain('Build the thing');
    });

    it('keeps the chat it made when the message fails, and the retry goes to that chat instead of making another', async () => {
        let sends = 0;

        await mount((input) => {
            if (input.type === 'chat.create') return accepted({ chat: made });

            return ++sends === 1 ? refused : accepted();
        });
        type('Build the thing');
        await pressEnter();

        expect(started).toEqual([]);
        expect(text()).toContain('Build the thing');

        await pressEnter();

        expect(sent.map(input => input.type)).toEqual(['chat.create', 'chat.send', 'chat.send']);
        expect(sent[2]).toEqual({ type: 'chat.send', chatId: 'c-new', text: 'Build the thing', mode: 'steer' });
        expect(started).toEqual(['c-new']);
    });

    it('starts the chat in the mode it offers: Hands-off', async () => {
        await mount(input => (input.type === 'chat.create' ? accepted({ chat: made }) : accepted()));

        expect(container.textContent).toContain('Hands-off');
    });

    it('is as tall as the page asks while empty, and one line otherwise', async () => {
        await mount(() => accepted(), 3);

        expect(field().style.minHeight).toBe('60px');

        await act(async () => root.unmount());
        root = createRoot(container);
        await mount(() => accepted());

        expect(field().style.minHeight).toBe('24px');
    });
});

describe('the words of the new-chat page', () => {
    it('are kept per project, as its files are: another project\'s page has none of them', async () => {
        await mount(() => accepted(), undefined, 'p-one');
        type('Words of one');

        // The same composer, drawn again for another project.
        await mount(() => accepted(), undefined, 'p-two');

        expect(text()).toBe('');

        type('Words of two');
        await mount(() => accepted(), undefined, 'p-one');

        expect(text()).toBe('Words of one');
        expect(messageOf(draftOf(newChatDraftKey('p-two')))).toBe('Words of two');
        expect(messageOf(draftOf(newChatDraftKey('p-one')))).toBe('Words of one');
    });

    it('go back to the project they were typed in when sending them fails after the person has moved on', async () => {
        let release!: (result: CommandResult) => void;

        await mount(() => new Promise<CommandResult>((resolve) => {
            release = resolve;
        }), undefined, 'p-one');
        type('Build the thing');
        await pressEnter();

        // The chat is still being made when the person goes to another project.
        await mount(() => accepted(), undefined, 'p-two');
        await act(async () => release(refused));

        expect(text()).toBe('');
        expect(messageOf(draftOf(newChatDraftKey('p-two')))).toBe('');
        expect(messageOf(draftOf(newChatDraftKey('p-one')))).toBe('Build the thing');

        await mount(() => accepted(), undefined, 'p-one');

        expect(text()).toBe('Build the thing');
    });
});
