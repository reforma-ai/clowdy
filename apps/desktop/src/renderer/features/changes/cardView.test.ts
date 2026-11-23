import { describe, expect, it } from 'vitest';

import { CARD_TEXT, cardBody, estimatedLines, needsSides } from './cardView';

import type { GitChangedFile, GitFileSides } from '@clowdy/protocol';
import type { SidesEntry } from './fileSides';

const MODE = '100644';
const revision = (oldMode: string, oldBlob: string, newMode: string, newBlob: string) => `${ oldMode }:${ oldBlob.repeat(40) }:${ newMode }:${ newBlob.repeat(40) }`;

const modified: GitChangedFile = { path: 'src/a.ts', kind: 'modified', additions: 2, deletions: 1, revision: revision(MODE, '1', MODE, '2') };
const added: GitChangedFile = { path: 'src/new.ts', kind: 'added', additions: 3, deletions: 0, revision: revision('000000', '0', MODE, '3') };
const deleted: GitChangedFile = { path: 'src/gone.ts', kind: 'deleted', additions: 0, deletions: 4, revision: revision(MODE, '4', '000000', '0') };
const renamed: GitChangedFile = { path: 'src/renamed.ts', oldPath: 'src/old.ts', kind: 'renamed', additions: 0, deletions: 0, revision: revision(MODE, '5', MODE, '5') };

const ready = (sides: GitFileSides): SidesEntry => ({ status: 'ready', sides });
const text = (original: string | null, modifiedText: string | null, file: GitChangedFile = modified): GitFileSides => ({ state: 'text', original, modified: modifiedText, revision: file.revision });

describe('what an open card shows', () => {
    it('is the diff of the two texts of a file that was read', () => {
        expect(cardBody(modified, ready(text('a\n', 'b\n')))).toEqual({ kind: 'diff', original: 'a\n', modified: 'b\n' });
    });

    it('draws a new file as all added and a deleted file as all removed: the side that is not there stays null', () => {
        expect(cardBody(added, ready(text(null, 'one\ntwo\n', added)))).toEqual({ kind: 'diff', original: null, modified: 'one\ntwo\n' });
        expect(cardBody(deleted, ready(text('bye\n', null, deleted)))).toEqual({ kind: 'diff', original: 'bye\n', modified: null });
    });

    it('is loading until the texts have come', () => {
        expect(cardBody(modified, undefined)).toEqual({ kind: 'loading' });
        expect(cardBody(modified, { status: 'loading' })).toEqual({ kind: 'loading' });
    });

    it('keeps the texts the file had before it was edited on show while the new ones are on their way', () => {
        const before = text('a\n', 'b\n');

        expect(cardBody(modified, { status: 'loading' }, before)).toEqual({ kind: 'diff', original: 'a\n', modified: 'b\n' });
        expect(cardBody(modified, undefined, before)).toEqual({ kind: 'diff', original: 'a\n', modified: 'b\n' });
        // The new texts replace them as soon as they are read.
        expect(cardBody(modified, ready(text('a\n', 'c\n')), before)).toEqual({ kind: 'diff', original: 'a\n', modified: 'c\n' });
    });

    it('says a file that could not be read could not be, with the daemon\'s reason, and not the old texts', () => {
        expect(cardBody(modified, { status: 'error', message: 'git did not answer' }, text('a\n', 'b\n'))).toEqual({ kind: 'error', message: 'git did not answer' });
        expect(CARD_TEXT.error).toBe('Couldn\'t read this file');
    });

    it('settles a binary or too large file from the list\'s own flags, with no text read at all', () => {
        expect(cardBody({ ...added, binary: true, additions: undefined, deletions: undefined }, undefined)).toEqual({ kind: 'binary' });
        expect(cardBody({ ...modified, tooLarge: true }, undefined)).toEqual({ kind: 'tooLarge' });
        expect(needsSides({ ...added, binary: true })).toBe(false);
        expect(needsSides({ ...modified, tooLarge: true })).toBe(false);
        expect(needsSides(modified)).toBe(true);
        expect(CARD_TEXT.binary).toBe('Binary file');
        expect(CARD_TEXT.tooLarge).toBe('Too large to show');
    });

    it('takes the daemon\'s word for a file the list could not tell was binary or too large: a NUL in a side, a side over the limit', () => {
        expect(cardBody(modified, ready({ state: 'binary', revision: modified.revision }))).toEqual({ kind: 'binary' });
        expect(cardBody(modified, ready({ state: 'too_large', revision: modified.revision }))).toEqual({ kind: 'tooLarge' });
    });

    it('says a file whose two texts are the same has no change to show: a rename with no edit, a change of mode, or neither', () => {
        expect(cardBody(renamed, ready(text('same\n', 'same\n', renamed)))).toEqual({ kind: 'note', text: CARD_TEXT.renamedOnly });

        const mode: GitChangedFile = { ...modified, additions: 0, deletions: 0, revision: revision(MODE, '1', '100755', '1') };

        expect(cardBody(mode, ready(text('same\n', 'same\n', mode)))).toEqual({ kind: 'note', text: CARD_TEXT.modeOnly });
        expect(cardBody(modified, ready(text('same\n', 'same\n')))).toEqual({ kind: 'note', text: CARD_TEXT.unchanged });
    });

    it('says an empty file is empty, whether it was added or deleted, and draws a file that has lines', () => {
        expect(cardBody(added, ready(text(null, '', added)))).toEqual({ kind: 'note', text: CARD_TEXT.emptyFile });
        expect(cardBody(deleted, ready(text('', null, deleted)))).toEqual({ kind: 'note', text: CARD_TEXT.emptyFile });
        expect(cardBody(added, ready(text(null, 'x\n', added))).kind).toBe('diff');
    });
});

describe('the place a card holds before its text has come', () => {
    it('is the changed lines of the file and the context around them, never less than a dozen lines', () => {
        expect(estimatedLines({ additions: 40, deletions: 10 })).toBe(58);
        expect(estimatedLines({ additions: 1, deletions: 0 })).toBe(12);
        // A file whose lines were not counted has the least.
        expect(estimatedLines({})).toBe(12);
    });

    it('stops growing for a file that changes thousands of lines', () => {
        expect(estimatedLines({ additions: 19_000, deletions: 900 })).toBe(5000);
    });
});
