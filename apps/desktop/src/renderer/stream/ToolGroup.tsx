import { useState } from 'react';

import { ReasoningLine } from './ReasoningLine';
import { ToolCard } from './ToolCard';
import { summarizeTools } from './toolGroups';
import { Worked } from './Worked';
import { WorkingLine } from './WorkingLine';

import type { StreamItem } from '@clowdy/protocol';

export interface ToolGroupProps {
    /** The calls of the run and the thoughts between them, in order: tool and reasoning items only (`groupToolRuns`). */
    items: StreamItem[];
    /** This group is at the end of the stream while the agent is working. */
    live?: boolean;
}

/**
 * A run of tool calls, and the thoughts between them, behind one line that says what the calls did (`Ran 18 commands, explored 3 files`), so a turn reads as
 * its phases and not as a list of commands. A closed live group previews the most recent call still running.
 */
export function ToolGroup({ items, live = false }: ToolGroupProps) {
    const [open, setOpen] = useState(false);
    const calls = items.flatMap(item => (item.body.kind === 'tool' ? [item.body] : []));
    const running = live && !open ? calls.findLast(call => call.state === 'running') : undefined;

    return (
        <>
            <Worked label={summarizeTools(calls)} open={open} onOpenChange={setOpen} ruled>
                {items.map(item => {
                    if (item.body.kind === 'tool') return <ToolCard key={item.id} call={item.body} />;

                    return item.body.kind === 'reasoning' ? <ReasoningLine key={item.id} body={item.body} /> : null;
                })}
            </Worked>
            {live && <WorkingLine tool={running} />}
        </>
    );
}
