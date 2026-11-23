import { getChat } from '../db/chats';
import { firstUserItem } from '../db/items';
import { firstWords, saveChat, titleFrom } from '../domain/chats';
import { FIRST_MESSAGE_START } from './prompts';

import type { Chat, Run } from '@clowdy/protocol';
import type { SessionTitle } from '../engine/types';
import type { Store } from '../store';

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The chat an orchestrator answers. */
function chatOf(store: Store, run: Run): Chat | undefined {
    return run.role === 'orchestrator' && run.chatId ? getChat(store.db, run.chatId) : undefined;
}

/** Whether nobody has named the chat, not the person and not the agent: its title is still the first words of its first message. */
function isUnnamed(store: Store, run: Run, chat: Chat): boolean {
    const first = firstUserItem(store.db, run.id)?.body;

    return first?.kind === 'user' && chat.title === firstWords(first);
}

/**
 * Whether a title is only a message the agent was sent, which Codex gives as the title of a session until its own is ready: the message of this turn,
 * or the first one of the conversation, which every first message starts with the line that names the entry skill, so no name an agent made of it can
 * start the same way.
 */
function echoesPrompt(title: string, prompt: string): boolean {
    const head = title.replace(/(…|\.{3})$/u, '').trimEnd();

    return head.length > 0 && (head.startsWith(FIRST_MESSAGE_START) || squash(prompt).startsWith(head));
}

/** Takes the title an agent gave a chat's orchestrator, unless it is the message again or the chat was named meanwhile (by the person, or by an earlier title). */
function takeTitle(store: Store, run: Run, given: string, prompt: string): boolean {
    const title = titleFrom(squash(given));

    if (!title || echoesPrompt(title, prompt)) {
        return false;
    }

    return store.tx(() => {
        const chat = chatOf(store, run);

        if (!chat || !isUnnamed(store, run, chat)) {
            return false;
        }

        // The chat keeps its place in the order of activity: a name that arrives late is no new message.
        if (chat.title !== title) {
            saveChat(store, { ...chat, title });
        }

        return true;
    });
}

/**
 * What a turn of this run does about the title its agent gives the session. A chat's orchestrator whose agent can name chats (`enabled` is the person's
 * switch for it, `undefined` for an agent that has none) takes the agent's title while the chat still has the first words of its message for a name. Any
 * other session of such an agent is told to keep the title the chat has, so the agent spends no model call on a name nobody will use: a chat the person
 * renamed, one named for its task, one whose switch is off. The engine tells a new session from one that continues, which has its title already.
 */
export function sessionTitle(
    store: Store,
    run: Run,
    enabled: boolean | undefined,
    prompt: string
): SessionTitle | undefined {
    const chat = chatOf(store, run);

    if (enabled === undefined || !chat) {
        return undefined;
    }

    return enabled && isUnnamed(store, run, chat)
        ? { onTitle: title => takeTitle(store, run, title, prompt) }
        : { keep: chat.title };
}
