import { isTerminalRunStatus, shownRunStatus } from '@clowdy/protocol';

import { subagentLabel } from '../../stream/subagents';
import { orchestratorOf } from '../agents/agentTree';
import { isRunActive } from './chatRun';

import type { BackgroundItem, Chat, ChatId, Run, RunId } from '@clowdy/protocol';

/** The rows the strip above the message box lists at most; the rest are counted on one line. */
export const MAX_AGENT_ROWS = 5;

/**
 * The agents of a chat that work now, oldest first: the native sub-agents below its orchestrator that are running or wait for the person.
 * Queued and blocked runs are not working yet, and finished ones are in the stream.
 */
export function runningAgents(runs: Iterable<Run>, orchestratorRunId: RunId | undefined): Run[] {
    if (orchestratorRunId === undefined) return [];

    return [...runs]
        .filter(run => run.rootRunId === orchestratorRunId && run.id !== orchestratorRunId && ['running', 'waiting_user'].includes(shownRunStatus(run)))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/**
 * What the orchestrator has open in the background (a command, a sub-agent, a workflow its session still waits for). The daemon clears the list
 * once the run is over; a run that ended never counts here, whatever a stale snapshot says.
 */
export function openBackground(run: Run | undefined): BackgroundItem[] {
    return run === undefined || isTerminalRunStatus(run.status) ? [] : run.background ?? [];
}

/**
 * The open background items that no row of an agent shows already. A sub-agent has a child run, which is its row (it opens the run and shows what it
 * does), so it is not counted a second time in the background row: its item names the call that started it, as the child run's `parentToolCallId`
 * does (the daemon uses that call's id as the item's). A sub-agent with no running child run, and every command and task, is counted.
 */
export function unlistedBackground(items: readonly BackgroundItem[], agents: readonly Pick<Run, 'parentToolCallId'>[]): BackgroundItem[] {
    const shown = new Set(agents.flatMap(agent => agent.parentToolCallId !== undefined ? [agent.parentToolCallId] : []));

    return items.filter(item => item.kind !== 'subagent' || !shown.has(item.id));
}

/**
 * Splits the background items no agent row shows into the ones that get a row of their own and the ones the single background row counts. An item gets its
 * own row when its agent lets the person stop it alone (`BackgroundItem.canStopAlone`: a command whose terminal can be cancelled), up to `MAX_AGENT_ROWS`
 * of them; a stoppable item past that, and every item that cannot be stopped alone, is counted, and the Stop of the counting row ends the run.
 */
export function backgroundRows(items: readonly BackgroundItem[], agents: readonly Pick<Run, 'parentToolCallId'>[]): { own: BackgroundItem[]; counted: BackgroundItem[] } {
    const unlisted = unlistedBackground(items, agents);
    const stoppable = unlisted.filter(item => item.kind !== 'subagent' && item.canStopAlone === true);
    const own = stoppable.slice(0, MAX_AGENT_ROWS);

    return { own, counted: unlisted.filter(item => !own.includes(item)) };
}

/** What a row of its own says of a background item: what kind it is and what it runs, `Command · bun run test`. */
export function backgroundItemText(item: Pick<BackgroundItem, 'kind' | 'title'>): string {
    return `${ item.kind === 'task' ? 'Task' : item.kind === 'subagent' ? 'Sub-agent' : 'Command' } · ${ item.title }`;
}

/**
 * Whether Stop on a row ends that sub-agent alone, leaving the orchestrator and the other agents at work. It can when its session can end it
 * (`Run.canStopAlone`, which the daemon sets from what the engine and the agent offer); one that cannot has no Stop, and while a turn runs the
 * composer's own Stop ends everything.
 */
export function canStopAlone(run: Pick<Run, 'canStopAlone'>): boolean {
    return run.canStopAlone === true;
}

/** How many rows with a Stop of their own the strip needs before it offers Stop all: with one, that row's own Stop does it. */
const STOP_ALL_FROM = 2;

/**
 * Whether the header over the rows offers Stop all. It stops every agent that can stop alone (`run.stopAgents`) and every thread at work (`run.cancel`
 * of each), the ones hidden behind "N more agents at work" too, and none of the sub-agents that cannot, so only the rows that can stop count, and it
 * takes two of them to be worth a button.
 */
export function offersStopAll(agents: readonly Pick<Run, 'canStopAlone'>[], threadCount = 0): boolean {
    return agents.filter(canStopAlone).length + threadCount >= STOP_ALL_FROM;
}

/** The words of the background row: `Background task running`, `2 background tasks running`. Items of every kind are tasks to the person. */
export function backgroundRowText(count: number): string {
    return count === 1 ? 'Background task running' : `${ count } background tasks running`;
}

/** How a row names its sub-agent: by its type (`Explore agent`). */
export function agentRowLabel(run: Pick<Run, 'name'>): string {
    const label = subagentLabel(run.name) ?? 'Sub-agent';

    return /agent$/i.test(label) ? label : `${ label } agent`;
}

/** One row's words: `Explore agent · Reading form.tsx · 4 calls`, `Explore agent working` before it has done anything, `… · Waiting for you`. */
export function agentRowText(run: Pick<Run, 'name' | 'status' | 'awaitingUser'>, activity: string | undefined, calls: number): string {
    const label = agentRowLabel(run);

    if (shownRunStatus(run) === 'waiting_user') return `${ label } · Waiting for you`;

    const head = activity ? `${ label } · ${ activity }` : `${ label } working`;

    return calls > 0 ? `${ head } · ${ calls } ${ calls === 1 ? 'call' : 'calls' }` : head;
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
    return threads.flatMap((chat) => {
        const run = orchestratorOf(chat, runs);

        return chat.archivedAt === undefined && isRunActive(run) ? [{ chat, run }] : [];
    }).sort((a, b) => a.chat.createdAt - b.chat.createdAt || a.chat.id.localeCompare(b.chat.id));
}

/** One row of the strip: a native sub-agent of the orchestrator, or a thread of the chat. */
export type StripRow =
    | { kind: 'agent'; id: RunId; run: Run }
    | { kind: 'thread'; id: ChatId; chat: Chat; run: Run };

/** Whether the row's agent or thread waits for the person (`shownRunStatus`, so also while its run rests for background work with a card open). */
export function needsPerson(row: StripRow): boolean {
    return shownRunStatus(row.run) === 'waiting_user';
}

/**
 * The rows of the strip, those that wait for the person first and then the rest, each group oldest first, sub-agents and threads together: a sub-agent by
 * when its run was made, a thread by when it was made. A question comes to the top, so the cap on the rows never hides it.
 */
export function stripRows(agents: readonly Run[], threads: readonly ThreadAtWork[]): StripRow[] {
    const rows: StripRow[] = [
        ...agents.map(run => ({ kind: 'agent' as const, id: run.id, run })),
        ...threads.map(({ chat, run }) => ({ kind: 'thread' as const, id: chat.id, chat, run })),
    ];
    const madeAt = (row: StripRow) => (row.kind === 'agent' ? row.run.createdAt : row.chat.createdAt);

    return rows.sort((a, b) => Number(needsPerson(b)) - Number(needsPerson(a)) || madeAt(a) - madeAt(b) || a.id.localeCompare(b.id));
}

/**
 * The rows to draw: all of them, or, while the person has folded the strip, only those that wait for them. A fold hides work that goes on, never a
 * question: a thread that asks stays on the folded line.
 */
export function drawnRows(rows: readonly StripRow[], folded: boolean): StripRow[] {
    return folded ? rows.filter(needsPerson) : [...rows];
}

/**
 * What a thread's row says: its title and what it does. `Fix login · Running bun test` while it works (`Fix login working` before it has done anything
 * of its own), `· Waiting for you` on a question, `· Waiting for background work` while its session keeps work open after its turn, `· Waiting for a
 * free slot` while queued, and why it is blocked.
 */
export function threadRowText(chat: Pick<Chat, 'title'>, run: Pick<Run, 'status' | 'statusReason' | 'awaitingUser'>, activity: string | undefined): string {
    // A thread that rests for its background work while its agent asks reads as waiting for the person (`shownRunStatus`): the card is in its own chat.
    switch (shownRunStatus(run)) {
        case 'waiting_user':
            return `${ chat.title } · Waiting for you`;
        case 'waiting_background':
            return `${ chat.title } · Waiting for background work`;
        case 'queued':
            return `${ chat.title } · Waiting for a free slot`;
        case 'blocked':
            return `${ chat.title } · ${ run.statusReason ?? 'Blocked' }`;
        default:
            return activity ? `${ chat.title } · ${ activity }` : `${ chat.title } working`;
    }
}
