import { useEffect } from 'react';

import { useRootStore } from '../../stores';
import { isPlaceReady, type Place } from '../sidePanel/currentPlace';
import { type GitFacts, type GitPlaceKey, gitFactsOf, type PlaceFacts } from './gitFacts';

import type { ProjectId } from '@clowdy/protocol';

/** The git facts of the app. */
export function useGitFactsStore(): GitFacts {
    return gitFactsOf(useRootStore().transport);
}

/**
 * The git facts of a place of a project, read for as long as the component is drawn (the store counts the readers, so the rail's summary and the Changes tab are one). Nothing for a
 * worktree that is not made yet, and nothing for no place or no project at all. What it gives back is the place's own: while another place is on show it is never that one's answer.
 *
 * The store starts a round of reads for the first reader of a place only, and the rail's summary keeps the place it shows observed, so a view that comes to it later (the Changes
 * tab, which lists files the facts do not keep and reads them again for each round) would be as old as the last round. A reader that comes to a place somebody reads already asks
 * for a round when none is on its way, as it had one when it was the first to look.
 */
export function useGitFacts(projectId: ProjectId | undefined, place: Place | undefined): PlaceFacts | undefined {
    const store = useGitFactsStore();
    const key: GitPlaceKey | undefined =
        projectId && place && isPlaceReady(place)
            ? { projectId, folderId: place.folder.id, ...(place.workspace && { workspaceId: place.workspace.id }) }
            : undefined;
    const facts = key && store.of(key);

    useEffect(() => {
        if (!facts) return undefined;

        const round = facts.generation;
        const release = store.observe(facts.key);

        // Nothing began a round for this reader and none is under way: the answer it finds is from before it came.
        if (facts.generation === round && !facts.status.loading) store.refresh(facts.key);

        return release;
    }, [store, facts]);

    return facts;
}
