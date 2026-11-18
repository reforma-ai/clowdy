import { isKnownFileExtension } from '@clowdy/lib';

import { isDirectoryPath } from './markdown/chipPath';
import { isFilePathLike, normalizeFileReferencePath } from './markdown/codeCitation';

import type { StreamLinks } from './StreamLinks';

/** Where a mention may start: the start of a word, a bracket or a quote, never inside an address (`a@b.c`), a URL (`/@scope/pkg.js`) or a branch name. */
const AT_WORD_START = '(?<![^\\s(\\[{"\'])';

/**
 * What changes in a line, or what is left as written, in the order the pattern tries them:
 * an inline code span (left alone), a quoted file mention (`@"my notes.md"`), a file mention (`@src/a.ts`) and
 * something shaped like a task key (`CAR-24`, not the start of `CAR-24-form`).
 */
const TOKEN = new RegExp(
    `(?<!\`)(\`+)(?!\`).+?(?<!\`)\\1(?!\`)|${ AT_WORD_START }@"([^"\\n]+)"|${ AT_WORD_START }@(\\S+)|${ AT_WORD_START }([A-Z][A-Z0-9]*-\\d+)(?![\\w-])`,
    'g'
);

/** A line that opens or closes a fenced block: three or more backticks or tildes. */
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;

/** What can follow a path in a sentence without being part of it. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;

function chipText(match: string, span: string | undefined, quoted: string | undefined, bare: string | undefined, key: string | undefined, taskOfKey: StreamLinks['taskOfKey']): string {
    if (span !== undefined) return match;

    if (key !== undefined) {
        return taskOfKey?.(key) ? `\`${ key }\`` : match;
    }

    const path = quoted ?? bare ?? '';

    if (path.includes('`')) return match;

    // `@src/a.ts.` ends a sentence; the dot is not the path's.
    const bareTrim = quoted === undefined ? TRAILING_PUNCTUATION.exec(path)?.[0] ?? '' : '';
    const clean = normalizeFileReferencePath(bareTrim ? path.slice(0, -bareTrim.length) : path);
    // A quoted path may hold spaces, which no chip takes; it is still shown as code so Markdown leaves its characters alone.
    const isPath = quoted === undefined ? isFilePathLike(clean) : isKnownFileExtension(clean) || isDirectoryPath(clean);

    return clean && isPath ? `\`${ clean }\`${ bareTrim }` : match;
}

/**
 * What a person wrote, ready for Markdown: files they mentioned and tasks of the project they named become inline
 * code, which the stream shows as chips. Everything else, code spans and fenced blocks included, is left as written.
 */
export function personMarkdown(text: string, taskOfKey?: StreamLinks['taskOfKey']): string {
    // The fence that is open: only the same character, at least as long, closes it.
    let fence: string | undefined;

    return text.split('\n').map((line) => {
        const [, marks = '', rest = ''] = FENCE.exec(line) ?? [];
        // A backtick fence has no backtick in its info, or the line is a code span (```code```).
        const isFence = marks !== '' && !(marks[0] === '`' && rest.includes('`'));

        if (fence) {
            if (isFence && marks[0] === fence[0] && marks.length >= fence.length && rest.trim() === '') fence = undefined;

            return line;
        }

        if (isFence) {
            fence = marks;

            return line;
        }

        return line.replace(TOKEN, (match, span, quoted, bare, key) => chipText(match, span, quoted, bare, key, taskOfKey));
    }).join('\n');
}
