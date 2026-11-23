import { useEffect, useState } from 'react';

import { useRootStore } from '../../stores';
import { placeRef } from '../changes/gitFacts';

import type { GitChanges, GitScope, ProjectId } from '@clowdy/protocol';
import type { Place } from '../sidePanel/currentPlace';

/** How many answers are kept for a window: a run's list never changes (its scope is two trees), so an answer is read once, and a chat that is opened again shows its plate at once. */
const KEPT_ANSWERS = 32;

const kept = new WeakMap<object, Map<string, GitChanges>>();

/**
 * The files a run changed (`GET .../git/changes` for the run's scope), read once for each scope and place and kept: nothing ever makes the answer of a scope of two trees stale, so
 * there is no refresh. A scope that is not given reads nothing. A read that fails (a tree git has pruned, a daemon that does not answer) is no answer: nothing is drawn, and the next
 * time the plate is drawn it asks again. The answer is the place's own: one that is still on its way for another scope is never handed back.
 */
export function useLastRunChanges(projectId: ProjectId, place: Place, scope: GitScope | undefined): GitChanges | undefined {
    const { transport } = useRootStore();
    const key = scope && `${ projectId }/${ place.folder.id }/${ place.workspace?.id ?? '' }/${ scope }`;
    const [answer, setAnswer] = useState<{ key: string; changes: GitChanges | undefined }>();

    useEffect(() => {
        if (!key || !scope) return undefined;

        const answers = kept.get(transport) ?? new Map<string, GitChanges>();
        const known = answers.get(key);

        kept.set(transport, answers);

        if (known) {
            setAnswer({ key, changes: known });

            return undefined;
        }

        let current = true;

        transport.getGitChanges(projectId, placeRef({ projectId, folderId: place.folder.id, ...(place.workspace && { workspaceId: place.workspace.id }) }), scope).then(
            (changes) => {
                answers.set(key, changes);

                // The oldest answers go.
                for (const [oldest] of [...answers].slice(0, Math.max(0, answers.size - KEPT_ANSWERS))) answers.delete(oldest);

                if (current) setAnswer({ key, changes });
            },
            () => {
                if (current) setAnswer({ key, changes: undefined });
            }
        );

        return () => {
            current = false;
        };
    }, [transport, projectId, place.folder.id, place.workspace?.id, scope, key]);

    return answer?.key === key ? answer?.changes : undefined;
}
