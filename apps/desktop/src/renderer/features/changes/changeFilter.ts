// The filter above the Changes tab's cards and file list: one text that narrows both. It is a list of patterns separated by commas.
//
// - A pattern with no glob character (`*`, `?`, `[`) is a piece of the path, found whatever its case (`price` finds `src/booking/Price.ts`).
// - A pattern with one is a glob over the path, read by `minimatch`, whatever its case, dotfiles included: `*` is any run of characters but `/`, `**` as a part of the path of its
//   own is any folders or none (`a/**/b` finds `a/b`), `?` is one character but `/`, and `[abc]`, `[a-z]` and `[!abc]` are a set of characters. A backslash makes the next
//   character itself. Braces (`{a,b}`) and extended patterns (`+(a|b)`) are not read: their characters are themselves.
// - A glob with no `/` in it is matched against the file's name alone, so `*.md` finds every Markdown file whatever its folder; one with a `/` is matched against the path
//   from its start (`docs/**`, `src/**/*.test.ts`).
// - A glob that has more than three runs of stars in one part of the path (`*a*b*c*d*`) is a piece of the path too: see `MAX_STAR_RUNS`.
// - A pattern that starts with `!` leaves out what it matches. A file is shown when it matches some pattern that does not start with `!` (or there is none) and none that does.
// - Nothing typed, or only commas and spaces, shows every file.
//
// It is a plain function over paths, so the tests can drive it without the view.

import { Minimatch } from 'minimatch';

import type { MinimatchOptions } from 'minimatch';

/** What makes a pattern a glob and not a piece of the path. */
const GLOB_CHARACTER = /[*?[]/;

/**
 * The most runs of stars one part of a glob (between its slashes) may have. `minimatch` makes a regular expression of a part, and each run of stars lets the rest of the name be tried
 * again, so the time grows as the length of the name to the power of the runs. Measured on a name of 255 characters (the longest a file system has) that is 3 ms for three runs, 156 ms
 * for four and seconds for five; `*a*a*a*a*a*b` on a name of 100 characters took more than two seconds, and a filter is run on every key. A glob over the limit is read as a piece
 * of the path, which costs the length of the path. A part that is only `**` is a folder count, not a run: `minimatch` matches those without trying a name again.
 */
const MAX_STAR_RUNS = 3;

/**
 * `dot`: a name that starts with a dot is a name like another. `nocase`: whatever its case. `nonegate` and `nocomment`: a `!` or a `#` at the start is itself, since the filter reads
 * the `!` of a pattern on its own. `nobrace` and `noext`: the grammar above has no braces and no `+(a|b)`, and a text typed on every key should not grow into several globs. `platform`: a path is
 * `/`-separated and a backslash escapes, on every system.
 */
const GLOB_OPTIONS = {
    dot: true,
    nocase: true,
    nonegate: true,
    nocomment: true,
    nobrace: true,
    noext: true,
    platform: 'linux',
} satisfies MinimatchOptions;

/** Whether a part of a glob has more runs of stars than a name can be tried against in good time. */
const hasTooManyStars = (glob: string): boolean =>
    glob.split('/').some(part => (part.match(/\*+/g)?.length ?? 0) > MAX_STAR_RUNS);

/**
 * A glob made once, to match many paths. A glob with no `/` is about the name of a file, wherever the file is. Nothing for a glob with too many stars, and for one that `minimatch`
 * refuses (one over 64 KiB): the caller reads it as the pattern's own text.
 */
function compileGlob(glob: string): Minimatch | undefined {
    if (hasTooManyStars(glob)) return undefined;

    try {
        return new Minimatch(glob, { ...GLOB_OPTIONS, matchBase: !glob.includes('/') });
    } catch {
        return undefined;
    }
}

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
        const glob = compileGlob(body);

        if (glob) return { exclude, matches: path => glob.match(path) };
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
    const patterns = text
        .split(',')
        .map(part => patternOf(part.trim()))
        .filter((pattern): pattern is Pattern => pattern !== undefined);
    const included = patterns.filter(pattern => !pattern.exclude);
    const excluded = patterns.filter(pattern => pattern.exclude);

    return {
        isEmpty: patterns.length === 0,
        matches: path =>
            (included.length === 0 || included.some(pattern => pattern.matches(path))) &&
            !excluded.some(pattern => pattern.matches(path)),
    };
}

/** The items whose path passes the filter text, in their order. The same items when nothing is typed. */
export function filterChanged<T extends { path: string }>(items: readonly T[], text: string): readonly T[] {
    const filter = compileChangeFilter(text);

    return filter.isEmpty ? items : items.filter(item => filter.matches(item.path));
}
