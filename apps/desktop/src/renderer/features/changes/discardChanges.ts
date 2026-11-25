import { gitFactsOf, placeRef } from './gitFacts';

import type { GitDiscardResult } from '@clowdy/protocol';
import type { Transport } from '../../daemon/transport';
import type { PlaceChanges } from './PlaceChanges';

/**
 * Discards the changes of one file of a place (`POST git/discard`): the file goes back to the last commit, or is deleted when git does not have it. The place's
 * git facts are read again afterwards, and so are the lists of the tab, which follow the facts' next round (`GitFacts.refresh`, as a commit does): the status, the counts, the uncommitted list
 * and the scope's list, so the file's card and its row go when the file is no longer changed. It is read again whether the daemon said yes or no: a discard that failed may have done part of
 * what it was asked (a restore that git stopped half way, a new file that was left because it was written to meanwhile). Rejects with the daemon's own line for the dialog to show; a discard is asked once and not retried.
 * A `Viewed` mark needs no clearing: it holds the revision the file was marked at, and a file that is back at the last commit is not listed any more, or is listed with another revision, so the mark
 * no longer counts.
 */
export async function discardChanges(
    model: PlaceChanges,
    transport: Transport,
    path: string
): Promise<GitDiscardResult> {
    const { key } = model.facts;

    try {
        return await transport.discardGit(key.projectId, placeRef(key), [path]);
    } finally {
        gitFactsOf(transport).refresh(key);
    }
}
