/** What a cache asks `load` for: the value, and how long it is kept (0: not at all). */
export interface Loaded<V> {
    value: V;
    keepMs: number;
}

/**
 * Values kept for a time, by key, each loaded once at a time however many ask meanwhile. A load that throws keeps nothing and fails everyone who waited for it, so the next
 * ask loads again. At most `limit` values are kept; the oldest goes first.
 */
export class TtlCache<V> {
    readonly #kept = new Map<string, { value: V; until: number }>();
    readonly #pending = new Map<string, Promise<V>>();
    readonly #limit: number;
    readonly #now: () => number;

    constructor({ limit = 256, now = Date.now }: { limit?: number; now?: () => number } = {}) {
        this.#limit = limit;
        this.#now = now;
    }

    /** The value kept for `key`, else what `load` finds, loaded once for everyone who asks meanwhile. */
    get(key: string, load: () => Promise<Loaded<V>>): Promise<V> {
        const kept = this.peek(key);

        if (kept !== undefined) return Promise.resolve(kept);

        let pending = this.#pending.get(key);

        if (!pending) {
            pending = load()
                .then(({ value, keepMs }) => {
                    if (keepMs > 0) this.set(key, value, keepMs);

                    return value;
                })
                .finally(() => this.#pending.delete(key));
            this.#pending.set(key, pending);
        }

        return pending;
    }

    /** The value kept for `key`, if it is still good. */
    peek(key: string): V | undefined {
        const kept = this.#kept.get(key);

        if (kept === undefined) return undefined;

        if (kept.until > this.#now()) return kept.value;

        this.#kept.delete(key);

        return undefined;
    }

    set(key: string, value: V, keepMs: number): void {
        this.#kept.delete(key);

        while (this.#kept.size >= this.#limit) this.#kept.delete(this.#kept.keys().next().value as string);

        this.#kept.set(key, { value, until: this.#now() + keepMs });
    }

    delete(key: string): void {
        this.#kept.delete(key);
    }
}
