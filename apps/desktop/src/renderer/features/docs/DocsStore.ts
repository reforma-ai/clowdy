import { folderNames, mainFolder } from '@clowdy/protocol';
import { computedStruct, makeAutoObservable, observableRef, observableShallow, reaction, runInAction } from 'mobx';

import { TransportError } from '../../daemon/transport';
import { DocBuffer, type DiskVersion } from './DocBuffer';
import { copyPath, initialContent, newDocumentPath } from './names';
import { ancestorKeys, docKey, docsNodes, fileNodes, filterTree, type DocRef, type DocsNode } from './tree';

import type { CommandResult, DocsTree, FolderId, ProjectId } from '@clowdy/protocol';
import type { CommandInput, Transport } from '../../daemon/transport';
import type { ProjectState, ProjectUi } from '../../stores';

export type DocsTab = 'editor' | 'markdown' | 'preview';
export type TreeStatus = 'loading' | 'ready' | 'failed';
export type CreateResult = { ok: true; path: string } | { ok: false; message: string };

/** A folder of the project as the Documents screen names it. */
export interface DocsFolderView {
    folderId: FolderId;
    name: string;
    path: string;
}

export interface DocsStoreDeps {
    project: Pick<ProjectState, 'id' | 'project' | 'lastDocsChange'>;
    ui: Pick<ProjectUi, 'docPath' | 'docFolderId' | 'openDoc'>;
    transport: Pick<Transport, 'getDocsTree' | 'getDocFile'>;
    command: (input: CommandInput) => Promise<CommandResult>;
}

const isDiskVersion = (value: unknown): value is DiskVersion => (
    typeof value === 'object' && value !== null && typeof (value as DiskVersion).content === 'string' && typeof (value as DiskVersion).hash === 'string'
);

/**
 * The Documents screen's state for one project: the docs tree of each of its folders, the selection, and one `DocBuffer` for the open
 * document and for every document that holds unsaved text. A document is known by its folder and its path (`docKey`), since two folders
 * may hold the same path. It lives as long as the project does, so another section and back loses nothing.
 *
 * Unsaved text is never dropped. A buffer is released only when leaving it loses nothing (its text is on disk),
 * and a disk version that differs from edited text waits as a conflict for the person's choice.
 */
export class DocsStore {
    /** The daemon's answer: the documents of each folder, in the project's order. */
    tree: DocsTree = [];
    treeStatus: TreeStatus = 'loading';
    treeError = '';
    query = '';
    tab: DocsTab = 'editor';
    /** The rows that show their contents, by key. */
    expanded = new Set<string>();
    /** By `docKey`. */
    buffers = new Map<string, DocBuffer>();
    readonly #deps: DocsStoreDeps;
    /** Counts the looks at a file and the saves of it, so that a look that began before a newer one is dropped. */
    readonly #versions = new WeakMap<DocBuffer, number>();
    /** Buffers whose file changed on disk while they loaded or saved: look again when that ends. */
    readonly #recheck = new WeakSet<DocBuffer>();
    #treeLoading = false;
    #treeAgain = false;
    #treeLoadedOnce = false;
    /** The folders whose rows have been opened once, when they first showed. */
    readonly #seenFolders = new Set<FolderId>();

    constructor(deps: DocsStoreDeps) {
        this.#deps = deps;
        makeAutoObservable(this, { tree: observableRef, buffers: observableShallow, currentDoc: computedStruct });
        reaction(() => deps.project.lastDocsChange, (change) => {
            if (change) this.#handleChange(change);
        });
        reaction(() => this.currentKey, (key, previous) => this.#follow(this.currentDoc, previous));
        // A folder added, removed or moved: the tree has other folders, or another main one.
        reaction(() => deps.project.project.folders.map(folder => `${ folder.id }:${ folder.path }`).join('\n'), () => {
            if (this.#treeLoadedOnce) void this.loadTree();
        });
    }

    /** The screen shows: loads what is missing, and looks again at what may have changed while it was away. */
    activate(): void {
        void this.loadTree();
        this.#follow(this.currentDoc, null);
        this.buffers.forEach(buffer => void this.#look(buffer));
    }

    /* --------------------------------- Derived --------------------------------- */

    /** Each folder's short name, unique within the project. */
    get namesById(): Map<FolderId, string> {
        const { folders } = this.#deps.project.project;
        const names = folderNames(folders);

        return new Map(folders.map((folder, index) => [folder.id, names[index] ?? folder.path]));
    }

    /** The folders the tree shows, in the project's order: a folder other than the main one that the daemon left out (missing) is not among them. */
    get folders(): DocsFolderView[] {
        const paths = new Map(this.#deps.project.project.folders.map(folder => [folder.id, folder.path]));

        return this.tree.map(({ folderId }) => ({ folderId, name: this.folderName(folderId), path: paths.get(folderId) ?? '' }));
    }

    /** The tree shows the folders as its top level. */
    get multiFolder(): boolean {
        return this.tree.length > 1;
    }

    get nodes(): DocsNode[] {
        return docsNodes(this.tree, this.namesById);
    }

    /** The keys of the documents the tree lists. */
    get keys(): Set<string> {
        return new Set(fileNodes(this.nodes).map(node => node.key));
    }

    get visibleTree(): DocsNode[] {
        return filterTree(this.nodes, this.query);
    }

    /**
     * The selected document: the stored selection while the file is listed or open, otherwise the first one.
     * Nothing is replaced before the tree is known.
     */
    get currentDoc(): DocRef | null {
        const { docPath, docFolderId } = this.#deps.ui;
        const chosen = docPath === null ? null : { folderId: docFolderId ?? this.#mainFolderId, path: docPath };

        if (this.treeStatus !== 'ready') return chosen;

        // An open file stays selected even when the tree no longer lists it: the buffer says what happened.
        if (chosen && (this.keys.has(docKey(chosen)) || this.buffers.get(docKey(chosen))?.status === 'ready')) return chosen;

        const first = fileNodes(this.nodes)[0];

        return first ? { folderId: first.folderId, path: first.path } : null;
    }

    get currentKey(): string | null {
        return this.currentDoc ? docKey(this.currentDoc) : null;
    }

    get current(): DocBuffer | undefined {
        return this.currentKey ? this.buffers.get(this.currentKey) : undefined;
    }

    /** Documents gone from disk that are still open or hold text, and that the tree no longer lists. */
    get removedBuffers(): DocBuffer[] {
        return [...this.buffers.values()].filter(buffer => buffer.removed && !this.keys.has(buffer.key));
    }

    /** Where a new document goes unless the person picks another folder: the folder of the open document, else the main folder. */
    get newDocumentFolder(): FolderId {
        const open = this.currentDoc?.folderId;

        return open && this.tree.some(folder => folder.folderId === open) ? open : this.#mainFolderId;
    }

    /** The paths a new document in `folderId` must not take. */
    takenPaths(folderId: FolderId): string[] {
        const inFolder = (doc: DocRef) => doc.folderId === folderId;

        return [...fileNodes(this.nodes).filter(inFolder), ...[...this.buffers.values()].filter(inFolder)].map(doc => doc.path);
    }

    folderName(folderId: FolderId): string {
        return this.namesById.get(folderId) ?? folderId;
    }

    isOpen(key: string): boolean {
        return this.query.trim() !== '' || this.expanded.has(key);
    }

    /* --------------------------------- Actions --------------------------------- */

    setQuery(query: string): void {
        this.query = query;
    }

    setTab(tab: DocsTab): void {
        this.tab = tab;
    }

    select({ folderId, path }: DocRef): void {
        this.#deps.ui.openDoc(path, folderId);
    }

    toggleDir(key: string): void {
        if (this.expanded.has(key)) this.expanded.delete(key);
        else this.expanded.add(key);
    }

    /** Shows a folder in the tree (an empty path is the folder of the project itself): clears the search and opens it and the ones above it. */
    reveal(dir: DocRef): void {
        this.query = '';
        [...ancestorKeys(dir), docKey(dir)].forEach(key => this.expanded.add(key));
    }

    async loadTree(): Promise<void> {
        // One fetch at a time; changes that come meanwhile are covered by one more.
        if (this.#treeLoading) {
            this.#treeAgain = true;

            return;
        }

        this.#treeLoading = true;

        try {
            do {
                this.#treeAgain = false;
                await this.#fetchTree();
            } while (this.#treeAgain);
        }
        finally {
            this.#treeLoading = false;
        }
    }

    /** Opens the document again after it failed to load. */
    retry(doc: DocRef): void {
        this.buffers.delete(docKey(doc));
        this.#follow(doc, null);
    }

    /** Saves over the version the document started from. If the daemon refuses, the text stays as it is. */
    async save(buffer: DocBuffer | undefined = this.current): Promise<void> {
        if (!buffer || buffer.saving || !buffer.dirty || buffer.conflict) return;

        await this.#write(buffer, buffer.baseHash);
    }

    /** Conflict: overwrite what is on disk with the edited text. */
    async keepMine(buffer: DocBuffer): Promise<void> {
        if (buffer.conflict && !buffer.saving) await this.#write(buffer, buffer.conflict.hash);
    }

    /** Conflict: drop the edited text for what is on disk. */
    takeTheirs(buffer: DocBuffer): void {
        if (buffer.conflict) buffer.takeTheirs(buffer.conflict);
    }

    /**
     * Conflict: save the edited text as a new document beside this one, then show what is on disk. If the copy
     * cannot be written nothing changes. Resolves to the copy's path.
     */
    async copyMineAndTakeTheirs(buffer: DocBuffer): Promise<string | undefined> {
        const theirs = buffer.conflict;

        if (!theirs || buffer.saving) return undefined;

        const path = copyPath(buffer.path, this.takenPaths(buffer.folderId));
        const result = await this.#deps.command({ type: 'docs.write', projectId: this.#projectId, folderId: buffer.folderId, path, content: buffer.text, baseHash: null });

        if (!result.ok) {
            buffer.failSave(`Your text could not be copied: ${ result.error.message }`);

            return undefined;
        }

        // Taken only if the person is still looking at the version they were shown.
        buffer.takeTheirs(theirs);
        void this.loadTree();

        return path;
    }

    /** Creates a document under the name the person typed, in the docs folder of `folderId` (made by this first write when it has none), and opens it. */
    async createDocument(input: string, folderId: FolderId = this.newDocumentFolder): Promise<CreateResult> {
        const named = newDocumentPath(input, this.takenPaths(folderId));

        if ('error' in named) return { ok: false, message: named.error };

        const { path } = named;
        const result = await this.#deps.command({ type: 'docs.write', projectId: this.#projectId, folderId, path, content: initialContent(path), baseHash: null });

        if (!result.ok) return { ok: false, message: result.error.code === 'conflict' ? `${ path } already exists.` : result.error.message };

        // The tree must list the file before it can be the selection.
        await this.loadTree();
        runInAction(() => {
            this.query = '';
            this.select({ folderId, path });
        });

        return { ok: true, path };
    }

    /* --------------------------------- Internals --------------------------------- */

    get #projectId(): ProjectId {
        return this.#deps.project.id;
    }

    get #mainFolderId(): FolderId {
        return mainFolder(this.#deps.project.project).id;
    }

    async #fetchTree(): Promise<void> {
        let tree: DocsTree;

        try {
            tree = await this.#deps.transport.getDocsTree(this.#projectId);
        }
        catch (error) {
            runInAction(() => {
                // A tree that is shown stays; only the first load can fail the screen.
                if (this.treeStatus !== 'ready') this.treeStatus = 'failed';

                this.treeError = error instanceof Error ? error.message : String(error);
            });

            return;
        }

        runInAction(() => {
            this.tree = tree;
            this.treeStatus = 'ready';
            this.treeError = '';
            this.#treeLoadedOnce = true;

            // A folder shows open the first time it is listed, with the folders at the top of its docs.
            for (const { folderId, nodes } of tree) {
                if (this.#seenFolders.has(folderId)) continue;

                this.#seenFolders.add(folderId);
                this.expanded.add(docKey({ folderId, path: '' }));
                nodes.filter(node => node.kind === 'dir').forEach(node => this.expanded.add(docKey({ folderId, path: node.path })));
            }
        });
    }

    /** The selection changed: release the document that was left, if that loses nothing, and load the new one. */
    #follow(doc: DocRef | null, previous: string | null): void {
        const key = doc ? docKey(doc) : null;
        const left = previous && previous !== key ? this.buffers.get(previous) : undefined;

        if (left && !left.edited && !left.saving) this.buffers.delete(left.key);

        if (!doc || !key) return;

        ancestorKeys(doc).forEach(ancestor => this.expanded.add(ancestor));

        const existing = this.buffers.get(key);

        if (existing && existing.status !== 'failed') return;

        const buffer = new DocBuffer(doc.folderId, doc.path);

        this.buffers.set(key, buffer);
        void this.#load(buffer);
    }

    async #load(buffer: DocBuffer): Promise<void> {
        try {
            buffer.loaded(await this.#deps.transport.getDocFile(this.#projectId, buffer.folderId, buffer.path));
        }
        catch (error) {
            buffer.failed(error instanceof TransportError && error.status === 404 ? 'This document no longer exists.' : error instanceof Error ? error.message : String(error));

            return;
        }

        if (this.#recheck.delete(buffer)) void this.#look(buffer);
    }

    #handleChange(changed: DocRef): void {
        void this.loadTree();

        for (const buffer of this.buffers.values()) {
            // A folder that changed may have taken the file with it.
            if (buffer.folderId === changed.folderId && (buffer.path === changed.path || buffer.path.startsWith(`${ changed.path }/`))) void this.#look(buffer);
        }
    }

    /** Compares a buffer with the disk, and lets the buffer decide what the difference means. */
    async #look(buffer: DocBuffer): Promise<void> {
        if (buffer.status === 'failed') return;

        if (buffer.status === 'loading' || buffer.saving) {
            this.#recheck.add(buffer);

            return;
        }

        const version = this.#next(buffer);
        const disk = await this.#readDisk(buffer);

        // A newer look, or a save, began meanwhile: its answer is the current one.
        if (disk !== undefined && this.#versions.get(buffer) === version) buffer.observe(disk);
    }

    /** The file as it is on disk; `null` when it is gone, `undefined` when the daemon could not say. */
    async #readDisk({ folderId, path }: DocRef): Promise<DiskVersion | null | undefined> {
        try {
            const { content, hash } = await this.#deps.transport.getDocFile(this.#projectId, folderId, path);

            return { content, hash };
        }
        catch (error) {
            return error instanceof TransportError && error.status === 404 ? null : undefined;
        }
    }

    async #write(buffer: DocBuffer, baseHash: string | null): Promise<void> {
        const { content } = buffer.startSave();

        this.#next(buffer);

        const result = await this.#deps.command({ type: 'docs.write', projectId: this.#projectId, folderId: buffer.folderId, path: buffer.path, content, baseHash });

        await this.#settle(buffer, content, result);

        if (this.#recheck.delete(buffer)) void this.#look(buffer);
    }

    async #settle(buffer: DocBuffer, content: string, result: CommandResult): Promise<void> {
        if (result.ok) {
            const hash = (result.data as { hash?: unknown } | null)?.hash;

            if (typeof hash === 'string') {
                buffer.finishSave(content, hash);
            }
            else {
                buffer.endSave();
                await this.#look(buffer);
            }

            return;
        }

        const { code, message, details } = result.error;

        if (code === 'conflict') {
            // The daemon sends the version it found; ask for it when it did not.
            const disk = isDiskVersion(details) ? { content: details.content, hash: details.hash } : await this.#readDisk(buffer);

            if (disk === undefined) buffer.failSave(message);
            else buffer.conflictedSave(disk);
        }
        else if (code === 'not_found') {
            buffer.conflictedSave(null);
        }
        else {
            buffer.failSave(message);
        }
    }

    #next(buffer: DocBuffer): number {
        const version = (this.#versions.get(buffer) ?? 0) + 1;

        this.#versions.set(buffer, version);

        return version;
    }
}
