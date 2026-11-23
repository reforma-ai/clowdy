import { watch } from 'node:fs';

import type { FSWatcher } from 'node:fs';

const DEBOUNCE_MS = 300;

/**
 * Watches skill folders and calls back once a burst of changes is over (`debounceMs` after the last event).
 * Editors write a file as several events, and git or a copy touches many at once. Debouncing and watching
 * folders rather than files follows Reforma's `skills-sync.ts` (a recursive watch, 300 ms).
 */
export class FolderWatchers {
    /** One watcher per folder, with whoever listens to it: a folder can be in several projects. */
    private watchers = new Map<string, { watcher: FSWatcher; listeners: Map<string, () => void> }>();
    private timers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(private debounceMs = DEBOUNCE_MS) {}

    /**
     * Calls `onChange` after changes under `dir`. Does nothing when `key` listens to `dir` already, and when it does not
     * exist or cannot be watched; the caller asks again later (the next request for the catalog).
     */
    watch(key: string, dir: string, onChange: () => void): void {
        const known = this.watchers.get(dir);

        if (known) {
            if (!known.listeners.has(key)) {
                known.listeners.set(key, onChange);
            }

            return;
        }

        try {
            const listeners = new Map([[key, onChange]]);
            const watcher = watch(dir, { recursive: true }, () =>
                listeners.forEach((listener, listenerKey) => this.schedule(listenerKey, listener))
            );

            watcher.on('error', () => this.drop(dir));
            this.watchers.set(dir, { watcher, listeners });
        } catch {
            // Missing or unwatchable.
        }
    }

    /** Stops `key` listening to `dir`, and watching `dir` once nobody listens; a later `watch` of it starts afresh. */
    unwatch(key: string, dir: string): void {
        const known = this.watchers.get(dir);

        known?.listeners.delete(key);

        if (known?.listeners.size === 0) {
            this.drop(dir);
        }
    }

    stop(): void {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }

        for (const dir of [...this.watchers.keys()]) {
            this.drop(dir);
        }

        this.timers.clear();
    }

    private drop(dir: string): void {
        this.watchers.get(dir)?.watcher.close();
        this.watchers.delete(dir);
    }

    private schedule(key: string, onChange: () => void): void {
        clearTimeout(this.timers.get(key));
        this.timers.set(
            key,
            setTimeout(() => {
                this.timers.delete(key);

                try {
                    onChange();
                } catch (error) {
                    console.error('[clowdy] reading the skill folders failed:', error);
                }
            }, this.debounceMs)
        );
    }
}
