import type { SelectedLines } from '@clowdy/file-manager/react';

/** The language a fence names for a path: its extension, as the highlighter knows languages by it; none for a file with no extension. */
function languageOf(path: string): string {
    return /\.([a-z0-9+#_-]{1,16})$/i.exec(path)?.[1]?.toLowerCase() ?? '';
}

/**
 * The most characters of code one quote holds. The words of a whole lockfile would be megabytes in the message box, which draws a node for every line break: it would
 * take seconds to show and a long moment to follow every key, and the message would be a flood for the agent. A selection past it is cut at a line and says so.
 */
const MAX_QUOTED_CHARS = 100_000;

/** A fence one backtick longer than the longest run in the text, so the text can never close it, and at least three. */
function fenceOf(text: string): string {
    const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(run => run[0].length));

    return '`'.repeat(Math.max(3, longest + 1));
}

/** The text up to its last whole line that fits in `MAX_QUOTED_CHARS`, or its first characters when one line is longer than that. */
function cutText(text: string): string {
    const end = text.lastIndexOf('\n', MAX_QUOTED_CHARS);

    return text.slice(0, end > 0 ? end : MAX_QUOTED_CHARS);
}

/**
 * The words of a selection in code, as Add to chat quotes them: the path and the lines in code (`src/a.ts:10-12`, or `src/a.ts:10` for one line), so the agent can find
 * the place, then the selected text in a fenced block named for the file's language, which keeps its indentation and line breaks where a quote's own lines would lose
 * them. The composer's quote (`ComposerHandle.quote`) puts `> ` before every line, and the person's message is sent as it is. The lines are those of the text the editor
 * showed: in a diff card, the new text of the file. A selection of more than `MAX_QUOTED_CHARS` characters is quoted up to the last line that fits, the lines named are
 * those that were quoted, and a line after the block says where the selection goes on to.
 */
export function codeQuote(path: string, { from, to, text }: SelectedLines): string {
    const cut = text.length > MAX_QUOTED_CHARS;
    const quoted = cut ? cutText(text) : text;
    const last = cut ? from + (quoted.match(/\n/g)?.length ?? 0) : to;
    const range = from === last ? `${ from }` : `${ from }-${ last }`;
    const fence = fenceOf(quoted);
    // Trailing blank space is no part of the code, and a leading line break would open the fence on an empty line.
    const code = quoted.replace(/^(?:[ \t]*\n)+/, '').trimEnd();
    const rest = cut ? `\n… the selection goes on to line ${ to }` : '';

    return `\`${ path }:${ range }\`\n${ fence }${ languageOf(path) }\n${ code }\n${ fence }${ rest }`;
}
