import { Shimmer } from '@clowdy/components/Shimmer';
import { Text } from '@clowdy/components/Text';
import { Message } from '@clowdy/icons/14';
import { ProgressLoader } from '@clowdy/icons/assets';
import { isTerminalRunStatus, type StreamItemBody } from '@clowdy/protocol';

import { useProjectState, useProjectUi } from '../stores';
import styles from './SubagentCard.module.css';
import { agentPurpose, agentStatusLine, childOfCall, subagentLabel, subagentName, subagentTitle } from './subagents';
import { useAgentActivity } from './useAgentActivity';

type ToolBody = Extract<StreamItemBody, { kind: 'tool' }>;

interface AgentCardProps {
    title: string;
    /** The line under the title: what the agent does, or how it ended. */
    line?: string;
    error?: string;
    /** The agent works: a loader and a shimmering title. */
    running: boolean;
    /** The title says something went wrong without words of its own (a call that never finished). */
    muted?: boolean;
    /** Opens the agent's run. Without it the card is not pressable. */
    onOpen?: () => void;
}

/**
 * The frame of an agent's card (Reforma's agent card): a loader while the agent works and a message mark after, the title, one line of
 * activity, an error in red. The whole card opens the agent's run when there is one; nothing in it expands, the run is where the work is.
 */
function AgentCard({ title, line, error, running, muted, onOpen }: AgentCardProps) {
    const content = (
        <>
            <span className={styles.icon} aria-hidden>
                {running ? <ProgressLoader size={14} /> : <Message />}
            </span>
            <span className={styles.text}>
                <span className={styles.titleLine}>
                    {running ? (
                        <Shimmer as="span" className={styles.title} duration={1}>
                            {title}
                        </Shimmer>
                    ) : (
                        <Text className={styles.title} color={muted ? 'secondary' : undefined}>
                            {title}
                        </Text>
                    )}
                </span>
                {line && (
                    <Text variant="sm" color="secondary" truncate>
                        {line}
                    </Text>
                )}
                {error && (
                    <Text variant="xs" color="danger" className={styles.error}>
                        {error}
                    </Text>
                )}
            </span>
        </>
    );

    return (
        <div className={styles.card} data-slot="agent-card" aria-busy={running || undefined}>
            {onOpen ? (
                <button
                    type="button"
                    className={styles.body}
                    aria-label={[title, line].filter(Boolean).join('. ')}
                    onClick={onOpen}
                >
                    {content}
                </button>
            ) : (
                <div className={styles.body}>{content}</div>
            )}
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
 * An agent's own sub-agent, on the call that started it: its purpose (the line its agent gave it) with what the sub-agent does while it runs, `Finished` after; a sub-agent with no purpose reads `Exploring`, then `Ran Explore agent`.
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
            // What the sub-agent was asked to do is its name, as the list and its page call it; the type and the verb are for a card whose agent gave none.
            title={
                stalled ? 'The agent did not finish' : ((child && agentPurpose(child)) ?? subagentTitle(label, live))
            }
            line={agentStatusLine({ live, failed, stalled, activity })}
            error={failed ? call.error?.trim() || 'The agent failed' : undefined}
            running={live}
            muted={stalled}
            onOpen={child && (() => ui.openRun(child.id))}
        />
    );
}
