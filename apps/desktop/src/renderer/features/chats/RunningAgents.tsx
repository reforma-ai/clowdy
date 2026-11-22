import { Shimmer } from '@clowdy/components/Shimmer';
import { BackgroundTask, Robot, Split, Terminal } from '@clowdy/icons/14';
import { shownRunStatus } from '@clowdy/protocol';

import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { useAgentActivity } from '../../stream/useAgentActivity';
import { openChat } from './archiveChat';
import { perform } from './commands';
import { ComposerBanner, ComposerBannerHeader, ComposerBannerStatus } from './ComposerBanner';
import {
    agentRowLabel,
    agentRowText,
    backgroundItemText,
    backgroundRows,
    backgroundRowText,
    canStopAlone,
    MAX_AGENT_ROWS,
    offersStopAll,
    openBackground,
    runningAgents,
    stripRows,
    threadRowText,
    threadsAtWork,
    type StripRow,
    type ThreadAtWork,
} from './runningAgentRows';

import type { BackgroundItem, Chat, Run, RunId } from '@clowdy/protocol';

function AgentRow({ run }: { run: Run }) {
    const root = useRootStore();
    const ui = useProjectUi();
    const waiting = shownRunStatus(run) === 'waiting_user';
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
 * A thread of the chat at work: its title and what it does. The row opens the thread's chat; Stop ends that thread alone (`run.cancel` of its
 * orchestrator, which holds the thread's queue as the person's Stop on a chat does) and leaves this chat and its other threads going.
 */
function ThreadRow({ chat, run }: ThreadAtWork) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const working = shownRunStatus(run) === 'running';
    const { activity } = useAgentActivity(working ? run.id : undefined);
    const text = threadRowText(chat, run, activity);

    return (
        <ComposerBannerStatus
            icon={ <Split /> }
            action="Stop"
            onAction={ () => void perform(root, { type: 'run.cancel', runId: run.id }) }
            onPress={ () => void openChat(root, project, ui, chat.id) }
            pressLabel={ `Open ${ chat.title }. ${ text }` }
        >
            { working ? <Shimmer duration={ 1 }>{ text }</Shimmer> : text }
        </ComposerBannerStatus>
    );
}

/**
 * The line over the rows. Stop all stops every sub-agent that can stop alone and lets the orchestrator go on, knowing they were stopped
 * (`run.stopAgents`), and stops every thread at work (one `run.cancel` each): unlike the composer's Stop, which ends the whole run. It is there
 * when two or more rows have a Stop of their own. Its chevron folds the rows away (`ProjectUi.agentsFolded`), and the line then says how many agents
 * are at work.
 */
function AgentsHeader({ orchestrator, agents, threads }: { orchestrator: Run | undefined; agents: readonly Run[]; threads: readonly ThreadAtWork[] }) {
    const root = useRootStore();
    const ui = useProjectUi();
    const folded = ui.agentsFolded;
    const stopAll = offersStopAll(agents, threads.length);

    const stop = () => {
        if (orchestrator && agents.some(canStopAlone)) void perform(root, { type: 'run.stopAgents', runId: orchestrator.id });

        threads.forEach(({ run }) => void perform(root, { type: 'run.cancel', runId: run.id }));
    };

    return (
        <ComposerBannerHeader
            action={ stopAll ? 'Stop all' : undefined }
            onAction={ stopAll ? stop : undefined }
            collapsed={ folded }
            onToggle={ () => ui.toggleAgentsFolded() }
            toggleLabel={ folded ? 'Show agents' : 'Hide agents' }
        >
            { folded ? `Agents running · ${ agents.length + threads.length }` : 'Agents running' }
        </ComposerBannerHeader>
    );
}

/**
 * One background item the person can stop alone: a command the agent lets be cancelled. Its Stop ends that item and nothing else, the run and its other work
 * go on (`run.stopBackground`), and the agent is told. Not pressable, since there is no run of its own to open, and not an agent: it does not open the
 * header over the agents' rows and is not part of its Stop all.
 */
function BackgroundItemRow({ runId, item }: { runId: RunId; item: BackgroundItem }) {
    const root = useRootStore();

    return (
        <ComposerBannerStatus
            icon={ <Terminal /> }
            action="Stop"
            onAction={ () => void perform(root, { type: 'run.stopBackground', runId, itemId: item.id }) }
        >
            <Shimmer duration={ 1 }>{ backgroundItemText(item) }</Shimmer>
        </ComposerBannerStatus>
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

function Row({ row }: { row: StripRow }) {
    return row.kind === 'agent' ? <AgentRow run={ row.run } /> : <ThreadRow chat={ row.chat } run={ row.run } />;
}

/**
 * The work of the chat that goes on now, one row each above the message box (Reforma's `ChatComposerSubagents`): under a line that says "Agents running"
 * (with Stop all when two or more rows can stop alone), the native sub-agents of the orchestrator and the threads of the chat that work, oldest
 * first, each with who it is and what it does (a sub-agent's row opens its run, a thread's row opens the thread's chat; Stop ends that one alone), then
 * a row for each background command the agent lets the person stop alone (its own Stop ends that command only), then one row that counts the rest of
 * the background work the orchestrator has open. Each thing is in one row: a sub-agent with a child run is its row, not a count. Nothing while there is
 * none of these. The chevron of the line folds all the rows under it away; without agents or threads there is no line, so no fold, and the background
 * rows show.
 */
export function RunningAgents({ chat }: { chat: Chat }) {
    const project = useProjectState();
    const ui = useProjectUi();
    const agents = runningAgents(project.runs.values(), chat.orchestratorRunId);
    const threads = threadsAtWork(project.threadsOf(chat.id), project.runs);
    const rows = stripRows(agents, threads);
    const orchestrator = chat.orchestratorRunId === undefined ? undefined : project.runs.get(chat.orchestratorRunId);
    // A sub-agent with a child run is one of the rows above, and is not counted again here; a command that can be stopped alone has a row of its own.
    const { own, counted: background } = backgroundRows(openBackground(orchestrator), agents);
    const hidden = rows.length - MAX_AGENT_ROWS;
    const folded = ui.agentsFolded && rows.length > 0;

    if (rows.length === 0 && own.length === 0 && background.length === 0) return null;

    return (
        <ComposerBanner role="group" aria-label="Work in progress">
            { rows.length > 0 && <AgentsHeader orchestrator={ orchestrator } agents={ agents } threads={ threads } /> }
            { !folded && rows.slice(0, MAX_AGENT_ROWS).map(row => <Row key={ row.id } row={ row } />) }
            { !folded && hidden > 0 && <ComposerBannerStatus icon={ <Robot /> }>{ `${ hidden } more ${ hidden === 1 ? 'agent' : 'agents' } at work` }</ComposerBannerStatus> }
            { !folded && orchestrator && own.map(item => <BackgroundItemRow key={ item.id } runId={ orchestrator.id } item={ item } />) }
            { !folded && orchestrator && background.length > 0 && <BackgroundRow runId={ orchestrator.id } count={ background.length } /> }
        </ComposerBanner>
    );
}
