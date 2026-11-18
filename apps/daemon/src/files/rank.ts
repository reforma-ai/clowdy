/** How far a path is from what was typed; lower is better. */
function scoreOf(lower: string, first: string | undefined): number {
    if (!first) {
        // Nothing typed: the files nearest the project root come first.
        return lower.split('/').length - 1;
    }

    const name = lower.slice(lower.lastIndexOf('/') + 1);

    if (name.startsWith(first)) {
        return 0;
    }

    if (name.includes(first)) {
        return 1;
    }

    // A folder whose name starts with it.
    return lower.includes(`/${ first }`) || lower.startsWith(first) ? 2 : 3;
}

/**
 * The paths that contain every word of `query` (case does not matter), best first: a file name that starts with the
 * first word, then one that contains it, then a folder, then anywhere in the path; shorter paths win a tie.
 */
export function searchPaths(paths: readonly string[], query: string, limit: number): string[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches: Array<{ path: string; score: number }> = [];

    for (const path of paths) {
        const lower = path.toLowerCase();

        if (words.every(word => lower.includes(word))) {
            matches.push({ path, score: scoreOf(lower, words[0]) });
        }
    }

    matches.sort((a, b) => a.score - b.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));

    return matches.slice(0, limit).map(match => match.path);
}
