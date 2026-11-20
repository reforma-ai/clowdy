import { isTerminalRunStatus } from '@clowdy/protocol';

import { subagentLabel } from '../../stream/subagents';

import type { BackgroundItem, Run, RunId } from '@clowdy/protocol';

/** The rows the strip above the message box lists at most; the rest are counted on one line. */
export const MAX_AGENT_ROWS = 5;

/**
 * The agents of a chat that work now, oldest first: the native sub-agents below its orchestrator that are running or wait for the person.
 * Queued and blocked runs are not working yet, and finished ones are in the stream.
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
export function unlistedBackground(items: readonly BackgroundItem[], agents: readonly Pick<Run, 'parentToolCallId'>[]): BackgroundItem[] {
    const shown = new Set(agents.flatMap(agent => agent.parentToolCallId !== undefined ? [agent.parentToolCallId] : []));

    return items.filter(item => item.kind !== 'subagent' || !shown.has(item.id));
}

/**
 * Whether Stop on a row ends that sub-agent alone, leaving the orchestrator and the other agents at work. It can when its session can end it
 * (`Run.canStopAlone`, which the daemon sets from what the engine and the agent offer); one that cannot has no Stop, and while a turn runs the
 * composer's own Stop ends everything.
 */
export function canStopAlone(run: Pick<Run, 'canStopAlone'>): boolean {
    return run.canStopAlone === true;
}

/** How many agents that can stop alone the strip needs before it offers Stop all: with one, that row's own Stop does it. */
const STOP_ALL_FROM = 2;

/**
 * Whether the header over the rows offers Stop all. It stops every agent that can stop alone (`run.stopAgents`), the ones hidden behind
 * "N more agents at work" too, and none of those that cannot, so only the agents that can stop count, and it takes two of them to be worth a button.
 */
export function offersStopAll(agents: readonly Pick<Run, 'canStopAlone'>[]): boolean {
    return agents.filter(canStopAlone).length >= STOP_ALL_FROM;
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
export function agentRowText(run: Pick<Run, 'name' | 'status'>, activity: string | undefined, calls: number): string {
    const label = agentRowLabel(run);

    if (run.status === 'waiting_user') return `${ label } · Waiting for you`;

    const head = activity ? `${ label } · ${ activity }` : `${ label } working`;

    return calls > 0 ? `${ head } · ${ calls } ${ calls === 1 ? 'call' : 'calls' }` : head;
}
