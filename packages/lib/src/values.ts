type NonInheritValue<T> = T extends 'default' | 'inherit' | null | undefined ? never : T;

/**
 * Returns the default value if the passed value is empty or inherit
 */
export function defaultValue<Args extends any[]>(
    ...variables: Args
): NonInheritValue<Args[number]> extends never
    ? Args extends [any, ...any[]]
        ? Args[number] | undefined
        : undefined
    : NonInheritValue<Args[number]> {
    let last: any;

    while (variables.length) {
        last = variables.shift();

        if (last != null && last !== 'default' && last !== 'inherit') {
            return last;
        }
    }

    return last;
}

/**
 * Normalize various truthy/falsy values to a boolean.
 *
 * Returns `true` for: `true`, `'true'`, `'1'`, `1`
 * Returns `false` for: `false`, `'false'`, `'0'`, `0`, `null`
 *
 * @example
 * normalizeBoolean(true) // true
 * normalizeBoolean('true') // true
 * normalizeBoolean('string') // true
 * normalizeBoolean('1') // true
 * normalizeBoolean('false') // false
 * normalizeBoolean('0') // false
 * normalizeBoolean(0) // false
 * normalizeBoolean(null) // false
 * normalizeBoolean(undefined) // undefined
 */
export function normalizeBoolean(value: unknown): boolean | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (value === 'true') {
        return true;
    }

    if (value === 'false' || value === '0') {
        return false;
    }

    return Boolean(value);
}
