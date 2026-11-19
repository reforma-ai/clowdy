import { existsSync, lstatSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';

import { CLOWDY_DIR, DOCS_DIR, isDocFile, realPathBelow } from './paths';
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

    /**
     * Returns false when the platform cannot watch this folder. `announceFound` reports what the folder already holds as created: a docs
     * folder that has just appeared, whose files nobody announced yet.
     */
    start(announceFound = false): boolean {
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

            if (announceFound) {
                [...this.known].filter(path => !this.isOwnWrite(path)).forEach(path => this.publish(path, 'created'));
            }

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

const isDirectory = (path: string) => {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
};

/**
 * Watches the documents of one folder. Once its `.clowdy/docs` exists, that is watched as `DocsWatcher` does. Until then the folder, and then
 * its `.clowdy`, are watched (not recursively, so a large repository costs one watch) for the docs folder to appear: nothing makes it before
 * the first document is written there, by the daemon or by an agent. What a docs folder holds when it appears is reported as created.
 */
export class FolderDocsWatcher {
    private docs?: DocsWatcher;
    /** While the docs folder does not exist: the folder that is watched for it. */
    private waiting?: { dir: string; watcher: FSWatcher };
    private stopped = false;

    constructor(
        private folder: string,
        private publish: (path: string, change: DocsChange) => void,
        private isOwnWrite: (path: string) => boolean,
        private onFailure: () => void
    ) {}

    /** Returns false when the platform cannot watch the folder. */
    start(): boolean {
        return this.settle(false);
    }

    /**
     * Looks whether the docs folder exists now, and moves the watch onto it when it does. A waiting watch calls this on every change it sees;
     * the daemon calls it after its own first write, so the files it wrote are known before anything reports them.
     */
    check(): void {
        if (this.docs || this.stopped || this.settle(true)) {
            return;
        }

        this.stop();
        this.onFailure();
    }

    stop(): void {
        this.stopped = true;
        this.docs?.stop();
        this.docs = undefined;
        this.closeWaiting();
    }

    private settle(announce: boolean): boolean {
        const docs = join(this.folder, DOCS_DIR);

        if (isDirectory(docs)) {
            this.closeWaiting();

            const root = realPathBelow(this.folder, docs);

            // A docs folder that is a link out of its folder is refused to read and write, so nothing in it is announced either.
            if (!root) {
                return true;
            }

            const watcher = new DocsWatcher(root, this.publish, this.isOwnWrite, () => {
                this.stop();
                this.onFailure();
            });

            if (!watcher.start(announce)) {
                return false;
            }

            this.docs = watcher;

            return true;
        }

        const clowdy = join(this.folder, CLOWDY_DIR);
        const dir = isDirectory(clowdy) ? clowdy : this.folder;

        if (this.waiting?.dir !== dir) {
            this.closeWaiting();

            try {
                const watcher = watch(dir, () => this.check());

                watcher.on('error', () => {
                    this.stop();
                    this.onFailure();
                });
                this.waiting = { dir, watcher };
            }
            catch {
                return false;
            }
        }

        // A watch reports nothing that happened before it began: look again at what may have appeared while it was being set up.
        return isDirectory(docs) || (dir === this.folder && isDirectory(clowdy)) ? this.settle(announce) : true;
    }

    private closeWaiting(): void {
        this.waiting?.watcher.close();
        this.waiting = undefined;
    }
}
