import { use } from 'react';

import { useProjectState } from '../stores';
import { StreamLinksContext } from './StreamLinks';
import {
    agentActivityLine,
    agentOutcome,
    agentPurpose,
    agentReport,
    childOfCall,
    subagentLabel,
    subagentName,
    subagentTitle,
} from './subagents';
import { AgentCard } from './ThreadCards';
import { useAgentActivity } from './useAgentActivity';

import type { StreamItemBody } from '@clowdy/protocol';

type ToolBody = Extract<StreamItemBody, { kind: 'tool' }>;

export interface SubagentCardProps {
    /** An agent's own sub-agent call: `Agent`, `Task`, `spawnAgent`, `spawn_subagent`. */
    call: ToolBody;
    /** The stream's run is going: a call that is still running may be live, not left unfinished. */
    active: boolean;
}

/**
 * An agent's own sub-agent, on the call that started it, drawn as a thread that stopped is (`AgentCard`): its name (what it was asked to do, the line its agent gave it; a sub-agent with
 * no purpose is `Explore agent`, and `Exploring` while it works) with what it does while it runs, then how it ended and its report.
 * When the agent reported the sub-agent's work, the daemon made a native child run under this call, which the activity and the report come from and a press
 * opens; an agent that reported nothing leaves a card that only says it ran.
 */
export function SubagentCard({ call, active }: SubagentCardProps) {
    const project = useProjectState();
    const { onOpenRun } = use(StreamLinksContext);
    const child = childOfCall(project.runs.values(), call.toolCallId);
    // The child run, when there is one, says how it ended; a call that never ended is over once its run is, though the run may work again.
    const outcome = agentOutcome(call, child, active);
    const live = outcome === undefined;
    const { activity } = useAgentActivity(live ? child?.id : undefined);
    // Only the call names the type: the child's own name is the same, or the daemon's placeholder for a call that names none.
    const label = subagentLabel(subagentName(call.input));

    return (
        <AgentCard
            // What the sub-agent was asked to do is its name, as the list and its page call it; the type and the verb are for a card whose agent gave none.
            name={(child && agentPurpose(child)) ?? subagentTitle(label, live)}
            outcome={outcome}
            activity={live ? agentActivityLine(activity) : undefined}
            report={agentReport(outcome, call, child)}
            onOpen={child && onOpenRun && (() => onOpenRun(child.id))}
        />
    );
}
