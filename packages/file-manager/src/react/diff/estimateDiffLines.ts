/** The tallest guess for a text with both sides, whose unchanged lines fold away; a text with one side shows whole. */
const FOLDED_LINES_GUESS = 16;
const WHOLE_LINES_CAP = 200;

function countLines(text: string | null): number {
    return text ? text.split('\n').length : 0;
}

/**
 * How many lines a diff of these texts is likely to take, for the box that stands in until the editor is built.
 * A text with one side shows whole; with two, most lines fold away behind a row, which a guess cannot know exactly.
 */
export function estimateDiffLines(original: string | null, modified: string | null): number {
    const before = countLines(original);
    const after = countLines(modified);

    if (!before || !after) {
        return Math.min(Math.max(before, after, 1), WHOLE_LINES_CAP);
    }

    return Math.min(Math.max(before, after), FOLDED_LINES_GUESS);
}
