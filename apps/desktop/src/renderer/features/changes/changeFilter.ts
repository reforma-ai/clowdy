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

/** One state of a glob's matcher: where it goes without reading a character, and where each character it accepts takes it. */
interface State {
    free: number[];
    reads: Array<{ accepts: (character: string) => boolean; to: number }>;
}

const slash = (character: string): boolean => character === '/';
const notSlash = (character: string): boolean => character !== '/';
const anything = (): boolean => true;

/**
 * A glob as a function that says whether it matches the whole of a path: see the rules above. `[` with no `]` after it is a plain character. Nothing for a glob that makes no valid
 * expression (`[z-a]`), which the caller reads as the pattern's own text.
 *
 * The glob is made into a small automaton and run over the path one character at a time, keeping every state it can be in, so a path costs its length times the glob's, however many
 * stars the person typed. (A regular expression of the same glob backtracks: `a*a*a*a*b` took seconds on a path of a hundred characters, and a filter is run on every key.)
 */
export function compileGlob(glob: string): ((path: string) => boolean) | undefined {
    const states: State[] = [{ free: [], reads: [] }];
    // Where the glob has got to so far; the path matches when it ends here.
    let last = 0;

    const add = (): number => states.push({ free: [], reads: [] }) - 1;
    const read = (accepts: (character: string) => boolean): void => {
        const to = add();

        states[last]!.reads.push({ accepts, to });
        last = to;
    };
    const literal = (text: string): void => {
        const lower = text.toLowerCase();

        read(character => character === text || character.toLowerCase() === lower);
    };

    try {
        for (let index = 0; index < glob.length; index++) {
            const character = glob[index]!;

            if (character === '\\' && index + 1 < glob.length) {
                literal(glob[++index]!);
            }
            else if (character === '*') {
                // A run of stars is one `**`.
                const double = glob[index + 1] === '*';

                while (glob[index + 1] === '*') index++;

                const from = last;
                const out = add();

                // Either may be no characters at all.
                states[from]!.free.push(out);
                last = out;

                if (double && glob[index + 1] === '/') {
                    // `**/` is any folders, or none: a run of `<name>/`.
                    index++;

                    const inside = add();

                    states[from]!.reads.push({ accepts: notSlash, to: inside }, { accepts: slash, to: from });
                    states[inside]!.reads.push({ accepts: notSlash, to: inside }, { accepts: slash, to: from });
                }
                else {
                    // `*` stops at a `/`, `**` does not.
                    states[from]!.reads.push({ accepts: double ? anything : notSlash, to: from });
                }
            }
            else if (character === '?') {
                read(notSlash);
            }
            else if (character === '[') {
                const close = glob.indexOf(']', index + 2);

                if (close === -1) {
                    literal('[');
                    continue;
                }

                let set = glob.slice(index + 1, close);
                const negated = set.startsWith('!') || set.startsWith('^');

                if (negated) set = set.slice(1);

                // Inside a set only `\`, `]`, `^` and `-` (at a range) matter; the rest is taken as it is. Whatever whole character it names, in either case.
                const expression = new RegExp(`^[${ negated ? '^' : '' }${ set.replace(/[\\\]^]/g, '\\$&') }]$`, 'is');

                read(candidate => expression.test(candidate));
                index = close;
            }
            else {
                literal(character);
            }
        }
    }
    catch {
        return undefined;
    }

    const closures = states.map((_, start) => {
        const reached = new Set<number>([start]);

        for (const id of reached) for (const target of states[id]!.free) reached.add(target);

        return [...reached];
    });

    return (path) => {
        let current = new Set(closures[0]);

        for (let at = 0; at < path.length && current.size > 0; at++) {
            const next = new Set<number>();

            for (const id of current) {
                for (const { accepts, to } of states[id]!.reads) {
                    if (accepts(path[at]!)) for (const target of closures[to]!) next.add(target);
                }
            }

            current = next;
        }

        return current.has(last);
    };
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
        const glob = compileGlob(body);

        if (glob) {
            // A glob with no folder in it is about the name of a file, wherever the file is.
            const byName = !body.includes('/');

            return { exclude, matches: path => glob(byName ? nameOf(path) : path) };
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
