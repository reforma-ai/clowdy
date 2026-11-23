import type { GitChangedFile, GitFileSides } from '@clowdy/protocol';
import type { SidesEntry } from './fileSides';

/** What the body of an open card shows. */
export type CardBody =
    /** The texts are on their way; nothing yet to draw. */
    | { kind: 'loading' }
    /** The texts could not be read. */
    | { kind: 'error'; message: string }
    /** Git takes the file for binary: no text to draw. */
    | { kind: 'binary' }
    /** The file is too big to draw: no text. */
    | { kind: 'tooLarge' }
    /** A word instead of a diff: there are no lines to show. */
    | { kind: 'note'; text: string }
    /** The diff of the two texts. */
    | { kind: 'diff'; original: string | null; modified: string | null };

/** The words of the body's states, kept in one place so the card and its tests say the same thing. */
export const CARD_TEXT = {
    binary: 'Binary file',
    tooLarge: 'Too large to show',
    error: 'Couldn\'t read this file',
    emptyFile: 'Empty file',
    unchanged: 'No changes to the text',
    modeOnly: 'Only the file mode changed',
    renamedOnly: 'Renamed with no changes to the text',
} as const;

/** The mode of the file on each side, from its revision (`<oldMode>:<oldBlob>:<newMode>:<newBlob>`); a side that is not there has zeros. */
function modesOf(revision: string): { before: string; after: string } {
    const [before = '', , after = ''] = revision.split(':');

    return { before, after };
}

const isAbsentMode = (mode: string) => /^0*$/.test(mode);

/** What is said of a file whose two texts are the same, or that has no lines at all. `undefined` when there is a diff to draw. */
function noteOf(file: GitChangedFile, { original, modified }: { original: string | null; modified: string | null }): string | undefined {
    if (original === modified) {
        const { before, after } = modesOf(file.revision);

        if (before !== after && !isAbsentMode(before) && !isAbsentMode(after)) return CARD_TEXT.modeOnly;

        return file.kind === 'renamed' || file.kind === 'copied' ? CARD_TEXT.renamedOnly : CARD_TEXT.unchanged;
    }

    // A file that is added or deleted with no lines in it: the diff view would draw nothing.
    return (original === null && modified === '') || (original === '' && modified === null) ? CARD_TEXT.emptyFile : undefined;
}

/**
 * What an open card shows, from what its list says of the file and where its texts are. The list's own flags settle a binary or too large file with no read at all; otherwise the
 * texts decide (the daemon calls a file binary when a side has a NUL in it, which the list could not know). `previous` is the texts of the file as they were before it was edited:
 * they stay on show while the new ones are on the way, so a card does not blink out and in whenever its file is saved.
 */
export function cardBody(file: GitChangedFile, entry: SidesEntry | undefined, previous?: GitFileSides): CardBody {
    if (file.binary) return { kind: 'binary' };

    if (file.tooLarge) return { kind: 'tooLarge' };

    if (entry?.status === 'error') return { kind: 'error', message: entry.message };

    const sides = entry?.status === 'ready' ? entry.sides : previous;

    if (!sides) return { kind: 'loading' };

    if (sides.state === 'binary') return { kind: 'binary' };

    if (sides.state === 'too_large') return { kind: 'tooLarge' };

    const note = noteOf(file, sides);

    return note ? { kind: 'note', text: note } : { kind: 'diff', original: sides.original, modified: sides.modified };
}

/** Whether the card needs its texts read: there is nothing to read for a file the list already says is binary or too big. */
export const needsSides = (file: GitChangedFile): boolean => !file.binary && !file.tooLarge;

/** The lines of context and folded rows around the changes, as `DiffView` shows them: 3 on each side of a change and a row for what is left out. */
const CONTEXT_LINES = 8;

/** The most lines a card holds a place for before its text has come. */
const MAX_ESTIMATED_LINES = 5000;

/**
 * How many lines the diff of a file will take, from the counts its list gives, for the box that stands in until the text is read and the view is built (`DiffView`'s own guess
 * is 16 lines for two sides, and real cards were 526 to 5752 px). A file whose lines were not counted has a modest box.
 */
export function estimatedLines(file: Pick<GitChangedFile, 'additions' | 'deletions'>): number {
    const changed = (file.additions ?? 0) + (file.deletions ?? 0);

    return Math.min(MAX_ESTIMATED_LINES, Math.max(changed + CONTEXT_LINES, 12));
}
