import { Marker, MarkerContent, MarkerIcon } from '@clowdy/components/Marker';
import { Tooltip } from '@clowdy/components/Tooltip';
import { Collapse } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';
import { STOPPED_TOOL } from '@clowdy/protocol';

import { formatTokens } from '../shared/tokens';
import styles from './CompactionLine.module.css';
import { compactionCounts } from './compaction';

import type { StreamItemBody } from '@clowdy/protocol';

type ToolBody = Extract<StreamItemBody, { kind: 'tool' }>;

export interface CompactionLineProps {
    /** The agent's compaction call (`compact`). */
    call: ToolBody;
    /** The stream's run is going: a call that is still running is live, not left unfinished. */
    active: boolean;
}

/** What the line says once the compaction is over: `Context compacted · 22K → 6K`, the counts when the agent reported them. */
function doneText(output: unknown): string {
    const counts = compactionCounts(output);

    return counts
        ? `Context compacted · ${formatTokens(counts.before)} → ${formatTokens(counts.after)}`
        : 'Context compacted';
}

/**
 * The agent compacting its context, as one quiet line instead of a tool card (Reforma's compaction notice): a shimmer while it runs, what it saved
 * after, and a line in the danger tone when it failed, with the reason on hover. One the person stopped is not a failure and stays quiet. The agents
 * report it as a tool call, the daemon names it `compact`.
 */
export function CompactionLine({ call, active }: CompactionLineProps) {
    const live = call.state === 'running' && active;
    const stopped = call.state === 'error' && call.error === STOPPED_TOOL;
    const failed = call.state === 'error' && !stopped;

    return (
        <Marker className={cn(styles.line, failed && styles.failed)} role="status">
            <MarkerIcon>
                <Collapse />
            </MarkerIcon>
            {live && <MarkerContent shimmer>Compacting context</MarkerContent>}
            {call.state === 'done' && <MarkerContent>{doneText(call.output)}</MarkerContent>}
            {stopped && <MarkerContent>Compaction stopped</MarkerContent>}
            {failed && (
                <Tooltip content={call.error?.trim() || 'The agent could not compact its context'} wrapTrigger>
                    <MarkerContent>Compaction failed</MarkerContent>
                </Tooltip>
            )}
            {call.state === 'running' && !active && <MarkerContent>Compaction did not finish</MarkerContent>}
        </Marker>
    );
}
