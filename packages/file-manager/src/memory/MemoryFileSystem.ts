import { Minimatch } from 'minimatch';

import { decodeUtf8, dirname, isPathWithin, normalizePath } from '../paths';
import { FileSystemError } from '../provider';

import type {
    FileChange,
    FileContent,
    FileEntry,
    FileSystemProvider,
    MoveOperation,
    OverwriteOptions,
    WatchEvent,
    WriteOptions,
} from '../provider';

type MemoryNode = { kind: 'directory' } | { kind: 'file'; data: string | Uint8Array<ArrayBuffer>; version: string };

export interface MemoryFileSystemOptions {
    /** Leave versions out of watch changes, like a provider that cannot hash files. */
    omitEventVersions?: boolean;
}

const encoder = new TextEncoder();

function sizeOf(data: string | Uint8Array): number {
    return typeof data === 'string' ? encoder.encode(data).length : data.length;
}

/** An in-memory provider with versions, errors and watch events; for tests, stories and demos. */
export class MemoryFileSystem implements FileSystemProvider {
    readonly capabilities = {};

    readonly #nodes = new Map<string, MemoryNode>();
    readonly #listeners = new Set<(event: WatchEvent) => void>();
    readonly #omitEventVersions: boolean;
    #lastVersion = 0;

    /** Starts with `files`: text, or bytes that read as binary when they are not UTF-8. */
    constructor(
        files: Record<string, string | Uint8Array> = {},
        { omitEventVersions = false }: MemoryFileSystemOptions = {}
    ) {
        this.#omitEventVersions = omitEventVersions;

        for (const [path, data] of Object.entries(files)) {
            const normalized = normalizePath(path);

            this.#createParents(normalized);
            this.#nodes.set(normalized, {
                kind: 'file',
                data: typeof data === 'string' ? data : new Uint8Array(data),
                version: this.#nextVersion(),
            });
        }
    }

    async list(dir = '', depth = Number.POSITIVE_INFINITY): Promise<FileEntry[]> {
        const root = normalizePath(dir);
        const prefix = root ? `${root}/` : '';

        return [...this.#nodes].flatMap(([path, node]): FileEntry[] => {
            if (path === root || (root && !path.startsWith(prefix))) {
                return [];
            }

            const relative = root ? path.slice(prefix.length) : path;
            const segments = relative.split('/').filter(Boolean).length;

            if (segments === 0 || segments > depth) {
                return [];
            }

            if (node.kind === 'file') {
                return [{ path, kind: 'file', size: sizeOf(node.data) }];
            }

            const hasChildren =
                segments === depth && [...this.#nodes.keys()].some(other => other.startsWith(`${path}/`));

            return [{ path, kind: 'directory', ...(segments === depth ? { hasChildren } : {}) }];
        });
    }

    /** A word matches anywhere in a held path. A glob is used as given. At most 50. Does not read the files. */
    async findFiles(query: string): Promise<string[]> {
        const text = query.trim();

        if (!text) {
            return [];
        }

        const pattern = /[*?[\]]/.test(text) ? text : `*${text}*`;
        const glob = new Minimatch(pattern, { dot: true, nocase: true, matchBase: !pattern.includes('/') });
        const paths: string[] = [];

        for (const [path, node] of this.#nodes) {
            if (node.kind === 'file' && glob.match(path)) {
                paths.push(path);

                if (paths.length === 50) {
                    break;
                }
            }
        }

        return paths;
    }

    async read(path: string): Promise<FileContent> {
        const file = this.#file(normalizePath(path));
        const text = typeof file.data === 'string' ? file.data : decodeUtf8(file.data);

        return text === null
            ? { kind: 'binary', blob: new Blob([file.data]), version: file.version }
            : { kind: 'text', text, version: file.version };
    }

    async write(path: string, content: string | Blob, { expectedVersion }: WriteOptions = {}): Promise<string> {
        const target = normalizePath(path);
        const data = typeof content === 'string' ? content : new Uint8Array(await content.arrayBuffer());
        const existing = this.#nodes.get(target);

        if (existing?.kind === 'directory') {
            throw new FileSystemError('Exists', `${target} is a folder`, { path: target });
        }

        if (expectedVersion === null && existing) {
            throw new FileSystemError('Exists', `${target} already exists`, { path: target });
        }

        if (typeof expectedVersion === 'string' && existing?.version !== expectedVersion) {
            throw new FileSystemError('Conflict', `${target} changed on disk`, {
                path: target,
                currentVersion: existing?.version ?? null,
            });
        }

        const changes = this.#createParents(target);
        const version = this.#nextVersion();
        const size = sizeOf(data);

        this.#nodes.set(target, { kind: 'file', data, version });
        changes.push(
            existing
                ? { type: 'changed', path: target, version, size }
                : { type: 'created', path: target, kind: 'file', version, size }
        );
        this.#emit(changes);

        return version;
    }

    async createDirectory(path: string): Promise<void> {
        const target = normalizePath(path);

        if (this.#nodes.has(target)) {
            throw new FileSystemError('Exists', `${target} already exists`, { path: target });
        }

        const changes = this.#createParents(target);

        this.#nodes.set(target, { kind: 'directory' });
        changes.push({ type: 'created', path: target, kind: 'directory' });
        this.#emit(changes);
    }

    async move(moves: readonly MoveOperation[], { overwrite = false }: OverwriteOptions = {}): Promise<void> {
        const normalized = moves.map(({ from, to }) => ({ from: normalizePath(from), to: normalizePath(to) }));

        // Check the whole batch before changing anything.
        for (const { from, to } of normalized) {
            this.#checkTransfer(from, to, overwrite);
        }

        this.#emit(normalized.flatMap(({ from, to }) => this.#transfer(from, to, false)));
    }

    async copy(copies: readonly MoveOperation[], { overwrite = false }: OverwriteOptions = {}): Promise<void> {
        const normalized = copies.map(({ from, to }) => ({ from: normalizePath(from), to: normalizePath(to) }));

        for (const { from, to } of normalized) {
            this.#checkTransfer(from, to, overwrite);
        }

        this.#emit(normalized.flatMap(({ from, to }) => this.#transfer(from, to, true)));
    }

    async delete(paths: readonly string[]): Promise<void> {
        const targets = paths.map(normalizePath);

        for (const path of targets) {
            if (!this.#nodes.has(path)) {
                throw new FileSystemError('NotFound', `${path} does not exist`, { path });
            }
        }

        this.#emit(targets.flatMap(path => this.#remove(path)));
    }

    watch(listener: (event: WatchEvent) => void): () => void {
        this.#listeners.add(listener);

        return () => {
            this.#listeners.delete(listener);
        };
    }

    /** Tells watchers that changes may have been missed, as a provider does after a dropped connection. */
    resync(): void {
        for (const listener of this.#listeners) {
            listener({ type: 'resync' });
        }
    }

    #file(path: string): Extract<MemoryNode, { kind: 'file' }> {
        const node = this.#nodes.get(path);

        if (node?.kind !== 'file') {
            throw new FileSystemError('NotFound', `${path} is not a file`, { path });
        }

        return node;
    }

    #nextVersion(): string {
        this.#lastVersion += 1;

        return String(this.#lastVersion);
    }

    /** Creates missing parent folders of `path`, top down. */
    #createParents(path: string): FileChange[] {
        const missing: string[] = [];

        for (let dir = dirname(path); dir !== ''; dir = dirname(dir)) {
            const node = this.#nodes.get(dir);

            if (node?.kind === 'file') {
                throw new FileSystemError('Exists', `${dir} is a file`, { path: dir });
            }

            if (!node) {
                missing.unshift(dir);
            }
        }

        return missing.map((dir): FileChange => {
            this.#nodes.set(dir, { kind: 'directory' });

            return { type: 'created', path: dir, kind: 'directory' };
        });
    }

    #checkTransfer(from: string, to: string, overwrite: boolean): void {
        if (!this.#nodes.has(from)) {
            throw new FileSystemError('NotFound', `${from} does not exist`, { path: from });
        }

        if (isPathWithin(to, from)) {
            throw new FileSystemError('Conflict', `${from} can't move into itself`, { path: to });
        }

        if (this.#nodes.has(to) && !overwrite) {
            throw new FileSystemError('Exists', `${to} already exists`, { path: to });
        }
    }

    /** Moves or copies `from` and everything inside it to `to`, replacing `to`. */
    #transfer(from: string, to: string, copy: boolean): FileChange[] {
        const sources = [...this.#nodes]
            .filter(([path]) => isPathWithin(path, from))
            .sort(([a], [b]) => (a < b ? -1 : 1));
        const changes = this.#nodes.has(to) ? this.#remove(to) : [];

        changes.push(...this.#createParents(to));

        if (!copy) {
            changes.push(...this.#remove(from));
        }

        for (const [path, node] of sources) {
            const target = to + path.slice(from.length);

            if (node.kind === 'directory') {
                this.#nodes.set(target, node);
                changes.push({ type: 'created', path: target, kind: 'directory' });

                continue;
            }

            const version = copy ? this.#nextVersion() : node.version;

            this.#nodes.set(target, { ...node, version });
            changes.push({ type: 'created', path: target, kind: 'file', version, size: sizeOf(node.data) });
        }

        return changes;
    }

    #remove(path: string): FileChange[] {
        for (const key of [...this.#nodes.keys()]) {
            if (isPathWithin(key, path)) {
                this.#nodes.delete(key);
            }
        }

        return [{ type: 'deleted', path }];
    }

    /** Delivers changes on a microtask, apart from the call that made them, as a socket-backed provider does. */
    #emit(changes: FileChange[]): void {
        const reported = this.#omitEventVersions
            ? changes.map(change => (change.type === 'deleted' ? change : { ...change, version: undefined }))
            : changes;

        queueMicrotask(() => {
            for (const listener of this.#listeners) {
                listener({ type: 'changes', changes: reported });
            }
        });
    }
}
