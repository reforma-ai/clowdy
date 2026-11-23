import { toast } from '@clowdy/components/Toast';
import { when } from 'mobx';

import type { Chat, ChatId } from '@clowdy/protocol';
import type { ProjectState, ProjectUi, RootStore } from '../../stores';

/** How long the new chat is waited for on the event feed before the page opens it anyway. */
const FEED_WAIT_MS = 5000;

export interface ForkRequest {
    root: RootStore;
    project: ProjectState;
    ui: ProjectUi;
    chatId: ChatId;
    /** The answer to fork at: an item of the chat's own stream with `canFork`. */
    itemId: string;
    /** False once the person has left the chat the press was made in: the new chat is still made and listed, but they are not taken to it. */
    stillOpen?: () => boolean;
}

/**
 * Forks a chat at an answer and opens the new chat. A refusal (the agent cannot fork, a failed provider call) is a toast with the daemon's words and
 * leaves everything as it was. The command answers with the chat, but the store learns it from the event feed, which may not have it yet, and a page
 * pointed at a chat the store does not know settles on another one: so the chat is opened once the store has it (or after a wait, when the feed is
 * late). Resolves to whether the new chat was opened.
 */
export async function forkChat({
    root,
    project,
    ui,
    chatId,
    itemId,
    stillOpen = () => true,
}: ForkRequest): Promise<boolean> {
    const result = await root.command({ type: 'chat.fork', chatId, itemId });

    if (!result.ok) {
        toast.error({ message: result.error.message || "Couldn't fork the chat" });

        return false;
    }

    const { chat } = result.data as { chat: Chat };

    if (!project.chats.has(chat.id)) {
        await when(() => project.chats.has(chat.id), { timeout: FEED_WAIT_MS }).catch(() => undefined);
    }

    if (!stillOpen()) return false;

    ui.openChat(chat.id);

    return true;
}
