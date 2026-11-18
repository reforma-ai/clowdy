import { openConfirmModal } from '@clowdy/components/modals';

import { perform } from './commands';

import type { Chat } from '@clowdy/protocol';
import type { RootStore } from '../../stores';

/**
 * Deletes a chat. One that never ran anything goes at once; one with a conversation asks first, since the conversation
 * and the runs of its agents go with it (the tasks it made stay).
 */
export function deleteChat(root: RootStore, chat: Chat, hasRuns: boolean): void {
    if (!hasRuns) {
        void perform(root, { type: 'chat.delete', chatId: chat.id });

        return;
    }

    openConfirmModal({
        title: 'Delete chat?',
        message: `"${ chat.title }" and the runs of its agents are deleted for good. The tasks it made stay.`,
        confirmLabel: 'Delete',
        destructive: true,
        onConfirm: async () => {
            const result = await root.command({ type: 'chat.delete', chatId: chat.id });

            // The dialog shows a thrown message as an error and stays open.
            if (!result.ok) throw new Error(result.error.message);
        },
    });
}
