// @vitest-environment happy-dom
import { MAX_ATTACHMENT_BYTES } from '@clowdy/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RootStoreProvider, type RootStore } from '../../stores';
import { Composer } from './Composer';
import { filesOf, setFiles } from './composerFiles';
import { modelStore } from './modelTestKit';

import type { Attachment, Chat, CommandResult } from '@clowdy/protocol';
import type { Editor } from '@tiptap/core';
import type { CommandInput } from '../../daemon/transport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const accepted: CommandResult = { ok: true, requestId: 'request-1', data: {} };
const refused: CommandResult = { ok: false, requestId: 'request-1', error: { code: 'unavailable', message: 'The daemon cannot be reached' } };

let container: HTMLDivElement;
let root: Root;
let sent: CommandInput[];
// Drafts are remembered per chat for the whole session, so each test gets a chat of its own.
let chat: Chat;
let chatNumber = 0;
let uploads: ReturnType<typeof vi.fn>;
let deletions: ReturnType<typeof vi.fn>;

const sentFile = (file: File, id: string): Attachment => ({ id, name: file.name, mediaType: file.type, size: file.size });

async function mount(result: CommandResult = accepted, page: 'chat' | { projectId: string } = 'chat') {
    const transport = {
        uploadAttachment: uploads,
        deleteAttachment: deletions,
        getDocsTree: vi.fn(async () => []),
        getProjectFiles: vi.fn(async () => []),
        getSkills: vi.fn(async () => ({ entries: [], tokens: 0, warnings: [] })),
    };
    const command = vi.fn(async (input: CommandInput) => {
        sent.push(input);

        return result;
    });
    const store = { command, transport, skillsRevision: 0, selectedProject: { project: { id: 'p', folders: [{ id: 'f1', path: '/Users/dev/web' }] }, taskList: [] }, ...await modelStore() };

    await act(async () => {
        root.render(
            <RootStoreProvider value={ store as unknown as RootStore }>
                { page === 'chat'
                    ? <Composer chat={ chat } run={ undefined } />
                    : <Composer chat={ undefined } run={ undefined } start={ { projectId: page.projectId, onStarted: () => undefined } } /> }
            </RootStoreProvider>
        );
    });
}

const field = () => container.querySelector<HTMLElement>('[contenteditable="true"]')!;
const editor = () => (field() as HTMLElement & { editor: Editor }).editor;
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${ label }"]`);
const tiles = () => [...container.querySelectorAll('[data-slot="attachments"] > *')];

async function pick(...files: File[]) {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;

    Object.defineProperty(input, 'files', { value: files, configurable: true });
    await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
}

beforeEach(() => {
    sent = [];
    chat = { id: `c-files-${ ++chatNumber }`, projectId: 'p', title: 'New chat', mode: 'autopilot', createdAt: 0, updatedAt: 0 };
    uploads = vi.fn(async (_projectId: string, file: File) => sentFile(file, `a-${ file.name }`));
    deletions = vi.fn(async () => undefined);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setFiles(chat.id, []);
});

describe('Composer files', () => {
    it('uploads what is picked at once and shows a tile for each', async () => {
        await mount();
        await pick(new File(['a'], 'a.txt', { type: 'text/plain' }), new File(['bb'], 'b.log', { type: 'text/plain' }));

        expect(uploads).toHaveBeenCalledTimes(2);
        expect(uploads.mock.calls.map(call => (call[1] as File).name)).toEqual(['a.txt', 'b.log']);
        expect(tiles()).toHaveLength(2);
        expect(filesOf(chat.id).map(file => file.status)).toEqual(['ready', 'ready']);
    });

    it('sends the files with no text, and empties the box', async () => {
        await mount();

        expect(button('Send')!.disabled).toBe(true);

        await pick(new File(['a'], 'a.txt', { type: 'text/plain' }));

        expect(button('Send')!.disabled).toBe(false);

        await act(async () => button('Send')!.click());

        expect(sent).toEqual([{ type: 'chat.send', chatId: chat.id, text: '', attachmentIds: ['a-a.txt'], mode: 'steer' }]);
        expect(tiles()).toHaveLength(0);
    });

    it('sends the files with the text', async () => {
        await mount();
        await pick(new File(['a'], 'a.txt', { type: 'text/plain' }));
        act(() => {
            editor().commands.insertContent('Look at this');
        });
        await act(async () => button('Send')!.click());

        expect(sent).toEqual([{ type: 'chat.send', chatId: chat.id, text: 'Look at this', attachmentIds: ['a-a.txt'], mode: 'steer' }]);
    });

    it('holds the message back while a file is going up, and says why', async () => {
        let finish: (attachment: Attachment) => void = () => undefined;
        const file = new File(['a'], 'slow.txt', { type: 'text/plain' });

        uploads.mockImplementationOnce(() => new Promise<Attachment>(resolve => {
            finish = resolve;
        }));
        await mount();
        await pick(file);

        expect(button('Send')!.disabled).toBe(true);
        expect(filesOf(chat.id)[0]?.status).toBe('uploading');
        // A disabled button takes no pointer, so the reason sits on a stand-in that does (and that the keyboard reaches).
        expect(container.querySelector('[role="button"][aria-label="Send"]')).not.toBeNull();

        await act(async () => finish(sentFile(file, 'a-slow')));

        expect(button('Send')!.disabled).toBe(false);
        expect(container.querySelector('[role="button"][aria-label="Send"]')).toBeNull();
    });

    it('keeps a file that did not upload as a tile to retry or remove, and holds the message until then', async () => {
        const file = new File(['a'], 'bad.txt', { type: 'text/plain' });

        uploads.mockRejectedValueOnce(new Error('The file is over the limit'));
        await mount();
        await pick(file);

        expect(filesOf(chat.id)[0]).toMatchObject({ status: 'error', error: 'The file is over the limit' });
        expect(button('Send')!.disabled).toBe(true);

        await act(async () => button('Retry bad.txt')?.click());

        expect(uploads).toHaveBeenCalledTimes(2);
        expect(filesOf(chat.id)[0]?.status).toBe('ready');
        expect(button('Send')!.disabled).toBe(false);
    });

    it('takes a tile off, and tells the daemon to drop a file it holds', async () => {
        await mount();
        await pick(new File(['a'], 'a.txt', { type: 'text/plain' }));
        await act(async () => button('Remove a.txt')!.click());

        expect(tiles()).toHaveLength(0);
        expect(deletions).toHaveBeenCalledWith('p', 'a-a.txt');
    });

    it('does not take a file over the limit, nor the same file twice', async () => {
        const big = new File(['x'], 'big.bin');

        Object.defineProperty(big, 'size', { value: MAX_ATTACHMENT_BYTES + 1 });
        await mount();
        await pick(big, new File(['a'], 'a.txt'));
        await pick(new File(['a'], 'a.txt'));

        expect(uploads).toHaveBeenCalledTimes(1);
        expect(tiles()).toHaveLength(1);
    });

    it('gives the files back when the daemon refuses the message', async () => {
        await mount(refused);
        await pick(new File(['a'], 'a.txt', { type: 'text/plain' }));
        await act(async () => button('Send')!.click());

        expect(sent).toHaveLength(1);
        expect(filesOf(chat.id).map(file => file.name)).toEqual(['a.txt']);
        expect(tiles()).toHaveLength(1);
    });

    it('takes a file pasted into the message box before the text that came with it', async () => {
        await mount();

        const file = new File(['a'], 'copied.png', { type: 'image/png' });
        const paste = new Event('paste', { bubbles: true, cancelable: true });

        // What Finder puts on the clipboard for a copied file: the file, and its name as text.
        Object.defineProperty(paste, 'clipboardData', { value: { files: [file], items: [], types: ['Files', 'text/plain'], getData: (type: string) => (type === 'text/plain' ? 'copied.png' : '') } });
        await act(async () => void field().dispatchEvent(paste));

        expect(paste.defaultPrevented).toBe(true);
        expect(uploads).toHaveBeenCalledTimes(1);
        expect(tiles()).toHaveLength(1);
        expect(editor().getText()).toBe('');
    });

    it('cites a file pasted from the project\'s folder by its path, and attaches one from anywhere else', async () => {
        await mount();

        window.desktop = {
            platform: 'darwin',
            readClipboardFiles: async () => [
                { path: '/Users/dev/web/src/a.ts', name: 'a.ts', kind: 'file' },
                { path: '/Users/dev/Downloads/report.pdf', name: 'report.pdf', kind: 'file' },
            ],
        } as unknown as typeof window.desktop;

        try {
            const paste = new Event('paste', { bubbles: true, cancelable: true });

            Object.defineProperty(paste, 'clipboardData', { value: { files: [new File(['a'], 'a.ts'), new File(['r'], 'report.pdf')], items: [], types: ['Files'], getData: () => '' } });
            await act(async () => void field().dispatchEvent(paste));

            const chips = (editor().getJSON().content ?? []).flatMap(block => block.content ?? []).filter(node => node.type === 'composerMention');

            expect(chips.map(chip => chip.attrs?.data)).toEqual([{ path: 'src/a.ts' }]);
            expect(uploads.mock.calls.map(call => (call[1] as File).name)).toEqual(['report.pdf']);
            expect(tiles()).toHaveLength(1);
        }
        finally {
            delete window.desktop;
        }
    });

    it('keeps the files of the new-chat page per project, because a file belongs to the project it was uploaded to', async () => {
        await mount(accepted, { projectId: 'p-one' });
        await pick(new File(['a'], 'one.txt', { type: 'text/plain' }));

        expect(tiles()).toHaveLength(1);

        await mount(accepted, { projectId: 'p-two' });

        expect(tiles()).toHaveLength(0);

        await pick(new File(['b'], 'two.txt', { type: 'text/plain' }));

        expect(uploads.mock.calls.map(call => [call[0], (call[1] as File).name])).toEqual([['p-one', 'one.txt'], ['p-two', 'two.txt']]);

        await mount(accepted, { projectId: 'p-one' });

        expect(tiles()).toHaveLength(1);
        expect(filesOf('@new-chat:p-one').map(file => file.name)).toEqual(['one.txt']);
        setFiles('@new-chat:p-one', []);
        setFiles('@new-chat:p-two', []);
    });

    it('keeps the files of a chat for when it is shown again', async () => {
        await mount();
        await pick(new File(['a'], 'a.txt', { type: 'text/plain' }));
        act(() => root.unmount());
        root = createRoot(container);
        await mount();

        expect(tiles()).toHaveLength(1);
    });
});
