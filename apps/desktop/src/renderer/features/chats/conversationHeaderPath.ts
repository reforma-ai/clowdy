import { ancestorChats, chatOfRun } from '../agents/agentTree';

import type { Chat, ChatId, Run, RunId } from '@clowdy/protocol';

/** What a press on a part of the path opens: a chat, or a native sub-agent below its chat. */
export type HeaderTarget = { kind: 'chat'; chatId: ChatId } | { kind: 'run'; runId: RunId };

/** One part of the path over a conversation. The last part is the page itself; any other part without a `target` is named only. */
export interface HeaderPart {
    /** Stable between renders, and unique in the path. */
    key: string;
    label: string;
    /** Absent for the page itself, and for a chat in the archive: opening one would bring it back, so it is named and not linked. */
    target?: HeaderTarget;
}

/** A path longer than this folds its middle: the first part, `…`, and the last two stay. */
export const MAX_PARTS = 4;

/** What a chat with no title yet reads as: the list's own row for it. */
const UNTITLED = 'New chat';

const chatLabel = (chat: Chat) => (chat.title.trim() === '' ? UNTITLED : chat.title);

export interface HeaderPathInput {
    chats: ReadonlyMap<ChatId, Chat>;
    runs: ReadonlyMap<RunId, Run>;
    /** The chat the page belongs to: the page itself, or the chat of the sub-agent. Absent when the sub-agent's chat is gone. */
    chat: Chat | undefined;
    /** The native sub-agent the page shows, when it is not a chat's own page. */
    subagent?: Run;
    /** How the app names a run to the person (`useRunLabel`). */
    label: (run: Run) => string;
}

/**
 * The path over a conversation, from the chat the person made down to the page: `Chat`, `Chat › Thread`, `Chat › Thread › Thread` for a chat page, and for a native
 * sub-agent the path of its chat and then the sub-agents it runs inside (the oldest first) and its own name. A parent that is not in the store ends the path
 * above it, since it cannot be named.
 */
export function conversationHeaderPath({ chats, runs, chat, subagent, label }: HeaderPathInput): HeaderPart[] {
    const chatsOf = chat ? [...ancestorChats(chats, chat.id).reverse(), chat] : [];
    // A chat is opened from the path unless it is the page itself or in the archive.
    const chatPart = (item: Chat, isPage: boolean): HeaderPart => ({
        key: `chat:${item.id}`,
        label: chatLabel(item),
        ...(!isPage && item.archivedAt === undefined && { target: { kind: 'chat', chatId: item.id } }),
    });

    if (!subagent) return chatsOf.map((item, index) => chatPart(item, index === chatsOf.length - 1));

    const chatParts = chatsOf.map(item => chatPart(item, false));

    // The sub-agents it runs inside, nearest to the chat first. A run with no parent is an orchestrator: that is the chat itself.
    const parents: Run[] = [];
    const seen = new Set([subagent.id]);

    for (let id = subagent.parentRunId; id !== undefined && !seen.has(id); ) {
        seen.add(id);

        const parent = runs.get(id);

        if (!parent || parent.parentRunId === undefined) break;

        parents.unshift(parent);
        id = parent.parentRunId;
    }

    return [
        ...chatParts,
        ...parents.map(
            (parent): HeaderPart => ({
                key: `run:${parent.id}`,
                label: label(parent),
                target: { kind: 'run', runId: parent.id },
            })
        ),
        { key: `run:${subagent.id}`, label: label(subagent) },
    ];
}

/** A part of the path as drawn: a part of it, or the `…` that stands for the parts folded away. */
export type HeaderItem = HeaderPart | { fold: true; hidden: number };

/** The path to draw: all of it, or with its middle folded into one `…` when it is longer than `MAX_PARTS` and has not been opened out. The last part always stays. */
export function foldedPath(parts: readonly HeaderPart[], isOpenedOut: boolean): HeaderItem[] {
    if (isOpenedOut || parts.length <= MAX_PARTS) return [...parts];

    return [parts[0]!, { fold: true, hidden: parts.length - 3 }, ...parts.slice(-2)];
}
