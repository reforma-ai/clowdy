/*
 * How a path is shown to the person: the home folder as `~`, and, when the room is short, the middle of it as `…` by whole names, so the start (which
 * tells where it is) and the end (which tells what it is) stay: `~/Foo/…/baz/foo`, never `~/Foo/bar/baz/f…`. Pure strings, no DOM: `PathText` measures and picks.
 */

/** The separator a path uses: a backslash in a Windows path, a slash in any other. */
function separatorOf(path: string): '/' | '\\' {
    return path.includes('\\') && !path.includes('/') ? '\\' : '/';
}

/**
 * The path with the home folder written as `~` where it starts in it: `/Users/me/code/app` is `~/code/app` and the home folder itself `~`. A path elsewhere, or
 * one that only starts with the same letters (`/Users/mel`), stays as it is, and so does any path while the home folder is not known. On Windows the case of
 * the drive and of the names is no difference.
 */
export function tildePath(path: string, home: string | undefined): string {
    const root = home?.replace(/[\\/]+$/, '');

    if (!root) return path;

    const windows = /^[a-z]:/i.test(root);
    const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);

    if (same(path, root)) return '~';

    const next = path[root.length];

    return same(path.slice(0, root.length), root) && (next === '/' || next === '\\') ? `~${ path.slice(root.length) }` : path;
}

/**
 * The ways to write a path, from the whole of it to the least of it, for a line that has to be as long as it fits. After the whole path come the forms with
 * the middle names left out: the start and the last names kept, the longest first (`~/Foo/…/baz/foo`, `~/…/baz/foo`, `~/…/foo`), and at the end only
 * the last name (`…/foo`). The start is the root mark with the first name (`~/Foo`, `/Users`, `C:\Users`), or the root mark alone from the second form on.
 */
export function pathVariants(path: string): string[] {
    const sep = separatorOf(path);
    const parts = path.split(sep);
    const count = parts.length;
    const variants = [path];
    const add = (head: string[], tail: string[]) => {
        const text = [...head, '…', ...tail].join(sep);

        if (!variants.includes(text)) variants.push(text);
    };

    for (let kept = count - 1; kept >= 2; kept--) {
        // Two names at the start are worth it only with two at the end: `~/Foo/…/foo` says less than `~/…/baz/foo`, which is not longer.
        const head = kept - 2 >= 2 ? 2 : 1;

        add(parts.slice(0, head), parts.slice(count - (kept - head)));
    }

    if (count > 1) add([], parts.slice(count - 1));

    return variants;
}
