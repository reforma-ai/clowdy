import { useRunStream } from '../stores';
import { latestActivity } from './subagents';

import type { RunId } from '@clowdy/protocol';

/**
 * What a working agent does now and how many tools it has called, from its run's stream. Pass a run only while it works: its stream is fetched
 * then, and a finished agent's card says `Finished` without fetching anything.
 */
export function useAgentActivity(runId: RunId | undefined): { activity?: string; calls: number } {
    const items = useRunStream(runId)?.items ?? [];

    return { activity: latestActivity(items), calls: items.filter(item => item.body.kind === 'tool').length };
}
