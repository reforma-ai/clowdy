// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RootStore, RootStoreProvider } from '../../stores';
import { Composer } from './Composer';
import { filesOf } from './composerFiles';
import { modelStore } from './modelTestKit';

import type { Chat, CommandResult, QueuedMessage, Run } from '@clowdy/protocol';
import type { Editor } from '@tiptap/core';
import type { CommandInput } from '../../daemon/transport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const accepted: CommandResult = { ok: true, requestId: 'request-1', data: {} };
const queued = (id: string, text: string, fields: Partial<QueuedMessage> = {}): QueuedMessage => ({
    id,
    mode: 'queue',
    text,
    content: text,
    createdAt: 0,
    ...fields,
});
const notes = { id: 'a-notes', name: 'notes.txt', mediaType: 'text/plain', size: 5 };
const transport = {
    getDocsTree: vi.fn(async () => []),
    getProjectFiles: vi.fn(async () => []),
    getSkills: vi.fn(async () => ({ entries: [], tokens: 0, warnings: [] })),
};

let container: HTMLDivElement;
let root: Root;
let sent: CommandInput[];
let chatNumber = 0;

async function mount(chat: Chat, status: Run['status'] = 'running') {
    const command = vi.fn(async (input: CommandInput) => {
        sent.push(input);

        return accepted;
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
                <Composer chat={chat} run={{ id: 'r-1', status } as Run} />
            </RootStoreProvider>
        );
    });
}

function chatWith(queue: QueuedMessage[], fields: Partial<Chat> = {}): Chat {
    return {
        id: `c-queue-${++chatNumber}`,
        projectId: 'p',
        title: 'Chat',
        mode: 'autopilot',
        orchestratorRunId: 'r-1',
        queue,
        createdAt: 0,
        updatedAt: 0,
        ...fields,
    };
}

const previews = () => container.querySelectorAll<HTMLElement>('[aria-label^="Edit: "]');
/** The row of a message: the preview is pressed to edit, and the row holds it with the status and the actions. */
const rowOf = (label: string) => container.querySelector<HTMLElement>(`[aria-label="Edit: ${label}"]`)!.parentElement!;
const buttonIn = (scope: HTMLElement, name: string) =>
    [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
        button => button.getAttribute('aria-label') === name || button.textContent === name
    );
const fieldText = () =>
    (
        container.querySelector<HTMLElement>('[contenteditable="true"]') as HTMLElement & { editor: Editor }
    ).editor.getText();

beforeEach(() => {
    sent = [];
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('the queue in the composer', () => {
    it('shows each waiting message with its files, and a steer as steering without Send now', async () => {
        await mount(
            chatWith([
                queued('q-1', 'Use the blue one', { mode: 'steer' }),
                queued('q-2', 'Then the footer', { attachments: [notes] }),
                queued('q-3', '', { attachments: [notes, { ...notes, id: 'a-2' }] }),
            ])
        );

        expect(container.querySelector('[aria-label="Queued messages"]')).not.toBeNull();
        expect(previews()).toHaveLength(3);
        expect(rowOf('Use the blue one').textContent).toContain('Steering…');
        expect(buttonIn(rowOf('Use the blue one'), 'Send now')).toBeUndefined();
        expect(rowOf('Then the footer').textContent).toContain('1 file');
        expect(buttonIn(rowOf('Then the footer'), 'Send now')).toBeDefined();
        // A message of files alone is named by them.
        expect(rowOf('2 files')).toBeDefined();
        expect(rowOf('Use the blue one').hasAttribute('data-first')).toBe(true);
        expect(rowOf('Then the footer').hasAttribute('data-first')).toBe(false);
    });

    it('draws nothing when nothing waits', async () => {
        await mount(chatWith([]));

        expect(container.querySelector('[aria-label="Queued messages"]')).toBeNull();
    });

    it('says why a paused queue holds and how to resume it', async () => {
        await mount(chatWith([queued('q-1', 'Later')], { queuePaused: 'stopped' }), 'cancelled');

        expect(container.querySelector('[role="status"]')?.textContent).toBe(
            'Queue paused after Stop. Use Send now on a message to resume.'
        );

        await mount(chatWith([queued('q-1', 'Later')], { queuePaused: 'failed' }), 'failed');

        expect(container.querySelector('[role="status"]')?.textContent).toBe(
            'Queue paused: the reply failed. Use Send now on a message to resume.'
        );
    });

    it('sends a message now, and removes one with its files', async () => {
        const chat = chatWith([queued('q-1', 'First'), queued('q-2', 'Second')]);

        await mount(chat);
        await act(async () => buttonIn(rowOf('Second'), 'Send now')!.click());
        await act(async () => buttonIn(rowOf('First'), 'Remove')!.click());

        expect(sent).toEqual([
            { type: 'chat.sendQueued', chatId: chat.id, itemId: 'q-2' },
            { type: 'chat.removeQueued', chatId: chat.id, itemId: 'q-1' },
        ]);
    });

    it('takes a message out to edit it: its words go back into the box and its files with them, uploaded already', async () => {
        const chat = chatWith([queued('q-1', 'Then the footer', { attachments: [notes] })]);

        await mount(chat);
        await act(async () => buttonIn(rowOf('Then the footer'), 'Edit')!.click());

        expect(sent).toEqual([{ type: 'chat.removeQueued', chatId: chat.id, itemId: 'q-1', keepFiles: true }]);
        expect(fieldText()).toBe('Then the footer');
        expect(filesOf(chat.id)).toEqual([
            expect.objectContaining({ name: 'notes.txt', status: 'ready', attachment: notes }),
        ]);
    });

    it('puts the words of an edited message in front of what is typed', async () => {
        const chat = chatWith([queued('q-1', 'Queued words')]);

        await mount(chat);
        act(() => {
            (
                container.querySelector<HTMLElement>('[contenteditable="true"]') as HTMLElement & { editor: Editor }
            ).editor.commands.insertContent('typed since');
        });
        await act(async () => container.querySelector<HTMLElement>('[aria-label="Edit: Queued words"]')!.click());

        expect(fieldText()).toBe('Queued words\n\ntyped since');
    });

    describe('a compact item', () => {
        const compact = queued('q-c', 'Compact the conversation', { command: 'compact', content: '/compact' });
        const compactRow = () =>
            [...container.querySelectorAll<HTMLElement>('[data-first], [class*="item"]')].find(row =>
                row.textContent?.startsWith('Compact the conversation')
            )!;
        const sendNow = () => buttonIn(compactRow(), 'Send now')!;

        it('reads "Compact the conversation", with nothing to edit, and can be removed', async () => {
            const chat = chatWith([compact, queued('q-1', 'Then this')]);

            await mount(chat);

            expect(compactRow()).toBeDefined();
            expect(container.querySelector('[aria-label="Edit: Compact the conversation"]')).toBeNull();
            expect(buttonIn(compactRow(), 'Edit')).toBeUndefined();
            expect(compactRow().textContent).not.toContain('Steering…');

            await act(async () => buttonIn(compactRow(), 'Remove')!.click());

            expect(sent).toEqual([{ type: 'chat.removeQueued', chatId: chat.id, itemId: 'q-c' }]);
        });

        /** The hint of the stand-in of a Send now that is off, as its tooltip shows it on focus. */
        async function sendNowHint() {
            await act(async () => {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
                compactRow().querySelector<HTMLElement>('[role="button"][aria-disabled]')!.focus();
            });
            await act(async () => new Promise(resolve => setTimeout(resolve, 0)));

            return document.querySelector('[role="tooltip"]')?.textContent;
        }

        it('cannot be sent now while the orchestrator works, and says when it runs', async () => {
            await mount(chatWith([compact]), 'running');

            expect(sendNow().disabled).toBe(true);
            expect(compactRow().querySelector('[role="button"][aria-disabled]')?.getAttribute('aria-label')).toBe(
                'Send now'
            );
            expect(await sendNowHint()).toBe('Runs when the agent finishes');

            await act(async () => sendNow().click());

            expect(sent).toEqual([]);
        });

        it('in a held queue, says it is sent by hand once the orchestrator has finished', async () => {
            await mount(chatWith([compact], { queuePaused: 'stopped' }), 'running');

            expect(sendNow().disabled).toBe(true);
            expect(await sendNowHint()).toBe('Send it once the agent finishes');
        });

        it('is sent now from a held queue once the orchestrator has finished', async () => {
            const chat = chatWith([compact], { queuePaused: 'stopped' });

            await mount(chat, 'cancelled');

            expect(sendNow().disabled).toBe(false);

            await act(async () => sendNow().click());

            expect(sent).toEqual([{ type: 'chat.sendQueued', chatId: chat.id, itemId: 'q-c' }]);
        });
    });

    describe('an item a thread sent', () => {
        const notice = queued('q-n', 'Thread "Fix login" finished', {
            from: {
                kind: 'threadNotice',
                threads: [{ chatId: 'c-t', title: 'Fix login', outcome: 'finished', text: 'Done' }],
            },
            // A daemon never puts files on one; the row would not show them anyway.
            attachments: [notes],
        });
        const noticeRow = () => container.querySelector<HTMLElement>('[data-thread]')!;

        it('reads its summary after the thread mark, has nothing to edit and never shows files', async () => {
            await mount(chatWith([notice, queued('q-1', 'Then this')]));

            expect(noticeRow().textContent).toContain('Thread "Fix login" finished');
            expect(noticeRow().querySelector('svg')).not.toBeNull();
            expect(noticeRow().textContent).not.toContain('1 file');
            expect(container.querySelector('[aria-label^="Edit: Thread"]')).toBeNull();
            expect(buttonIn(noticeRow(), 'Edit')).toBeUndefined();
            // The person's own message beside it keeps its Edit.
            expect(buttonIn(rowOf('Then this'), 'Edit')).toBeDefined();
        });

        it('is sent now or removed like any queued message', async () => {
            const chat = chatWith([notice]);

            await mount(chat);
            await act(async () => buttonIn(noticeRow(), 'Send now')!.click());
            await act(async () => buttonIn(noticeRow(), 'Remove')!.click());

            expect(sent).toEqual([
                { type: 'chat.sendQueued', chatId: chat.id, itemId: 'q-n' },
                { type: 'chat.removeQueued', chatId: chat.id, itemId: 'q-n' },
            ]);
        });

        it("draws a thread's message the same way, by its words and the title of the thread that wrote them", async () => {
            await mount(
                chatWith([
                    queued('q-m', 'Use the staging keys', {
                        from: { kind: 'thread', chatId: 'c-t', title: 'Fix login' },
                    }),
                ])
            );

            expect(noticeRow().textContent).toContain('Fix login: Use the staging keys');
            expect(buttonIn(noticeRow(), 'Edit')).toBeUndefined();
        });
    });
});
