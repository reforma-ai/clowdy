import { calendarDayDiff } from '@clowdy/lib/date';
import {
    type Chat,
    type ChatId,
    type FolderId,
    folderNames,
    isTerminalRunStatus,
    mainFolder,
    type ProjectFolder,
    type Run,
    type RunId,
    shownRunStatus,
} from '@clowdy/protocol';

import { isRunActive } from '../chats/chatRun';

import type { StatusTone } from '../../shared';

/** What every line of the Agents list has: where it stands, and the fold it carries (a line with nothing below it has none). */
interface RowBase {
    /** The key of the line in the list: a chat's id, or a sub-agent's run id. */
    id: string;
    depth: number;
    /** How many lines the list has below this one, shown or folded away. A line with none has no fold. */
    childCount: number;
    isExpanded: boolean;
}

/** A chat, at the depth of the thread tree it sits in (0 for a chat the person made). Its `childCount` counts the threads and the sub-agents that are listed, those nested below another one too. */
export interface ChatRow extends RowBase {
    kind: 'chat';
    id: ChatId;
    chat: Chat;
}

/** A native sub-agent of a chat, one level in below it, or below the sub-agent that started it. It has no fold: what it started is listed below it. */
export interface SubagentRow extends RowBase {
    kind: 'subagent';
    id: RunId;
    run: Run;
    chat: Chat;
}

export type AgentRow = ChatRow | SubagentRow;

export interface AgentRowsInput {
    /** The chats at depth 0, in the list's order (`visibleChats`). */
    roots: readonly Chat[];
    /** The threads a chat started directly, oldest first; archived ones are left out here. */
    threadsOf: (chatId: ChatId) => readonly Chat[];
    runs: ReadonlyMap<RunId, Run>;
    /**
     * The native sub-agents of a chat's orchestrator, oldest first (`nativeAgentsByRoot`), the archived ones too: the list leaves an archived one out with what
     * it started, which it can only do when it knows them. Without it no sub-agent is a row.
     */
    agentsOf?: (chat: Chat) => readonly Run[];
    /** The chats whose threads and sub-agents are open. Every other one is folded. */
    expanded: ReadonlySet<ChatId>;
    /** List a thread whose run is over, and a sub-agent whose run is over. */
    showFinished: boolean;
    /** List what works under a folded chat too (a thread, a sub-agent), not only what waits for the person. */
    expandRunning?: boolean;
    /** The chat the screen shows: it stays listed whatever the filter says. */
    openChatId?: ChatId;
    /** The sub-agent whose page is open: it stays listed whatever the filter says. */
    openRunId?: RunId;
}

/** The native sub-agents of each orchestrator, by its run id, oldest first: one pass over the runs, for the list to ask by chat. A chat with none has no entry. */
export function nativeAgentsByRoot(runs: Iterable<Run>): Map<RunId, Run[]> {
    const byRoot = new Map<RunId, Run[]>();

    for (const run of runs) {
        if (run.origin !== 'native') continue;

        const list = byRoot.get(run.rootRunId);

        if (list) list.push(run);
        else byRoot.set(run.rootRunId, [run]);
    }

    for (const list of byRoot.values()) list.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

    return byRoot;
}

/** The orchestrator of a chat, once its first message started one. */
export function orchestratorOf(chat: Chat, runs: ReadonlyMap<RunId, Run>): Run | undefined {
    return chat.orchestratorRunId === undefined ? undefined : runs.get(chat.orchestratorRunId);
}

/** A thread is finished when its orchestrator's run is over: done, failed, stopped or interrupted. One that never started is not. */
export function isFinishedThread(chat: Chat, runs: ReadonlyMap<RunId, Run>): boolean {
    const run = orchestratorOf(chat, runs);

    return run !== undefined && isTerminalRunStatus(run.status);
}

/** A chat whose orchestrator waits for the person: a question or a request for permission is open (`shownRunStatus`, so also while it rests for its background work). */
export function asksThePerson(chat: Chat, runs: ReadonlyMap<RunId, Run>): boolean {
    const run = orchestratorOf(chat, runs);

    return run !== undefined && shownRunStatus(run) === 'waiting_user';
}

/** A thread works while its orchestrator is queued, running, blocked, waits for the person or for its background work. */
export function isActiveThread(chat: Chat, runs: ReadonlyMap<RunId, Run>): boolean {
    return isRunActive(orchestratorOf(chat, runs));
}

/**
 * The sub-agents the daemon will not archive now: each one that works, and each one that started a sub-agent that does, at any depth. The list offers no Archive on
 * them, as it offers none on a chat whose agents work.
 */
export function busySubagents(runs: ReadonlyMap<RunId, Run>): Set<RunId> {
    const busy = new Set<RunId>();

    for (const run of runs.values()) {
        if (run.origin !== 'native' || !isRunActive(run)) continue;

        busy.add(run.id);

        for (const ancestor of ancestorRuns(runs, run)) busy.add(ancestor.id);
    }

    return busy;
}

/** A native sub-agent that the list shows, with the sub-agents it started that it shows below it, oldest first. */
interface AgentNode {
    run: Run;
    children: AgentNode[];
}

/** What a chat lists below it, in one order: a thread, or a sub-agent with what it started. */
type Below = { kind: 'thread'; chat: Chat } | { kind: 'agent'; node: AgentNode };

/** A sub-agent works while its run is not over (`isRunActive`, as a plain test: it is not a type guard here). */
const works = (run: Run): boolean => isRunActive(run);

const countNodes = (nodes: readonly AgentNode[]): number =>
    nodes.reduce((count, node) => count + 1 + countNodes(node.children), 0);

/**
 * The list as rows, top to bottom: each root chat, followed by what is below it when it is expanded: its threads (and theirs, at any depth) and its native
 * sub-agents in one list, the oldest first by the time each was made, so a sub-agent stands among the threads like a thread does. A sub-agent that another
 * one started is nested below that one, whether it works or is over. A thread's own sub-agents are below that thread.
 *
 * A folded chat still lists what waits for the person (a thread or a sub-agent, and the chats and sub-agents between), so a question is never behind a
 * fold, and with `expandRunning` what works too; the row keeps its fold, closed, and the rest stays out until the chat is expanded. Archived threads are
 * not rows, nor are archived sub-agents and what each one started, the open page among them (bringing one back is what opening it does, `openRun`). Without `showFinished`, a thread or a sub-agent that is over is left out unless something listed is below it (it still works, or it is the
 * open page) or it is the open page itself (the open chat, the open sub-agent, which stays below a folded chat too), and a row's fold counts only what is listed.
 */
export function agentRows({
    roots,
    threadsOf,
    runs,
    agentsOf,
    expanded,
    showFinished,
    expandRunning = false,
    openChatId,
    openRunId,
}: AgentRowsInput): AgentRow[] {
    const listed = new Map<ChatId, Chat[]>();
    const visiting = new Set<ChatId>();
    const listedAgents = new Map<ChatId, { all: AgentNode[]; folded: AgentNode[] }>();
    const surfacing = new Map<ChatId, boolean>();

    // The threads of a chat that the filter keeps, worked out bottom up so that a thread kept for its own sake keeps its parents too.
    const listedThreads = (chatId: ChatId): Chat[] => {
        const known = listed.get(chatId);

        if (known) return known;

        visiting.add(chatId);

        const kept = threadsOf(chatId).filter(thread => {
            // Chats form a tree by contract; the guard keeps a corrupt parent cycle from looping.
            if (thread.archivedAt !== undefined || visiting.has(thread.id)) return false;

            const below = listedThreads(thread.id);

            return (
                showFinished ||
                thread.id === openChatId ||
                below.length > 0 ||
                agentsOfChat(thread).all.length > 0 ||
                !isFinishedThread(thread, runs)
            );
        });

        visiting.delete(chatId);
        listed.set(chatId, kept);

        return kept;
    };

    // A sub-agent below a folded chat: it is the open page, it asks, or it works (when that is listed), or one of those is below it.
    const surfaceAgents = (nodes: readonly AgentNode[]): AgentNode[] =>
        nodes.flatMap(({ run, children }) => {
            const below = surfaceAgents(children);
            const own = run.id === openRunId || shownRunStatus(run) === 'waiting_user' || (expandRunning && works(run));

            return own || below.length > 0 ? [{ run, children: below }] : [];
        });

    // The sub-agents of a chat that the filter keeps, in one pass over them (the chat's own, oldest first): each below the one that started it, a sub-agent
    // kept for its own sake keeping its parents too, as a thread does. One that is its own ancestor, in corrupt data, stands right below the chat.
    const agentsOfChat = (chat: Chat) => {
        let known = listedAgents.get(chat.id);

        if (known) return known;

        const agents = agentsOf?.(chat) ?? [];
        const ids = new Set(agents.map(run => run.id));
        const startedBy = new Map<RunId | undefined, Run[]>();

        for (const run of agents) {
            const parent = run.parentRunId !== undefined && ids.has(run.parentRunId) ? run.parentRunId : undefined;
            const siblings = startedBy.get(parent);

            if (siblings) siblings.push(run);
            else startedBy.set(parent, [run]);
        }

        const seen = new Set<RunId>();
        // `away`: a sub-agent that an archived one started. The daemon puts those away together, but bringing one back leaves the rest, so what it started may be
        // in use below one that is not: it is still not a row, and it is marked seen so that the pass over every run does not list it as a root.
        const build = (run: Run, away: boolean): AgentNode[] => {
            if (seen.has(run.id)) return [];

            seen.add(run.id);

            const isAway = away || run.archivedAt !== undefined;
            const children = (startedBy.get(run.id) ?? []).flatMap(child => build(child, isAway));

            return !isAway && (showFinished || works(run) || run.id === openRunId || children.length > 0)
                ? [{ run, children }]
                : [];
        };
        // The roots come oldest first; a parent cycle, in corrupt data, is met after them, so the whole is put in order again (it is sorted already but for that).
        const all = [...(startedBy.get(undefined) ?? []), ...agents]
            .flatMap(run => build(run, false))
            .sort((a, b) => a.run.createdAt - b.run.createdAt || a.run.id.localeCompare(b.run.id));

        known = { all, folded: surfaceAgents(all) };
        listedAgents.set(chat.id, known);

        return known;
    };

    // The chat shows below a folded one: it asks, or works (when that is listed), or has a sub-agent that is shown so, or a thread below it is shown so.
    const surfaces = (chat: Chat): boolean => {
        const known = surfacing.get(chat.id);

        if (known !== undefined) return known;

        const is =
            asksThePerson(chat, runs) ||
            (expandRunning && isActiveThread(chat, runs)) ||
            agentsOfChat(chat).folded.length > 0 ||
            listedThreads(chat.id).some(surfaces);

        surfacing.set(chat.id, is);

        return is;
    };

    // The threads and the sub-agents of a chat in one list, the oldest first (both come oldest first, so this is a merge).
    const inOrder = (threads: readonly Chat[], agents: readonly AgentNode[]): Below[] => {
        const merged: Below[] = [];
        let thread = 0;
        let agent = 0;

        while (thread < threads.length || agent < agents.length) {
            const takeThread =
                agent >= agents.length ||
                (thread < threads.length &&
                    (threads[thread].createdAt - agents[agent].run.createdAt ||
                        threads[thread].id.localeCompare(agents[agent].run.id)) <= 0);

            if (takeThread) merged.push({ kind: 'thread', chat: threads[thread++] });
            else merged.push({ kind: 'agent', node: agents[agent++] });
        }

        return merged;
    };

    const rows: AgentRow[] = [];
    const walk = (chat: Chat, depth: number) => {
        const threads = listedThreads(chat.id);
        const { all, folded } = agentsOfChat(chat);
        const childCount = threads.length + countNodes(all);
        const isExpanded = childCount > 0 && expanded.has(chat.id);
        const place = (node: AgentNode, at: number) => {
            rows.push({
                kind: 'subagent',
                id: node.run.id,
                run: node.run,
                chat,
                depth: at,
                childCount: 0,
                isExpanded: false,
            });
            node.children.forEach(child => place(child, at + 1));
        };

        rows.push({ kind: 'chat', id: chat.id, chat, depth, childCount, isExpanded });

        for (const below of isExpanded ? inOrder(threads, all) : inOrder(threads.filter(surfaces), folded))
            if (below.kind === 'thread') walk(below.chat, depth + 1);
            else place(below.node, depth + 1);
    };

    roots.forEach(root => walk(root, 0));

    return rows;
}

/**
 * Roots in their manual order. Chats outside that order go above it, newest first.
 * A thread whose parent is missing or archived stands here too, so it is not lost.
 */
export function visibleChats(chatList: readonly Chat[], order: readonly ChatId[] = []): Chat[] {
    const rank = new Map(order.map((id, index) => [id, index]));
    const inUse = new Set(chatList.filter(chat => chat.archivedAt === undefined).map(chat => chat.id));

    return chatList
        .filter(
            chat => chat.archivedAt === undefined && (chat.parentChatId === undefined || !inUse.has(chat.parentChatId))
        )
        .sort((a, b) => (rank.get(a.id) ?? -1) - (rank.get(b.id) ?? -1) || b.createdAt - a.createdAt);
}

/** One folder's part of the grouped list: its chats at depth 0, in the order `visibleChats` gave them. */
export interface AgentGroup {
    folder: ProjectFolder;
    /** The folder's short name, which tells the project's folders apart (`folderNames`). */
    name: string;
    isMain: boolean;
    roots: Chat[];
}

/** The folder with this id, else the main one: no id follows the main folder, and one the project no longer has was handed back to it. */
export function folderById(folders: readonly ProjectFolder[], folderId: FolderId | null | undefined): ProjectFolder {
    return folders.find(folder => folder.id === folderId) ?? mainFolder({ folders: [...folders] });
}

/** The folder a new chat of the grouped list is for: the one `draftFolderId` names, else the main one (see `folderById`), with its short name. */
export function draftTarget(
    folders: readonly ProjectFolder[],
    draftFolderId: FolderId | null | undefined
): Pick<AgentGroup, 'folder' | 'name' | 'isMain'> {
    const folder = folderById(folders, draftFolderId);
    const index = folders.indexOf(folder);

    return { folder, name: folderNames(folders)[index] ?? folder.path, isMain: index === 0 };
}

/**
 * The root chats split by folder, one group per folder of the project in the project's order (main first), a folder with no chat included. A chat with
 * no folder follows the main folder, so it stands in the main group. Each group keeps the order of `roots`.
 */
export function agentGroups(roots: readonly Chat[], folders: readonly ProjectFolder[]): AgentGroup[] {
    const names = folderNames(folders);
    const groups = folders.map(
        (folder, index): AgentGroup => ({ folder, name: names[index] ?? folder.path, isMain: index === 0, roots: [] })
    );

    for (const chat of roots) {
        const { id } = folderById(folders, chat.folderId);

        groups.find(group => group.folder.id === id)?.roots.push(chat);
    }

    return groups;
}

/** The folder whose group lists a chat: the folder of the chat the person made that it sits below (a thread is below its parent, in its group). */
export function groupFolderOf(
    chats: ReadonlyMap<ChatId, Chat>,
    folders: readonly ProjectFolder[],
    chatId: ChatId
): FolderId | undefined {
    const chat = chats.get(chatId);

    if (!chat) return undefined;

    return folderById(folders, (ancestorChats(chats, chatId).at(-1) ?? chat).folderId).id;
}

/** The folder a chat works in, with its short name: the one whose group lists it (`groupFolderOf`), so a thread works where the chat it is below does. */
export function chatFolder(
    chats: ReadonlyMap<ChatId, Chat>,
    folders: readonly ProjectFolder[],
    chatId: ChatId
): Pick<AgentGroup, 'folder' | 'name'> | undefined {
    const id = groupFolderOf(chats, folders, chatId);
    const index = folders.findIndex(folder => folder.id === id);
    const folder = folders[index];

    return folder && { folder, name: folderNames(folders)[index] ?? folder.path };
}

/**
 * The chats the archive lists, the one put away last first. A thread put away with its parent is part of the parent's cascade and has no entry of
 * its own; one put away alone, while its parent is in use, has one.
 */
export function archivedChats(chatList: readonly Chat[]): (Chat & { archivedAt: number })[] {
    const archived = new Set(chatList.filter(chat => chat.archivedAt !== undefined).map(chat => chat.id));

    return chatList
        .filter(
            (chat): chat is Chat & { archivedAt: number } =>
                chat.archivedAt !== undefined && (chat.parentChatId === undefined || !archived.has(chat.parentChatId))
        )
        .sort((a, b) => b.archivedAt - a.archivedAt);
}

export type ArchiveGroupId = 'today' | 'yesterday' | 'week' | 'older';

/** The archive's chats put away in one stretch of days, under its title. */
export interface ArchiveGroup {
    id: ArchiveGroupId;
    title: string;
    chats: (Chat & { archivedAt: number })[];
}

const ARCHIVE_GROUP_TITLES: Record<ArchiveGroupId, string> = {
    today: 'Today',
    yesterday: 'Yesterday',
    week: 'Last 7 days',
    older: 'Older',
};

/** The group of a chat put away `days` calendar days ago: a moment ahead of the clock is today. */
function archiveGroupOf(days: number): ArchiveGroupId {
    if (days <= 0) return 'today';

    if (days === 1) return 'yesterday';

    return days <= 7 ? 'week' : 'older';
}

/**
 * The archive's chats (`archivedChats`) in groups by the calendar day they were put away: today, yesterday, the 7 days before, and older. The order of the chats is
 * kept, the last one first, and a group with no chat is left out. `now` is for tests.
 */
export function archiveGroups(chats: readonly (Chat & { archivedAt: number })[], now = Date.now()): ArchiveGroup[] {
    const today = new Date(now);
    const groups = new Map<ArchiveGroupId, ArchiveGroup>();

    for (const chat of chats) {
        const id = archiveGroupOf(calendarDayDiff(new Date(chat.archivedAt), today));
        const group = groups.get(id) ?? { id, title: ARCHIVE_GROUP_TITLES[id], chats: [] };

        group.chats.push(chat);
        groups.set(id, group);
    }

    return (Object.keys(ARCHIVE_GROUP_TITLES) as ArchiveGroupId[]).flatMap(id => groups.get(id) ?? []);
}

/** The chats a thread sits below, nearest first: its parent, the parent's parent, up to the chat the person made. Empty for such a chat. */
export function ancestorChats(chats: ReadonlyMap<ChatId, Chat>, chatId: ChatId): Chat[] {
    const ancestors: Chat[] = [];

    for (
        let parent = chats.get(chatId)?.parentChatId;
        parent !== undefined && parent !== chatId;
        parent = chats.get(parent)?.parentChatId
    ) {
        const chat = chats.get(parent);

        if (!chat || ancestors.includes(chat)) break;

        ancestors.push(chat);
    }

    return ancestors;
}

/**
 * The sub-agents a run was started inside, nearest first: the one that started it, the one that started that one, up to the first one below the chat's
 * orchestrator. The orchestrator itself is the chat, so it is not here. Empty for an orchestrator.
 */
export function ancestorRuns(runs: ReadonlyMap<RunId, Run>, run: Run): Run[] {
    const ancestors: Run[] = [];
    let parent = run.parentRunId === undefined ? undefined : runs.get(run.parentRunId);

    // The orchestrator has no parent run, which ends the walk; so does a cycle, in corrupt data.
    while (parent?.parentRunId !== undefined && parent.id !== run.id && !ancestors.includes(parent)) {
        ancestors.push(parent);
        parent = runs.get(parent.parentRunId);
    }

    return ancestors;
}

/** The chat a run belongs to: the one whose orchestrator is the root of the run's tree. A thread's orchestrator is a root run of its own. */
export function chatOfRun(chats: Iterable<Chat>, run: Pick<Run, 'rootRunId'>): Chat | undefined {
    return [...chats].find(chat => chat.orchestratorRunId === run.rootRunId);
}

/** What the main pane shows: a chat (a thread is one too), and a sub-agent's run of that chat when the person opened one, or the new-chat row. */
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
export function resolveSelection(
    chats: ReadonlyMap<ChatId, Chat>,
    chatList: readonly Chat[],
    runs: ReadonlyMap<RunId, Run>,
    chatId: ChatId | null,
    runId: RunId | null,
    draft = false
): AgentSelection {
    if (draft) return { chat: undefined, run: undefined, draft: true };

    const run = runId === null ? undefined : runs.get(runId);
    const owner = run ? chatOfRun(chats.values(), run) : undefined;

    if (run && owner && owner.archivedAt === undefined)
        return { chat: owner, run: run.parentRunId === undefined ? undefined : run, draft: false };

    const remembered = chatId === null ? undefined : chats.get(chatId);
    const chat = (remembered?.archivedAt === undefined ? remembered : undefined) ?? chatList[0];

    return { chat, run: undefined, draft: chat === undefined };
}

/** What the threads below a chat are doing that its dot tells: some work, or some wait for the person (which wins). */
export type ThreadsActivity = 'working' | 'asking';

/** The row's status tone. An unsent draft uses a neutral Edit icon. */
export function chatDotTone(
    run: Run | undefined,
    threads?: ThreadsActivity,
    draft = false,
    unread = false
): StatusTone | undefined {
    const status = run && shownRunStatus(run);
    switch (status) {
        case 'failed':
            return 'danger';
        case 'waiting_user':
            return 'accent';
        case 'blocked':
            return 'warning';
        case 'queued':
            return 'neutral';
    }
    if (threads === 'asking') return 'accent';
    if (status === 'running' || status === 'waiting_background' || threads === 'working') return 'success';
    if (draft) return 'neutral';
    return status === 'succeeded' && unread ? 'warning' : undefined;
}
