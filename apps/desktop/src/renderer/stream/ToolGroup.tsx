import { useState } from 'react';

import { ReasoningLine } from './ReasoningLine';
import { ToolCard } from './ToolCard';
import { summarizeTools } from './toolGroups';
import { Worked } from './Worked';

import type { StreamItem } from '@clowdy/protocol';

export interface ToolGroupProps {
    /** The calls of the run and the thoughts between them, in order: tool and reasoning items only (`groupToolRuns`). */
    items: StreamItem[];
    /** The run is what the agent is doing now, the end of the stream while it works: its calls show. Once the agent goes on to something else the group closes. */
    live?: boolean;
}

/**
 * A run of tool calls, and the thoughts between them, behind one line that says what the calls did (`Ran 18 commands, explored 3 files`), so a turn reads as
 * its phases and not as a list of commands. Closed while it is over; open while it is the live end of the stream, so the person can watch the calls run. A press on the line decides for good.
 */
export function ToolGroup({ items, live = false }: ToolGroupProps) {
    const [chosen, setChosen] = useState<boolean>();
    const calls = items.flatMap(item => (item.body.kind === 'tool' ? [item.body] : []));

    return (
        <Worked label={ summarizeTools(calls) } open={ chosen ?? live } onOpenChange={ setChosen } shimmer={ calls.some(call => call.state === 'running') } ruled>
            { items.map((item) => {
                if (item.body.kind === 'tool') return <ToolCard key={ item.id } call={ item.body } />;

                return item.body.kind === 'reasoning' ? <ReasoningLine key={ item.id } body={ item.body } /> : null;
            }) }
        </Worked>
    );
}
