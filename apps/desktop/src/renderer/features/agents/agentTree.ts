import { ACTIVE_RUN_STATUSES, type Chat, type ChatId, type Run, type RunId } from '@clowdy/protocol';

import type { StatusTone } from '../../shared';
import type { ChatSort } from '../../stores';
import type { RunNode } from '../../stores/runTree';

/** One line of the Agents list: a chat, or a run nested under the chat that started it. */
export type AgentRow =
    | { kind: 'chat'; id: ChatId; chat: Chat; depth: 0; childCount: number; isExpanded: boolean }
    | { kind: 'run'; id: RunId; run: Run; depth: number; childCount: number; isExpanded: boolean };

/** A line under a run's summary, saying why it waits or stopped. */
export interface RowNote {
    text: string;
    tone: 'warning' | 'danger' | 'neutral';
}

/**
 * The list as rows, top to bottom: the chats as they are given, each followed by the runs below its orchestrator (the
 * orchestrator is the chat itself, so it has no row of its own). A collapsed chat or run hides what is below it. Ids of
 * chats and runs never collide, so one set holds the folds of both.
 */
export function agentRows(chats: readonly Chat[], forest: readonly RunNode[], collapsed: ReadonlySet<string>): AgentRow[] {
    const nodes = new Map<RunId, RunNode>();
    const index = (level: readonly RunNode[]) => {
        for (const node of level) {
            nodes.set(node.run.id, node);
            index(node.children);
        }
    };

    index(forest);

    const rows: AgentRow[] = [];
    const walk = (children: readonly RunNode[], depth: number) => {
        for (const { run, children: below } of children) {
            const isExpanded = !collapsed.has(run.id);

            rows.push({ kind: 'run', id: run.id, run, depth, childCount: below.length, isExpanded });

            if (isExpanded) walk(below, depth + 1);
        }
    };

    for (const chat of chats) {
        const below = (chat.orchestratorRunId ? nodes.get(chat.orchestratorRunId)?.children : undefined) ?? [];
        const isExpanded = !collapsed.has(chat.id);

        rows.push({ kind: 'chat', id: chat.id, chat, depth: 0, childCount: below.length, isExpanded });

        if (isExpanded) walk(below, 1);
    }

    return rows;
}

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

/** What the main pane shows: a chat, and a run of that chat when the person opened one below it, or the new-chat row. */
export interface AgentSelection {
    chat: Chat | undefined;
    /** A run below the chat's orchestrator. The orchestrator itself is the chat, so it is never here. */
    run: Run | undefined;
    /** The new-chat row: asked for, or the only thing there is to show because the project has no chat yet. */
    draft: boolean;
}

/**
 * The selection the screen shows, from what the UI remembers. A remembered run wins when its chat is known (a run is
 * opened from a chip or from the list), and a root run is its chat. Anything gone, and a chat that is in the archive (it has
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

/** The run's parents, nearest first. */
export function ancestorIds(runs: ReadonlyMap<RunId, Run>, runId: RunId): RunId[] {
    const ancestors: RunId[] = [];

    for (let parent = runs.get(runId)?.parentRunId; parent !== undefined && !ancestors.includes(parent); parent = runs.get(parent)?.parentRunId) {
        ancestors.push(parent);
    }

    return ancestors;
}

/**
 * The row of the list that stands for a run below a chat: its own, or, for a native sub-agent, which has no row, the row of the run whose session
 * it lives in. Nothing when that is the chat's orchestrator, whose row is the chat's.
 */
export function listedRunId(runs: ReadonlyMap<RunId, Run>, run: Run): RunId | undefined {
    // The daemon puts a sub-agent under the run of the session it came from, never under another sub-agent.
    const listed = run.origin === 'native' && run.parentRunId !== undefined ? runs.get(run.parentRunId) : run;

    return listed?.parentRunId === undefined ? undefined : listed.id;
}

/**
 * How many spawned children of each run are still going. Counted over every run, so what is folded away does not change it. Native sub-agents
 * are not counted: they are not rows, and they end with their parent's turn.
 */
export function countActiveChildren(runs: Iterable<Run>): Map<RunId, number> {
    const counts = new Map<RunId, number>();

    for (const run of runs) {
        if (run.parentRunId !== undefined && run.origin !== 'native' && ACTIVE_RUN_STATUSES.includes(run.status)) counts.set(run.parentRunId, (counts.get(run.parentRunId) ?? 0) + 1);
    }

    return counts;
}

/** Why the run waits or stopped, for the line under its summary. Nothing for a run that is simply working or done. */
export function describeRun(run: Run, activeChildCount: number): RowNote | undefined {
    switch (run.status) {
        case 'waiting_children':
            return { text: activeChildCount > 0 ? `Waiting for sub-agents · ${ activeChildCount } active` : 'Waiting for sub-agents', tone: 'warning' };
        case 'waiting_background': {
            const open = run.background?.length ?? 0;

            // Nothing is stuck: the agent's own work goes on, so the note is calm.
            return { text: open > 0 ? `Waiting for background work · ${ open } open` : 'Waiting for background work', tone: 'neutral' };
        }
        case 'waiting_user':
            return { text: run.statusReason ?? 'Waiting for your answer', tone: 'warning' };
        case 'blocked':
            return run.statusReason ? { text: run.statusReason, tone: 'warning' } : undefined;
        case 'queued':
        case 'cancelled':
        case 'interrupted':
            return run.statusReason ? { text: run.statusReason, tone: 'neutral' } : undefined;
        case 'failed': {
            const reason = run.error ?? run.statusReason;

            return reason ? { text: reason, tone: 'danger' } : undefined;
        }
        case 'running':
        case 'succeeded':
            return undefined;
    }
}

/**
 * The dot on the icon of a chat's row, from what its orchestrator is doing: green while it works (or waits for its executors or for
 * its own background work), blue when it has asked the person something, red when it failed. A run that is blocked or queued shows
 * its usual tone.
 * Nothing for a chat that has not started or whose run is over (done, stopped, interrupted): no news is no dot.
 */
export function chatDotTone(run: Run | undefined): StatusTone | undefined {
    switch (run?.status) {
        case 'running':
        case 'waiting_children':
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
