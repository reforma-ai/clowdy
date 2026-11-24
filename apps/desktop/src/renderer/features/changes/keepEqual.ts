/** What an element of a list is matched by when the list is read again: its path, for the lists of files, else its place in the list. */
const pathOf = (value: unknown): string | undefined =>
    typeof value === 'object' && value !== null && typeof (value as { path?: unknown }).path === 'string'
        ? (value as { path: string }).path
        : undefined;

/**
 * `next`, with every part that equals the same part of `previous` replaced by that part: a read that found nothing new gives back the very objects of the last one, and a read that
 * found one file edited gives back a new list in which every other file is the object it was. A view that draws them is then drawn again only where something changed. For the
 * daemon's JSON answers: plain objects, arrays and primitives. The elements of a list are matched by their `path` when they have one, so a file that came or went does not make the
 * ones after it new.
 */
export function keepEqual<T>(previous: T, next: T): T {
    if (Object.is(previous, next)) return previous;

    if (typeof previous !== 'object' || typeof next !== 'object' || previous === null || next === null) return next;

    if (Array.isArray(previous) || Array.isArray(next)) {
        if (!Array.isArray(previous) || !Array.isArray(next)) return next;

        const byPath = new Map<string, unknown>();

        for (const item of previous) {
            const path = pathOf(item);

            if (path !== undefined) byPath.set(path, item);
        }

        let same = previous.length === next.length;
        const kept = next.map((item, index) => {
            const path = pathOf(item);
            const before = path === undefined ? previous[index] : byPath.get(path);
            const result = before === undefined ? item : keepEqual(before, item);

            if (result !== previous[index]) same = false;

            return result;
        });

        return (same ? previous : kept) as T;
    }

    const before = previous as Record<string, unknown>;
    const after = next as Record<string, unknown>;
    const keys = Object.keys(after);
    let same = keys.length === Object.keys(before).length;
    const kept: Record<string, unknown> = {};

    for (const key of keys) {
        // Own keys only: `constructor` or `toString` of a record keyed by names is not a part of the last answer.
        const had = Object.hasOwn(before, key);
        const result = had ? keepEqual(before[key], after[key]) : after[key];

        if (!had || result !== before[key]) same = false;

        kept[key] = result;
    }

    return (same ? previous : kept) as T;
}
