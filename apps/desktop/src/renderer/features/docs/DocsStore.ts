import { makeAutoObservable, observableRef, observableShallow, reaction, runInAction } from 'mobx';

import { TransportError } from '../../daemon/transport';
import { DocBuffer, type DiskVersion } from './DocBuffer';
import { copyPath, initialContent, newDocumentPath } from './names';
import { ancestorDirs, filePaths, filterTree } from './tree';

import type { CommandResult, DocNode, DocsTree, ProjectId } from '@clowdy/protocol';
import type { CommandInput, Transport } from '../../daemon/transport';
import type { ProjectState, ProjectUi } from '../../stores';

export type DocsTab = 'editor' | 'markdown' | 'preview';
export type TreeStatus = 'loading' | 'ready' | 'failed';
export type CreateResult = { ok: true; path: string } | { ok: false; message: string };

export interface DocsStoreDeps {
    project: Pick<ProjectState, 'id' | 'lastDocsChange'>;
    ui: Pick<ProjectUi, 'docPath' | 'openDoc'>;
    transport: Pick<Transport, 'getDocsTree' | 'getDocFile'>;
    command: (input: CommandInput) => Promise<CommandResult>;
}

const isDiskVersion = (value: unknown): value is DiskVersion => (
    typeof value === 'object' && value !== null && typeof (value as DiskVersion).content === 'string' && typeof (value as DiskVersion).hash === 'string'
);

/**
 * The Documents screen's state for one project: the docs tree, the selection, and one `DocBuffer` for the open
 * document and for every document that holds unsaved text. It lives as long as the project does, so another
 * section and back loses nothing.
 *
 * Unsaved text is never dropped. A buffer is released only when leaving it loses nothing (its text is on disk),
 * and a disk version that differs from edited text waits as a conflict for the person's choice.
 */
export class DocsStore {
    tree: DocNode[] = [];
    treeStatus: TreeStatus = 'loading';
    treeError = '';
    query = '';
    tab: DocsTab = 'editor';
    /** The folders that show their contents. */
    expanded = new Set<string>();
    buffers = new Map<string, DocBuffer>();
    readonly #deps: DocsStoreDeps;
    /** Counts the looks at a file and the saves of it, so that a look that began before a newer one is dropped. */
    readonly #versions = new WeakMap<DocBuffer, number>();
    /** Buffers whose file changed on disk while they loaded or saved: look again when that ends. */
    readonly #recheck = new WeakSet<DocBuffer>();
    #treeLoading = false;
    #treeAgain = false;
    #treeLoadedOnce = false;

    constructor(deps: DocsStoreDeps) {
        this.#deps = deps;
        makeAutoObservable(this, { tree: observableRef, buffers: observableShallow });
        reaction(() => deps.project.lastDocsChange, (change) => {
            if (change) this.#handleChange(change.path);
        });
        reaction(() => this.currentPath, (path, previous) => this.#follow(path, previous));
    }

    /** The screen shows: loads what is missing, and looks again at what may have changed while it was away. */
    activate(): void {
        void this.loadTree();
        this.#follow(this.currentPath, null);
        this.buffers.forEach(buffer => void this.#look(buffer));
    }

    /* --------------------------------- Derived --------------------------------- */

    get paths(): Set<string> {
        return new Set(filePaths(this.tree));
    }

    get visibleTree(): DocNode[] {
        return filterTree(this.tree, this.query);
    }

    /**
     * The selected document: the stored selection while the file is listed or open, otherwise the first one.
     * Nothing is replaced before the tree is known.
     */
    get currentPath(): string | null {
        const chosen = this.#deps.ui.docPath;

        if (this.treeStatus !== 'ready') return chosen;

        // An open file stays selected even when the tree no longer lists it: the buffer says what happened.
        if (chosen && (this.paths.has(chosen) || this.buffers.get(chosen)?.status === 'ready')) return chosen;

        return filePaths(this.tree)[0] ?? null;
    }

    get current(): DocBuffer | undefined {
        return this.currentPath ? this.buffers.get(this.currentPath) : undefined;
    }

    /** Documents gone from disk that are still open or hold text, and that the tree no longer lists. */
    get removedBuffers(): DocBuffer[] {
        return [...this.buffers.values()].filter(buffer => buffer.removed && !this.paths.has(buffer.path));
    }

    /** The paths a new document must not take. */
    get takenPaths(): string[] {
        return [...this.paths, ...this.buffers.keys()];
    }

    isOpen(dirPath: string): boolean {
        return this.query.trim() !== '' || this.expanded.has(dirPath);
    }

    /* --------------------------------- Actions --------------------------------- */

    setQuery(query: string): void {
        this.query = query;
    }

    setTab(tab: DocsTab): void {
        this.tab = tab;
    }

    select(path: string): void {
        this.#deps.ui.openDoc(path);
    }

    toggleDir(dirPath: string): void {
        if (this.expanded.has(dirPath)) this.expanded.delete(dirPath);
        else this.expanded.add(dirPath);
    }

    /** Shows a folder in the tree: clears the search and opens the folder and the ones above it. */
    reveal(dirPath: string): void {
        this.query = '';
        [...ancestorDirs(dirPath), dirPath].forEach(dir => this.expanded.add(dir));
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
    retry(path: string): void {
        this.buffers.delete(path);
        this.#follow(path, null);
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

        const path = copyPath(buffer.path, this.takenPaths);
        const result = await this.#deps.command({ type: 'docs.write', projectId: this.#projectId, path, content: buffer.text, baseHash: null });

        if (!result.ok) {
            buffer.failSave(`Your text could not be copied: ${ result.error.message }`);

            return undefined;
        }

        // Taken only if the person is still looking at the version they were shown.
        buffer.takeTheirs(theirs);
        void this.loadTree();

        return path;
    }

    /** Creates a document under the name the person typed, and opens it. */
    async createDocument(input: string): Promise<CreateResult> {
        const named = newDocumentPath(input, this.takenPaths);

        if ('error' in named) return { ok: false, message: named.error };

        const { path } = named;
        const result = await this.#deps.command({ type: 'docs.write', projectId: this.#projectId, path, content: initialContent(path), baseHash: null });

        if (!result.ok) return { ok: false, message: result.error.code === 'conflict' ? `${ path } already exists.` : result.error.message };

        // The tree must list the file before it can be the selection.
        await this.loadTree();
        runInAction(() => {
            this.query = '';
            this.select(path);
        });

        return { ok: true, path };
    }

    /* --------------------------------- Internals --------------------------------- */

    get #projectId(): ProjectId {
        return this.#deps.project.id;
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

            if (!this.#treeLoadedOnce) {
                this.#treeLoadedOnce = true;
                tree.filter(node => node.kind === 'dir').forEach(node => this.expanded.add(node.path));
            }
        });
    }

    /** The selection changed: release the document that was left, if that loses nothing, and load the new one. */
    #follow(path: string | null, previous: string | null): void {
        const left = previous && previous !== path ? this.buffers.get(previous) : undefined;

        if (left && !left.edited && !left.saving) this.buffers.delete(left.path);

        if (!path) return;

        ancestorDirs(path).forEach(dir => this.expanded.add(dir));

        const existing = this.buffers.get(path);

        if (existing && existing.status !== 'failed') return;

        const buffer = new DocBuffer(path);

        this.buffers.set(path, buffer);
        void this.#load(buffer);
    }

    async #load(buffer: DocBuffer): Promise<void> {
        try {
            buffer.loaded(await this.#deps.transport.getDocFile(this.#projectId, buffer.path));
        }
        catch (error) {
            buffer.failed(error instanceof TransportError && error.status === 404 ? 'This document no longer exists.' : error instanceof Error ? error.message : String(error));

            return;
        }

        if (this.#recheck.delete(buffer)) void this.#look(buffer);
    }

    #handleChange(changedPath: string): void {
        void this.loadTree();

        for (const buffer of this.buffers.values()) {
            // A folder that changed may have taken the file with it.
            if (buffer.path === changedPath || buffer.path.startsWith(`${ changedPath }/`)) void this.#look(buffer);
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
        const disk = await this.#readDisk(buffer.path);

        // A newer look, or a save, began meanwhile: its answer is the current one.
        if (disk !== undefined && this.#versions.get(buffer) === version) buffer.observe(disk);
    }

    /** The file as it is on disk; `null` when it is gone, `undefined` when the daemon could not say. */
    async #readDisk(path: string): Promise<DiskVersion | null | undefined> {
        try {
            const { content, hash } = await this.#deps.transport.getDocFile(this.#projectId, path);

            return { content, hash };
        }
        catch (error) {
            return error instanceof TransportError && error.status === 404 ? null : undefined;
        }
    }

    async #write(buffer: DocBuffer, baseHash: string | null): Promise<void> {
        const { content } = buffer.startSave();

        this.#next(buffer);

        const result = await this.#deps.command({ type: 'docs.write', projectId: this.#projectId, path: buffer.path, content, baseHash });

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
            const disk = isDiskVersion(details) ? { content: details.content, hash: details.hash } : await this.#readDisk(buffer.path);

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
