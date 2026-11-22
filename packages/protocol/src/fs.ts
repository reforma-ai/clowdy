import type { FolderId } from './domain';

/**
 * The files of one folder of a project, as the app's file manager reads and edits them. Every route is under
 * `/v1/projects/:id/fs/` and names the folder by `folderId` (a folder the project does not have is `not_found`), and a file or folder by
 * `path`: relative to that folder, `/` separators, no leading slash, `''` for the folder itself. A path with `..`, or one that resolves
 * (symbolic links followed) to a place outside the folder, is refused with `invalid` and `details.reason: 'outside'`.
 *
 * GET    fs/list?folderId=&path=&depth=   -> FsEntry[]. The entries below `path` at most `depth` path segments down (`src/app/foo` is depth
 *                                            3 from the folder), all of them without `depth`. Each `path` is relative to the folder, not to
 *                                            the requested one. A folder at the cutoff is listed without its content, with `hasChildren`.
 *                                            `.git` and `node_modules` are always such a folder, however deep the listing: they are listed
 *                                            only when asked for by their own path. A link to a folder is a folder that is never entered by
 *                                            a deeper listing, and a link to a file is a file. A missing `path` is `not_found`, a file
 *                                            `invalid`.
 * GET    fs/find?folderId=&query=         -> string[]. At most `MAX_FS_FIND` paths of files whose name matches `query`: a word matches
 *                                            anywhere in the path, a query with `*` or `?` is a glob. Not `.git` or `node_modules`.
 * GET    fs/file?folderId=&path=          -> the file's bytes (`application/octet-stream`, `nosniff`, `Content-Security-Policy: sandbox`)
 *                                            with its version in the `x-clowdy-version` header. A file over `MAX_FS_FILE_BYTES` is `invalid`
 *                                            with `details.reason: 'too_large'`; a missing one `not_found`; a folder `invalid`.
 * PUT    fs/file?folderId=&path=          -> { version }. The raw body is the content. Parent folders are made. `If-None-Match: *` writes only
 *                                            a new file (`conflict`, `details.reason: 'exists'` otherwise), `If-Match: <version>` only over
 *                                            that version (`conflict`, `details.reason: 'version'` and `details.currentVersion`, the version
 *                                            there now or `null` when the file is gone); neither writes over whatever is there.
 * POST   fs/folder                        -> { ok: true }. Body `{ folderId, path }`. Parent folders are made; one that is there is fine.
 * POST   fs/move                          -> { ok: true }. Body `{ folderId, moves: FsMove[], overwrite?: boolean }`: the whole batch or nothing
 *                                            (a failed one leaves what it moved moved back). A target that is there is `conflict` with
 *                                            `details.reason: 'exists'` and `details.path`, unless `overwrite` replaces it.
 * POST   fs/copy                          -> { ok: true }. Body `{ folderId, copies: FsMove[], overwrite?: boolean }`, as move; a folder is
 *                                            copied with everything in it.
 * POST   fs/delete                        -> { ok: true }. Body `{ folderId, paths: string[] }`. Deleting is final (no trash); a folder goes
 *                                            with everything in it; a path that is not there is fine.
 * GET    fs/watch?folderId=               -> a Server-Sent Events stream of `FsWatchEvent`s (the `data:` line is JSON, no event name), for as
 *                                            long as the client reads it. Changes of one burst come as one batch (about 100 ms). Nothing under
 *                                            `.git` or `node_modules` is reported. `{ type: 'resync' }` when changes may have been missed.
 *
 * POST   fs/search                       -> FsSearchResult. Body `{ folderId, query, matchCase?, wholeWord?, exclude? }`: a search of the folder's file
 *                                            contents for the literal text `query` (never a pattern; at most `MAX_FS_QUERY_LENGTH`
 *                                            characters), case-insensitive unless `matchCase`, `wholeWord` as ripgrep's `-w`. `exclude` are
 *                                            globs of paths the person's file tree does not show, left out too. Dotfiles are searched;
 *                                            `.git`, `node_modules`, the project's own `.clowdy`, lock files and minified or map files
 *                                            are not; files over 1 MB and files that are not UTF-8 text are skipped. At most
 *                                            `MAX_FS_SEARCH_MATCHES` matches and `MAX_FS_SEARCH_LINES_PER_FILE` matching lines of a file are
 *                                            returned, and a cut sets `truncated`; files are in path order, lines in file order. It runs
 *                                            ripgrep (`CLOWDY_RG`, else `rg` on the PATH) and, where there is none, a scan of its own that
 *                                            returns the same. The daemon stops searching when the client drops the request.
 *
 * A `version` is opaque and only compared for equality: the file's size and its modification time with its sub-millisecond part.
 */

export type FsKind = 'file' | 'directory';

/** One item of a listing. */
export interface FsEntry {
    path: string;
    kind: FsKind;
    /** Bytes, for a file. */
    size?: number;
    /** For a folder at the depth cutoff: whether it holds anything the listing left out. */
    hasChildren?: boolean;
}

/** One change `fs/watch` reports. Deleting a folder deletes everything in it. */
export type FsChange =
    | { type: 'created'; path: string; kind: FsKind; version?: string; size?: number }
    | { type: 'changed'; path: string; version?: string; size?: number }
    | { type: 'deleted'; path: string };

export type FsWatchEvent = { type: 'changes'; changes: FsChange[] } | { type: 'resync' };

export interface FsMove {
    from: string;
    to: string;
}

/** Why a file route was refused, in `error.details.reason` next to the error code. */
export type FsErrorReason = 'exists' | 'version' | 'outside' | 'too_large' | 'permission';

/** The bytes a file may have to be read through the daemon. */
export const MAX_FS_FILE_BYTES = 64 * 1024 * 1024;
/** The most paths `fs/find` answers with. */
export const MAX_FS_FIND = 50;
/** The header that carries a file's version on a read. */
export const FS_VERSION_HEADER = 'x-clowdy-version';

/** One matching line of a search. `line` and `column` (of the first match) are 1-based; `ranges` are offsets into `preview`, which is the line or, for a long line, the part around its first match. */
export interface FsSearchMatch {
    line: number;
    column: number;
    preview: string;
    ranges: Array<{ start: number; end: number }>;
}

/** The matching lines of a search, by file. */
export interface FsSearchResult {
    files: Array<{ path: string; matches: FsSearchMatch[] }>;
    truncated: boolean;
}

export interface FsSearchRequest {
    folderId: FolderId;
    query: string;
    matchCase?: boolean;
    wholeWord?: boolean;
    exclude?: string[];
}

export const MAX_FS_SEARCH_MATCHES = 2000;
export const MAX_FS_SEARCH_LINES_PER_FILE = 100;
export const MAX_FS_QUERY_LENGTH = 1000;

export interface FsLocation {
    folderId: FolderId;
    path: string;
}
