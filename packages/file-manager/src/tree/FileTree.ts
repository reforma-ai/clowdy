import { Minimatch } from 'minimatch';
import { action, computed, observable, observableShallow, runInAction } from 'mobx';

import { basename, dirname, normalizePath } from '../paths';
import { FileSystemError } from '../provider';

import type { FileChange, FileEntry, FileSystemProvider } from '../provider';

export type FileTreeStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Globs over provider-relative paths, dotfiles included. A match also hides everything inside it. */
export interface FileTreeFilters {
    /** Never shown, e.g. build output. */
    exclude?: readonly string[];
    /** Shown only while `showHidden` is on, e.g. dotfiles. */
    hidden?: readonly string[];
}

type Visibility = 'shown' | 'hidden' | 'excluded';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/** The first listing. `src/app/foo` is included; `src/app/foo/bar.ts` waits until `foo` is opened. */
const INITIAL_DEPTH = 3;

function compareEntries(a: FileEntry, b: FileEntry): number {
    if (a.kind !== b.kind) {
        return a.kind === 'directory' ? -1 : 1;
    }

    const nameA = basename(a.path);
    const nameB = basename(b.path);

    // Siblings have distinct names, so a case-only tie still gets a stable order.
    return collator.compare(nameA, nameB) || (nameA < nameB ? -1 : 1);
}

function addEntry(entries: Map<string, FileEntry>, entry: FileEntry): void {
    entries.set(entry.path, entry);

    for (let dir = dirname(entry.path); dir !== '' && !entries.has(dir); dir = dirname(dir)) {
        entries.set(dir, { path: dir, kind: 'directory' });
    }
}

function removeEntry(entries: Map<string, FileEntry>, path: string): void {
    const kind = entries.get(path)?.kind;

    entries.delete(path);

    if (kind === 'file') {
        return;
    }

    const prefix = `${path}/`;

    for (const key of [...entries.keys()]) {
        if (key.startsWith(prefix)) {
            entries.delete(key);
        }
    }
}

function applyChange(entries: Map<string, FileEntry>, change: FileChange): void {
    if (change.type === 'deleted') {
        removeEntry(entries, change.path);

        return;
    }

    const existing = entries.get(change.path);
    const kind = change.type === 'created' ? change.kind : (existing?.kind ?? 'file');

    addEntry(entries, {
        path: change.path,
        kind,
        size: change.size ?? existing?.size,
        ...(kind === 'directory' && existing?.hasChildren !== undefined ? { hasChildren: existing.hasChildren } : {}),
    });
}

/** The provider's listing as an index, patched by watch changes, with the globs that hide paths. */
export class FileTree {
    /** Every listed path, files and directories, keyed by path; hidden and excluded ones included. */
    @observableShallow accessor entries: Map<string, FileEntry> = new Map();
    @observable accessor status: FileTreeStatus = 'idle';
    /** Paths matching the hidden globs are shown too. */
    @observable accessor showHidden = false;

    readonly #provider: FileSystemProvider;
    readonly #exclude: Minimatch[];
    readonly #hidden: Minimatch[];
    /** How each path matches the globs by itself; its folders are checked on their own. */
    readonly #visibility = new Map<string, Visibility>();
    /** Changes seen while a listing is in flight, replayed on top of it. */
    #pending: FileChange[] | null = null;
    #generation = 0;
    /** How deep the root listing reached. A path with at most this many segments is in the window. */
    #rootDepth = 0;
    /** Folders opened past the root window. A resync lists these again, not the rest of the project. */
    #opened = new Set<string>();
    /** Folders `loadDeep` listed whole: a resync lists each of them once, whole, and not every folder below it one by one. */
    readonly #deep = new Set<string>();
    /** Folders `loadDeep` was asked for while a refresh was in flight: that refresh's listing knows nothing of them, so they are listed again once it has committed. */
    readonly #deepRetry = new Set<string>();
    /** Creates under a folder this tab has not listed. They are not rows; they give that folder a chevron. */
    #below = new Set<string>();

    /** Shown entries by parent, sorted. Kept alive so reads outside a reaction reuse it. */
    readonly #byParent = computed(
        () => {
            const byParent = new Map<string, FileEntry[]>();

            for (const entry of this.entries.values()) {
                if (!this.#shows(entry.path)) {
                    continue;
                }

                const parent = dirname(entry.path);
                const siblings = byParent.get(parent);

                if (siblings) {
                    siblings.push(entry);
                } else {
                    byParent.set(parent, [entry]);
                }
            }

            for (const siblings of byParent.values()) {
                siblings.sort(compareEntries);
            }

            return byParent;
        },
        { keepAlive: true }
    );

    /** Every entry by parent, sorted, with no rule of hiding or excluding: for a view of the tree that has rules of its own. */
    readonly #allByParent = computed(
        () => {
            const byParent = new Map<string, FileEntry[]>();

            for (const entry of this.entries.values()) {
                const parent = dirname(entry.path);
                const siblings = byParent.get(parent);

                if (siblings) {
                    siblings.push(entry);
                } else {
                    byParent.set(parent, [entry]);
                }
            }

            for (const siblings of byParent.values()) {
                siblings.sort(compareEntries);
            }

            return byParent;
        },
        { keepAlive: true }
    );

    constructor(provider: FileSystemProvider, { exclude = [], hidden = [] }: FileTreeFilters = {}) {
        this.#provider = provider;
        this.#exclude = exclude.map(glob => new Minimatch(glob, { dot: true }));
        this.#hidden = hidden.map(glob => new Minimatch(glob, { dot: true }));
    }

    get(path: string): FileEntry | undefined {
        return this.entries.get(path);
    }

    /** Shown children of a shown directory (`''` is the root): folders first, then natural name order. */
    children(path = ''): readonly FileEntry[] {
        return this.#byParent.get().get(path) ?? [];
    }

    /**
     * The listed children of a folder (`''` is the root), whatever the hidden and excluded globs say, folders first, then natural name order. For a view that draws a
     * part of the tree by rules of its own, such as a folder of documents inside a hidden one.
     */
    entriesOf(path = ''): readonly FileEntry[] {
        return this.#allByParent.get().get(path) ?? [];
    }

    /** The path and every folder above it are shown. */
    isVisible(path: string): boolean {
        for (let current = normalizePath(path); current !== ''; current = dirname(current)) {
            if (!this.#shows(current)) {
                return false;
            }
        }

        return true;
    }

    /** The path, or a folder above it, matches the hidden globs: a row the tree draws only while `showHidden` is on. */
    isHidden(path: string): boolean {
        for (let current = normalizePath(path); current !== ''; current = dirname(current)) {
            if (this.#visibilityOf(current) === 'hidden') {
                return true;
            }
        }

        return false;
    }

    /** Globs of the paths it does not show: the excluded ones, and the hidden ones unless `showHidden`. */
    get unshownGlobs(): string[] {
        return [...this.#exclude, ...(this.showHidden ? [] : this.#hidden)].map(glob => glob.pattern);
    }

    @action
    setShowHidden(show: boolean): void {
        this.showHidden = show;
    }

    /** Lists the root at depth 3 and each folder this tab has opened. Changes that arrive meanwhile are applied on top. */
    async refresh(): Promise<void> {
        const generation = ++this.#generation;

        this.#pending ??= [];

        if (this.status !== 'ready') {
            runInAction(() => {
                this.status = 'loading';
            });
        }

        const openedAtStart = new Set(this.#opened);

        try {
            const listed: FileEntry[] = [];
            const covered = new Set<string>();

            const deepRoots = [...this.#deep];
            const belowDeep = (dir: string) => deepRoots.some(root => dir === root || dir.startsWith(`${root}/`));

            // A folder opened while this listing is in flight is listed before the tree is replaced. The folders below a deep one are in its own listing.
            for (;;) {
                const extra = [...this.#opened].filter(dir => !covered.has(dir) && !belowDeep(dir));

                if (covered.size > 0 && extra.length === 0) {
                    break;
                }

                const includeRoot = covered.size === 0;
                const [root, nested, deep] = await Promise.all([
                    includeRoot ? this.#provider.list('', INITIAL_DEPTH) : Promise.resolve([]),
                    Promise.all(extra.map(dir => this.#listOpened(dir))).then(groups => groups.flat()),
                    includeRoot
                        ? Promise.all(deepRoots.map(dir => this.#listDeepAgain(dir))).then(groups => groups.flat())
                        : Promise.resolve([]),
                ]);

                if (generation !== this.#generation) {
                    return;
                }

                covered.add('');

                for (const dir of extra) {
                    covered.add(dir);
                }
                listed.push(...root, ...nested, ...deep);
            }

            runInAction(() => {
                const entries = new Map<string, FileEntry>();

                for (const entry of listed) {
                    addEntry(entries, entry);
                }

                const queued = this.#pending ?? [];

                this.entries = entries;
                this.#rootDepth = INITIAL_DEPTH;
                this.#below.clear();
                this.#pending = null;

                for (const change of queued) {
                    this.#apply(change);
                }

                this.status = 'ready';
            });

            await this.#retryDeep();
        } catch (error) {
            if (generation === this.#generation) {
                this.#pending = null;

                for (const dir of this.#opened) {
                    if (!openedAtStart.has(dir)) {
                        this.#opened.delete(dir);
                    }
                }

                runInAction(() => {
                    this.status = 'error';
                });
            }

            throw error;
        }
    }

    /**
     * Lists one folder the root window did not include. A folder already inside that window is a no-op.
     * Opening it is what a resync will list again.
     */
    async load(path: string): Promise<void> {
        const dir = normalizePath(path);

        if (!dir || this.#opened.has(dir)) {
            return;
        }

        const segments = dir.split('/').filter(Boolean).length;

        if (this.#rootDepth > 0 && segments < this.#rootDepth) {
            return;
        }

        const generation = this.#generation;

        this.#opened.add(dir);

        // A refresh in flight lists `#opened` before it commits. Listing here would race that replace.
        if (this.#pending) {
            return;
        }

        try {
            const listed = await this.#provider.list(dir, 1);

            if (generation !== this.#generation || this.#pending) {
                return;
            }

            runInAction(() => {
                for (const entry of listed) {
                    addEntry(this.entries, entry);
                }

                const self = this.entries.get(dir);

                if (self) {
                    this.entries.set(dir, { ...self, hasChildren: listed.length > 0 });
                }
            });
        } catch (error) {
            if (generation === this.#generation && !this.#pending) {
                this.#opened.delete(dir);
            }

            throw error;
        }
    }

    /**
     * Lists a folder and everything below it, for a view that needs the whole of a small part of the tree (a folder of documents), and counts every folder it
     * listed as opened, so a resync lists them again and the changes below them show. A folder that is not there lists nothing. Not while a refresh is in
     * flight: its listing replaces the entries and knows nothing of this folder, so the folder is listed again once the refresh has committed.
     */
    async loadDeep(path: string): Promise<void> {
        const dir = normalizePath(path);

        if (this.#pending) {
            this.#deepRetry.add(dir);

            return;
        }

        const generation = this.#generation;
        let listed: FileEntry[];

        try {
            listed = await this.#provider.list(dir);
        } catch (error) {
            if (FileSystemError.is(error, 'NotFound')) {
                return;
            }

            throw error;
        }

        if (generation !== this.#generation || this.#pending) {
            this.#deepRetry.add(dir);

            // A refresh that began and committed while the folder was being listed has nobody left to ask again.
            if (!this.#pending) {
                await this.#retryDeep();
            }

            return;
        }

        runInAction(() => {
            for (const entry of listed) {
                addEntry(this.entries, entry);

                if (entry.kind === 'directory') {
                    this.#opened.add(entry.path);
                }
            }

            if (dir !== '') {
                this.#opened.add(dir);
                this.#deep.add(dir);
            }
        });
    }

    /**
     * An opened folder's entries for a resync. A folder that is gone since it was opened (a resync that came with no delete events says nothing of it, as after a branch
     * was checked out) lists nothing and is forgotten: one folder that is not there must not fail the listing of the rest, again and again.
     */
    async #listOpened(dir: string): Promise<FileEntry[]> {
        try {
            return await this.#provider.list(dir, 1);
        } catch (error) {
            if (FileSystemError.is(error, 'NotFound')) {
                this.#opened.delete(dir);

                return [];
            }

            throw error;
        }
    }

    /** A deep folder's entries, whole, for a resync. One that is gone is forgotten with the folders opened below it. */
    async #listDeepAgain(dir: string): Promise<FileEntry[]> {
        try {
            return await this.#provider.list(dir);
        } catch (error) {
            if (FileSystemError.is(error, 'NotFound')) {
                this.#deep.delete(dir);

                for (const opened of [...this.#opened]) {
                    if (opened === dir || opened.startsWith(`${dir}/`)) {
                        this.#opened.delete(opened);
                    }
                }

                return [];
            }

            throw error;
        }
    }

    /** Lists again the folders `loadDeep` could not list while a refresh was in flight. A folder that fails stays as the refresh left it: its top level. */
    async #retryDeep(): Promise<void> {
        const roots = [...this.#deepRetry];

        this.#deepRetry.clear();
        await Promise.all(roots.map(root => this.loadDeep(root).catch(() => undefined)));
    }

    @action
    applyChanges(changes: readonly FileChange[]): void {
        if (this.#pending) {
            this.#pending.push(...changes);

            return;
        }

        for (const change of changes) {
            this.#apply(change);
        }
    }

    /**
     * The tree has listed this path's folder: the path is inside the root window or a direct child of
     * a folder this tab opened. A covered path the tree lacks is gone; below that, only a read can tell.
     */
    covers(path: string): boolean {
        const segments = path.split('/').filter(Boolean).length;

        if (this.#rootDepth > 0 && segments <= this.#rootDepth) {
            return true;
        }

        return this.#opened.has(dirname(path));
    }

    #apply(change: FileChange): void {
        if (change.type !== 'deleted' && !this.covers(change.path)) {
            this.#noteBelow(change.path);

            return;
        }

        applyChange(this.entries, change);

        const entry = this.entries.get(change.path);

        if (entry?.kind === 'directory') {
            this.#chevronFor(change.path);
        }

        if (change.type !== 'deleted') {
            return;
        }

        this.#dropBelow(change.path);
        this.#opened.delete(change.path);

        for (const dir of [...this.#opened]) {
            if (dir.startsWith(`${change.path}/`)) {
                this.#opened.delete(dir);
            }
        }
    }

    /** A create under a folder the tree has not listed. The row waits for that folder to open. */
    #noteBelow(path: string): void {
        this.#below.add(path);

        for (let dir = dirname(path); dir !== ''; dir = dirname(dir)) {
            const entry = this.entries.get(dir);

            if (entry?.kind === 'directory') {
                this.#chevronFor(dir);

                return;
            }
        }
    }

    #chevronFor(path: string): void {
        const prefix = `${path}/`;

        if (![...this.#below].some(child => child.startsWith(prefix))) {
            return;
        }

        const entry = this.entries.get(path);

        if (entry?.kind === 'directory' && entry.hasChildren !== true) {
            this.entries.set(path, { ...entry, hasChildren: true });
        }
    }

    #dropBelow(path: string): void {
        const prefix = `${path}/`;

        for (const child of this.#below) {
            if (child === path || child.startsWith(prefix)) {
                this.#below.delete(child);
            }
        }
    }

    #visibilityOf(path: string): Visibility {
        let visibility = this.#visibility.get(path);

        if (visibility === undefined) {
            visibility = this.#exclude.some(glob => glob.match(path))
                ? 'excluded'
                : this.#hidden.some(glob => glob.match(path))
                  ? 'hidden'
                  : 'shown';
            this.#visibility.set(path, visibility);
        }

        return visibility;
    }

    #shows(path: string): boolean {
        const visibility = this.#visibilityOf(path);

        return visibility === 'shown' || (visibility === 'hidden' && this.showHidden);
    }
}
