// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { RootStoreProvider, type RootStore } from '../../stores';
import { busyEnter } from './busyEnter';
import { Composer, type EditMode } from './Composer';
import { docOfMessage, draftOf, dropDraft, editDraftKey, messageOf, saveDraft } from './composerDrafts';
import { filesOf, setFiles, type DraftFile } from './composerFiles';
import { modelStore } from './modelTestKit';

import type { Attachment, Chat, CommandResult, QueuedMessage, Run } from '@clowdy/protocol';
import type { Editor } from '@tiptap/core';
import type { CommandInput } from '../../daemon/transport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const accepted: CommandResult = { ok: true, requestId: 'request-1', data: {} };
const sentFile = (id: string, name: string): Attachment => ({ id, name, mediaType: 'text/plain', size: 5 });
/** A file of the message being edited, as an edit session seeds it. */
const seeded = (attachment: Attachment): DraftFile => ({ key: `k-${ attachment.id }`, name: attachment.name, mediaType: attachment.mediaType, size: attachment.size, status: 'ready', attachment, sent: true });

let container: HTMLDivElement;
let root: Root;
let sent: CommandInput[];
let uploads: ReturnType<typeof vi.fn>;
let deletions: ReturnType<typeof vi.fn>;
// Drafts and files are remembered for the whole session, so each test gets a chat of its own.
let chat: Chat;
let chatNumber = 0;
let key: string;
let edit: EditMode;
let onSubmit: Mock<EditMode['onSubmit']>;
let onCancel: Mock<EditMode['onCancel']>;

async function mount(options: { editMode?: Partial<EditMode> | false; status?: Run['status']; chat?: Chat } = {}) {
    const transport = {
        uploadAttachment: uploads,
        deleteAttachment: deletions,
        getDocsTree: vi.fn(async () => []),
        getProjectFiles: vi.fn(async () => []),
        getSkills: vi.fn(async () => ({ entries: [], tokens: 0, warnings: [] })),
    };
    const command = vi.fn(async (input: CommandInput) => {
        sent.push(input);

        return accepted;
    });
    const store = { command, transport, skillsRevision: 0, selectedProject: { project: { id: 'p', folders: [{ id: 'f1', path: '/Users/dev/web' }] }, taskList: [] }, ...await modelStore() };
    const target = options.chat ?? chat;
    const run = options.status ? { id: 'r-1', status: options.status } as Run : undefined;

    await act(async () => {
        root.render(
            <RootStoreProvider value={ store as unknown as RootStore }>
                <Composer chat={ target } run={ run } editMode={ options.editMode === false ? undefined : { ...edit, ...options.editMode } } />
            </RootStoreProvider>
        );
    });
    // The editor takes the caret a moment after it mounts.
    await act(async () => {
        await new Promise(requestAnimationFrame);
    });
}

const field = () => container.querySelector<HTMLElement>('[contenteditable="true"]')!;
const editor = () => (field() as HTMLElement & { editor: Editor }).editor;
const text = () => editor().getText({ blockSeparator: '\n' });
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${ label }"]`);
const tiles = () => [...container.querySelectorAll('[data-slot="attachments"] > *')];
const placeholder = () => field().querySelector('[data-placeholder]')?.getAttribute('data-placeholder');

function type(value: string) {
    act(() => {
        editor().commands.insertContent(value);
    });
}

async function press(keyName: string, mods: { metaKey?: boolean; shiftKey?: boolean } = {}) {
    await act(async () => {
        field().dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...mods }));
    });
}

async function pick(...files: File[]) {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;

    Object.defineProperty(input, 'files', { value: files, configurable: true });
    await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
}

beforeEach(() => {
    sent = [];
    chat = { id: `c-edit-${ ++chatNumber }`, projectId: 'p', title: 'Chat', mode: 'autopilot', orchestratorRunId: 'r-1', createdAt: 0, updatedAt: 0 };
    key = editDraftKey(chat.id, 'i-1');
    onSubmit = vi.fn();
    onCancel = vi.fn();
    edit = { draftKey: key, onSubmit, onCancel, isPending: false };
    uploads = vi.fn(async (_projectId: string, file: File) => sentFile(`a-${ file.name }`, file.name));
    deletions = vi.fn(async () => undefined);
    saveDraft(key, docOfMessage('Make the title bigger'));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    dropDraft(key);
    dropDraft(chat.id);
    setFiles(key, []);
    setFiles(chat.id, []);
    busyEnter.setMode('steer');
});

describe('the message box in edit mode', () => {
    describe('its own session', () => {
        it('starts from the words of the session, not from the chat\'s draft', async () => {
            saveDraft(chat.id, docOfMessage('what I was typing below'));
            await mount();

            expect(text()).toBe('Make the title bigger');
        });

        it('keeps what is typed in the session out of the chat\'s draft, and the other way round', async () => {
            saveDraft(chat.id, docOfMessage('what I was typing below'));
            await mount();
            type(' and blue');

            expect(messageOf(draftOf(key))).toBe('Make the title bigger and blue');
            expect(messageOf(draftOf(chat.id))).toBe('what I was typing below');

            // The box at the bottom, on the same chat, is a box of its own.
            await mount({ editMode: false });

            expect(text()).toBe('what I was typing below');

            type('!');

            expect(messageOf(draftOf(chat.id))).toBe('what I was typing below!');
            expect(messageOf(draftOf(key))).toBe('Make the title bigger and blue');
        });

        it('keeps the files of the session apart from the files of the chat\'s draft', async () => {
            setFiles(chat.id, [seeded(sentFile('a-draft', 'draft.txt'))]);
            setFiles(key, [seeded(sentFile('a-sent', 'form.txt'))]);
            await mount();

            expect(tiles()).toHaveLength(1);
            expect(container.textContent).toContain('form.txt');
            expect(container.textContent).not.toContain('draft.txt');

            await pick(new File(['a'], 'new.txt', { type: 'text/plain' }));

            expect(filesOf(key).map(file => file.name)).toEqual(['form.txt', 'new.txt']);
            expect(filesOf(chat.id).map(file => file.name)).toEqual(['draft.txt']);
        });
    });

    describe('what it leaves out', () => {
        const queue: QueuedMessage[] = [{ id: 'q-1', mode: 'queue', text: 'Then the footer', content: 'Then the footer', createdAt: 0 }];

        it('has no queue, which belongs to the box at the bottom', async () => {
            const waiting = { ...chat, queue };

            await mount({ chat: waiting, editMode: false });

            expect(container.textContent).toContain('Then the footer');

            await mount({ chat: waiting });

            expect(container.textContent).not.toContain('Then the footer');
        });

        it('has no mode, model or context of its own: the message goes on the chat as it is', async () => {
            await mount({ editMode: false });

            expect(container.textContent).toContain('Hands-off');

            await mount();

            expect(container.textContent).not.toContain('Hands-off');
            expect([...container.querySelectorAll('button')].map(node => node.getAttribute('aria-label')).filter(Boolean).sort()).toEqual(['Attach files', 'Submit edit']);
        });
    });

    describe('the field', () => {
        it('has a placeholder of its own', async () => {
            saveDraft(key, docOfMessage(''));
            await mount();

            expect(placeholder()).toBe('Edit message');
            expect(field().getAttribute('aria-label')).toBe('Edit message');
        });

        it('takes the focus when it opens, with the caret at the end of the words', async () => {
            await mount();

            expect(document.activeElement).toBe(field());

            const { selection } = editor().state;

            expect(selection.empty).toBe(true);
            expect(selection.$from.parentOffset).toBe('Make the title bigger'.length);
            expect(selection.$from.parent.textContent).toBe('Make the title bigger');
        });

        it('takes the focus even in a chat whose agent has started, where the box at the bottom does not', async () => {
            // The chat has an orchestrator, which is where the box at the bottom leaves the focus alone.
            expect(chat.orchestratorRunId).toBeDefined();

            await mount();

            expect(document.activeElement).toBe(field());
        });
    });

    describe('Enter', () => {
        it('gives the words and the ids of the uploaded files to the page, and sends nothing itself', async () => {
            setFiles(key, [seeded(sentFile('a-1', 'form.txt')), seeded(sentFile('a-2', 'notes.txt'))]);
            await mount();
            type(' now');
            await press('Enter');

            expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ text: 'Make the title bigger now', attachmentIds: ['a-1', 'a-2'] });
            expect(sent).toEqual([]);
        });

        it('submits on Cmd+Enter the same way: there is no steering or queueing in an edit', async () => {
            await mount();
            await press('Enter', { metaKey: true });

            expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ text: 'Make the title bigger', attachmentIds: [] });
            expect(sent).toEqual([]);
        });

        it('waits for a busy agent whatever Settings > Chat says: the chat is rewritten only at rest, so nothing is sent, queued or steered', async () => {
            busyEnter.setMode('queue');
            await mount({ status: 'running' });
            await press('Enter');
            await press('Enter', { metaKey: true });
            await act(async () => button('Submit edit')!.click());

            expect(onSubmit).not.toHaveBeenCalled();
            expect(sent).toEqual([]);
            // The send button is not a Stop while the agent works, and it stays off with the reason on the stand-in that takes its place.
            expect(button('Stop')).toBeNull();
            expect(button('Submit edit')?.disabled).toBe(true);
            expect(container.querySelector('[role="button"][aria-disabled][aria-label="Submit edit"]')).not.toBeNull();

            await act(async () => {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
                container.querySelector<HTMLElement>('[role="button"][aria-disabled][aria-label="Submit edit"]')!.focus();
            });
            await act(async () => new Promise(resolve => setTimeout(resolve, 0)));

            expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Stop the agent to edit');
        });

        it('goes through once the agent that was working has stopped, with the words as they were', async () => {
            await mount({ status: 'running' });
            type(' now');
            await press('Enter');

            expect(onSubmit).not.toHaveBeenCalled();

            await mount({ status: 'succeeded' });

            expect(button('Submit edit')?.disabled).toBe(false);
            expect(container.querySelector('[role="button"][aria-disabled][aria-label="Submit edit"]')).toBeNull();

            await press('Enter');

            expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ text: 'Make the title bigger now', attachmentIds: [] });
        });

        it('starts a new line on Shift+Enter, as a message does', async () => {
            await mount();
            await press('Enter', { shiftKey: true });

            expect(onSubmit).not.toHaveBeenCalled();
        });

        it('submits from the send button', async () => {
            await mount();
            await act(async () => button('Submit edit')!.click());

            expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ text: 'Make the title bigger', attachmentIds: [] });
        });

        it('leaves the words and the files where they are, so an edit that is refused finds them in the box', async () => {
            setFiles(key, [seeded(sentFile('a-1', 'form.txt'))]);
            await mount();
            await press('Enter');

            expect(text()).toBe('Make the title bigger');
            expect(messageOf(draftOf(key))).toBe('Make the title bigger');
            expect(tiles()).toHaveLength(1);
            expect(filesOf(key)).toHaveLength(1);
        });

        it('sends a message of files alone, once its words were taken out', async () => {
            setFiles(key, [seeded(sentFile('a-1', 'form.txt'))]);
            saveDraft(key, docOfMessage(''));
            await mount();
            await press('Enter');

            expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ text: '', attachmentIds: ['a-1'] });
        });
    });

    describe('an empty message', () => {
        it('cannot be sent: Enter does nothing and the send button is off', async () => {
            saveDraft(key, docOfMessage('   '));
            await mount();

            expect(button('Submit edit')?.disabled).toBe(true);

            await press('Enter');

            expect(onSubmit).not.toHaveBeenCalled();
        });
    });

    describe('while a file is going up', () => {
        it('holds the message back until the upload is done, as a message is', async () => {
            let finish!: (attachment: Attachment) => void;

            uploads.mockImplementation(() => new Promise<Attachment>((resolve) => {
                finish = resolve;
            }));
            await mount();
            await pick(new File(['a'], 'new.txt', { type: 'text/plain' }));
            await press('Enter');

            expect(onSubmit).not.toHaveBeenCalled();
            expect(button('Submit edit')?.disabled).toBe(true);

            await act(async () => finish(sentFile('a-new', 'new.txt')));
            await press('Enter');

            expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ text: 'Make the title bigger', attachmentIds: ['a-new'] });
        });

        it('holds it back for a file that did not go up too', async () => {
            uploads.mockRejectedValue(new Error('The daemon cannot be reached'));
            await mount();
            await pick(new File(['a'], 'new.txt', { type: 'text/plain' }));
            await press('Enter');

            expect(onSubmit).not.toHaveBeenCalled();
        });
    });

    describe('while the edit is on its way', () => {
        it('spins on the send button and takes no second submit', async () => {
            await mount({ editMode: { isPending: true } });

            expect(button('Submit edit')?.hasAttribute('data-pending')).toBe(true);

            await press('Enter');
            await act(async () => button('Submit edit')!.click());

            expect(onSubmit).not.toHaveBeenCalled();
        });
    });

    describe('Escape', () => {
        it('stops editing, with nothing sent', async () => {
            await mount();
            await press('Escape');

            expect(onCancel).toHaveBeenCalledOnce();
            expect(onSubmit).not.toHaveBeenCalled();
            expect(sent).toEqual([]);
        });

        it('means nothing to the box of the chat, which has nothing to stop', async () => {
            await mount({ editMode: false });
            await press('Escape');

            expect(onCancel).not.toHaveBeenCalled();
        });
    });

    describe('the files of the message that was sent', () => {
        it('are not deleted from the daemon when one is taken off, since the message still has them until an edit goes through', async () => {
            setFiles(key, [seeded(sentFile('a-1', 'form.txt')), seeded(sentFile('a-2', 'notes.txt'))]);
            await mount();

            const remove = container.querySelectorAll<HTMLButtonElement>('[data-slot="attachments"] button');

            expect(remove.length).toBeGreaterThan(0);

            await act(async () => remove[0].click());

            expect(deletions).not.toHaveBeenCalled();
            expect(filesOf(key).map(file => file.attachment?.id)).toEqual(['a-2']);

            await press('Enter');

            expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ text: 'Make the title bigger', attachmentIds: ['a-2'] });
        });

        it('are told from the ones the editor uploaded, which are deleted when taken off: nobody will send them', async () => {
            setFiles(key, [seeded(sentFile('a-1', 'form.txt'))]);
            await mount();
            await pick(new File(['a'], 'new.txt', { type: 'text/plain' }));

            expect(filesOf(key)).toHaveLength(2);

            const removeNew = [...container.querySelectorAll<HTMLButtonElement>('[data-slot="attachments"] button')].at(-1)!;

            await act(async () => removeNew.click());

            expect(deletions).toHaveBeenCalledExactlyOnceWith('p', 'a-new.txt');
            expect(filesOf(key).map(file => file.attachment?.id)).toEqual(['a-1']);
        });
    });
});
