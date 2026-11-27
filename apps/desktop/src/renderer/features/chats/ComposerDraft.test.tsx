// @vitest-environment happy-dom
import { type ComposerDoc, emptyComposerDoc } from '@clowdy/components/RichInput';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RootStore, RootStoreProvider } from '../../stores';
import { branchPrefix } from './branchPrefix';
import { Composer } from './Composer';
import { draftOf, messageOf, newChatDraftKey, saveDraft } from './composerDrafts';
import { modelStore } from './modelTestKit';

import type { Attachment, Chat, ChatWorkspaceChoice, Command, CommandResult } from '@clowdy/protocol';
import type { Editor } from '@tiptap/core';
import type { CommandInput } from '../../daemon/transport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The Composer on the new-chat page: there is no chat yet, and the first message makes it. */

const made: Chat = { id: 'c-new', projectId: 'p', title: 'New chat', mode: 'autopilot', createdAt: 0, updatedAt: 0 };
const accepted = (data: unknown = {}): CommandResult => ({ ok: true, requestId: 'request-1', data });
const refused: CommandResult = {
    ok: false,
    requestId: 'request-1',
    error: { code: 'unavailable', message: 'The daemon cannot be reached' },
};

const transport = {
    getDocsTree: vi.fn(async () => []),
    getProjectFiles: vi.fn(async () => []),
    getSkills: vi.fn(async () => ({ entries: [], tokens: 0, warnings: [] })),
    deleteAttachment: vi.fn(async () => undefined),
};

let container: HTMLDivElement;
let root: Root;
let sent: CommandInput[];
let started: string[];
const journals = new Map<
    string,
    {
        createdChat?: Chat;
        operation?: Extract<Command, { type: 'chat.create' | 'chat.send' }>;
        firstMessage?: Omit<Extract<Command, { type: 'chat.send' }>, 'type' | 'requestId' | 'chatId'>;
        attachments?: readonly Attachment[];
        reply?: import('../../stream/MessageActions').ReplyMessage;
    }
>();

/** `answer` says what the daemon answers to each command, in the order they are sent. Drawn again for another `projectId` or `folderId`, it is the same composer on another project's or folder's page. */
async function mount(
    answer: (input: CommandInput) => CommandResult | Promise<CommandResult>,
    minLines?: number,
    projectId = 'p',
    folderId?: string,
    workspace?: ChatWorkspaceChoice,
    draft?: { key: string; doc: ComposerDoc; change: (doc: ComposerDoc) => void }
) {
    const journal = draft && {
        key: draft.key,
        get: () => journals.get(draft.key),
        clearRefused: () => {
            const previous = journals.get(draft.key);
            if (previous)
                journals.set(draft.key, {
                    createdChat: previous.createdChat,
                    attachments: previous.attachments,
                    reply: previous.reply,
                });
            return true;
        },
        setAttachments: (attachments: readonly Attachment[]) => {
            journals.set(draft.key, { ...journals.get(draft.key), attachments });
        },
        setReply: (reply?: import('../../stream/MessageActions').ReplyMessage) => {
            journals.set(draft.key, { ...journals.get(draft.key), reply });
        },
        set: (
            operation: Extract<Command, { type: 'chat.create' | 'chat.send' }> | undefined,
            createdChat?: Chat,
            firstMessage?: Omit<Extract<Command, { type: 'chat.send' }>, 'type' | 'requestId' | 'chatId'>,
            attachments?: readonly Attachment[],
            reply?: import('../../stream/MessageActions').ReplyMessage
        ) => {
            const previous = journals.get(draft.key);
            journals.set(draft.key, {
                operation,
                createdChat: createdChat ?? previous?.createdChat,
                firstMessage: firstMessage ?? previous?.firstMessage,
                attachments: attachments ?? previous?.attachments,
                reply: reply ?? previous?.reply,
            });
            return true;
        },
    };
    const command = vi.fn(async (input: CommandInput) => {
        sent.push(input);

        return answer(input);
    });
    const store = {
        command,
        transport,
        skillsRevision: 0,
        selectedProject: { project: { id: 'p', folders: [{ id: 'f1', path: '/Users/dev/web' }] }, taskList: [] },
        ...(await modelStore()),
    };

    await act(async () => {
        root.render(
            <RootStoreProvider value={store as unknown as RootStore}>
                <Composer
                    chat={undefined}
                    run={undefined}
                    minLines={minLines}
                    start={{
                        projectId,
                        ...(draft && {
                            draftKey: draft.key,
                            draftDoc: draft.doc,
                            onDraftChange: draft.change,
                            journal,
                        }),
                        folderId,
                        ...(workspace && { workspace }),
                        onStarted: chatId => started.push(chatId),
                    }}
                />
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

const pressEnter = () =>
    act(async () => {
        field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });

beforeEach(() => {
    // What is typed on the new-chat page is remembered for the whole session, so each test starts it empty.
    for (const projectId of ['p', 'p-one', 'p-two']) saveDraft(newChatDraftKey(projectId), emptyComposerDoc());

    sent = [];
    started = [];
    journals.clear();
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

        await mount(input => {
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

    it('makes the chat in the folder the page is for, and in none for the main folder', async () => {
        await mount(
            input => (input.type === 'chat.create' ? accepted({ chat: { ...made, folderId: 'fld-api' } }) : accepted()),
            undefined,
            'p',
            'fld-api'
        );
        type('Fix the endpoint');
        await pressEnter();

        expect(sent[0]).toEqual({
            type: 'chat.create',
            projectId: 'p',
            folderId: 'fld-api',
            mode: 'autopilot',
            engine: 'claude',
            model: 'opus',
            effort: 'high',
        });

        sent = [];
        await mount(input => (input.type === 'chat.create' ? accepted({ chat: made }) : accepted()));
        type('Fix the page');
        await pressEnter();

        expect(sent[0]).not.toHaveProperty('folderId');
    });

    it('asks for a new worktree as the page chose it, with the branch prefix of Settings when it is not the default, and for no prefix otherwise', async () => {
        const choice: ChatWorkspaceChoice = { mode: 'new', base: 'dev' };
        const answer = (input: CommandInput) => (input.type === 'chat.create' ? accepted({ chat: made }) : accepted());
        const workspaceOf = () => (sent[0] as { workspace?: unknown }).workspace;

        await mount(answer, undefined, 'p', 'f1', choice);
        type('Start in a worktree');
        await pressEnter();

        // Nothing is added for the default prefix: a daemon from before the setting takes the command as it was.
        expect(workspaceOf()).toEqual({ mode: 'new', base: 'dev' });

        sent = [];
        branchPrefix.setValue('max');

        try {
            await mount(answer, undefined, 'p', 'f1', choice);
            type('Start in another worktree');
            await pressEnter();

            expect(workspaceOf()).toEqual({ mode: 'new', base: 'dev', branchPrefix: 'max' });
            // The page's own choice is the one it had.
            expect(choice).toEqual({ mode: 'new', base: 'dev' });

            // A worktree that exists has no branch to name.
            sent = [];
            await mount(answer, undefined, 'p', 'f1', { mode: 'existing', path: '/work/p-feature' });
            type('Start in the feature worktree');
            await pressEnter();

            expect(workspaceOf()).toEqual({ mode: 'existing', path: '/work/p-feature' });
        } finally {
            branchPrefix.setValue('');
        }
    });

    it("does not send the message of another folder's page to the chat a failed message left in this one", async () => {
        await mount(
            input => {
                if (input.type === 'chat.create') return accepted({ chat: { ...made, folderId: 'fld-api' } });

                return refused;
            },
            undefined,
            'p',
            'fld-api'
        );
        type('Fix the endpoint');
        await pressEnter();

        // The same composer, drawn again for the main folder: the chat made for the api folder is not its chat.
        sent = [];
        await mount(input =>
            input.type === 'chat.create' ? accepted({ chat: { ...made, id: 'c-main' } }) : accepted()
        );
        await pressEnter();

        expect(sent.map(input => input.type)).toEqual(['chat.create', 'chat.send']);
        expect(sent[1]).toMatchObject({ type: 'chat.send', chatId: 'c-main' });
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

describe('identified new-chat drafts', () => {
    it('retains persisted words during a failed asynchronous send and after navigation', async () => {
        let release!: (result: CommandResult) => void;
        let doc = emptyComposerDoc();
        const draft = {
            key: '@new-chat:p:one',
            get doc() {
                return doc;
            },
            change: (next: ComposerDoc) => {
                doc = next;
            },
        };
        await mount(
            () =>
                new Promise<CommandResult>(resolve => {
                    release = resolve;
                }),
            undefined,
            'p',
            undefined,
            undefined,
            draft
        );
        type('Keep these words');
        await pressEnter();
        expect(messageOf(doc)).toBe('Keep these words');
        await mount(() => accepted(), undefined, 'p-two');
        await act(async () => release(refused));
        expect(messageOf(doc)).toBe('Keep these words');
        expect(started).toEqual([]);
    });

    it('locks the message during a first send and keeps the original words on failure', async () => {
        let release!: (result: CommandResult) => void;
        let doc = emptyComposerDoc();
        const draft = {
            key: '@new-chat:p:three',
            get doc() {
                return doc;
            },
            change: (next: ComposerDoc) => {
                doc = next;
            },
        };
        await mount(
            () =>
                new Promise<CommandResult>(resolve => {
                    release = resolve;
                }),
            undefined,
            'p',
            undefined,
            undefined,
            draft
        );
        type('Original message');
        await pressEnter();
        expect(container.querySelector('[contenteditable="false"]')).not.toBeNull();
        await act(async () => release(refused));
        expect(messageOf(doc)).toBe('Original message');
        expect(started).toEqual([]);
    });

    it('retries an attachment-only first message restored after chat creation', async () => {
        const key = '@new-chat:p:attachment';
        const draft = { key, doc: emptyComposerDoc(), change: (_doc: ComposerDoc) => {} };
        journals.set(key, { createdChat: made, firstMessage: { text: '', attachmentIds: ['a-1'], mode: 'steer' } });
        await mount(() => accepted(), undefined, 'p', undefined, undefined, draft);
        const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
        await act(async () => sendButton.click());
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ type: 'chat.send', chatId: 'c-new', text: '', attachmentIds: ['a-1'] });
        expect(started).toEqual(['c-new']);
    });

    it('keeps the same send request after an uncertain result', async () => {
        let sendCount = 0;
        let doc = emptyComposerDoc();
        const draft = {
            key: '@new-chat:p:two',
            get doc() {
                return doc;
            },
            change: (next: ComposerDoc) => {
                doc = next;
            },
        };
        await mount(
            input =>
                input.type === 'chat.create'
                    ? accepted({ chat: made })
                    : ++sendCount === 1
                      ? { ...refused, requestId: 'unsent' }
                      : accepted(),
            undefined,
            'p',
            undefined,
            undefined,
            draft
        );
        type('First');
        await pressEnter();
        const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
        await act(async () => sendButton.click());
        const sends = sent.filter(input => input.type === 'chat.send');
        expect(sends).toHaveLength(2);
        expect(sends[0]).toEqual(sends[1]);
        expect(started).toEqual(['c-new']);
    });

    it('allows the refused first message to be edited and retried in the same chat', async () => {
        let sendCount = 0;
        let doc = emptyComposerDoc();
        const draft = {
            key: '@new-chat:p:refused',
            get doc() {
                return doc;
            },
            change: (next: ComposerDoc) => {
                doc = next;
            },
        };
        await mount(
            input =>
                input.type === 'chat.create' ? accepted({ chat: made }) : ++sendCount === 1 ? refused : accepted(),
            undefined,
            'p',
            undefined,
            undefined,
            draft
        );
        type('First');
        await pressEnter();
        expect(text()).toBe('First');
        type(' revised');
        await pressEnter();
        expect(sent.filter(input => input.type === 'chat.create')).toHaveLength(1);
        const sends = sent.filter(input => input.type === 'chat.send');
        expect(sends.map(input => input.type === 'chat.send' && input.text)).toEqual(['First', 'First revised']);
        expect(started).toEqual(['c-new']);
    });

    it('restores and removes a saved attachment after a refused send', async () => {
        const key = '@new-chat:p:recovered-file';
        const file = { id: 'file-1', name: 'notes.txt', mediaType: 'text/plain', size: 5 };
        journals.set(key, { createdChat: made, attachments: [file] });
        await mount(() => accepted(), undefined, 'p', undefined, undefined, {
            key,
            doc: emptyComposerDoc(),
            change: () => {},
        });
        const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove notes.txt"]');
        expect(remove).not.toBeNull();
        await act(async () => remove!.click());
        expect(journals.get(key)?.attachments).toEqual([]);
        expect(container.querySelector('button[aria-label="Remove notes.txt"]')).toBeNull();
    });

    it('keeps the saved reply locked while an uncertain send is retried', async () => {
        const key = '@new-chat:p:pending-reply';
        const reply = { role: 'assistant' as const, text: 'Original answer' };
        const operation = {
            type: 'chat.send' as const,
            requestId: 'request-pending',
            chatId: made.id,
            text: '> Original answer\n\nContinue',
        };
        journals.set(key, { createdChat: made, reply, operation, firstMessage: { text: operation.text } });
        await mount(() => accepted(), undefined, 'p', undefined, undefined, {
            key,
            doc: emptyComposerDoc(),
            change: () => {},
        });
        expect(container.querySelector<HTMLButtonElement>('button[aria-label="Remove quote"]')?.disabled).toBe(true);
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click());
        expect(sent.find(input => input.type === 'chat.send')).toEqual(operation);
    });
});

describe('the words of the new-chat page', () => {
    it("are kept per project, as its files are: another project's page has none of them", async () => {
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

        await mount(
            () =>
                new Promise<CommandResult>(resolve => {
                    release = resolve;
                }),
            undefined,
            'p-one'
        );
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
