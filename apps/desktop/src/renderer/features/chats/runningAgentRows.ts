import { isTerminalRunStatus, shownRunStatus } from '@clowdy/protocol';

import { agentPurpose, subagentLabel } from '../../stream/subagents';
import { orchestratorOf } from '../agents/agentTree';
import { isRunActive } from './chatRun';

import type { BackgroundItem, Chat, ChatId, Run, RunId } from '@clowdy/protocol';

/** The maximum number of rows visible before scrolling. */
export const MAX_AGENT_ROWS = 5;

/**
 * The agents of a chat that work now, oldest first: the native sub-agents below its orchestrator that are running or wait for the person.
 * Queued and blocked runs are not working yet, and finished ones are in the stream.
 */
export function runningAgents(runs: Iterable<Run>, orchestratorRunId: RunId | undefined): Run[] {
    if (orchestratorRunId === undefined) return [];

    return [...runs]
        .filter(
            run =>
                run.rootRunId === orchestratorRunId &&
                run.id !== orchestratorRunId &&
                ['running', 'waiting_user'].includes(shownRunStatus(run))
        )
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/**
 * What the orchestrator has open in the background (a command, a sub-agent, a workflow its session still waits for). The daemon clears the list
 * once the run is over; a run that ended never counts here, whatever a stale snapshot says.
 */
export function openBackground(run: Run | undefined): BackgroundItem[] {
    return run === undefined || isTerminalRunStatus(run.status) ? [] : (run.background ?? []);
}

/**
 * The open background items that no row of an agent shows already. A sub-agent has a child run, which is its row (it opens the run and shows what it
 * does), so it is not counted a second time in the background row: its item names the call that started it, as the child run's `parentToolCallId`
 * does (the daemon uses that call's id as the item's). A sub-agent with no running child run, and every command and task, is counted.
 */
export function unlistedBackground(
    items: readonly BackgroundItem[],
    agents: readonly Pick<Run, 'parentToolCallId'>[]
): BackgroundItem[] {
    const shown = new Set(
        agents.flatMap(agent => (agent.parentToolCallId !== undefined ? [agent.parentToolCallId] : []))
    );

    return items.filter(item => item.kind !== 'subagent' || !shown.has(item.id));
}

/**
 * Splits the background items no agent row shows into the ones that get a row of their own and the ones the single background row counts. An item gets its
 * own row for each command and each task that the agent lets the person stop alone. Items that cannot be stopped alone are also counted;
 * the Stop of the counting row ends the run, preserving a way to stop that work.
 */
export function backgroundRows(
    items: readonly BackgroundItem[],
    agents: readonly Pick<Run, 'parentToolCallId'>[]
): { own: BackgroundItem[]; counted: BackgroundItem[] } {
    const unlisted = unlistedBackground(items, agents);
    const own = unlisted.filter(
        item => item.kind === 'command' || (item.kind === 'task' && item.canStopAlone === true)
    );

    return { own, counted: unlisted.filter(item => item.canStopAlone !== true || item.kind === 'subagent') };
}

/** What a row of its own says of a background item: what kind it is and what it runs, `Command: bun run test`. */
export function backgroundItemText(item: Pick<BackgroundItem, 'kind' | 'title'>): string {
    const scheduled = item.kind === 'task' ? /^(Monitor|Wakeup)(?: · |: )(.+)$/.exec(item.title) : null;

    if (scheduled) return `${scheduled[1]}: ${scheduled[2]}`;

    return `${item.kind === 'task' ? 'Task' : item.kind === 'subagent' ? 'Sub-agent' : 'Command'}: ${item.title}`;
}

/**
 * Whether Stop on a row ends that sub-agent alone, leaving the orchestrator and the other agents at work. It can when its session can end it
 * (`Run.canStopAlone`, which the daemon sets from what the engine and the agent offer); one that cannot has no Stop, and while a turn runs the
 * composer's own Stop ends everything.
 */
export function canStopAlone(run: Pick<Run, 'canStopAlone'>): boolean {
    return run.canStopAlone === true;
}

/** The words of the background row: `Background task running`, `2 background tasks running`. Items of every kind are tasks to the person. */
export function backgroundRowText(count: number): string {
    return count === 1 ? 'Background task running' : `${count} background tasks running`;
}

/**
 * How a sub-agent is named to the person: by what it was asked to do, the one line its agent gave it (`Run.summary`, `Review the clone route diff`), as a thread is by its
 * title. A sub-agent that has none reads by its type (`Explore agent`). Users take a sub-agent and a thread for nearly the same thing, so the type is no name.
 */
export function agentRowLabel(run: Pick<Run, 'name' | 'summary'>): string {
    const purpose = agentPurpose(run);

    if (purpose) return purpose;

    const label = subagentLabel(run.name) ?? 'Sub-agent';

    return /agent$/i.test(label) ? label : `${label} agent`;
}

/** A thread of the open chat that works now: the thread's chat and its orchestrator. */
export interface ThreadAtWork {
    chat: Chat;
    run: Run;
}

/**
 * The threads the chat started that work now, oldest first: their orchestrator is queued, running, blocked, or waits for the person or for its
 * background work. Only the chat's own threads: a thread's threads are rows of that thread's strip.
 */
export function threadsAtWork(threads: readonly Chat[], runs: ReadonlyMap<RunId, Run>): ThreadAtWork[] {
    return threads
        .flatMap(chat => {
            const run = orchestratorOf(chat, runs);

            return chat.archivedAt === undefined && isRunActive(run) ? [{ chat, run }] : [];
        })
        .sort((a, b) => a.chat.createdAt - b.chat.createdAt || a.chat.id.localeCompare(b.chat.id));
}

/** One row of the strip: a native sub-agent of the orchestrator, or a thread of the chat. */
export type StripRow = { kind: 'agent'; id: RunId; run: Run } | { kind: 'thread'; id: ChatId; chat: Chat; run: Run };

/** Whether the row's agent or thread waits for the person (`shownRunStatus`, so also while its run rests for background work with a card open). */
export function needsPerson(row: StripRow): boolean {
    return shownRunStatus(row.run) === 'waiting_user';
}

/**
 * The rows of the strip, those that wait for the person first and then the rest, each group oldest first, sub-agents and threads together: a sub-agent by
 * when its run was made, a thread by when it was made. A question comes to the top, ahead of other work.
 */
export function stripRows(agents: readonly Run[], threads: readonly ThreadAtWork[]): StripRow[] {
    const rows: StripRow[] = [
        ...agents.map(run => ({ kind: 'agent' as const, id: run.id, run })),
        ...threads.map(({ chat, run }) => ({ kind: 'thread' as const, id: chat.id, chat, run })),
    ];
    const madeAt = (row: StripRow) => (row.kind === 'agent' ? row.run.createdAt : row.chat.createdAt);

    return rows.sort(
        (a, b) => Number(needsPerson(b)) - Number(needsPerson(a)) || madeAt(a) - madeAt(b) || a.id.localeCompare(b.id)
    );
}

/**
 * The rows to draw: all of them, or, while the person has folded the strip, only those that wait for them. A fold hides work that goes on, never a
 * question: a thread that asks stays on the folded line.
 */
export function drawnRows(rows: readonly StripRow[], folded: boolean): StripRow[] {
    return folded ? rows.filter(needsPerson) : [...rows];
}
