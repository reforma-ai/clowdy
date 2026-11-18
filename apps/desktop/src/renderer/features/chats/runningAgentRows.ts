import { subagentLabel } from '../../stream/subagents';

import type { Run, RunId } from '@clowdy/protocol';

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
