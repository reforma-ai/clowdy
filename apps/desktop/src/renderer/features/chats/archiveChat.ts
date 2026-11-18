import { perform } from './commands';

import type { Chat } from '@clowdy/protocol';
import type { ProjectUi, RootStore } from '../../stores';

/**
 * Archives the chat, or brings it back, and tells the person when the daemon refused (its agents are working). The chat
 * that is open goes out of sight with the archive, so the page moves on to the first chat that is still listed.
 */
export async function archiveChat(root: RootStore, ui: ProjectUi, chat: Chat, archived: boolean, isOpen: boolean): Promise<void> {
    const result = await perform(root, { type: 'chat.setArchived', chatId: chat.id, archived });

    if (result.ok && archived && isOpen && !ui.showArchived) ui.openChat(null);
}
