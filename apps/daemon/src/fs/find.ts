import { CUTOFF_NAMES, isAddressable, isListed } from './paths';

/** A name that is a word is tested as a part of the path; one with `*` or `?` is a glob, tested on the file name alone when it has no `/`. */
const GLOB_CHARACTERS = /[*?]/;

/** A predicate on the lowercase path, for a query that is already trimmed and not empty. */
function matcher(query: string): (lowerPath: string) => boolean {
    const lower = query.toLowerCase();

    if (!GLOB_CHARACTERS.test(lower)) {
        return path => path.includes(lower);
    }

    const glob = new Bun.Glob(lower);
    const baseOnly = !lower.includes('/');

    return path => {
        try {
            return glob.match(baseOnly ? path.slice(path.lastIndexOf('/') + 1) : path);
        } catch {
            return false;
        }
    };
}

/** The best matches come first: a name that starts with the word, then one that contains it, then the rest; shorter paths win a tie. */
function scoreOf(lowerPath: string, word: string | undefined): number {
    if (word === undefined) {
        return 0;
    }

    const name = lowerPath.slice(lowerPath.lastIndexOf('/') + 1);

    return name.startsWith(word) ? 0 : name.includes(word) ? 1 : 2;
}

/**
 * The paths of `paths` that match `query` (case does not matter), best first. Nothing under `.git` or `node_modules`, and no name a client
 * could not address back. The caller caps them: it still has to look whether each is a file.
 */
export function matchPaths(paths: readonly string[], query: string): string[] {
    const text = query.trim();

    if (!text) {
        return [];
    }

    const matches = matcher(text);
    const word = GLOB_CHARACTERS.test(text) ? undefined : text.toLowerCase();
    const found: Array<{ path: string; score: number }> = [];

    for (const path of paths) {
        const lower = path.toLowerCase();

        if (
            matches(lower) &&
            isListed(path.slice(path.lastIndexOf('/') + 1)) &&
            isAddressable(path) &&
            !path.split('/').some(name => CUTOFF_NAMES.has(name))
        ) {
            found.push({ path, score: scoreOf(lower, word) });
        }
    }

    return found
        .sort(
            (a, b) =>
                a.score - b.score || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
        )
        .map(match => match.path);
}
