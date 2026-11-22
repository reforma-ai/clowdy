/**
 * The storage contract: everything the file manager needs from a file system.
 * Paths are POSIX and relative to the provider root (`app/page.tsx`, no leading slash).
 * A `version` is opaque (a content hash, size plus mtime, a counter) and only compared for equality.
 */

export type FileKind = 'file' | 'directory';

/** One item of a listing. */
export interface FileEntry {
    path: string;
    kind: FileKind;
    /** Size in bytes, when the provider knows it without reading the file. */
    size?: number;
    /**
     * A directory at the depth cutoff. `true` when it has children the listing left out,
     * so the explorer can show a chevron before those children are loaded. `false` is an empty folder.
     */
    hasChildren?: boolean;
}

/** What `read` returns. The provider decides what counts as text; see `decodeUtf8`. */
export type FileContent =
    | { kind: 'text'; text: string; version: string }
    | { kind: 'binary'; blob: Blob; version: string };

export interface WriteOptions {
    /**
     * Write only over this version, otherwise fail with `Conflict`.
     * `null` creates the file and fails with `Exists` when it is there. Omitted writes unconditionally.
     */
    expectedVersion?: string | null;
}

export interface MoveOperation {
    from: string;
    to: string;
}

export interface OverwriteOptions {
    /** Replace an existing target instead of failing with `Exists`. */
    overwrite?: boolean;
}

/** One change a watch reports. Deleting a directory deletes everything inside it. */
export type FileChange =
    | { type: 'created'; path: string; kind: FileKind; version?: string; size?: number }
    | { type: 'changed'; path: string; version?: string; size?: number }
    | { type: 'deleted'; path: string };

/** A batch of changes, or `resync` when the provider may have missed some and the listing should be read again. */
export type WatchEvent = { type: 'changes'; changes: readonly FileChange[] } | { type: 'resync' };

export interface FileSystemCapabilities {
    /** Nothing can be edited, saved, created, moved or deleted. */
    readonly?: boolean;
    /** Deletes can be undone, so the delete confirm says so. */
    trash?: boolean;
}

/** A file system the manager can browse and edit. Failures throw {@link FileSystemError}. */
export interface FileSystemProvider {
    readonly capabilities?: FileSystemCapabilities;
    /**
     * Entries under `path` (`''` is the root), at most `depth` path segments below it, or all of them
     * without `depth`. `src/app/foo` from the root is depth 3. A cutoff directory sets `hasChildren`
     * without listing inside it.
     */
    list(path?: string, depth?: number): Promise<FileEntry[]>;
    /** Paths matching a filename query, at most 50. A word matches anywhere; a glob is used as given. */
    findFiles?(query: string): Promise<readonly string[]>;
    read(path: string): Promise<FileContent>;
    /** Writes text or bytes and returns the new version. Missing parent directories are created. */
    write(path: string, content: string | Blob, options?: WriteOptions): Promise<string>;
    createDirectory(path: string): Promise<void>;
    /** Moves a batch of paths as one operation. */
    move(moves: readonly MoveOperation[], options?: OverwriteOptions): Promise<void>;
    /** Copies a batch of paths as one operation. */
    copy(copies: readonly MoveOperation[], options?: OverwriteOptions): Promise<void>;
    delete(paths: readonly string[]): Promise<void>;
    /** Subscribes to changes under the root; returns the unsubscribe. */
    watch?(listener: (event: WatchEvent) => void): () => void;
}

export type FileSystemErrorCode = 'NotFound' | 'Exists' | 'Conflict' | 'NoPermission' | 'Unavailable';

export interface FileSystemErrorOptions {
    path?: string;
    /** For `Conflict`: the version on disk, or `null` when the file is gone. */
    currentVersion?: string | null;
    cause?: unknown;
}

/** A provider failure with a code the manager acts on. */
export class FileSystemError extends Error {
    readonly code: FileSystemErrorCode;
    readonly path?: string;
    readonly currentVersion?: string | null;

    constructor(code: FileSystemErrorCode, message: string, options: FileSystemErrorOptions = {}) {
        super(message, { cause: options.cause });
        this.name = 'FileSystemError';
        this.code = code;
        this.path = options.path;
        this.currentVersion = options.currentVersion;
    }

    /** True when `error` is a `FileSystemError`, with `code` when one is given. */
    static is(error: unknown, code?: FileSystemErrorCode): error is FileSystemError {
        return error instanceof FileSystemError && (code === undefined || error.code === code);
    }
}

/** Rewrites the text before it is written, or returns nothing to keep it (e.g. a formatter). */
export type SaveParticipant = (path: string, text: string) => Promise<string | undefined> | string | undefined;

/** Reports an error to the person, e.g. as a toast. */
export type Notify = (message: string, error?: unknown) => void;

/** A content search: literal text, case-insensitive unless asked otherwise. */
export interface SearchQuery {
    query: string;
    matchCase?: boolean;
    wholeWord?: boolean;
    /** Globs of the paths the file tree does not show, left out of the search too. */
    exclude?: string[];
}

/** One matching line. `line` and `column` (of the first match) are 1-based; `ranges` are offsets into `preview`. */
export interface SearchMatch {
    line: number;
    column: number;
    /** The line, or a part of a long line around its first match. */
    preview: string;
    ranges: Array<{ start: number; end: number }>;
}

/** Matching lines grouped by file. `truncated` when the per-file or total match cap cut the result. */
export interface SearchResult {
    files: Array<{ path: string; matches: SearchMatch[] }>;
    truncated: boolean;
}

/**
 * Searches file contents, e.g. with ripgrep on a server. Stops when `signal` aborts. A rejection's
 * message shows in the Search tab.
 */
export type SearchService = (query: SearchQuery, signal: AbortSignal) => Promise<SearchResult>;
