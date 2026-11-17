/** The part of `Storage` the stores use. */
export interface KeyValueStorage {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
}

/** `localStorage`, or nothing where the browser blocks it (private windows, blocked site data). */
export function browserStorage(): KeyValueStorage | undefined {
    try {
        return window.localStorage;
    }
    catch {
        return undefined;
    }
}

/** A stored JSON value, or `undefined` when there is none, it is not JSON, or storage throws. */
export function readStored(storage: KeyValueStorage | undefined, key: string): unknown {
    try {
        const raw = storage?.getItem(key);

        return raw == null ? undefined : JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}

export function writeStored(storage: KeyValueStorage | undefined, key: string, value: unknown): void {
    try {
        storage?.setItem(key, JSON.stringify(value));
    }
    catch {
        // Storage is a convenience: a full or blocked one must not break the app.
    }
}
