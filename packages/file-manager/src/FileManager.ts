import { action, computed, observable, observableRef, runInAction } from 'mobx';

import { Tabs } from './documents/Tabs';
import { TextDocument } from './documents/TextDocument';
import { FileOperations, topmost } from './FileOperations';
import { dirname, isPathWithin, normalizePath } from './paths';
import { TextSearch } from './search/TextSearch';
import { FileTree } from './tree/FileTree';

import type { TabsSnapshot } from './documents/Tabs';
import type { TextSelection } from './documents/TextDocument';
import type { ClipboardEntry, FileClipboard, FileSystemProvider, Notify, SaveParticipant, SearchService, WatchEvent } from './provider';

/** Most tabs open at once. Opening another closes the least recently used ones that have no unsaved edits. */
export const MAX_TABS = 6;

export interface FileManagerOptions {
    provider: FileSystemProvider;
    /** Run in order before every save; each may rewrite the text (e.g. a formatter). */
    saveParticipants?: SaveParticipant[];
    /** Reports errors to the person. Defaults to the console. */
    notify?: Notify;
    /** Globs for paths the explorer never shows, e.g. build output. Dotfiles match too. */
    exclude?: readonly string[];
    /** Globs for paths the explorer shows only with "Show hidden files", e.g. dotfiles. */
    hidden?: readonly string[];
    /** Searches file contents, e.g. with ripgrep on a server. Without it, search reads the shown text files through the provider. */
    search?: SearchService;
    /** The system clipboard's files. Without it the tree has no Copy and no Paste: there is nowhere to copy to. */
    clipboard?: FileClipboard;
}

/** The active tab, as a host reports it (e.g. to chat). */
export interface ActiveEditor {
    path: string;
    /** The 1-based main selection; `null` when the tab shows no text, or shows it as rich text, which has no lines. */
    selection: TextSelection | null;
    /** Lines in the buffer; `0` when the tab shows no text. */
    lineCount: number;
}

/** A file tree and its open documents over one provider. */
export class FileManager {
    readonly provider: FileSystemProvider;
    readonly tree: FileTree;
    readonly tabs = new Tabs();
    readonly operations: FileOperations = new FileOperations(this);
    readonly search: TextSearch;
    readonly saveParticipants: readonly SaveParticipant[];
    /** The provider allows no edits. */
    readonly readonly: boolean;
    /** The latest path to show in the explorer; see `reveal`. */
    @observableRef accessor revealed: { path: string } | null = null;
    /** What the Files filter looks for. */
    @observable accessor filterQuery = '';
    /** The shown files the latest filter found, with its query; `null` while the query is empty. */
    @observableRef accessor filterResult: { query: string; paths: ReadonlySet<string> } | null = null;
    /** Folders open in the Files tree, so they open again when the tree mounts again (e.g. back from the Search tab). */
    readonly openFolders = new Set<string>();
    /** The system clipboard's files, when the host gave it. */
    readonly clipboard: FileClipboard | undefined;

    readonly #notify: Notify;
    #unwatch: (() => void) | null = null;
    #listing: Promise<void> = Promise.resolve();
    #disposed = false;
    #filterGeneration = 0;

    constructor({ provider, saveParticipants = [], notify, exclude, hidden, search, clipboard }: FileManagerOptions) {
        this.provider = provider;
        this.tree = new FileTree(provider, { exclude, hidden });
        this.search = new TextSearch(this, search);
        this.saveParticipants = saveParticipants;
        this.readonly = provider.capabilities?.readonly ?? false;
        this.clipboard = clipboard;
        this.#notify = notify ?? ((message, error) => console.error(message, error));
    }

    @computed
    get activeEditor(): ActiveEditor | null {
        const document = this.tabs.active;

        if (!document) {
            return null;
        }

        return {
            path: document.path,
            selection: document.view === 'source' ? document.selection : null,
            lineCount: document.status === 'text' ? (document.state?.doc.lines ?? 0) : 0,
        };
    }

    /** Paths for the Files filter. A word matches anywhere; the provider caps the list. */
    findFiles(query: string): Promise<readonly string[]> {
        const find = this.provider.findFiles;

        if (!find || !query.trim()) {
            return Promise.resolve([]);
        }

        return find.call(this.provider, query).catch((error: unknown) => {
            this.notify('Couldn’t find files', error);

            return [];
        });
    }

    /** Starts watching and lists the tree. */
    start(): Promise<void> {
        this.#unwatch ??= this.provider.watch?.(this.#onWatch) ?? null;

        return this.#list();
    }

    /** Lists the tree again and checks open documents against the disk, e.g. after a reconnect. */
    async refresh(): Promise<void> {
        for (const document of this.tabs.documents) {
            this.#closeIfGone(document, document.handleChange());
        }

        await this.#list();
    }

    dispose(): void {
        this.#disposed = true;
        this.#unwatch?.();
        this.#unwatch = null;
        this.search.dispose();

        for (const document of this.tabs.documents) {
            document.dispose();
        }
    }

    /**
     * Opens a file in a tab, or activates its tab, and moves the selection to the given 1-based
     * range once it is loaded. A folder is revealed instead, resolving `null`.
     */
    async open(path: string, selection?: TextSelection): Promise<TextDocument | null> {
        const normalized = normalizePath(path);

        // The listing tells a folder from a file, also while `start` is still listing.
        await this.#listed();

        if (normalized === '') {
            return null;
        }

        if (this.tree.get(normalized)?.kind === 'directory') {
            this.reveal(normalized);

            return null;
        }

        const document = this.tabs.get(normalized) ?? this.#add(normalized);

        // A tab that failed to load tries again.
        if (document.status === 'error') {
            void document.load();
        }

        this.tabs.activate(normalized);
        this.#closeExtraTabs();
        await document.idle();

        if (selection) {
            document.select(selection);
        }

        return document;
    }

    /** Whether Copy has somewhere to put files: the host gave the system clipboard. */
    get canCopy(): boolean {
        return this.clipboard !== undefined;
    }

    /** Whether Paste has something to read and may write: the host gave the system clipboard, and the provider can be edited. */
    get canPaste(): boolean {
        return this.clipboard !== undefined && !this.readonly;
    }

    /** Puts files and folders on the system clipboard, where the host's file manager and other programs paste them from too. */
    async copy(paths: readonly string[]): Promise<void> {
        const targets = topmost(paths);

        if (!this.clipboard || targets.length === 0) {
            return;
        }

        try {
            await this.clipboard.write(targets);
        }
        catch (error) {
            this.notify(`Couldn’t copy ${targets.length === 1 ? targets[0] : `${targets.length} items`}`, error);
        }
    }

    /**
     * Copies what the system clipboard holds into `folder` and reveals the first copy. What is the provider's own is copied by the provider (a copied folder
     * pasted on itself is copied next to itself, as in Finder), and the rest, copied in the host's file manager, by the host.
     */
    async paste(folder: string): Promise<void> {
        const { clipboard } = this;

        if (!clipboard || this.readonly) {
            return;
        }

        let entries: readonly ClipboardEntry[];

        try {
            entries = await clipboard.read();
        }
        catch (error) {
            this.notify('Couldn’t read the clipboard', error);

            return;
        }

        if (entries.length === 0) {
            this.notify('Nothing to paste');

            return;
        }

        const target = normalizePath(folder);
        // The provider copies what its tree lists; whatever else is in its root, the tree does not know and the host copies.
        const known = (entry: ClipboardEntry) => entry.local !== undefined && this.tree.get(normalizePath(entry.local)) !== undefined;
        const own = entries.filter(known).map(entry => normalizePath(entry.local!));
        const into = own.includes(target) ? dirname(target) : target;
        const copied = await this.operations.copy(own, into);
        const imported = await this.operations.import(entries.filter(entry => !known(entry)), into);
        const [first] = [...copied, ...imported];

        if (first) {
            this.reveal(first);
        }
    }

    /** Asks the explorer to show a file or folder: its folders open, the row selected and scrolled into view. */
    @action
    reveal(path: string): void {
        this.revealed = { path: normalizePath(path) };
    }

    /**
     * Filters the Files tree to the shown files `findFiles` returns for `query`, and the ones the tree has listed that have its words (`listedFiles`), listing the
     * folders above each so they have rows. An empty query shows the whole tree again.
     */
    @action
    filter(query: string): Promise<void> {
        const generation = ++this.#filterGeneration;

        this.filterQuery = query;

        if (!query.trim()) {
            this.filterResult = null;

            return Promise.resolve();
        }

        return this.#shownMatches(query).then(paths => {
            if (generation === this.#filterGeneration) {
                runInAction(() => {
                    this.filterResult = { query, paths };
                });
            }
        });
    }

    /** Closes a tab without asking; the view asks about unsaved edits first. */
    close(path: string): void {
        const document = this.tabs.get(path);

        if (document) {
            this.tabs.remove(document);
            document.dispose();
        }
    }

    /** Saves every document with unsaved edits. Resolves `true` when all of them saved. */
    async saveAll(): Promise<boolean> {
        const dirty = this.tabs.documents.filter(document => document.dirty);
        const saved = await Promise.all(dirty.map(document => document.save()));

        return saved.every(Boolean);
    }

    snapshot(): TabsSnapshot {
        return this.tabs.snapshot();
    }

    /** Reopens tabs from a snapshot after the listing that `start` began; paths that are no longer files are skipped. */
    async restore(snapshot: TabsSnapshot): Promise<void> {
        await this.#listed();

        for (const path of snapshot.paths) {
            if ((await this.#isFile(path)) && !this.tabs.get(path)) {
                this.#add(path);
            }
        }

        if (snapshot.active !== null) {
            this.tabs.activate(snapshot.active);
        }

        if (!this.tabs.active && this.tabs.documents[0]) {
            this.tabs.activate(this.tabs.documents[0].path);
        }

        this.#closeExtraTabs();
    }

    /** Reports an error through the host's `notify`. */
    notify(message: string, error?: unknown): void {
        this.#notify(message, error);
    }

    /**
     * @internal An operation changed or removed the file of an open document. A file the tree still
     * lists, or one below its listed folders, is read again: a clean buffer reloads and a dirty one
     * shows "Changed on disk". A missing one closes a clean tab and keeps a dirty one marked deleted.
     */
    reconcile(document: TextDocument): void {
        const listed = this.tree.get(document.path)?.kind === 'file' || !this.tree.covers(document.path);

        this.#closeIfGone(document, listed ? document.handleChange() : document.handleDelete());
    }

    /**
     * The files the tree has listed so far, and shows, whose path has every word of `query`, ignoring case. They are what the person sees, which a provider's own search may
     * not know: the daemon's, for one, lists the files git tracks and leaves out the ones it ignores.
     */
    listedFiles(query: string): string[] {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);

        if (words.length === 0) {
            return [];
        }

        return [...this.tree.entries.values()]
            .filter(({ path, kind }) => kind === 'file' && words.every(word => path.toLowerCase().includes(word)) && this.tree.isVisible(path))
            .map(({ path }) => path);
    }

    /** Files `findFiles` returns and the tree has listed, that the tree shows, once the folders above them are listed. */
    async #shownMatches(query: string): Promise<ReadonlySet<string>> {
        const found = (await this.findFiles(query)).filter(path => this.tree.isVisible(path));
        const paths = [...new Set([...found, ...this.listedFiles(query)])];
        const folders = new Set<string>();

        for (const path of paths) {
            for (let dir = dirname(path); dir !== '' && !folders.has(dir); dir = dirname(dir)) {
                folders.add(dir);
            }
        }

        // A folder inside the listed window, or one listed before, is a no-op.
        const loads = await Promise.allSettled([...folders].map(dir => this.tree.load(dir)));
        const failed = loads.find(load => load.status === 'rejected');

        if (failed) {
            this.notify('Couldn’t list files', failed.reason);
        }

        return new Set(paths);
    }

    /** The active editor's selection, when it is on one line: what a host's search starts with. Rich text keeps its selection to itself. */
    selectedText(): string | undefined {
        const document = this.tabs.active;
        const state = document?.view === 'source' ? document.state : null;
        const selection = state?.selection.main;

        if (!state || !selection || selection.empty) {
            return undefined;
        }

        const text = state.sliceDoc(selection.from, selection.to);

        return text.includes('\n') ? undefined : text;
    }

    /** Whether a path is a file. Below the listed folders, its folder is listed to find out. */
    async #isFile(path: string): Promise<boolean> {
        if (this.tree.covers(path)) {
            return this.tree.get(path)?.kind === 'file';
        }

        try {
            const listed = await this.provider.list(dirname(path), 1);

            return listed.some(entry => entry.path === path && entry.kind === 'file');
        }
        catch {
            return false;
        }
    }

    /** Past `MAX_TABS`, closes the least recently used tabs that have no unsaved edits. */
    #closeExtraTabs(): void {
        const extra = this.tabs.documents.length - MAX_TABS;
        const closable = this.tabs.byLastUse().filter(document => !document.dirty && document !== this.tabs.active);

        for (const document of closable.slice(0, Math.max(extra, 0))) {
            this.close(document.path);
        }
    }

    #add(path: string): TextDocument {
        const document = new TextDocument(path, this);

        this.tabs.add(document);
        void document.load();

        return document;
    }

    #list(): Promise<void> {
        const listing = this.tree.refresh().catch((error: unknown) => {
            this.notify('Couldn’t list files', error);
        });

        this.#listing = listing;

        return listing;
    }

    /** Resolves once the latest listing is in, including one a resync started meanwhile. */
    async #listed(): Promise<void> {
        let listing: Promise<void>;

        do {
            listing = this.#listing;
            await listing;
        } while (listing !== this.#listing);
    }

    #onWatch = (event: WatchEvent): void => {
        if (this.#disposed) {
            return;
        }

        if (event.type === 'resync') {
            void this.refresh();

            return;
        }

        this.tree.applyChanges(event.changes);

        for (const change of event.changes) {
            if (change.type !== 'deleted') {
                const document = this.tabs.get(change.path);

                if (document) {
                    this.#closeIfGone(document, document.handleChange(change.version));
                }

                continue;
            }

            for (const document of this.tabs.documents.filter(open => isPathWithin(open.path, change.path))) {
                // Created again in the same batch (e.g. replaced by a move): its created change reloads it.
                if (this.tree.get(document.path)?.kind === 'file') {
                    continue;
                }

                // Below the listed folders the tree can't tell; the re-read closes it when it is gone.
                this.#closeIfGone(
                    document,
                    this.tree.covers(document.path) ? document.handleDelete() : document.handleChange()
                );
            }
        }
    };

    /** Closes a document's tab once it reports its file gone with a clean buffer. */
    #closeIfGone(document: TextDocument, gone: Promise<boolean>): void {
        void gone.then(clean => {
            if (clean && this.tabs.get(document.path) === document) {
                this.close(document.path);
            }
        });
    }
}
