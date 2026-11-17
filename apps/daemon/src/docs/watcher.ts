import { existsSync, lstatSync, watch } from 'node:fs';
import { join } from 'node:path';

import { isDocFile } from './paths';
import { flatten, listDocs } from './tree';

import type { FSWatcher } from 'node:fs';

export type DocsChange = 'created' | 'modified' | 'removed';

const DEBOUNCE_MS = 100;

/**
 * Watches one docs folder recursively and reports Markdown files and folders that appeared, changed or vanished.
 * Events of one burst are merged (about 100 ms), and paths the daemon itself just wrote are not reported.
 */
export class DocsWatcher {
    private known = new Set<string>();
    private dirty = new Set<string>();
    private timer?: ReturnType<typeof setTimeout>;
    private watcher?: FSWatcher;

    constructor(
        private root: string,
        private publish: (path: string, change: DocsChange) => void,
        /** Whether the daemon wrote this path itself a moment ago. */
        private isOwnWrite: (path: string) => boolean,
        private onFailure: () => void
    ) {}

    /** Returns false when the platform cannot watch this folder. */
    start(): boolean {
        try {
            this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
                if (filename) {
                    this.dirty.add(String(filename).replaceAll('\\', '/'));
                    this.timer ??= setTimeout(() => this.flush(), DEBOUNCE_MS);
                }
            });
            this.watcher.on('error', () => {
                this.stop();
                this.onFailure();
            });

            // Listing after the watcher exists leaves no gap: a file that appears meanwhile is either known or reported.
            this.known = new Set(flatten(listDocs(this.root)));

            return true;
        }
        catch {
            this.stop();

            return false;
        }
    }

    stop(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.watcher?.close();
        this.watcher = undefined;
    }

    private flush(): void {
        const paths = [...this.dirty].sort();

        this.timer = undefined;
        this.dirty.clear();

        for (const path of paths) {
            let change: DocsChange | undefined;

            try {
                change = this.classify(path);
            }
            catch {
                // The entry changed again while it was being looked at (a checkout or a removal that is still going):
                // that change raises its own event, which settles what the path is. Nothing may escape a timer callback.
                continue;
            }

            if (change && !this.isOwnWrite(path)) {
                this.publish(path, change);
            }
        }
    }

    private classify(path: string): DocsChange | undefined {
        const absolute = join(this.root, ...path.split('/'));

        if (!existsSync(absolute)) {
            if (!this.known.delete(path)) {
                return undefined;
            }

            for (const other of this.known) {
                if (other.startsWith(`${ path }/`)) {
                    this.known.delete(other);
                }
            }

            return 'removed';
        }

        const stat = lstatSync(absolute);

        if (stat.isSymbolicLink() || !(stat.isDirectory() || (stat.isFile() && isDocFile(path)))) {
            return undefined;
        }

        if (this.known.has(path)) {
            return stat.isFile() ? 'modified' : undefined;
        }

        this.known.add(path);

        if (stat.isDirectory()) {
            flatten(listDocs(this.root, path)).forEach(child => this.known.add(child));
        }

        return 'created';
    }
}
