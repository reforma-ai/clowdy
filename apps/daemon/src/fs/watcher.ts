import { watch } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { CUTOFF_NAMES, isAddressable, TRANSIENT_NAME, underCutoff } from './paths';
import { describe, walkTree } from './walk';

import type { FsChange, FsKind, FsWatchEvent } from '@clowdy/protocol';
import type { FSWatcher } from 'node:fs';

/** Events of one burst are merged: a change is told this long after the first event of the burst. */
export const WATCH_DEBOUNCE_MS = 100;

/** What a watcher remembers of a folder. */
const MAX_KNOWN = 200_000;
/** A checkout of another branch is more than the watcher works through. */
const MAX_BURST = 20_000;
/** A folder that appears is told with its content, up to this many entries; more and the clients list again. */
const MAX_CREATED_SUBTREE = 2000;
/** How long a watcher waits to start again after the platform stopped it, doubling up to the longest. */
const RESTART_MS = 1000;
const MAX_RESTART_MS = 30_000;

export interface WatchOptions {
    /** A test shortens it. */
    debounceMs?: number;
    /** A burst of more paths than this is not worked through: the clients list again. */
    maxBurst?: number;
    /** More entries than this and the watcher tells what it finds without knowing what was there before. */
    maxKnown?: number;
}

/** One client of a watch. `end` is called when the watch is over (the daemon stops). */
export interface WatchSubscriber {
    send(event: FsWatchEvent): void;
    end(): void;
}

interface Known {
    kind: FsKind;
    /** A file's version. */
    version?: string;
}

/**
 * Watches one folder, once, however many clients listen: a recursive `fs.watch` (changes under `.git` and `node_modules` are dropped as
 * they come), the debounce of a burst, and what the folder held, so that a path that appears is `created`, one that changes `changed` (only
 * when its version did), one that vanishes `deleted`. The platform's own event names are no help: a file saved over an existing one, and one
 * made new, both arrive as `rename`. The daemon's own writes are told like anyone's, with their version, which is how a client knows its own
 * save when it hears it.
 */
export class FolderWatch {
    private subscribers = new Set<WatchSubscriber>();
    private known = new Map<string, Known>();
    /** Whether `known` holds everything in the folder: when not, a path it does not know that exists is told `created`, and one gone `deleted`. */
    private complete = true;
    private dirty = new Set<string>();
    private timer?: ReturnType<typeof setTimeout>;
    private restartTimer?: ReturnType<typeof setTimeout>;
    private restartDelay = RESTART_MS;
    private watcher?: FSWatcher;
    /** The folder's state read, and the batches told so far. Changes wait for the first. */
    private ready: Promise<void> = Promise.resolve();
    private working: Promise<void> = Promise.resolve();
    private closed = false;

    /** @param root The real path of the folder. */
    constructor(readonly root: string, private options: WatchOptions = {}) {}

    get size(): number {
        return this.subscribers.size;
    }

    /** Starts watching; throws when the platform cannot. */
    start(): void {
        this.attach();
        this.ready = this.read();
    }

    subscribe(subscriber: WatchSubscriber): () => void {
        this.subscribers.add(subscriber);

        return () => void this.subscribers.delete(subscriber);
    }

    /** Ends every client's stream and lets go of the platform's watch. */
    close(): void {
        this.closed = true;
        clearTimeout(this.timer);
        clearTimeout(this.restartTimer);
        this.watcher?.close();
        this.watcher = undefined;

        for (const subscriber of [...this.subscribers]) {
            subscriber.end();
        }

        this.subscribers.clear();
    }

    private attach(): void {
        this.watcher = watch(this.root, { recursive: true }, (_event, filename) => this.hear(filename));
        this.watcher.on('error', () => this.lost());
    }

    private hear(filename: string | Buffer | null): void {
        const path = filename === null ? '' : String(filename).replaceAll('\\', '/');

        if (path === '') {
            // The platform names no path: anything may have changed.
            this.resync();

            return;
        }

        const name = path.slice(path.lastIndexOf('/') + 1);

        if (underCutoff(path) || TRANSIENT_NAME.test(name) || !isAddressable(path)) {
            return;
        }

        this.dirty.add(path);
        this.timer ??= setTimeout(() => this.flush(), this.options.debounceMs ?? WATCH_DEBOUNCE_MS);
    }

    private flush(): void {
        const paths = [...this.dirty].sort();

        this.timer = undefined;
        this.dirty.clear();
        this.working = this.working.then(async () => {
            await this.ready;

            if (this.closed) {
                return;
            }

            if (paths.length > (this.options.maxBurst ?? MAX_BURST)) {
                this.resync();

                return;
            }

            try {
                await this.tell(paths);
            }
            catch (error) {
                // A path that changed again while it was looked at raises its own event; nothing may escape into the event loop.
                console.warn('[clowdy] could not tell the changes of a watched folder:', error);
            }
        });
    }

    /** Reads what the folder holds now, as the state later changes are compared with. */
    private async read(): Promise<void> {
        const known = new Map<string, Known>();

        try {
            const { items, truncated } = await walkTree({ root: this.root, start: '', startReal: this.root, depth: Number.POSITIVE_INFINITY, cap: this.options.maxKnown ?? MAX_KNOWN });

            for (const { entry, version } of items) {
                known.set(entry.path, { kind: entry.kind, version });
            }

            this.complete = !truncated;
        }
        catch {
            this.complete = false;
        }

        this.known = known;
    }

    /**
     * What the folder has at `path` now, and whether it is a real folder (one that is entered; a link to a folder is not). Links that lead
     * out of the folder, and special files, are nothing.
     */
    private async look(path: string): Promise<{ kind: FsKind; size?: number; version?: string; entered: boolean } | undefined> {
        const abs = join(this.root, ...path.split('/'));
        let info;

        try {
            info = await lstat(abs);
        }
        catch {
            return undefined;
        }

        const found = await describe(this.root, abs, info.isFile() ? 'file' : info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'link' : 'other', path);

        return found && { kind: found.entry.kind, size: found.entry.size, version: found.version, entered: info.isDirectory() };
    }

    /** Drops what the folder held below the folders told deleted, in one pass however many there are. */
    private prune(gone: ReadonlySet<string>): void {
        if (gone.size === 0) {
            return;
        }

        for (const path of this.known.keys()) {
            for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
                if (gone.has(path.slice(0, slash))) {
                    this.known.delete(path);

                    break;
                }
            }
        }
    }

    private async tell(paths: readonly string[]): Promise<void> {
        const changes: FsChange[] = [];
        /** Told in this batch already, as part of a folder that arrived. */
        const told = new Set<string>();
        /** Folders told deleted: what is below them is told by that. */
        const gone = new Set<string>();
        let incomplete = false;

        const underGone = (path: string) => {
            for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
                if (gone.has(path.slice(0, slash))) {
                    return true;
                }
            }

            return false;
        };

        const vanished = (path: string, before: Known | undefined) => {
            this.known.delete(path);

            if (before?.kind === 'directory') {
                gone.add(path);
            }

            changes.push({ type: 'deleted', path });
        };

        for (const path of paths) {
            if (told.has(path) || underGone(path)) {
                continue;
            }

            const now = await this.look(path);
            const before = this.known.get(path);

            if (!now) {
                if (before || !this.complete) {
                    vanished(path, before);
                }

                continue;
            }

            if (before && before.kind !== now.kind) {
                vanished(path, before);
            }
            else if (before) {
                if (now.kind === 'file' && before.version !== now.version) {
                    this.known.set(path, { kind: 'file', version: now.version });
                    changes.push({ type: 'changed', path, version: now.version, size: now.size });
                }

                continue;
            }

            this.known.set(path, { kind: now.kind, version: now.version });
            told.add(path);
            changes.push(now.kind === 'file' ? { type: 'created', path, kind: 'file', version: now.version, size: now.size } : { type: 'created', path, kind: 'directory' });

            if (now.entered && !CUTOFF_NAMES.has(path.slice(path.lastIndexOf('/') + 1))) {
                // A folder moved or copied in arrives whole, without an event for what is in it.
                const { items, truncated } = await walkTree({ root: this.root, start: path, startReal: join(this.root, ...path.split('/')), depth: Number.POSITIVE_INFINITY, cap: MAX_CREATED_SUBTREE }).catch(() => ({ items: [], truncated: true }));

                incomplete ||= truncated;

                for (const { entry, version } of items) {
                    if (!this.known.has(entry.path)) {
                        this.known.set(entry.path, { kind: entry.kind, version });
                        changes.push(entry.kind === 'file' ? { type: 'created', path: entry.path, kind: 'file', version, size: entry.size } : { type: 'created', path: entry.path, kind: 'directory' });
                    }

                    told.add(entry.path);
                }
            }
        }

        this.prune(gone);

        if (changes.length > 0) {
            this.send({ type: 'changes', changes });
        }

        if (incomplete) {
            this.send({ type: 'resync' });
        }
    }

    private send(event: FsWatchEvent): void {
        for (const subscriber of this.subscribers) {
            try {
                subscriber.send(event);
            }
            catch {
                // A client that cannot be written to is gone; its stream ends itself.
            }
        }
    }

    /** Changes may have been missed: the clients list again, and what the watcher knows is read anew. */
    private resync(): void {
        this.dirty.clear();
        this.ready = this.read();
        this.send({ type: 'resync' });
    }

    /** The platform stopped the watch: start it again after a pause, and tell the clients to list again once it runs. */
    private lost(): void {
        this.watcher?.close();
        this.watcher = undefined;

        if (this.closed || this.restartTimer) {
            return;
        }

        this.restartTimer = setTimeout(() => {
            this.restartTimer = undefined;

            if (this.closed) {
                return;
            }

            try {
                this.attach();
                this.restartDelay = RESTART_MS;
                this.resync();
            }
            catch {
                this.restartDelay = Math.min(this.restartDelay * 2, MAX_RESTART_MS);
                this.lost();
            }
        }, this.restartDelay);
    }
}
