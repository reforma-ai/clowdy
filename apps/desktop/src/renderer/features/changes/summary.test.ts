import { describe, expect, it } from 'vitest';

import { summaryOf } from './summary';

import type { GitChangedFile } from '@clowdy/protocol';
import type { RepositoryChanges } from './PlaceChanges';

const file = (path: string, additions: number, deletions: number): GitChangedFile => ({
    path,
    kind: 'modified',
    additions,
    deletions,
    revision: 'r',
});

const files = [file('a.ts', 100, 10), file('b.md', 30, 8), file('c.ts', 5, 0)];
const changes = (more: Partial<RepositoryChanges> = {}): RepositoryChanges => ({
    isRepository: true,
    scope: 'all',
    files,
    fileCount: 3,
    additions: 135,
    deletions: 18,
    statsComplete: true,
    baseState: 'ready',
    ...more,
});

describe('the summary of a list', () => {
    it('is the files and the lines of the whole list, with a real minus sign', () => {
        expect(summaryOf(changes(), files)).toEqual({
            files: '3 files',
            additions: '+135',
            deletions: '−18',
            incomplete: false,
            notes: [],
        });
        expect(
            summaryOf(changes({ files: [files[0]!], fileCount: 1, additions: 100, deletions: 10 }), [files[0]!]).files
        ).toBe('1 file');
    });

    it('counts the files of the filter against all of them, and the lines of the ones it shows', () => {
        expect(summaryOf(changes(), [files[0]!, files[2]!])).toMatchObject({
            files: '2 of 3 files',
            additions: '+105',
            deletions: '−10',
        });
        expect(summaryOf(changes(), [])).toMatchObject({ files: '0 of 3 files', additions: '+0', deletions: '−0' });
    });

    it('takes the totals of the daemon for a list it cut, and says it shows only the first files', () => {
        const cut = summaryOf(changes({ fileCount: 731, additions: 4100, deletions: 880, truncated: true }), files);

        expect(cut).toMatchObject({ files: '731 files', additions: '+4100', deletions: '−880' });
        expect(cut.notes).toEqual(['Showing the first 3 files']);
    });

    it('says how many of the listed files are viewed when some are, whatever the filter shows', () => {
        expect(summaryOf(changes(), files)).not.toHaveProperty('viewed');
        expect(summaryOf(changes(), files, 0)).not.toHaveProperty('viewed');
        expect(summaryOf(changes(), files, 2).viewed).toBe('2 viewed');
        expect(summaryOf(changes(), [files[0]!], 1)).toMatchObject({ files: '1 of 3 files', viewed: '1 viewed' });
        // The daemon cut the list: the files that can be viewed are the ones it lists.
        expect(summaryOf(changes({ fileCount: 731, truncated: true }), files, 3).viewed).toBe('3 viewed');
    });

    it('says the lines are a lower bound when some were not counted', () => {
        expect(summaryOf(changes({ statsComplete: false }), files).incomplete).toBe(true);
    });

    it('says why there is no base, for the scope that is counted against it, and for no other', () => {
        expect(summaryOf(changes({ baseState: 'no_base' }), files).notes).toEqual([
            'There is no base branch to compare with yet',
        ]);
        expect(summaryOf(changes({ baseState: 'unborn' }), files).notes).toEqual(['The branch has no commits yet']);
        expect(summaryOf(changes({ scope: 'uncommitted', baseState: undefined }), files).notes).toEqual([]);
        expect(summaryOf(changes({ truncated: true, baseState: 'no_base' }), files).notes).toEqual([
            'Showing the first 3 files',
            'There is no base branch to compare with yet',
        ]);
    });
});
