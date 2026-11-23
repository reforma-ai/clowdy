export function parseJson<T>(text: string | null): T | undefined {
    return text === null ? undefined : (JSON.parse(text) as T);
}

export function toJson(value: unknown): string | null {
    return value === undefined ? null : JSON.stringify(value);
}

/** Drops `null` and `undefined` members: rows have NULLs where the protocol has absent optional fields. */
export function clean<T extends object>(value: T): T {
    return Object.fromEntries(
        Object.entries(value).filter(([, member]) => member !== null && member !== undefined)
    ) as T;
}
