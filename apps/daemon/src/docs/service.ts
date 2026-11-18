import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';

import { conflict, invalid, notFound, unavailable } from '../errors';
import { DOCS_DIR, isDocFile, MAX_DOC_BYTES, normalizeDocPath, resolveInside } from './paths';
import { listDocs } from './tree';
import { DocsWatcher } from './watcher';

import type { DocFile, DocsTree, Project } from '@clowdy/protocol';
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

/** A project's documents: Markdown files in `<project>/.clowdy/docs`, never outside it. */
export class DocsService {
    private watchers = new Map<string, DocsWatcher>();
    /** Paths this service wrote lately; `hash` is what it wrote (absent for a folder). */
    private ownWrites = new Map<string, { until: number; hash?: string }>();
    private unwatchable = new Set<string>();

    constructor(private store: Store) {}

    /** The real path of the docs folder, created on first use and never over existing files. */
    root(project: Project): string {
        if (!existsSync(project.path)) {
            throw unavailable(`The project folder ${ project.path } is missing`);
        }

        try {
            mkdirSync(join(project.path, DOCS_DIR), { recursive: true });
        }
        catch (error) {
            throw unavailable(`The docs folder cannot be created: ${ (error as Error).message }`);
        }

        const root = realpathSync.native(join(project.path, DOCS_DIR));
        const projectRoot = realpathSync.native(project.path);

        if (!root.startsWith(projectRoot + sep)) {
            throw invalid('The docs folder leaves the project');
        }

        this.watch(project, root);

        return root;
    }

    tree(project: Project): DocsTree {
        return listDocs(this.root(project));
    }

    read(project: Project, path: string): DocFile {
        const relative = this.checkedPath(path);
        const absolute = resolveInside(this.root(project), relative);
        const bytes = this.readBytes(absolute, relative);

        if (!bytes) {
            throw notFound('Document', relative);
        }

        return { path: relative, content: this.decode(bytes, relative), hash: hashOf(bytes) };
    }

    /**
     * Writes a document atomically (temp file in the same folder, then rename) when its on-disk hash is still
     * `baseHash`. A mismatch is a `conflict` that carries the current content and hash. The caller publishes the event.
     */
    write(project: Project, input: DocWrite): { path: string; hash: string; change: 'created' | 'modified' } {
        const relative = this.checkedPath(input.path);
        const bytes = Buffer.from(input.content, 'utf8');

        if (bytes.length > MAX_DOC_BYTES) {
            throw invalid(`A document is limited to ${ MAX_DOC_BYTES / 1024 / 1024 } MB`);
        }

        const root = this.root(project);
        const absolute = resolveInside(root, relative);
        const current = this.readBytes(absolute, relative);
        const currentDetails = current && { path: relative, content: this.decode(current, relative), hash: hashOf(current) };

        if (input.baseHash === null && currentDetails) {
            throw conflict(`${ relative } already exists`, currentDetails);
        }

        if (input.baseHash !== null && !currentDetails) {
            throw notFound('Document', relative);
        }

        if (input.baseHash !== null && currentDetails && currentDetails.hash !== input.baseHash) {
            throw conflict(`${ relative } changed on disk`, currentDetails);
        }

        // The folders this write creates are ours too: the watcher must not announce them.
        const segments = relative.split('/');

        for (let length = 1; length < segments.length; length++) {
            const folder = segments.slice(0, length).join('/');

            if (!existsSync(join(root, folder))) {
                this.rememberOwnWrite(folder);
            }
        }

        const hash = hashOf(bytes);

        mkdirSync(dirname(absolute), { recursive: true });
        atomicWrite(absolute, bytes);
        this.rememberOwnWrite(relative, hash);

        return { path: relative, hash, change: current ? 'modified' : 'created' };
    }

    /** Starts watching the docs folders that already exist, for projects known at startup. */
    watchExisting(projects: Project[]): void {
        for (const project of projects) {
            const folder = join(project.path, DOCS_DIR);

            if (existsSync(folder)) {
                this.root(project);
            }
        }
    }

    /**
     * Lets go of a project's docs watcher: the project was removed, or its folder was replaced. The next request for its documents
     * watches the folder it has then; a failure to watch is announced again for that folder.
     */
    forget(projectId: string): void {
        this.watchers.get(projectId)?.stop();
        this.watchers.delete(projectId);
        this.unwatchable.delete(projectId);
    }

    stop(): void {
        for (const watcher of this.watchers.values()) {
            watcher.stop();
        }

        this.watchers.clear();
    }

    private rememberOwnWrite(path: string, hash?: string): void {
        const now = Date.now();

        for (const [other, { until }] of this.ownWrites) {
            if (until <= now) {
                this.ownWrites.delete(other);
            }
        }

        this.ownWrites.set(path, { until: now + OWN_WRITE_MS, hash });
    }

    /** Whether a change to `path` is the write this service just made. Another writer's version of the file is news. */
    private isOwnWrite(root: string, path: string): boolean {
        const own = this.ownWrites.get(path);

        if (!own || own.until <= Date.now()) {
            return false;
        }

        if (own.hash === undefined) {
            return true;
        }

        try {
            return hashOf(readFileSync(join(root, ...path.split('/')))) === own.hash;
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

    private watch(project: Project, root: string): void {
        if (this.watchers.has(project.id)) {
            return;
        }

        const watcher = new DocsWatcher(
            root,
            (path, change) => this.publish(project.id, path, change),
            path => this.isOwnWrite(root, path),
            () => this.watchers.delete(project.id)
        );

        if (watcher.start()) {
            this.watchers.set(project.id, watcher);
        }
        else if (!this.unwatchable.has(project.id)) {
            this.unwatchable.add(project.id);
            console.warn(`[clowdy] cannot watch ${ root }; document changes made outside Clowdy will not be announced`);
            this.store.tx(() => this.store.emit(project.id, { type: 'notice', level: 'warn', text: 'Documents changed outside Clowdy will not refresh automatically' }));
        }
    }

    private publish(projectId: string, path: string, change: DocsChange): void {
        this.store.tx(() => this.store.emit(projectId, { type: 'docs.changed', path, change }));
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
