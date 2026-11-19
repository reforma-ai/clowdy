import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { foldersAtPath } from '../db/projects';
import { CommandError, conflict, invalid, notFound, unavailable } from '../errors';
import { CLOWDY_DIR, DOCS_DIR, isDocFile, MAX_DOC_BYTES, normalizeDocPath, realPathBelow, resolveInside } from './paths';
import { listDocs } from './tree';
import { FolderDocsWatcher } from './watcher';

import type { DocFile, DocsTree, FolderId, Project, ProjectFolder } from '@clowdy/protocol';
import type { Store } from '../store';
import type { DocsChange } from './watcher';

/** How long after our own write the watcher stays quiet about that path, as long as the file still holds what we wrote. */
const OWN_WRITE_MS = 1500;

/** Documents are UTF-8 text. A file that is not would come back changed from an edit, so it is not served. */
const utf8 = new TextDecoder('utf-8', { fatal: true });

export interface DocWrite {
    path: string;
    content: string;
    /** The hash of the version the edit started from, or `null` to create the file. */
    baseHash: string | null;
}

const hashOf = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/**
 * A project's documents: Markdown files in `<folder>/.clowdy/docs` of each of its folders, never outside them. A folder's docs folder is
 * made by the first document written there, never by a read, so a folder the person only added shows no trace of Clowdy. A folder can be in
 * several projects: it is watched once, and a change in it is announced to every project that has it.
 */
export class DocsService {
    /** One watcher per folder path, for as long as a project has that folder. */
    private watchers = new Map<string, FolderDocsWatcher>();
    /** Paths this service wrote lately, by folder and path (`ownKey`); `hash` is what it wrote (absent for a folder). */
    private ownWrites = new Map<string, { until: number; hash?: string }>();
    /** Folders whose watcher could not start, announced once. */
    private unwatchable = new Set<string>();

    constructor(private store: Store) {}

    /**
     * One entry per folder, in the project's order. The main folder's documents must be readable, since the project cannot work without
     * it: a missing main folder is `unavailable`, a docs folder that leads out of it `invalid`. Another folder whose documents cannot be read
     * (missing, or its docs folder leads out of it) is left out. A folder without a docs folder has no documents, and is watched for one.
     */
    tree(project: Project): DocsTree {
        return project.folders.flatMap((folder, index) => {
            try {
                const root = this.root(folder);

                this.watch(folder.path);

                return [{ folderId: folder.id, nodes: root ? listDocs(root) : [] }];
            }
            catch (error) {
                if (index === 0 || !(error instanceof CommandError)) {
                    throw error;
                }

                return [];
            }
        });
    }

    read(project: Project, folderId: FolderId, path: string): DocFile {
        const folder = this.folderOf(project, folderId);
        const relative = this.checkedPath(path);
        const root = this.root(folder);

        this.watch(folder.path);

        const bytes = root && this.readBytes(resolveInside(root, relative), relative);

        if (!bytes) {
            throw notFound('Document', relative);
        }

        return { path: relative, content: this.decode(bytes, relative), hash: hashOf(bytes) };
    }

    /**
     * Writes a document into a folder's docs folder atomically (temp file in the same folder, then rename) when its on-disk hash is still
     * `baseHash`; the first document of a folder makes its docs folder. A mismatch is a `conflict` that carries the current content and hash.
     * The caller announces the change, with `announce` and the folder's path it answers.
     */
    write(project: Project, folderId: FolderId, input: DocWrite): { folder: string; path: string; hash: string; change: 'created' | 'modified' } {
        const folder = this.folderOf(project, folderId);
        const relative = this.checkedPath(input.path);
        const bytes = Buffer.from(input.content, 'utf8');

        if (bytes.length > MAX_DOC_BYTES) {
            throw invalid(`A document is limited to ${ MAX_DOC_BYTES / 1024 / 1024 } MB`);
        }

        const existing = this.root(folder);

        if (!existing && input.baseHash !== null) {
            throw notFound('Document', relative);
        }

        const made = existing ? [] : this.makeDocsFolder(folder);

        try {
            const result = this.writeInto(existing ?? this.root(folder) as string, relative, bytes, input.baseHash, folder.path);

            this.watch(folder.path);

            return { folder: folder.path, ...result };
        }
        catch (error) {
            // A write that failed leaves no docs folder behind that it made.
            made.forEach(dir => removeEmptyDir(dir));
            throw error;
        }
    }

    /** Tells every project that has the folder at `folder` that a document in it changed, each with the id the folder has there. */
    announce(folder: string, path: string, change: DocsChange): void {
        this.store.tx(() => {
            for (const { projectId, folderId } of foldersAtPath(this.store.db, folder)) {
                this.store.emit(projectId, { type: 'docs.changed', folderId, path, change });
            }
        });
    }

    /** Starts watching the docs folders that already exist, for the projects known at startup. A folder without one waits for a read. */
    watchExisting(projects: Project[]): void {
        for (const path of new Set(projects.flatMap(project => project.folders.map(folder => folder.path)))) {
            if (existsSync(join(path, DOCS_DIR))) {
                this.watch(path);
            }
        }
    }

    /**
     * Lets go of the watchers of folders that no project has any more: a project was removed or given other folders. A folder another
     * project still has stays watched. A folder that comes back is watched on the next request for its documents.
     */
    release(): void {
        for (const [folder, watcher] of this.watchers) {
            if (foldersAtPath(this.store.db, folder).length === 0) {
                watcher.stop();
                this.watchers.delete(folder);
            }
        }

        for (const folder of this.unwatchable) {
            if (foldersAtPath(this.store.db, folder).length === 0) {
                this.unwatchable.delete(folder);
            }
        }
    }

    stop(): void {
        for (const watcher of this.watchers.values()) {
            watcher.stop();
        }

        this.watchers.clear();
    }

    private folderOf(project: Project, folderId: FolderId): ProjectFolder {
        if (!folderId) {
            throw invalid('The folder of the document is not given');
        }

        const folder = project.folders.find(candidate => candidate.id === folderId);

        if (!folder) {
            throw notFound('Folder', folderId);
        }

        return folder;
    }

    /**
     * The real path of a folder's docs folder, or `undefined` while it does not exist. A docs folder that is a link out of its folder is
     * refused, as is a missing folder, which is never made again.
     */
    private root(folder: ProjectFolder): string | undefined {
        if (!existsSync(folder.path)) {
            throw unavailable(`The folder ${ folder.path } is missing`);
        }

        const docs = join(folder.path, DOCS_DIR);

        if (!existsSync(docs)) {
            return undefined;
        }

        if (!statSync(docs).isDirectory()) {
            throw unavailable(`${ DOCS_DIR } in ${ basename(folder.path) } is not a folder`);
        }

        const root = realPathBelow(folder.path, docs);

        if (!root) {
            throw leadsOut(folder);
        }

        return root;
    }

    /**
     * Makes the folder's docs folder for its first document; answers the folders it made, innermost first, so a failed write can take them
     * back. Nothing is made through a `.clowdy` that is a link out of the folder.
     */
    private makeDocsFolder(folder: ProjectFolder): string[] {
        const clowdy = join(folder.path, CLOWDY_DIR);
        const hasClowdy = existsSync(clowdy);

        if (hasClowdy && !realPathBelow(folder.path, clowdy)) {
            throw leadsOut(folder);
        }

        const made = [join(folder.path, DOCS_DIR), ...hasClowdy ? [] : [clowdy]];

        try {
            mkdirSync(made[0] as string, { recursive: true });
        }
        catch (error) {
            throw unavailable(`The docs folder cannot be created: ${ (error as Error).message }`);
        }

        return made;
    }

    private writeInto(root: string, relative: string, bytes: Buffer, baseHash: string | null, folder: string): { path: string; hash: string; change: 'created' | 'modified' } {
        const absolute = resolveInside(root, relative);
        const current = this.readBytes(absolute, relative);
        const currentDetails = current && { path: relative, content: this.decode(current, relative), hash: hashOf(current) };

        if (baseHash === null && currentDetails) {
            throw conflict(`${ relative } already exists`, currentDetails);
        }

        if (baseHash !== null && !currentDetails) {
            throw notFound('Document', relative);
        }

        if (baseHash !== null && currentDetails && currentDetails.hash !== baseHash) {
            throw conflict(`${ relative } changed on disk`, currentDetails);
        }

        // The folders this write creates are ours too: the watcher must not announce them.
        const segments = relative.split('/');

        for (let length = 1; length < segments.length; length++) {
            const dir = segments.slice(0, length).join('/');

            if (!existsSync(join(root, dir))) {
                this.rememberOwnWrite(folder, dir);
            }
        }

        const hash = hashOf(bytes);

        mkdirSync(dirname(absolute), { recursive: true });
        atomicWrite(absolute, bytes);
        this.rememberOwnWrite(folder, relative, hash);

        return { path: relative, hash, change: current ? 'modified' : 'created' };
    }

    private rememberOwnWrite(folder: string, path: string, hash?: string): void {
        const now = Date.now();

        for (const [other, { until }] of this.ownWrites) {
            if (until <= now) {
                this.ownWrites.delete(other);
            }
        }

        this.ownWrites.set(ownKey(folder, path), { until: now + OWN_WRITE_MS, hash });
    }

    /** Whether a change to `path` is the write this service just made. Another writer's version of the file is news. */
    private isOwnWrite(folder: string, path: string): boolean {
        const own = this.ownWrites.get(ownKey(folder, path));

        if (!own || own.until <= Date.now()) {
            return false;
        }

        if (own.hash === undefined) {
            return true;
        }

        try {
            return hashOf(readFileSync(join(folder, DOCS_DIR, ...path.split('/')))) === own.hash;
        }
        catch {
            return false;
        }
    }

    private decode(bytes: Buffer, relative: string): string {
        try {
            return utf8.decode(bytes);
        }
        catch {
            throw invalid(`${ relative } is not valid UTF-8 text`);
        }
    }

    private checkedPath(path: string): string {
        const relative = normalizeDocPath(path);

        if (!isDocFile(relative)) {
            throw invalid('Only .md and .markdown documents are supported');
        }

        return relative;
    }

    private readBytes(absolute: string, relative: string): Buffer | undefined {
        if (!existsSync(absolute)) {
            return undefined;
        }

        const stat = statSync(absolute);

        if (!stat.isFile()) {
            throw invalid(`${ relative } is not a file`);
        }

        if (stat.size > MAX_DOC_BYTES) {
            throw invalid(`${ relative } is larger than ${ MAX_DOC_BYTES / 1024 / 1024 } MB`);
        }

        return readFileSync(absolute);
    }

    /** Watches a folder's documents, or looks again whether its docs folder has appeared when it is watched already. */
    private watch(folder: string): void {
        const known = this.watchers.get(folder);

        if (known) {
            known.check();

            return;
        }

        const watcher = new FolderDocsWatcher(
            folder,
            (path, change) => this.announce(folder, path, change),
            path => this.isOwnWrite(folder, path),
            () => {
                if (this.watchers.get(folder) === watcher) {
                    this.watchers.delete(folder);
                }
            }
        );

        if (watcher.start()) {
            this.watchers.set(folder, watcher);
        }
        else if (!this.unwatchable.has(folder)) {
            this.unwatchable.add(folder);
            console.warn(`[clowdy] cannot watch the documents of ${ folder }; changes made outside Clowdy will not be announced`);
            this.store.tx(() => {
                for (const { projectId } of foldersAtPath(this.store.db, folder)) {
                    this.store.emit(projectId, { type: 'notice', level: 'warn', text: 'Documents changed outside Clowdy will not refresh automatically' });
                }
            });
        }
    }
}

const ownKey = (folder: string, path: string) => `${ folder }\n${ path }`;

const leadsOut = (folder: ProjectFolder) => invalid(`The docs folder of ${ basename(folder.path) } leads out of it`);

function removeEmptyDir(path: string): void {
    try {
        rmdirSync(path);
    }
    catch {
        // Not empty, or gone: either way it is not an empty folder this write left behind.
    }
}

function atomicWrite(path: string, bytes: Buffer): void {
    const temp = join(dirname(path), `.${ basename(path) }.${ randomBytes(4).toString('hex') }.tmp`);
    const fd = openSync(temp, 'wx', 0o644);

    try {
        writeSync(fd, bytes);
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }

    try {
        renameSync(temp, path);
    }
    catch (error) {
        rmSync(temp, { force: true });
        throw error;
    }
}
