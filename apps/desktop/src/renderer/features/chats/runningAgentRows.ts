import { isTerminalRunStatus } from '@clowdy/protocol';

import { subagentLabel } from '../../stream/subagents';

import type { BackgroundItem, Run, RunId } from '@clowdy/protocol';

/** The rows the strip above the message box lists at most; the rest are counted on one line. */
export const MAX_AGENT_ROWS = 5;

/**
 * The agents of a chat that work now, oldest first: the runs below its orchestrator, spawned or native, that are running or wait for the
 * person. Queued and blocked runs are not working yet, and finished ones are in the stream and the Agents list.
 */
export function runningAgents(runs: Iterable<Run>, orchestratorRunId: RunId | undefined): Run[] {
    if (orchestratorRunId === undefined) return [];

    return [...runs]
        .filter(run => run.rootRunId === orchestratorRunId && run.id !== orchestratorRunId && (run.status === 'running' || run.status === 'waiting_user'))
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
export function unlistedBackground(items: readonly BackgroundItem[], agents: readonly Pick<Run, 'origin' | 'parentToolCallId'>[]): BackgroundItem[] {
    const shown = new Set(agents.flatMap(agent => agent.origin === 'native' && agent.parentToolCallId !== undefined ? [agent.parentToolCallId] : []));

    return items.filter(item => item.kind !== 'subagent' || !shown.has(item.id));
}

/**
 * Splits the background items no agent row shows into the ones that get a row of their own and the ones the single background row counts. An item gets its
 * own row when its agent lets the person stop it alone (`BackgroundItem.canStopAlone`: a command whose terminal can be cancelled), up to `MAX_AGENT_ROWS`
 * of them; a stoppable item past that, and every item that cannot be stopped alone, is counted, and the Stop of the counting row ends the run.
 */
export function backgroundRows(items: readonly BackgroundItem[], agents: readonly Pick<Run, 'origin' | 'parentToolCallId'>[]): { own: BackgroundItem[]; counted: BackgroundItem[] } {
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
 * Whether Stop on a row ends that agent alone, leaving the orchestrator and the other agents at work. A spawned run always can. A native sub-agent
 * can when its session can end it (`Run.canStopAlone`, which the daemon sets from what the engine and the agent offer); one that cannot has no Stop,
 * and while a turn runs the composer's own Stop ends everything.
 */
export function canStopAlone(run: Pick<Run, 'origin' | 'canStopAlone'>): boolean {
    return run.origin !== 'native' || run.canStopAlone === true;
}

/** How many agents that can stop alone the strip needs before it offers Stop all: with one, that row's own Stop does it. */
const STOP_ALL_FROM = 2;

/**
 * Whether the header over the rows offers Stop all. It stops every agent that can stop alone (`run.stopAgents`), the ones hidden behind
 * "N more agents at work" too, and none of those that cannot, so only the agents that can stop count, and it takes two of them to be worth a button.
 */
export function offersStopAll(agents: readonly Pick<Run, 'origin' | 'canStopAlone'>[]): boolean {
    return agents.filter(canStopAlone).length >= STOP_ALL_FROM;
}

/** The words of the background row: `Background task running`, `2 background tasks running`. Items of every kind are tasks to the person. */
export function backgroundRowText(count: number): string {
    return count === 1 ? 'Background task running' : `${ count } background tasks running`;
}

/** How a row names its agent: a spawned run by its own name (`Executor 07`), a native one by its type (`Explore agent`). */
export function agentRowLabel(run: Pick<Run, 'name' | 'origin'>): string {
    if (run.origin !== 'native') return run.name;

    const label = subagentLabel(run.name) ?? 'Sub-agent';

    return /agent$/i.test(label) ? label : `${ label } agent`;
}

/** One row's words: `Explore agent · Reading form.tsx · 4 calls`, `Executor 07 working` before it has done anything, `… · Waiting for you`. */
export function agentRowText(run: Pick<Run, 'name' | 'origin' | 'status'>, activity: string | undefined, calls: number): string {
    const label = agentRowLabel(run);

    if (run.status === 'waiting_user') return `${ label } · Waiting for you`;

    const head = activity ? `${ label } · ${ activity }` : `${ label } working`;

    return calls > 0 ? `${ head } · ${ calls } ${ calls === 1 ? 'call' : 'calls' }` : head;
}
