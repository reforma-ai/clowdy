// The filter above the Changes tab's cards and file list: one text that narrows both. It is a list of patterns separated by commas.
//
// - A pattern with no glob character (`*`, `?`, `[`) is a piece of the path, found whatever its case (`price` finds `src/booking/Price.ts`).
// - A pattern with one is a glob over the path, whatever its case, dotfiles included: `*` is any run of characters but `/`, `**` is any run at all (`**/` may be no folder
//   at all), `?` is one character but `/`, and `[abc]`, `[a-z]` and `[!abc]` are a set of characters. A backslash makes the next character itself.
// - A glob with no `/` in it is matched against the file's name alone, so `*.md` finds every Markdown file whatever its folder; one with a `/` is matched against the path
//   from its start (`docs/**`, `src/**/*.test.ts`).
// - A pattern that starts with `!` leaves out what it matches. A file is shown when it matches some pattern that does not start with `!` (or there is none) and none that does.
// - Nothing typed, or only commas and spaces, shows every file.
//
// It is a plain function over paths, so the cards and the sidebar's list read one answer and the tests drive it with no view.

/** What makes a pattern a glob and not a piece of the path. */
const GLOB_CHARACTER = /[*?[]/;

/** The names of the pattern's characters that a regular expression takes for its own. */
const REGEXP_SPECIAL = /[.+^${}()|[\]\\/-]/g;

const escapeLiteral = (text: string): string => text.replace(REGEXP_SPECIAL, '\\$&');

/**
 * A glob as a regular expression that matches the whole of a text: see the rules above. `[` with no `]` after it is a plain character. Nothing for a glob that makes no valid
 * expression (`[z-a]`), which the caller reads as the pattern's own text.
 */
export function globToRegExp(glob: string): RegExp | undefined {
    let source = '';

    for (let index = 0; index < glob.length; index++) {
        const character = glob[index]!;

        if (character === '\\' && index + 1 < glob.length) {
            source += escapeLiteral(glob[++index]!);
        }
        else if (character === '*') {
            if (glob[index + 1] !== '*') {
                source += '[^/]*';
                continue;
            }

            // A run of stars is one `**`.
            while (glob[index + 1] === '*') index++;

            if (glob[index + 1] === '/') {
                // `**/` is any folders, or none.
                index++;
                source += '(?:.*/)?';
            }
            else {
                source += '.*';
            }
        }
        else if (character === '?') {
            source += '[^/]';
        }
        else if (character === '[') {
            const close = glob.indexOf(']', index + 2);

            if (close === -1) {
                source += '\\[';
                continue;
            }

            let set = glob.slice(index + 1, close);
            const negated = set.startsWith('!') || set.startsWith('^');

            if (negated) set = set.slice(1);

            // Inside a set only `\`, `]`, `^` and `-` (at a range) matter; the rest is taken as it is.
            source += `[${ negated ? '^' : '' }${ set.replace(/[\\\]^]/g, '\\$&') }]`;
            index = close;
        }
        else {
            source += escapeLiteral(character);
        }
    }

    try {
        return new RegExp(`^${ source }$`, 'is');
    }
    catch {
        return undefined;
    }
}

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** One pattern of the filter, ready to test a path against. */
interface Pattern {
    /** Leaves out what it matches. */
    exclude: boolean;
    matches: (path: string) => boolean;
}

function patternOf(text: string): Pattern | undefined {
    const exclude = text.startsWith('!');
    const body = (exclude ? text.slice(1) : text).trim();

    if (body === '') return undefined;

    if (GLOB_CHARACTER.test(body)) {
        const expression = globToRegExp(body);

        if (expression) {
            // A glob with no folder in it is about the name of a file, wherever the file is.
            const byName = !body.includes('/');

            return { exclude, matches: path => expression.test(byName ? nameOf(path) : path) };
        }
    }

    const piece = body.toLowerCase();

    return { exclude, matches: path => path.toLowerCase().includes(piece) };
}

/** A filter made from the text typed, to be tried on many paths. */
export interface ChangeFilter {
    /** Nothing is filtered out: no pattern was typed. */
    readonly isEmpty: boolean;
    /** Whether a file's path passes. */
    matches: (path: string) => boolean;
}

/** The patterns of a filter text, in the order they were typed, with the empty ones and a bare `!` dropped. */
export function compileChangeFilter(text: string): ChangeFilter {
    const patterns = text.split(',').map(part => patternOf(part.trim())).filter((pattern): pattern is Pattern => pattern !== undefined);
    const included = patterns.filter(pattern => !pattern.exclude);
    const excluded = patterns.filter(pattern => pattern.exclude);

    return {
        isEmpty: patterns.length === 0,
        matches: path => (included.length === 0 || included.some(pattern => pattern.matches(path))) && !excluded.some(pattern => pattern.matches(path)),
    };
}

/** The items whose path passes the filter text, in their order. The same items when nothing is typed. */
export function filterChanged<T extends { path: string }>(items: readonly T[], text: string): readonly T[] {
    const filter = compileChangeFilter(text);

    return filter.isEmpty ? items : items.filter(item => filter.matches(item.path));
}
