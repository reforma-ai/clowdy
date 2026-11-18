import { Shimmer } from '@clowdy/components/Shimmer';
import { Text } from '@clowdy/components/Text';
import { Message } from '@clowdy/icons/14';
import { ProgressLoader } from '@clowdy/icons/assets';
import { isTerminalRunStatus, type Run, type StreamItemBody } from '@clowdy/protocol';

import { RUN_STATUS_VIEW, RunStatusPill } from '../shared';
import { useProjectState, useProjectUi } from '../stores';
import styles from './SubagentCard.module.css';
import { agentStatusLine, childOfCall, spawnedRunId, subagentLabel, subagentName, subagentTitle } from './subagents';
import { useAgentActivity } from './useAgentActivity';

import type { ReactNode } from 'react';

type ToolBody = Extract<StreamItemBody, { kind: 'tool' }>;

interface AgentCardProps {
    title: string;
    /** Muted words after the title on its line, such as what a spawned run works on. */
    aside?: string;
    /** The line under the title: what the agent does, or how it ended. */
    line?: string;
    error?: string;
    /** The agent works: a loader and a shimmering title. */
    running: boolean;
    /** The title says something went wrong without words of its own (a call that never finished). */
    muted?: boolean;
    /** At the end of the title's line: a spawned run's status. */
    trailing?: ReactNode;
    /** Opens the agent's run. Without it the card is not pressable. */
    onOpen?: () => void;
}

/**
 * The frame both agent cards share (Reforma's agent card): a loader while the agent works and a message mark after, the title, one line of
 * activity, an error in red. The whole card opens the agent's run when there is one; nothing in it expands, the run is where the work is.
 */
function AgentCard({ title, aside, line, error, running, muted, trailing, onOpen }: AgentCardProps) {
    const content = (
        <>
            <span className={ styles.icon } aria-hidden>{ running ? <ProgressLoader size={ 14 } /> : <Message /> }</span>
            <span className={ styles.text }>
                <span className={ styles.titleLine }>
                    { running
                        ? <Shimmer as="span" className={ styles.title } duration={ 1 }>{ title }</Shimmer>
                        : <Text className={ styles.title } color={ muted ? 'secondary' : undefined }>{ title }</Text> }
                    { aside && <Text color="secondary" truncate className={ styles.aside }>{ aside }</Text> }
                    { trailing && <span className={ styles.trailing }>{ trailing }</span> }
                </span>
                { line && <Text variant="sm" color="secondary" truncate>{ line }</Text> }
                { error && <Text variant="xs" color="danger" className={ styles.error }>{ error }</Text> }
            </span>
        </>
    );

    return (
        <div className={ styles.card } data-slot="agent-card" aria-busy={ running || undefined }>
            { onOpen
                ? (
                    <button type="button" className={ styles.body } aria-label={ [title, aside, line].filter(Boolean).join('. ') } onClick={ onOpen }>
                        { content }
                    </button>
                )
                : <div className={ styles.body }>{ content }</div> }
        </div>
    );
}

export interface SubagentCardProps {
    /** An agent's own sub-agent call: `Agent`, `Task`, `spawnAgent`, `spawn_subagent`. */
    call: ToolBody;
    /** The stream's run is going: a call that is still running may be live, not left unfinished. */
    active: boolean;
}

/**
 * An agent's own sub-agent, on the call that started it: `Exploring` with what the sub-agent does while it runs, `Ran Explore agent` after.
 * When the agent reported the sub-agent's work, the daemon made a native child run under this call, which the activity comes from and a press
 * opens; an agent that reported nothing leaves a card that only says it ran.
 */
export function SubagentCard({ call, active }: SubagentCardProps) {
    const project = useProjectState();
    const ui = useProjectUi();
    const child = childOfCall(project.runs.values(), call.toolCallId);
    const failed = call.state === 'error';
    // A call that never ended is over once its run is, or once its child ended with the turn (a stop or a retry), though the run works again.
    const stalled = call.state === 'running' && (!active || (child !== undefined && isTerminalRunStatus(child.status)));
    const live = call.state === 'running' && !stalled;
    const { activity } = useAgentActivity(live ? child?.id : undefined);
    // Only the call names the type: the child's own name is the same, or the daemon's placeholder for a call that names none.
    const label = subagentLabel(subagentName(call.input));

    return (
        <AgentCard
            title={ stalled ? 'The agent did not finish' : subagentTitle(label, live) }
            line={ agentStatusLine({ live, failed, stalled, activity }) }
            error={ failed ? call.error?.trim() || 'The agent failed' : undefined }
            running={ live }
            muted={ stalled }
            onOpen={ child && (() => ui.openRun(child.id)) }
        />
    );
}

/** How a spawned run that is not working says where it is: `Finished`, why it waits, why it stopped. */
function runLine(run: Run): string | undefined {
    if (run.status === 'succeeded') return 'Finished';

    if (run.status === 'failed') return undefined;

    return run.statusReason ?? RUN_STATUS_VIEW[run.status].label;
}

/**
 * A child Clowdy started with `run_spawn`, on that call: the child's name and what it works on, its status, what it does while it works, and a
 * press that opens it. The call returns at once with the child's id, so everything after that is the child run's own, live from the project.
 */
export function SpawnCard({ call }: { call: ToolBody }) {
    const project = useProjectState();
    const ui = useProjectUi();
    const runId = call.state === 'done' ? spawnedRunId(call.output) : undefined;
    const child = runId ? project.runs.get(runId) : undefined;
    const working = child?.status === 'running';
    const { activity } = useAgentActivity(working ? child.id : undefined);

    if (call.state === 'running') return <AgentCard title="Starting an agent" running />;

    if (call.state === 'error') return <AgentCard title="Could not start an agent" error={ call.error?.trim() || 'The daemon refused the agent' } running={ false } muted />;

    // The run is gone (its chat was cleared) or the agent mangled the result: the call still says an agent was started.
    if (!child) return <AgentCard title="Started an agent" running={ false } />;

    return (
        <AgentCard
            title={ child.name }
            aside={ child.summary || undefined }
            line={ working ? activity ?? 'Starting…' : runLine(child) }
            error={ child.status === 'failed' ? child.error ?? child.statusReason ?? 'The run failed' : undefined }
            running={ working }
            trailing={ <RunStatusPill status={ child.status } reason={ child.statusReason } /> }
            onOpen={ () => ui.openRun(child.id) }
        />
    );
}
