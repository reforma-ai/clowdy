import { openConfirmModal } from '@clowdy/components/modals';

import { perform } from './commands';

import type { Chat } from '@clowdy/protocol';
import type { RootStore } from '../../stores';

/** What the confirmation says goes: the chat, the threads below it (the daemon deletes them with it), and the runs of their agents. */
export function deleteMessage(chat: Pick<Chat, 'title'>, threadCount: number): string {
    if (threadCount === 0) return `"${ chat.title }" and the runs of its agents are deleted for good. The tasks it made stay.`;

    const threads = threadCount === 1 ? 'its thread' : `its ${ threadCount } threads`;

    return `"${ chat.title }", ${ threads } and the runs of their agents are deleted for good. The tasks they made stay.`;
}

/**
 * Deletes a chat. One that never ran anything goes at once; one with a conversation or threads asks first, since the conversation, the threads below it
 * (`threadCount`, at any depth) and the runs of their agents go with it (the tasks they made stay).
 */
export function deleteChat(root: RootStore, chat: Chat, hasRuns: boolean, threadCount = 0): void {
    if (!hasRuns && threadCount === 0) {
        void perform(root, { type: 'chat.delete', chatId: chat.id });

        return;
    }

    openConfirmModal({
        title: 'Delete chat?',
        message: deleteMessage(chat, threadCount),
        confirmLabel: 'Delete',
        destructive: true,
        onConfirm: async () => {
            const result = await root.command({ type: 'chat.delete', chatId: chat.id });

            // The dialog shows a thrown message as an error and stays open.
            if (!result.ok) throw new Error(result.error.message);
        },
    });
}
