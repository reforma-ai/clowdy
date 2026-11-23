import { isCommitScope, isRunScope } from './changeScopes';

import type { GitBaseState } from '@clowdy/protocol';
import type { PlaceChanges } from './PlaceChanges';

/** What the reading area of the tab shows: the cards, or one of the states that stand in for them. */
export type ListState =
    /** The first read of the list is on its way. */
    | { kind: 'loading' }
    /** The place is a folder that is not a git repository. */
    | { kind: 'notRepository' }
    /** The list could not be read and there is none from before to show instead. */
    | { kind: 'failed'; message: string }
    /** The scope has no changed file: `title` says so, `description` says why when it helps. */
    | { kind: 'empty'; title: string; description?: string }
    /** The scope has files and the filter lets none of them through. */
    | { kind: 'filtered' }
    /** The files the filter lets through are all viewed, and the toggle that hides the viewed ones is on. */
    | { kind: 'allViewed' }
    /** The cards. */
    | { kind: 'files' };

/** The titles and sentences of the states, in one place so the view and its tests say the same words. */
export const LIST_TEXT = {
    loading: 'Loading',
    notRepository: 'Not a git repository',
    notRepositoryHint: 'Changes show here once the folder is one',
    failed: "Couldn't read the changes",
    noChanges: 'No changes',
    filtered: 'No files match the filter',
    filteredHint: 'Try another pattern, or clear the filter',
    allViewed: 'Every file is viewed',
    allViewedHint: 'Show the viewed files to read a diff again',
} as const;

/** Why the changes of the branch could not be counted against a base, when the base is not there. */
export function baseStateWords(state: GitBaseState | undefined): string | undefined {
    switch (state) {
        case 'unborn':
            return 'The branch has no commits yet';
        case 'no_base':
            return 'There is no base branch to compare with yet';
        case 'no_merge_base':
            return 'The branch shares no history with its base';
        default:
            return undefined;
    }
}

/**
 * What the reading area shows for the place's list. A place that the status says is no repository has its own state before anything is read of its changes. A list that failed to
 * be read leaves the last one on show, and the failure is the state only while there is none. A scope with no file says why: a clean tree against a base, nothing committed,
 * no base to count from. With the viewed files hidden, a list whose files are all viewed says so in place of saying that the filter lets nothing through.
 */
export function listStateOf(model: PlaceChanges): ListState {
    if (model.isRepository === false) return { kind: 'notRepository' };

    const { changes, list } = model;

    if (!changes)
        return list.settled && list.error !== undefined ? { kind: 'failed', message: list.error } : { kind: 'loading' };

    if (changes.fileCount === 0 && changes.files.length === 0) {
        const { scope } = changes;
        const base = model.base?.state === 'ready' ? model.base : undefined;
        const missing = baseStateWords(changes.baseState);

        if (scope === 'branch')
            return { kind: 'empty', title: LIST_TEXT.noChanges, description: 'Nothing is committed on the branch yet' };

        if (scope === 'uncommitted')
            return { kind: 'empty', title: LIST_TEXT.noChanges, description: 'Everything is committed' };

        if (isCommitScope(scope))
            return { kind: 'empty', title: LIST_TEXT.noChanges, description: 'This commit changes no files' };

        if (isRunScope(scope))
            return { kind: 'empty', title: LIST_TEXT.noChanges, description: 'That run changed no files' };

        return {
            kind: 'empty',
            title: LIST_TEXT.noChanges,
            ...(missing ? { description: missing } : base ? { description: `Nothing differs from ${base.name}` } : {}),
        };
    }

    if (model.files.length > 0) return { kind: 'files' };

    return model.hideViewed && model.matchingFiles.length > 0 ? { kind: 'allViewed' } : { kind: 'filtered' };
}
