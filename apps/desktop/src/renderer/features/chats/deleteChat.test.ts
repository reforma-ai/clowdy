// @vitest-environment happy-dom
import { openConfirmModal } from '@clowdy/components/modals';
import { createElement, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_WORKSPACE_CHAT_ID, withFixtureWorkspace } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { TransportError } from '../../daemon/transport';
import { RootStore } from '../../stores';
import { deleteChat, deleteMessage } from './deleteChat';

import type { Chat, ChatWorkspaceRemoval } from '@clowdy/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// `Modal` cannot load under the desktop's Vitest (decorators); the dialog is what `openConfirmModal` was given, drawn here by hand.
vi.mock('@clowdy/components/modals', () => ({ openConfirmModal: vi.fn() }));
// A refusal is a toast, which has no host here.
vi.mock('@clowdy/components/Toast', () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

describe('deleteMessage', () => {
    it('names the chat and the runs of its agents when it has no threads', () => {
        expect(deleteMessage({ title: 'Fix login' }, 0)).toBe('"Fix login" and the runs of its agents are deleted for good. The tasks it made stay.');
    });

    it('says how many threads go with the chat', () => {
        expect(deleteMessage({ title: 'Ship it' }, 1)).toBe('"Ship it", its thread and the runs of their agents are deleted for good. The tasks they made stay.');
        expect(deleteMessage({ title: 'Ship it' }, 5)).toBe('"Ship it", its 5 threads and the runs of their agents are deleted for good. The tasks they made stay.');
    });
});

const LABEL = 'Also remove the worktree and its branch';

let container: HTMLDivElement;
let view: Root;
let transport: FixtureTransport;
let store: RootStore;
let workspaceChat: Chat;

/** The daemon takes every delete: the commands are only watched, so the chat is still there for the next press. */
const deletes = () => vi.spyOn(store, 'command').mockResolvedValue({ ok: true, requestId: 'r', data: { chatId: workspaceChat.id } });
const opened = () => vi.mocked(openConfirmModal).mock.calls.at(-1)![0];
const checkbox = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]');
const settle = () => act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
});
/** Draws what the confirmation holds, as the dialog would, and waits for the answer of the read. */
async function show(message: ReactNode) {
    await act(async () => view.render(message));
    await settle();
}
/** Presses Delete: what the dialog's button does. */
const confirm = () => opened().onConfirm();

beforeEach(async () => {
    vi.mocked(openConfirmModal).mockClear();

    const data = withFixtureWorkspace(createFixtureData());

    transport = new FixtureTransport({ data });
    store = new RootStore(transport);
    await store.load();
    workspaceChat = data.chats.find(chat => chat.id === FIXTURE_WORKSPACE_CHAT_ID)!;
    container = document.createElement('div');
    document.body.append(container);
    view = createRoot(container);
});

afterEach(async () => {
    await act(async () => view.unmount());
    container.remove();
    store.dispose();
    vi.restoreAllMocks();
});

describe('deleteChat', () => {
    it('deletes a chat that never ran at once, with no dialog and no question about a worktree', async () => {
        const command = vi.spyOn(store, 'command');
        const read = vi.spyOn(transport, 'getChatWorkspaceRemoval');

        deleteChat(store, workspaceChat, false, 0);
        await vi.waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'chat.delete', chatId: workspaceChat.id }));
        expect(openConfirmModal).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
    });

    it('offers to remove the worktree and its branch when the daemon says it can go, off until it is ticked', async () => {
        const command = deletes();

        deleteChat(store, workspaceChat, true, 0);
        expect(opened()).toMatchObject({ title: 'Delete chat?', confirmLabel: 'Delete', destructive: true });
        await show(opened().message);

        expect(container.textContent).toContain(deleteMessage(workspaceChat, 0));
        expect(container.textContent).toContain(LABEL);
        expect(checkbox()!.checked).toBe(false);

        // Left alone, the chat goes and the worktree stays.
        await confirm();
        expect(command).toHaveBeenLastCalledWith({ type: 'chat.delete', chatId: workspaceChat.id });
    });

    it('sends the choice with the delete once the box is ticked, and not after it is ticked off again', async () => {
        const command = deletes();

        deleteChat(store, workspaceChat, true, 0);
        await show(opened().message);

        await act(async () => checkbox()!.click());
        expect(checkbox()!.checked).toBe(true);
        await confirm();
        expect(command).toHaveBeenLastCalledWith({ type: 'chat.delete', chatId: workspaceChat.id, removeWorkspace: true });

        await act(async () => checkbox()!.click());
        expect(checkbox()!.checked).toBe(false);
        await confirm();
        expect(command).toHaveBeenLastCalledWith({ type: 'chat.delete', chatId: workspaceChat.id });
    });

    it('has no checkbox when the daemon says the worktree cannot be removed', async () => {
        const answer: ChatWorkspaceRemoval = { removable: false, path: workspaceChat.workspace!.path, branch: workspaceChat.workspace!.branch };

        vi.spyOn(transport, 'getChatWorkspaceRemoval').mockResolvedValue(answer);
        deleteChat(store, workspaceChat, true, 0);
        await show(opened().message);

        expect(container.textContent).toContain(deleteMessage(workspaceChat, 0));
        expect(checkbox()).toBeNull();
    });

    it('has no checkbox when the read fails, and the chat is deleted as before', async () => {
        const command = deletes();

        vi.spyOn(transport, 'getChatWorkspaceRemoval').mockRejectedValue(new TransportError('git did not answer', 503));
        deleteChat(store, workspaceChat, true, 0);
        await show(opened().message);

        expect(checkbox()).toBeNull();
        await confirm();
        expect(command).toHaveBeenLastCalledWith({ type: 'chat.delete', chatId: workspaceChat.id });
    });

    it('asks nothing about a chat with no worktree, or a worktree Clowdy did not make', async () => {
        const read = vi.spyOn(transport, 'getChatWorkspaceRemoval');
        const plain = store.selectedProject!.chats.get('c-4')!;

        deleteChat(store, plain, true, 0);
        await show(opened().message);
        expect(plain.workspace).toBeUndefined();

        const found: Chat = { ...workspaceChat, workspace: { ...workspaceChat.workspace!, managed: false } };

        deleteChat(store, found, true, 0);
        await show(opened().message);

        expect(read).not.toHaveBeenCalled();
        expect(checkbox()).toBeNull();
    });

    it('keeps the dialog open with the daemon\'s reason when it refuses the delete, so the box can be unticked', async () => {
        vi.spyOn(store, 'command').mockResolvedValue({ ok: false, requestId: 'r', error: { code: 'conflict', message: 'The worktree has changes that are not committed' } });
        deleteChat(store, workspaceChat, true, 0);
        await show(opened().message);
        await act(async () => checkbox()!.click());

        await expect(confirm()).rejects.toThrow('The worktree has changes that are not committed');
        expect(checkbox()!.checked).toBe(true);
    });

    it('does not offer the box once the dialog is gone before the read answers', async () => {
        let answer!: (value: ChatWorkspaceRemoval) => void;

        vi.spyOn(transport, 'getChatWorkspaceRemoval').mockReturnValue(new Promise(resolve => (answer = resolve)));
        deleteChat(store, workspaceChat, true, 0);
        await show(opened().message);
        await act(async () => view.render(createElement('div')));
        await act(async () => answer({ removable: true }));

        expect(checkbox()).toBeNull();
    });
});

describe('the fixture transport\'s answer', () => {
    it('is removable for a worktree Clowdy made that no other chat uses, and carries its path and branch', async () => {
        await expect(transport.getChatWorkspaceRemoval(workspaceChat.id)).resolves.toEqual({ removable: true, path: workspaceChat.workspace!.path, branch: workspaceChat.workspace!.branch });
        await expect(transport.getChatWorkspaceRemoval('c-4')).resolves.toEqual({ removable: false });
        await expect(transport.getChatWorkspaceRemoval('c-missing')).rejects.toMatchObject({ status: 404 });
    });

    it('is not removable while a chat outside the chat and its threads uses the worktree, and a delete that asks for it is refused', async () => {
        const data = withFixtureWorkspace(createFixtureData());
        const source = data.chats.find(chat => chat.id === FIXTURE_WORKSPACE_CHAT_ID)!;

        data.chats.push({ ...source, id: 'c-shared', title: 'Shares the worktree' });

        const shared = new FixtureTransport({ data });

        await expect(shared.getChatWorkspaceRemoval(source.id)).resolves.toMatchObject({ removable: false });
        await expect(shared.command({ type: 'chat.delete', chatId: source.id, removeWorkspace: true })).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } });
        await expect(shared.command({ type: 'chat.delete', chatId: source.id })).resolves.toMatchObject({ ok: true });
    });

    it('does not count the threads below the chat as sharing', async () => {
        const data = withFixtureWorkspace(createFixtureData());
        const source = data.chats.find(chat => chat.id === FIXTURE_WORKSPACE_CHAT_ID)!;

        data.chats.push({ ...source, id: 'c-thread', title: 'Thread', parentChatId: source.id });
        await expect(new FixtureTransport({ data }).getChatWorkspaceRemoval(source.id)).resolves.toMatchObject({ removable: true });
    });
});
