import { filesWords } from './gitSummary';
import { baseStateWords } from './listState';

import type { GitChangedFile } from '@clowdy/protocol';
import type { RepositoryChanges } from './PlaceChanges';

/** What the line under the filter says of the list: how many files and lines, and what to know about the list. */
export interface ChangesSummary {
    /** `16 files`, or `3 of 16 files` while the filter hides some. */
    files: string;
    /** `+491` and `−38`, with a real minus sign as the tool cards write it: of every file, or of the ones the filter shows. */
    additions: string;
    deletions: string;
    /** Some file's lines were not counted, so the numbers are a lower bound. */
    incomplete: boolean;
    /** What else to say, each a phrase: the list was cut, or the scope has no base to count from. */
    notes: string[];
}

/**
 * The summary line of a list. With the filter on, the numbers are those of the files it shows, against all the files the daemon listed; the totals of the list itself (which count
 * what the daemon cut off too) are shown when nothing is filtered. The notes say that the list holds only the first files of a larger one (`truncated`), and, for the scope that is
 * counted against the base, why there is none when the base is not there.
 */
export function summaryOf(changes: RepositoryChanges, shown: readonly GitChangedFile[]): ChangesSummary {
    const filtered = shown.length !== changes.files.length;
    const additions = filtered ? shown.reduce((sum, file) => sum + (file.additions ?? 0), 0) : changes.additions;
    const deletions = filtered ? shown.reduce((sum, file) => sum + (file.deletions ?? 0), 0) : changes.deletions;
    const notes: string[] = [];

    if (changes.truncated) notes.push(`Showing the first ${ changes.files.length } files`);

    if (changes.scope === 'all') {
        const missing = baseStateWords(changes.baseState);

        if (missing) notes.push(missing);
    }

    return {
        files: filtered ? `${ shown.length } of ${ filesWords(changes.files.length) }` : filesWords(changes.fileCount),
        additions: `+${ additions }`,
        deletions: `−${ deletions }`,
        incomplete: !changes.statsComplete,
        notes,
    };
}
