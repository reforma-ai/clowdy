/**
 * Structure clone any object
 */
export const clone = <T = any>(data: T): T => {
    if (typeof data !== 'object' || data == null) {
        return data;
    }

    if (Array.isArray(data)) {
        return data.map(item => clone(item)) as T;
    }

    const copy = { ...data } as Record<string, unknown>;

    for (const key of Object.keys(copy)) {
        copy[key] = clone(copy[key]);
    }

    return copy as T;
};

/**
 * Recursively freezes an object / array graph.
 * Already-frozen roots are returned as-is.
 */
export function deepFreeze<T>(value: T): Readonly<T> {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
        return value;
    }

    for (const key of Reflect.ownKeys(value)) {
        deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }

    return Object.freeze(value);
}
