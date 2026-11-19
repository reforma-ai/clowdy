import { Shimmer } from '@clowdy/components/Shimmer';
import { BackgroundTask, Robot } from '@clowdy/icons/14';

import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { useAgentActivity } from '../../stream/useAgentActivity';
import { perform } from './commands';
import { ComposerBanner, ComposerBannerStatus } from './ComposerBanner';
import { agentRowLabel, agentRowText, backgroundRowText, MAX_AGENT_ROWS, openBackground, runningAgents } from './runningAgentRows';

import type { Chat, Run, RunId } from '@clowdy/protocol';

function AgentRow({ run }: { run: Run }) {
    const root = useRootStore();
    const ui = useProjectUi();
    const waiting = run.status === 'waiting_user';
    const { activity, calls } = useAgentActivity(waiting ? undefined : run.id);
    const text = agentRowText(run, activity, calls);
    // A native sub-agent lives in its parent's session and stops with it: the daemon refuses to stop it alone.
    const stoppable = run.origin !== 'native';

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
 * What the orchestrator's session keeps open after its turn (a command, a sub-agent, a workflow): one shimmering line with how many, and Stop, which
 * ends the run and with it all of that. Not pressable, since there is no run of its own to open.
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
 * The work of the chat that goes on now, one row each above the message box (Reforma's `ChatComposerSubagents`): the agents, who it is, what it
 * does, how many tools it called (a row opens the agent's run, and Stop ends a spawned one), then one row for the background work the orchestrator
 * has open. Nothing while there is none of either.
 */
export function RunningAgents({ chat }: { chat: Chat }) {
    const project = useProjectState();
    const agents = runningAgents(project.runs.values(), chat.orchestratorRunId);
    const orchestrator = chat.orchestratorRunId === undefined ? undefined : project.runs.get(chat.orchestratorRunId);
    const background = openBackground(orchestrator);
    const hidden = agents.length - MAX_AGENT_ROWS;

    if (agents.length === 0 && background.length === 0) return null;

    return (
        <ComposerBanner role="group" aria-label="Work in progress">
            { agents.slice(0, MAX_AGENT_ROWS).map(run => <AgentRow key={ run.id } run={ run } />) }
            { hidden > 0 && <ComposerBannerStatus icon={ <Robot /> }>{ `${ hidden } more ${ hidden === 1 ? 'agent' : 'agents' } at work` }</ComposerBannerStatus> }
            { orchestrator && background.length > 0 && <BackgroundRow runId={ orchestrator.id } count={ background.length } /> }
        </ComposerBanner>
    );
}
