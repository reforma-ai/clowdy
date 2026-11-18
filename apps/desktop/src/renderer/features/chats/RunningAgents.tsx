import { Shimmer } from '@clowdy/components/Shimmer';
import { Robot } from '@clowdy/icons/14';

import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { useAgentActivity } from '../../stream/useAgentActivity';
import { perform } from './commands';
import { ComposerBanner, ComposerBannerStatus } from './ComposerBanner';
import { agentRowLabel, agentRowText, MAX_AGENT_ROWS, runningAgents } from './runningAgentRows';

import type { Chat, Run } from '@clowdy/protocol';

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
 * The agents of the chat that work now, one row each above the message box (Reforma's `ChatComposerSubagents`): who it is, what it does, how
 * many tools it called. A row opens the agent's run, and Stop ends a spawned one. Nothing while no agent of the chat works.
 */
export function RunningAgents({ chat }: { chat: Chat }) {
    const project = useProjectState();
    const agents = runningAgents(project.runs.values(), chat.orchestratorRunId);
    const hidden = agents.length - MAX_AGENT_ROWS;

    if (agents.length === 0) return null;

    return (
        <ComposerBanner role="group" aria-label="Agents at work">
            { agents.slice(0, MAX_AGENT_ROWS).map(run => <AgentRow key={ run.id } run={ run } />) }
            { hidden > 0 && <ComposerBannerStatus icon={ <Robot /> }>{ `${ hidden } more ${ hidden === 1 ? 'agent' : 'agents' } at work` }</ComposerBannerStatus> }
        </ComposerBanner>
    );
}
