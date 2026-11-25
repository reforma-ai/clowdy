import { describe, expect, it } from 'vitest';

import { discardableFiles, discardWords } from './discardRules';

import type { GitChangedFile, GitChanges } from '@clowdy/protocol';

const file = (path: string, more: Partial<GitChangedFile> = {}): GitChangedFile => ({
    path,
    kind: 'modified',
    revision: `100644:${'1'.repeat(40)}:100644:${'2'.repeat(40)}`,
    ...more,
});

const listOf = (files: GitChangedFile[]): Extract<GitChanges, { isRepository: true }> => ({
    isRepository: true,
    scope: 'uncommitted',
    files,
    fileCount: files.length,
    additions: 0,
    deletions: 0,
    statsComplete: true,
});

describe('discardableFiles', () => {
    const uncommitted = listOf([
        file('a.ts'),
        file('new.ts', { kind: 'added', untracked: true }),
        file('gone.ts', { kind: 'deleted' }),
    ]);

    it('offers the uncommitted files in the scopes that list them, as their uncommitted entries, and in no other', () => {
        for (const scope of ['all', 'uncommitted'] as const) {
            expect([...discardableFiles(scope, uncommitted).keys()]).toEqual(['a.ts', 'new.ts', 'gone.ts']);
        }

        expect(discardableFiles('all', uncommitted).get('new.ts')).toMatchObject({ kind: 'added', untracked: true });

        for (const scope of ['branch', `commit:${'a'.repeat(40)}`] as const) {
            expect(discardableFiles(scope, uncommitted).size).toBe(0);
        }
    });

    it('offers nothing before the uncommitted files have been read', () => {
        expect(discardableFiles('all', undefined).size).toBe(0);
    });

    it('leaves out a file with merge conflicts and a submodule, which the daemon refuses', () => {
        const submodule = file('vendor/sub', { revision: `160000:${'3'.repeat(40)}:160000:${'4'.repeat(40)}` });
        const added = file('vendor/new-sub', {
            kind: 'added',
            revision: `000000:${'0'.repeat(40)}:160000:${'4'.repeat(40)}`,
        });
        const list = listOf([file('a.ts'), file('both.ts', { kind: 'conflicted' }), submodule, added]);

        expect([...discardableFiles('all', list).keys()]).toEqual(['a.ts']);
    });
});

describe('discardWords', () => {
    it('says a tracked file goes back to the last commit', () => {
        expect(discardWords(file('src/booking/price.ts'))).toEqual({
            title: 'Discard changes to price.ts?',
            body: 'The file goes back to the last commit',
        });
        expect(discardWords(file('src/limits.ts', { kind: 'typechange' })).body).toBe(
            'The file goes back to the last commit'
        );
    });

    it('says an untracked file is deleted', () => {
        expect(discardWords(file('notes.md', { kind: 'added', untracked: true }))).toEqual({
            title: 'Delete notes.md?',
            body: 'The file is not in git and will be deleted',
        });
    });

    it('says a file that was added but never committed is deleted', () => {
        expect(discardWords(file('src/new.ts', { kind: 'added' }))).toEqual({
            title: 'Delete new.ts?',
            body: 'The file was never committed and will be deleted',
        });
    });

    it('describes undoing a rename and restoring a deleted file', () => {
        expect(discardWords(file('src/new-name.ts', { kind: 'renamed', oldPath: 'src/old-name.ts' }))).toEqual({
            title: 'Discard changes to new-name.ts?',
            body: 'The rename is undone and the file goes back to the last commit',
        });
        expect(discardWords(file('src/gone.ts', { kind: 'deleted' }))).toEqual({
            title: 'Discard changes to gone.ts?',
            body: 'The file comes back from the last commit',
        });
    });

    it('keeps the confirmation copy short, with no trailing period', () => {
        for (const kind of ['modified', 'added', 'deleted', 'renamed', 'typechange'] as const) {
            for (const untracked of [undefined, true as const]) {
                const { title, body } = discardWords(file('a.ts', { kind, ...(untracked && { untracked }) }));
                expect(title.endsWith('?')).toBe(true);
                expect(body.endsWith('.')).toBe(false);
            }
        }
    });
});
