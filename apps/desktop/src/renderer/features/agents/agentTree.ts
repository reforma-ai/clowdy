import { ACTIVE_RUN_STATUSES, type Chat, type ChatId, type Run, type RunId } from '@clowdy/protocol';

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
 * The chats the list shows: archived ones only when asked for, and the one that is open, so the page beside the list
 * always has its row.
 */
export function visibleChats(chatList: readonly Chat[], showArchived: boolean, openId?: ChatId): Chat[] {
    return chatList.filter(chat => chat.archivedAt === undefined || showArchived || chat.id === openId);
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
 * opened from a chip or from the list), and a root run is its chat. Anything gone falls back to the chat that was
 * selected (archived or not: it was asked for), and then to the first chat of `chatList`, the chats the list shows;
 * with no chat at all the new-chat row is what shows.
 */
export function resolveSelection(chats: ReadonlyMap<ChatId, Chat>, chatList: readonly Chat[], runs: ReadonlyMap<RunId, Run>, chatId: ChatId | null, runId: RunId | null, draft = false): AgentSelection {
    if (draft) return { chat: undefined, run: undefined, draft: true };

    const run = runId === null ? undefined : runs.get(runId);
    // Whose run it is does not depend on what the list shows: a run of an archived chat still opens below its chat.
    const owner = run ? [...chats.values()].find(chat => chat.orchestratorRunId === run.rootRunId) : undefined;

    if (run && owner) return { chat: owner, run: run.parentRunId === undefined ? undefined : run, draft: false };

    const chat = (chatId === null ? undefined : chats.get(chatId)) ?? chatList[0];

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

/** How many children of each run are still going. Counted over every run, so what is folded away does not change it. */
export function countActiveChildren(runs: Iterable<Run>): Map<RunId, number> {
    const counts = new Map<RunId, number>();

    for (const run of runs) {
        if (run.parentRunId !== undefined && ACTIVE_RUN_STATUSES.includes(run.status)) counts.set(run.parentRunId, (counts.get(run.parentRunId) ?? 0) + 1);
    }

    return counts;
}

/** Why the run waits or stopped, for the line under its summary. Nothing for a run that is simply working or done. */
export function describeRun(run: Run, activeChildCount: number): RowNote | undefined {
    switch (run.status) {
        case 'waiting_children':
            return { text: activeChildCount > 0 ? `Waiting for sub-agents · ${ activeChildCount } active` : 'Waiting for sub-agents', tone: 'warning' };
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
