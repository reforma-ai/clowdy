import { useProjectState } from '../stores';
import { runLabel } from './runLabel';

import type { Run } from '@clowdy/protocol';

/** `runLabel` over the chats of the open project: a function that names any run the way the person reads it. */
export function useRunLabel(): (run: Pick<Run, 'id' | 'name' | 'origin'>) => string {
    const { chats } = useProjectState();

    return run => runLabel(run, chats.values());
}
