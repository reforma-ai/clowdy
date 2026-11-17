/**
 * Array utility functions
 */

/**
 * Returns elements that are in the first array but not in any of the subsequent arrays
 */
export function arrayDifference<T>(...arrays: T[][]): T[] {
    if (arrays.length === 0) {
        return [];
    }
    if (arrays.length === 1) {
        return arrays[0];
    }

    const [first, ...rest] = arrays;

    return first.filter(item => !rest.some(arr => arr.includes(item)));
}

/**
 * Returns unique elements from an array
 */
export function arrayUnique<T>(arr: T[]): T[] {
    return Array.from(new Set(arr));
}

/**
 * Groups array elements by a key function
 */
export function arrayGroupBy<T, K extends string | number | symbol>(
    arr: T[],
    keyFn: (item: T) => K
): Record<K, T[]> {
    return arr.reduce((acc, item) => {
        const key = keyFn(item);

        if (!acc[key]) {
            acc[key] = [];
        }

        acc[key].push(item);

        return acc;
    }, {} as Record<K, T[]>);
}

/**
 * Input that can be normalized to a Set (single value, array, or iterable).
 */
export type SelectionInput<T> = T | T[] | Iterable<T>;

/**
 * Normalizes a single value, array, or iterable to a Set. null/undefined → empty Set.
 */
export function toSet<T>(keys: SelectionInput<T> | null | undefined): Set<T> {
    if (keys == null) {
        return new Set();
    }

    if (typeof keys === 'string' || typeof keys === 'number') {
        return new Set([keys]);
    }

    return new Set(keys as Iterable<T>);
}
