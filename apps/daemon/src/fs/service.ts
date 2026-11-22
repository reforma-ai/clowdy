import { MAX_FS_FILE_BYTES, MAX_FS_FIND } from '@clowdy/protocol';
import { realpath } from 'node:fs/promises';

import { invalid, notFound, unavailable } from '../errors';
import { makeFolder, remove, transfer } from './batch';
import { checkPreconditions, makeFolders, readBody, readFileBytes, removeFolders, writeFileAtomically } from './content';
import { matchPaths } from './find';
import { exists, fsFailure, locate, missing, normalizeFsPath, versionOf } from './paths';
import { ContentSearch } from './search';
import { watchStream } from './stream';
import { MAX_LIST_ENTRIES, walkTree } from './walk';
import { FolderWatch } from './watcher';

import type { FolderId, FsEntry, FsMove, FsSearchRequest, FsSearchResult, Project, ProjectFolder } from '@clowdy/protocol';
import type { FilesService } from '../files/service';
import type { Preconditions } from './content';
import type { SearchOptions } from './search';
import type { WatchOptions } from './watcher';

/** The most items one move, copy or delete names. */
export const MAX_BATCH = 10_000;

/** Paths of a search looked at together. */
const FIND_AHEAD = 64;

/** Whether `path` is a file now, a link to one inside the folder included. */
async function isFile(root: string, path: string): Promise<boolean> {
    try {
        return (await locate(root, path, true)).stat?.isFile() === true;
    }
    catch {
        return false;
    }
}

export interface FsWriteOptions extends Preconditions {
    /** The `Content-Length` the client declared; 0 when it sent none. */
    declaredLength: number;
}

/**
 * The files of a project's folders for the app's file manager, read and changed on behalf of a client that is not trusted: every path is
 * checked against the folder here (`paths.ts`), and nothing outside it is ever read, written, moved, copied, deleted or watched. A folder is
 * named by its id in the project; `.git` and `node_modules` are listed only as cutoff folders and never watched.
 *
 * Changes to one folder run one at a time (`exclusive`), so the daemon's own writes never interleave; reads and listings do not wait for them.
 */
export class FsService {
    /** The bytes a file may have to be read or written; a test lowers it. */
    maxFileBytes = MAX_FS_FILE_BYTES;
    /** Where the cap of a listing is; a test lowers it. */
    maxListEntries = MAX_LIST_ENTRIES;

    /** The search of file contents, with its limits; a test lowers them. */
    readonly contentSearch: ContentSearch;

    private watches = new Map<string, FolderWatch>();
    private queues = new Map<string, Promise<void>>();

    constructor(private files: FilesService, private watchOptions: WatchOptions = {}, searchOptions: SearchOptions = {}) {
        this.contentSearch = new ContentSearch(searchOptions);
    }

    async list(project: Project, folderId: FolderId, path: string, depth?: number): Promise<FsEntry[]> {
        const { root } = await this.open(project, folderId);
        const rel = normalizeFsPath(path);

        try {
            const target = await locate(root, rel, true);

            if (!target.stat) {
                throw missing(rel);
            }

            if (!target.stat.isDirectory()) {
                throw invalid(`${ rel } is a file`, { path: rel });
            }

            const { items } = await walkTree({ root, start: rel, startReal: target.real, depth: depth ?? Number.POSITIVE_INFINITY, cap: this.maxListEntries });

            return items.map(item => item.entry);
        }
        catch (error) {
            throw fsFailure(error, rel);
        }
    }

    /** Files whose name matches `query`, from the folder's cached listing (git's, where there is one), best first. */
    async find(project: Project, folderId: FolderId, query: string): Promise<string[]> {
        const { folder, root } = await this.open(project, folderId);
        const matches = matchPaths(await this.files.list(folder.path), query);
        const found: string[] = [];

        // A listing can name what is not a file now (a folder of another repository, a file deleted since): look at each before it counts.
        for (let index = 0; index < matches.length && found.length < MAX_FS_FIND; index += FIND_AHEAD) {
            const batch = matches.slice(index, index + FIND_AHEAD);
            const files = await Promise.all(batch.map(path => isFile(root, path)));

            found.push(...batch.filter((_path, position) => files[position]).slice(0, MAX_FS_FIND - found.length));
        }

        return found;
    }

    /**
     * The lines of the folder's files that hold `request.query` (see `ContentSearch`). It needs the folder on the disk (`unavailable`) and a
     * valid request (`invalid`); `signal` is the client's, and a client that went away ends the search.
     */
    async search(project: Project, request: FsSearchRequest, signal?: AbortSignal): Promise<FsSearchResult> {
        const { root } = await this.open(project, request.folderId);

        return this.contentSearch.search(root, request, signal);
    }

    async read(project: Project, folderId: FolderId, path: string): Promise<{ bytes: Uint8Array; version: string }> {
        const { root } = await this.open(project, folderId);
        const rel = normalizeFsPath(path);

        try {
            const target = await locate(root, rel, true);

            if (!target.stat) {
                throw missing(rel);
            }

            if (!target.stat.isFile()) {
                throw invalid(`${ rel === '' ? 'The folder' : rel } is a folder`, { path: rel });
            }

            return await readFileBytes(target.real, rel, this.maxFileBytes);
        }
        catch (error) {
            throw fsFailure(error, rel);
        }
    }

    /**
     * Writes the body as the file at `path`, parent folders made, and answers its new version. The body is read before the folder's lock is
     * taken, so a slow client holds nothing up; the version check and the write then follow each other as closely as the file system lets
     * them (the check is repeated right before the rename). A write over a folder, or below a file, is `conflict` (`exists`).
     */
    async write(project: Project, folderId: FolderId, path: string, body: AsyncIterable<Uint8Array> | null, options: FsWriteOptions): Promise<{ version: string }> {
        const { root } = await this.open(project, folderId);
        const rel = normalizeFsPath(path);
        const bytes = await readBody(body, options.declaredLength, rel, this.maxFileBytes);

        return this.exclusive(root, async () => {
            let made: string[] = [];

            try {
                const target = await locate(root, rel, true);

                if (target.blockedBy) {
                    throw exists(target.blockedBy, `A part of ${ rel } is a file`);
                }

                if (rel === '' || target.stat?.isDirectory()) {
                    throw exists(rel, `${ rel === '' ? 'The folder' : rel } is a folder`);
                }

                if (target.stat && !target.stat.isFile()) {
                    throw invalid(`${ rel } is not a regular file`, { path: rel });
                }

                checkPreconditions(rel, target.stat ? versionOf(target.stat) : null, options);
                made = await makeFolders(target.base, target.rest.slice(0, -1), rel);

                return { version: await writeFileAtomically(target.real, rel, bytes, target.stat, options) };
            }
            catch (error) {
                await removeFolders(made);
                throw fsFailure(error, rel);
            }
        });
    }

    async makeFolder(project: Project, folderId: FolderId, path: string): Promise<void> {
        const { root } = await this.open(project, folderId);
        const rel = normalizeFsPath(path);

        await this.exclusive(root, () => makeFolder(root, rel));
    }

    async move(project: Project, folderId: FolderId, moves: readonly FsMove[], overwrite = false): Promise<void> {
        await this.transfer(project, folderId, 'move', moves, overwrite);
    }

    async copy(project: Project, folderId: FolderId, copies: readonly FsMove[], overwrite = false): Promise<void> {
        await this.transfer(project, folderId, 'copy', copies, overwrite);
    }

    async remove(project: Project, folderId: FolderId, paths: readonly string[]): Promise<void> {
        const { root } = await this.open(project, folderId);

        this.limit(paths);

        const targets = paths.map(normalizeFsPath);

        await this.exclusive(root, () => remove(root, targets));
    }

    /**
     * The changes of a folder as an event stream. Every client of the folder shares one watcher, which is closed when the last of them leaves.
     * A platform that cannot watch is `unavailable`.
     */
    async watch(project: Project, folderId: FolderId, heartbeatMs?: number): Promise<ReadableStream<Uint8Array>> {
        const { root } = await this.open(project, folderId);
        let watcher = this.watches.get(root);

        if (!watcher) {
            watcher = new FolderWatch(root, this.watchOptions);

            try {
                watcher.start();
            }
            catch (error) {
                watcher.close();
                throw unavailable(`This folder cannot be watched: ${ (error as Error).message }`);
            }

            this.watches.set(root, watcher);
        }

        const shared = watcher;

        // Subscribed in the turn the watcher was found or made in, so a watcher that nobody listens to cannot be left open.
        return watchStream((subscriber) => {
            const leave = shared.subscribe(subscriber);

            return () => {
                leave();

                if (shared.size === 0 && this.watches.get(root) === shared) {
                    this.watches.delete(root);
                    shared.close();
                }
            };
        }, heartbeatMs);
    }

    /** Ends every watch and search; the daemon is stopping. */
    stop(): void {
        this.contentSearch.stop();

        for (const watcher of this.watches.values()) {
            watcher.close();
        }

        this.watches.clear();
    }

    private async transfer(project: Project, folderId: FolderId, mode: 'move' | 'copy', items: readonly FsMove[], overwrite: boolean): Promise<void> {
        const { root } = await this.open(project, folderId);

        this.limit(items);

        const transfers = items.map(({ from, to }) => ({ from: normalizeFsPath(from), to: normalizeFsPath(to) }));

        await this.exclusive(root, () => transfer(root, mode, transfers, overwrite));
    }

    private limit(items: readonly unknown[]): void {
        if (items.length > MAX_BATCH) {
            throw invalid(`At most ${ MAX_BATCH } items at a time`);
        }
    }

    private folderOf(project: Project, folderId: FolderId): ProjectFolder {
        if (!folderId) {
            throw invalid('The folder is not given');
        }

        const folder = project.folders.find(candidate => candidate.id === folderId);

        if (!folder) {
            throw notFound('Folder', folderId);
        }

        return folder;
    }

    /** The folder and its real path, which every link is judged against. A folder that is gone from the disk is `unavailable`. */
    private async open(project: Project, folderId: FolderId): Promise<{ folder: ProjectFolder; root: string }> {
        const folder = this.folderOf(project, folderId);

        try {
            return { folder, root: await realpath(folder.path) };
        }
        catch {
            throw unavailable(`The folder ${ folder.path } is missing`);
        }
    }

    /** Runs `work` after the changes already waiting on the same folder, and before the next. */
    private async exclusive<T>(root: string, work: () => Promise<T>): Promise<T> {
        const before = this.queues.get(root) ?? Promise.resolve();
        let release!: () => void;
        const turn = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = before.then(() => turn);

        this.queues.set(root, tail);
        await before;

        try {
            return await work();
        }
        finally {
            release();

            if (this.queues.get(root) === tail) {
                this.queues.delete(root);
            }
        }
    }
}
