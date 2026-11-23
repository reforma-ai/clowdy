import { MAX_FS_QUERY_LENGTH } from '@clowdy/protocol';

import { invalid } from '../errors';

/** The most bytes a file may have to be searched: ripgrep's `--max-filesize 1M`. A file over it is skipped. */
export const MAX_SEARCHED_BYTES = 1024 * 1024;

/** The longest `exclude` glob, how many a request may carry, and how many characters they have together (a command line is 32,000 characters on Windows). */
export const MAX_EXCLUDE_LENGTH = 500;
export const MAX_EXCLUDES = 200;
export const MAX_EXCLUDE_CHARACTERS = 20_000;

/**
 * Left out of every search, as gitignore-style globs both engines read the same way: the repository's own folder and what holds other
 * people's code, the project's own `.clowdy` folder (like the walk of `files/list.ts`, one at any depth), and generated files whose hits
 * bury the source. `fs/find` still finds the files.
 */
export const ALWAYS_EXCLUDED: readonly string[] = [
    '.git',
    'node_modules',
    '.clowdy',
    'bun.lock',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'npm-shrinkwrap.json',
    '*.min.js',
    '*.min.css',
    '*.map',
];

/** The text to look for: one line, not empty, not too long. A line break cannot be matched by a search line by line (ripgrep refuses it too), a NUL cannot be passed to it. */
export function checkQuery(query: string): void {
    if (query === '') {
        throw invalid('The search text is empty');
    }

    if (query.length > MAX_FS_QUERY_LENGTH) {
        throw invalid(`The search text is over ${MAX_FS_QUERY_LENGTH} characters`);
    }

    if (/[\n\r\0]/.test(query)) {
        throw invalid('The search text must be one line of text');
    }
}

/**
 * The globs of `exclude`: each not empty, at most `MAX_EXCLUDE_LENGTH` characters, without NUL, and not starting with `!` (it would
 * re-include what is left out, which only a pattern in a gitignore file can do). Whether a glob parses is ripgrep's to say.
 */
export function checkExcludes(exclude: readonly string[]): void {
    if (exclude.length > MAX_EXCLUDES) {
        throw invalid(`At most ${MAX_EXCLUDES} exclude globs`);
    }

    let characters = 0;

    for (const glob of exclude) {
        if (glob.trim() === '') {
            throw invalid('An exclude glob is empty');
        }

        if (glob.length > MAX_EXCLUDE_LENGTH) {
            throw invalid(`An exclude glob is over ${MAX_EXCLUDE_LENGTH} characters`);
        }

        if (glob.includes('\0')) {
            throw invalid('An exclude glob has a NUL character');
        }

        if (glob.startsWith('!')) {
            throw invalid('An exclude glob cannot start with !');
        }

        characters += glob.length;
    }

    if (characters > MAX_EXCLUDE_CHARACTERS) {
        throw invalid(`The exclude globs are over ${MAX_EXCLUDE_CHARACTERS} characters together`);
    }
}

interface Rule {
    glob: Bun.Glob;
    /** A glob with a `/` in it is matched against the path from the folder; one without, against every name on the way. */
    anchored: boolean;
    /** A glob that ends with `/` leaves out folders only. */
    foldersOnly: boolean;
}

function ruleOf(pattern: string): Rule {
    const foldersOnly = pattern.endsWith('/');
    const text = pattern.replace(/\/+$/, '');

    return { glob: new Bun.Glob(text.replace(/^\/+/, '')), anchored: text.includes('/'), foldersOnly };
}

/**
 * The gitignore-style globs of a search read in the daemon's own scan, the way ripgrep reads them for `-g '!<glob>'`: a path is left out
 * when the glob matches the path or the name of any folder above it (or its own name), unless the glob is for folders only.
 */
export class PathFilter {
    private rules: Rule[];
    private folders = new Map<string, boolean>();

    constructor(globs: readonly string[]) {
        this.rules = globs.map(ruleOf);
    }

    /** Whether the file at `path` (relative to the folder, `/` separators) is left out. */
    excludes(path: string): boolean {
        const cut = path.lastIndexOf('/');

        return (
            (cut !== -1 && this.excludesFolder(path.slice(0, cut))) || this.matches(path, path.slice(cut + 1), false)
        );
    }

    private excludesFolder(path: string): boolean {
        let known = this.folders.get(path);

        if (known === undefined) {
            const cut = path.lastIndexOf('/');

            known =
                (cut !== -1 && this.excludesFolder(path.slice(0, cut))) ||
                this.matches(path, path.slice(cut + 1), true);
            this.folders.set(path, known);
        }

        return known;
    }

    private matches(path: string, name: string, isFolder: boolean): boolean {
        return this.rules.some(rule => (isFolder || !rule.foldersOnly) && rule.glob.match(rule.anchored ? path : name));
    }
}

/** Characters ripgrep's `-w` counts as part of a word (Unicode `\w`). */
const WORD = String.raw`\p{Alphabetic}\p{M}\p{Nd}\p{Pc}‌‍`;

/**
 * The query as a regular expression that finds the literal text the way ripgrep's `-F` does: every occurrence, left to right, case-insensitive
 * by Unicode simple case folding unless `matchCase`, and with `wholeWord` only where no word character comes before or after it (`-w`).
 */
export function queryMatcher(query: string, matchCase: boolean, wholeWord: boolean): RegExp {
    const literal = query.replace(/[\\^$.*+?()[\]{}|/]/g, String.raw`\$&`);
    const source = wholeWord ? `(?<![${WORD}])(?:${literal})(?![${WORD}])` : literal;

    return new RegExp(source, matchCase ? 'gu' : 'giu');
}
