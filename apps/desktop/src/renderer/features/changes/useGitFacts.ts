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
 * The git facts of a place of a project, read for as long as the component is drawn (the store counts the readers, so the strip and the Info tab are one). Nothing for a
 * worktree that is not made yet, and nothing for no place at all. What it gives back is the place's own: while another place is on show it is never that one's answer.
 */
export function useGitFacts(projectId: ProjectId, place: Place | undefined): PlaceFacts | undefined {
    const store = useGitFactsStore();
    const key: GitPlaceKey | undefined =
        place && isPlaceReady(place)
            ? { projectId, folderId: place.folder.id, ...(place.workspace && { workspaceId: place.workspace.id }) }
            : undefined;
    const facts = key && store.of(key);

    useEffect(() => (facts ? store.observe(facts.key) : undefined), [store, facts]);

    return facts;
}
