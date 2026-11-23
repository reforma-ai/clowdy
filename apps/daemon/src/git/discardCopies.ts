import { GIT_DISCARD_KEEP_DAYS } from '@clowdy/protocol';
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { GitDiscardedFile } from '@clowdy/protocol';

/** How long the copy of what a discard removed is kept. The dialog tells the person the same number of days (`GIT_DISCARD_KEEP_DAYS`). */
export const KEEP_COPIES_MS = GIT_DISCARD_KEEP_DAYS * 24 * 60 * 60 * 1000;

/**
 * How much all the copies may take together. Past it the oldest are removed first (never the one that was just made). A discard whose own copy would not fit is refused, so the
 * cap holds without ever losing the copy of the work that is being deleted this minute.
 */
export const MAX_KEPT_BYTES = 500 * 1024 * 1024;

/**
 * The biggest file a copy is kept of. A bigger one is refused and left where it is: it is a build output or a data file, not what an agent wrote by hand, and the person can
 * discard it in a terminal. It also bounds how long a discard holds the place's line of writes.
 */
export const MAX_COPY_FILE_BYTES = 50 * 1024 * 1024;

/** The name of the file that says what a folder of copies holds. */
const MANIFEST = 'manifest.json';

/** What one file of a discard has to give to its copy. */
export interface CopySource {
    /** The path in the repository, as the changes list writes it. */
    path: string;
    action: GitDiscardedFile['action'];
    /** What the file is on the disk now; none for a file that is gone (a deleted file has nothing to keep). */
    work?:
        | { kind: 'file'; source: string; size: number }
        | { kind: 'link'; target: string };
    /** What the index holds when that is neither HEAD's nor the file's: the staged version, which a discard replaces as well. `read` is called once, when its turn comes. */
    staged?: { size: number; read: () => Promise<Buffer> };
}

/** What a discard tells the copy it makes: whose it is, and the files. */
export interface CopyJob {
    projectId: string;
    folderId: string;
    workspaceId?: string;
    /** The place's directory. */
    place: string;
    /** The branch checked out, and the commit it is at (what the files go back to). Absent for a detached HEAD, or no commit yet. */
    branch?: string;
    head?: string;
    files: CopySource[];
}

/** A copy that was made and checked. */
export interface KeptCopy {
    /** The folder: the manifest and `files/` (what the files held), `staged/` (what the index held). */
    folder: string;
    keptUntil: number;
    /** The files in it, the staged versions included. */
    files: number;
    bytes: number;
}

/** What a discard needs of its copies. The test double of a copy that fails implements it, or extends `DiscardCopies`. */
export interface CopyStore {
    /** The most one file may be for a copy to be made of it, and the most one discard's copies may come to. */
    readonly maxFileBytes: number;
    readonly maxBytes: number;
    /** Makes the copy and checks it: the sizes are those of the files. Throws and leaves nothing behind when it cannot. */
    keep: (job: CopyJob) => Promise<KeptCopy>;
    /** Says in the manifest that the discard was made (best effort). */
    finish: (copy: KeptCopy) => Promise<void>;
    /** Removes what is past its time, and then the oldest while the whole is over the cap, but never `keep`. */
    prune: (keep?: string) => Promise<void>;
}

export interface DiscardCopiesOptions {
    keepMs?: number;
    maxBytes?: number;
    maxFileBytes?: number;
    /** The clock: tests move it. */
    now?: () => number;
}

/** What the manifest of a copy says: enough to find the files again, and for `prune` to decide. */
interface Manifest {
    version: 1;
    projectId: string;
    folderId: string;
    workspaceId?: string;
    place: string;
    branch?: string;
    head?: string;
    /** When it was made, in milliseconds. */
    at: number;
    keptUntil: number;
    /** False until the discard ran: a copy of a discard that failed says so. */
    completed: boolean;
    /** The bytes of every copied file, which is what the cap counts. */
    bytes: number;
    files: Array<{
        path: string;
        action: GitDiscardedFile['action'];
        /** What was kept of the file as it was on the disk: its bytes (`file`), or the target of a link (`link`, in a file of its own). Absent when nothing was there. */
        copied?: 'file' | 'link';
        size?: number;
        /** The size of the staged version, when one was kept. */
        stagedSize?: number;
    }>;
}

/** A name for a folder of the copies that sorts by time, has no `:` (Windows) and does not clash with another made in the same millisecond. */
const folderName = (at: number) => `${ new Date(at).toISOString().replace(/[-:]/g, '').replace('.', '') }-${ randomBytes(3).toString('hex') }`;

/** What a name of the project may be as a folder: its id is the daemon's own, but nothing that could leave the folder is let through. */
const segment = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, '_') || '_';

/**
 * The copies of what a discard removes, in the daemon's own data folder (`<dataDir>/discarded/<project id>/<time>-<random>/`), never in the repository: a file written a minute
 * ago by an agent is what a person may want back. Each folder has `manifest.json` (what was discarded, from which place, when), `files/<path>` (the bytes the file held, a link as
 * the text of its target) and, when the index held another version, `staged/<path>`. There is no restore: the person copies the file back. Folders are removed after
 * `KEEP_COPIES_MS`, and the oldest first while all of them are over `MAX_KEPT_BYTES`. Everything is readable by the person alone.
 */
export class DiscardCopies implements CopyStore {
    readonly root: string;
    readonly maxFileBytes: number;
    readonly maxBytes: number;
    readonly #keepMs: number;
    readonly #now: () => number;
    /** The prunes one after the other: two of them removing the same folder is harmless, but the sizes they add up should be one reading. */
    #pruning: Promise<void> = Promise.resolve();

    constructor(dataDir: string, { keepMs = KEEP_COPIES_MS, maxBytes = MAX_KEPT_BYTES, maxFileBytes = MAX_COPY_FILE_BYTES, now = Date.now }: DiscardCopiesOptions = {}) {
        this.root = join(dataDir, 'discarded');
        this.#keepMs = keepMs;
        this.maxBytes = maxBytes;
        this.maxFileBytes = maxFileBytes;
        this.#now = now;
    }

    async keep(job: CopyJob): Promise<KeptCopy> {
        const at = this.#now();
        const folder = join(this.root, segment(job.projectId), folderName(at));
        const manifest: Manifest = {
            version: 1,
            projectId: job.projectId,
            folderId: job.folderId,
            ...(job.workspaceId !== undefined && { workspaceId: job.workspaceId }),
            place: job.place,
            ...(job.branch !== undefined && { branch: job.branch }),
            ...(job.head !== undefined && { head: job.head }),
            at,
            keptUntil: at + this.#keepMs,
            completed: false,
            bytes: 0,
            files: [],
        };
        let kept = 0;

        try {
            await mkdir(folder, { recursive: true, mode: 0o700 });

            for (const file of job.files) {
                const entry: Manifest['files'][number] = { path: file.path, action: file.action };

                if (file.work?.kind === 'file') {
                    await this.#copyFile(file.work.source, join(folder, 'files', file.path), file.work.size);
                    Object.assign(entry, { copied: 'file', size: file.work.size });
                    manifest.bytes += file.work.size;
                    kept++;
                }
                else if (file.work?.kind === 'link') {
                    const size = await this.#write(join(folder, 'files', file.path), Buffer.from(file.work.target));

                    Object.assign(entry, { copied: 'link', size });
                    manifest.bytes += size;
                    kept++;
                }

                if (file.staged) {
                    const content = await file.staged.read();

                    // The blob git was asked for is the size git said it was: the read is not the one that was measured otherwise.
                    if (content.length !== file.staged.size) throw new Error(`The staged version of ${ file.path } is not the size git said`);

                    entry.stagedSize = await this.#write(join(folder, 'staged', file.path), content);
                    manifest.bytes += entry.stagedSize;
                    kept++;
                }

                manifest.files.push(entry);
            }

            await writeFile(join(folder, MANIFEST), `${ JSON.stringify(manifest, null, 2) }\n`, { mode: 0o600 });
        }
        catch (error) {
            // Half a copy is no copy: nothing is discarded after this, and the folder does not stay to be mistaken for one.
            await rm(folder, { recursive: true, force: true }).catch(() => undefined);

            throw error;
        }

        return { folder, keptUntil: manifest.keptUntil, files: kept, bytes: manifest.bytes };
    }

    async finish(copy: KeptCopy): Promise<void> {
        try {
            const path = join(copy.folder, MANIFEST);
            const manifest = JSON.parse(await readFile(path, 'utf8')) as Manifest;

            await writeFile(path, `${ JSON.stringify({ ...manifest, completed: true }, null, 2) }\n`, { mode: 0o600 });
        }
        catch {
            // The copy is there all the same; only its note says "not done".
        }
    }

    prune(keep?: string): Promise<void> {
        this.#pruning = this.#pruning.then(() => this.#prune(keep)).catch(() => undefined);

        return this.#pruning;
    }

    /** Streams a file's bytes to `destination` (readable by the person alone) and checks the copy is as long as the file was when it was measured. */
    async #copyFile(source: string, destination: string, size: number): Promise<void> {
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await pipeline(createReadStream(source), createWriteStream(destination, { flags: 'wx', mode: 0o600 }));

        const copied = (await stat(destination)).size;

        if (copied !== size) throw new Error(`The copy of ${ source } is ${ copied } bytes, and the file was ${ size }`);
    }

    /** Writes bytes to `destination` (readable by the person alone) and reads its size back. */
    async #write(destination: string, content: Buffer): Promise<number> {
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, content, { flag: 'wx', mode: 0o600 });

        const written = (await stat(destination)).size;

        if (written !== content.length) throw new Error(`The copy at ${ destination } is ${ written } bytes, and it should be ${ content.length }`);

        return written;
    }

    async #prune(keep: string | undefined): Promise<void> {
        const now = this.#now();
        const left: Array<{ folder: string; at: number; bytes: number }> = [];
        const projects = await readdir(this.root).catch(() => [] as string[]);

        for (const project of projects) {
            const directory = join(this.root, project);
            const info = await lstat(directory).catch(() => undefined);

            // What is not a folder of ours (a link, a stray file) is not ours to remove.
            if (!info?.isDirectory()) continue;

            for (const name of await readdir(directory).catch(() => [] as string[])) {
                const folder = join(directory, name);
                const found = await this.#read(folder);

                if (!found) continue;

                if (folder !== keep && now - found.at > this.#keepMs) {
                    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
                }
                else {
                    left.push({ folder, ...found });
                }
            }

            // A project's folder with nothing in it any more: `rmdir` only, so a folder that is not empty stays.
            await rmdir(directory).catch(() => undefined);
        }

        let total = left.reduce((sum, copy) => sum + copy.bytes, 0);

        for (const copy of left.sort((a, b) => a.at - b.at || (a.folder < b.folder ? -1 : 1))) {
            if (total <= this.maxBytes) break;

            if (copy.folder === keep) continue;

            await rm(copy.folder, { recursive: true, force: true }).catch(() => undefined);
            total -= copy.bytes;
        }
    }

    /** When a folder of copies was made and what it holds, from its manifest; from the folder's own time when the manifest is not there (a copy that was interrupted). Not a folder: none. */
    async #read(folder: string): Promise<{ at: number; bytes: number } | undefined> {
        const info = await lstat(folder).catch(() => undefined);

        if (!info?.isDirectory()) return undefined;

        try {
            const manifest = JSON.parse(await readFile(join(folder, MANIFEST), 'utf8')) as Partial<Manifest>;

            if (typeof manifest.at === 'number' && typeof manifest.bytes === 'number') return { at: manifest.at, bytes: manifest.bytes };
        }
        catch {
            // Unreadable, or not JSON: it is judged by its time.
        }

        return { at: info.mtimeMs, bytes: 0 };
    }
}
