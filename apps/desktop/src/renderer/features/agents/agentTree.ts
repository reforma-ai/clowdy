import type { Chat, ChatId, Run, RunId } from '@clowdy/protocol';
import type { StatusTone } from '../../shared';
import type { ChatSort } from '../../stores';

/**
 * The chats the list shows: the ones in use. A chat is either here, with its row, or in the archive, which has its own list;
 * there is no chat that is open and archived. `chatList` comes by last activity; `sort` `created` puts the newest chat first instead.
 */
export function visibleChats(chatList: readonly Chat[], sort: ChatSort = 'activity'): Chat[] {
    const ordered = sort === 'created' ? [...chatList].sort((a, b) => b.createdAt - a.createdAt) : chatList;

    return ordered.filter(chat => chat.archivedAt === undefined);
}

/** The chats in the archive, the one put away last first. */
export function archivedChats(chatList: readonly Chat[]): (Chat & { archivedAt: number })[] {
    return chatList
        .filter((chat): chat is Chat & { archivedAt: number } => chat.archivedAt !== undefined)
        .sort((a, b) => b.archivedAt - a.archivedAt);
}

/** The chat a run belongs to: the one whose orchestrator is the root of the run's tree. */
export function chatOfRun(chats: Iterable<Chat>, run: Pick<Run, 'rootRunId'>): Chat | undefined {
    return [...chats].find(chat => chat.orchestratorRunId === run.rootRunId);
}

/** What the main pane shows: a chat, and a sub-agent's run of that chat when the person opened one, or the new-chat row. */
export interface AgentSelection {
    chat: Chat | undefined;
    /** A native sub-agent below the chat's orchestrator. The orchestrator itself is the chat, so it is never here. */
    run: Run | undefined;
    /** The new-chat row: asked for, or the only thing there is to show because the project has no chat yet. */
    draft: boolean;
}

/**
 * The selection the screen shows, from what the UI remembers. A remembered run wins when its chat is known (a run is
 * opened from a chip or from an agent's card), and a root run is its chat. Anything gone, and a chat that is in the archive (it has
 * no page: opening one brings it back first, `openChat`), falls back to the chat that was selected, and then to the first
 * chat of `chatList`, the chats the list shows; with no chat at all the new-chat page is what shows.
 */
export function resolveSelection(chats: ReadonlyMap<ChatId, Chat>, chatList: readonly Chat[], runs: ReadonlyMap<RunId, Run>, chatId: ChatId | null, runId: RunId | null, draft = false): AgentSelection {
    if (draft) return { chat: undefined, run: undefined, draft: true };

    const run = runId === null ? undefined : runs.get(runId);
    const owner = run ? chatOfRun(chats.values(), run) : undefined;

    if (run && owner && owner.archivedAt === undefined) return { chat: owner, run: run.parentRunId === undefined ? undefined : run, draft: false };

    const remembered = chatId === null ? undefined : chats.get(chatId);
    const chat = (remembered?.archivedAt === undefined ? remembered : undefined) ?? chatList[0];

    return { chat, run: undefined, draft: chat === undefined };
}

/**
 * The dot on the icon of a chat's row, from what its orchestrator is doing: green while it works (or waits for its own background work),
 * blue when it has asked the person something, red when it failed. A run that is blocked or queued shows its usual tone.
 * Nothing for a chat that has not started or whose run is over (done, stopped, interrupted): no news is no dot.
 */
export function chatDotTone(run: Run | undefined): StatusTone | undefined {
    switch (run?.status) {
        case 'running':
        case 'waiting_background':
            return 'success';
        case 'waiting_user':
            return 'accent';
        case 'failed':
            return 'danger';
        case 'blocked':
            return 'warning';
        case 'queued':
            return 'neutral';
        default:
            return undefined;
    }
}
