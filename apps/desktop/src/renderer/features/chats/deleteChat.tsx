import { Box } from '@clowdy/components/Box';
import { Checkbox } from '@clowdy/components/Checkbox';
import { openConfirmModal } from '@clowdy/components/modals';
import { Show } from '@clowdy/components/Show';
import { Text } from '@clowdy/components/Text';
import { useEffect, useState } from 'react';

import { perform } from './commands';

import type { Chat } from '@clowdy/protocol';
import type { RootStore } from '../../stores';

export function deleteMessage(threadCount: number): string {
    const consequences = 'You can’t undo this. Tasks stay in the project.';

    if (threadCount === 0) return consequences;

    return `This will also delete ${threadCount} ${threadCount === 1 ? 'thread' : 'threads'}. ${consequences}`;
}

/** What the person chose in the confirmation besides deleting the chat: it is read when Delete is pressed. */
interface DeleteChoice {
    removeWorkspace: boolean;
}

/**
 * Whether the daemon says the chat's worktree can be removed with it (`GET /v1/chats/:id/workspace`). Only a worktree Clowdy made is asked about, since nothing else is
 * removed. A read that fails says no: the confirmation then has no checkbox, and the chat is deleted as before.
 */
function useWorktreeRemovable(root: RootStore, chat: Pick<Chat, 'id' | 'workspace'>): boolean {
    const [removable, setRemovable] = useState(false);
    const asked = chat.workspace?.managed === true;

    useEffect(() => {
        if (!asked) return undefined;

        let current = true;

        root.transport.getChatWorkspaceRemoval(chat.id).then(
            answer => {
                if (current) setRemovable(answer.removable);
            },
            () => undefined
        );

        return () => {
            current = false;
        };
    }, [root, chat.id, asked]);

    return removable;
}

interface DeleteChatMessageProps {
    root: RootStore;
    chat: Pick<Chat, 'id' | 'workspace'>;
    text: string;
    choice: DeleteChoice;
}

/** The confirmation's message, and the checkbox that also removes the worktree and its branch once the daemon says it may (off until the person ticks it). */
function DeleteChatMessage({ root, chat, text, choice }: DeleteChatMessageProps) {
    const removable = useWorktreeRemovable(root, chat);
    const [checked, setChecked] = useState(choice.removeWorkspace);

    return (
        <Box gap="lg">
            <Text variant="md" color="secondary">
                {text}
            </Text>
            <Show when={removable}>
                <Checkbox
                    size="sm"
                    isSelected={checked}
                    onChange={selected => {
                        choice.removeWorkspace = selected;
                        setChecked(selected);
                    }}
                >
                    Also remove the worktree and its branch
                </Checkbox>
            </Show>
        </Box>
    );
}

/**
 * Deletes a chat. One that never ran anything goes at once (no worktree was made for it); one with a conversation or threads asks first, since the conversation, the threads
 * below it (`threadCount`, at any depth) and the runs of their agents go with it (the tasks they made stay). When the chat works in a worktree Clowdy made and the daemon
 * says it can go (nothing uncommitted, no other chat in it, its work merged), the confirmation offers to remove the worktree and its branch too, off by default; the daemon
 * checks again and refuses the whole delete when that no longer holds.
 */
export function deleteChat(root: RootStore, chat: Chat, hasRuns: boolean, threadCount = 0): void {
    if (!hasRuns && threadCount === 0) {
        void perform(root, { type: 'chat.delete', chatId: chat.id });

        return;
    }

    const choice: DeleteChoice = { removeWorkspace: false };

    openConfirmModal({
        title: `Delete “${chat.title}”?`,
        message: <DeleteChatMessage root={root} chat={chat} text={deleteMessage(threadCount)} choice={choice} />,
        confirmLabel: 'Delete chat',
        destructive: true,
        onConfirm: async () => {
            const result = await root.command({
                type: 'chat.delete',
                chatId: chat.id,
                ...(choice.removeWorkspace && { removeWorkspace: true }),
            });

            // The dialog shows a thrown message as an error and stays open.
            if (!result.ok) throw new Error(result.error.message);
        },
    });
}
