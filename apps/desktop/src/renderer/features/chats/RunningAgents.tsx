import { Shimmer } from '@clowdy/components/Shimmer';
import { BackgroundTask, Robot } from '@clowdy/icons/14';

import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { useAgentActivity } from '../../stream/useAgentActivity';
import { perform } from './commands';
import { ComposerBanner, ComposerBannerHeader, ComposerBannerStatus } from './ComposerBanner';
import { agentRowLabel, agentRowText, backgroundRowText, canStopAlone, MAX_AGENT_ROWS, offersStopAll, openBackground, runningAgents, unlistedBackground } from './runningAgentRows';

import type { Chat, Run, RunId } from '@clowdy/protocol';

function AgentRow({ run }: { run: Run }) {
    const root = useRootStore();
    const ui = useProjectUi();
    const waiting = run.status === 'waiting_user';
    const { activity, calls } = useAgentActivity(waiting ? undefined : run.id);
    const text = agentRowText(run, activity, calls);
    // Stop ends this agent and nothing else, whether the orchestrator's turn runs or its session waits. A sub-agent whose session cannot end it alone
    // has none: the composer's Stop ends the run.
    const stoppable = canStopAlone(run);

    return (
        <ComposerBannerStatus
            icon={ <Robot /> }
            action={ stoppable ? 'Stop' : undefined }
            onAction={ stoppable ? () => void perform(root, { type: 'run.cancel', runId: run.id }) : undefined }
            onPress={ () => ui.openRun(run.id) }
            pressLabel={ `Open ${ agentRowLabel(run) }. ${ text }` }
        >
            { waiting ? text : <Shimmer duration={ 1 }>{ text }</Shimmer> }
        </ComposerBannerStatus>
    );
}

/**
 * The line over the agents' rows. Stop all stops every agent that can stop alone and lets the orchestrator go on, knowing they were stopped
 * (`run.stopAgents`): unlike the composer's Stop, which ends the whole run. It is there when two or more rows have a Stop of their own.
 */
function AgentsHeader({ runId, stopAll }: { runId: RunId; stopAll: boolean }) {
    const root = useRootStore();

    return (
        <ComposerBannerHeader
            action={ stopAll ? 'Stop all' : undefined }
            onAction={ stopAll ? () => void perform(root, { type: 'run.stopAgents', runId }) : undefined }
        >
            Agents running
        </ComposerBannerHeader>
    );
}

/**
 * What the orchestrator's session keeps open after its turn that no agent row shows (a command, a workflow, a sub-agent that has no run to open): one
 * shimmering line with how many, and Stop, which ends the run and with it all of that. Not pressable, since there is no run of its own to open.
 */
function BackgroundRow({ runId, count }: { runId: RunId; count: number }) {
    const root = useRootStore();

    return (
        <ComposerBannerStatus
            icon={ <BackgroundTask /> }
            action="Stop"
            onAction={ () => void perform(root, { type: 'run.cancel', runId }) }
        >
            <Shimmer duration={ 1 }>{ backgroundRowText(count) }</Shimmer>
        </ComposerBannerStatus>
    );
}

/**
 * The work of the chat that goes on now, one row each above the message box (Reforma's `ChatComposerSubagents`): under a line that says "Agents running"
 * (with Stop all when two or more rows can stop alone), the agents, who it is, what it does, how many tools it called (a row opens the agent's run,
 * and Stop ends that agent alone, spawned or a sub-agent of the session, when its session can end it), then one row for the rest of the background
 * work the orchestrator has open. Each thing is in one row: a sub-agent with a child run is its row, not a count. Nothing while there is none of either.
 */
export function RunningAgents({ chat }: { chat: Chat }) {
    const project = useProjectState();
    const agents = runningAgents(project.runs.values(), chat.orchestratorRunId);
    const orchestrator = chat.orchestratorRunId === undefined ? undefined : project.runs.get(chat.orchestratorRunId);
    // A sub-agent with a child run is one of the rows above, and is not counted again here.
    const background = unlistedBackground(openBackground(orchestrator), agents);
    const hidden = agents.length - MAX_AGENT_ROWS;

    if (agents.length === 0 && background.length === 0) return null;

    return (
        <ComposerBanner role="group" aria-label="Work in progress">
            { orchestrator && agents.length > 0 && <AgentsHeader runId={ orchestrator.id } stopAll={ offersStopAll(agents) } /> }
            { agents.slice(0, MAX_AGENT_ROWS).map(run => <AgentRow key={ run.id } run={ run } />) }
            { hidden > 0 && <ComposerBannerStatus icon={ <Robot /> }>{ `${ hidden } more ${ hidden === 1 ? 'agent' : 'agents' } at work` }</ComposerBannerStatus> }
            { orchestrator && background.length > 0 && <BackgroundRow runId={ orchestrator.id } count={ background.length } /> }
        </ComposerBanner>
    );
}
