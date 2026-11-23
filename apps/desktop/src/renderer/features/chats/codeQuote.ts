import type { SelectedLines } from '@clowdy/file-manager/react';

/** The language a fence names for a path: its extension, as the highlighter knows languages by it; none for a file with no extension. */
function languageOf(path: string): string {
    return /\.([a-z0-9+#_-]{1,16})$/i.exec(path)?.[1]?.toLowerCase() ?? '';
}

/** A fence one backtick longer than the longest run in the text, so the text can never close it, and at least three. */
function fenceOf(text: string): string {
    const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(run => run[0].length));

    return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * The words of a selection in code, as Add to chat quotes them: the path and the lines in code (`src/a.ts:10-12`, or `src/a.ts:10` for one line), so the agent can find
 * the place, then the selected text in a fenced block named for the file's language, which keeps its indentation and line breaks where a quote's own lines would lose
 * them. The composer's quote (`ComposerHandle.quote`) puts `> ` before every line, and the person's message is sent as it is. The lines are those of the text the editor
 * showed: in a diff card, the new text of the file.
 */
export function codeQuote(path: string, { from, to, text }: SelectedLines): string {
    const range = from === to ? `${ from }` : `${ from }-${ to }`;
    const fence = fenceOf(text);
    // Trailing blank space is no part of the code, and a leading line break would open the fence on an empty line.
    const code = text.replace(/^(?:[ \t]*\n)+/, '').trimEnd();

    return `\`${ path }:${ range }\`\n${ fence }${ languageOf(path) }\n${ code }\n${ fence }`;
}
