import { opendir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { CUTOFF_NAMES, followLink, isListed, versionOf } from './paths';

import type { Dirent } from 'node:fs';
import type { FsEntry, FsKind } from '@clowdy/protocol';

/** The most entries one listing answers with; past it the folders not read yet are left as cutoffs. */
export const MAX_LIST_ENTRIES = 100_000;

/** Folders read at once, and files looked at (for their size) at once. */
const READ_AHEAD = 16;
const STAT_AHEAD = 64;

/** One entry found, with the version a file has (a watcher keeps it to tell a real change from noise). */
export interface Found {
    entry: FsEntry;
    version?: string;
}

export interface Walk {
    items: Found[];
    /** Whether the cap cut the listing short (folders left unread are cutoffs, but one folder that is over the cap on its own is cut). */
    truncated: boolean;
}

export interface WalkOptions {
    /** The real path of the folder, the base every link must stay inside. */
    root: string;
    /** The folder to list, relative to the root as the client wrote it: it prefixes every path. */
    start: string;
    /** The real path of `start`. */
    startReal: string;
    /** Path segments below `start` to list: 1 for its direct entries, `Infinity` for everything. */
    depth: number;
    cap: number;
}

interface Pending {
    /** Relative path of the folder, as the client sees it. */
    rel: string;
    /** Real path of the folder. */
    abs: string;
    /** How many segments below `start` the folder's entries are. */
    level: number;
    /** The folder's own entry, to mark when it is left unread; the listed folder has none. */
    item?: Found;
}

interface Read {
    found: Found;
    /** A folder to list the content of in the next round. */
    enter?: string;
}

async function inChunks<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = [];

    for (let index = 0; index < items.length; index += size) {
        results.push(...(await Promise.all(items.slice(index, index + size).map(work))));
    }

    return results;
}

/** Whether a folder holds anything a listing would show. A folder that cannot be read says yes: asking for it explains why. */
export async function hasEntries(path: string): Promise<boolean> {
    try {
        const dir = await opendir(path);

        try {
            for (let entry = await dir.read(); entry; entry = await dir.read()) {
                if (isListed(entry.name)) {
                    return true;
                }
            }

            return false;
        } finally {
            await dir.close();
        }
    } catch {
        return true;
    }
}

/**
 * What a file or link at `abs` is, for a listing or a watch: a file with its size and version, a folder (a link to one is a folder nothing
 * enters, with `hasChildren` told from the target), or nothing. A link that leads outside the folder or nowhere is nothing, and so is a
 * socket, a pipe or a device.
 */
export async function describe(
    root: string,
    abs: string,
    kind: 'file' | 'directory' | 'link' | 'other',
    rel: string
): Promise<Found | undefined> {
    try {
        let target = abs;
        let type: FsKind | undefined = kind === 'file' ? 'file' : kind === 'directory' ? 'directory' : undefined;

        if (kind === 'link') {
            const followed = await followLink(root, abs, rel);

            target = followed.real;
            type = followed.stat.isDirectory() ? 'directory' : followed.stat.isFile() ? 'file' : undefined;
        }

        if (type === 'directory') {
            // A link to a folder is never entered by a listing, so it always says whether there is something to ask for.
            return {
                entry: {
                    path: rel,
                    kind: 'directory',
                    ...(kind === 'link' && { hasChildren: await hasEntries(target) }),
                },
            };
        }

        if (type === 'file') {
            const info = await stat(target, { bigint: true });

            return { entry: { path: rel, kind: 'file', size: Number(info.size) }, version: versionOf(info) };
        }
    } catch {
        // Gone while it was looked at, a link that leaves the folder, a file nobody may look at: it is not listed.
    }

    return undefined;
}

const kindOf = (dirent: Dirent): 'file' | 'directory' | 'link' | 'other' =>
    dirent.isFile() ? 'file' : dirent.isDirectory() ? 'directory' : dirent.isSymbolicLink() ? 'link' : 'other';

async function readFolder(options: WalkOptions, folder: Pending): Promise<Read[] | undefined> {
    let dirents: Dirent[];

    try {
        dirents = await readdir(folder.abs, { withFileTypes: true });
    } catch (error) {
        // The folder asked for must be readable; one found on the way is left as a cutoff, and asking for it explains why.
        if (folder.item) {
            return undefined;
        }

        throw error;
    }

    const names = dirents
        .filter(dirent => isListed(dirent.name))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const cutoff = folder.level >= options.depth;

    const reads = await inChunks(names, STAT_AHEAD, async (dirent): Promise<Read | undefined> => {
        const rel = folder.rel === '' ? dirent.name : `${folder.rel}/${dirent.name}`;
        const abs = join(folder.abs, dirent.name);
        const kind = kindOf(dirent);

        if (kind === 'directory') {
            if (cutoff || CUTOFF_NAMES.has(dirent.name)) {
                return { found: { entry: { path: rel, kind: 'directory', hasChildren: await hasEntries(abs) } } };
            }

            return { found: { entry: { path: rel, kind: 'directory' } }, enter: abs };
        }

        const found = await describe(options.root, abs, kind, rel);

        return found && { found };
    });

    return reads.filter((read): read is Read => read !== undefined);
}

/**
 * The entries below `start`, level by level: every shallow folder is listed before any deeper one is begun, so the cap cuts the deepest
 * levels, never a whole branch. A folder at the depth cutoff, a `.git` or `node_modules`, a link to a folder, a folder that cannot be read and
 * a folder left unread by the cap are listed without their content and with `hasChildren`; a folder whose content would not fit the cap is
 * left that way too (only the listed folder itself, if it alone is over the cap, is cut).
 */
export async function walkTree(options: WalkOptions): Promise<Walk> {
    const items: Found[] = [];
    let truncated = false;
    let level: Pending[] = options.depth < 1 ? [] : [{ rel: options.start, abs: options.startReal, level: 1 }];
    let capped = false;

    const leave = (folders: Pending[]) => {
        for (const folder of folders) {
            if (folder.item) {
                folder.item.entry.hasChildren = true;
            }
        }
    };

    while (level.length > 0) {
        const next: Pending[] = [];

        for (let index = 0; index < level.length; index += READ_AHEAD) {
            if (items.length >= options.cap) {
                truncated = true;
                capped = true;
                leave([...level.slice(index), ...next]);

                break;
            }

            const chunk = level.slice(index, index + READ_AHEAD);
            const reads = await Promise.all(chunk.map(folder => readFolder(options, folder)));

            for (const [position, folder] of chunk.entries()) {
                const read = reads[position];

                if (!read || (folder.item && items.length + read.length > options.cap)) {
                    truncated = true;
                    leave([folder]);

                    continue;
                }

                // Only the listed folder can be over the cap on its own; it is cut.
                const fits = read.slice(0, Math.max(options.cap - items.length, 0));

                truncated ||= fits.length < read.length;

                for (const { found, enter } of fits) {
                    items.push(found);

                    if (enter) {
                        next.push({ rel: found.entry.path, abs: enter, level: folder.level + 1, item: found });
                    }
                }
            }
        }

        level = capped ? [] : next;
    }

    return { items, truncated };
}
