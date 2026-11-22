import { lstat, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { CommandError, conflict, invalid, unavailable } from '../errors';

import type { FsErrorReason } from '@clowdy/protocol';
import type { BigIntStats } from 'node:fs';

/** Folders a recursive listing never enters and nothing under which is watched or searched. */
export const CUTOFF_NAMES: ReadonlySet<string> = new Set(['.git', 'node_modules']);

/** Longest path a client may name; the file system's own limits (255 bytes a name) answer for the rest. */
const MAX_PATH_LENGTH = 4096;

/** What the daemon writes next to a file while it is being replaced, and keeps a replaced target under until a batch is done. */
export const TRANSIENT_NAME = /^\.clowdy-[0-9a-f]{8}\.(tmp|replaced)$/;

export function reasoned(reason: FsErrorReason, extra: Record<string, unknown> = {}): { reason: FsErrorReason } & Record<string, unknown> {
    return { reason, ...extra };
}

/** A path that leaves the folder, by its spelling or through a link. */
export const outside = (message: string) => invalid(message, reasoned('outside'));

export const missing = (path: string) => new CommandError('not_found', `${ path === '' ? 'The folder' : path } does not exist`, { path });

/** Something is already there, or a part of the path is a file: `conflict` with `details.reason: 'exists'` and the path that is in the way. */
export const exists = (path: string, message = `${ path } already exists`) => conflict(message, reasoned('exists', { path }));

/**
 * Validates a client-supplied path and returns it normalized: `/`-separated, relative, no `.` or empty segments; `''` is the folder itself.
 * Absolute paths, drive letters, backslashes, `..` and NUL are refused as leaving the folder.
 */
export function normalizeFsPath(input: unknown): string {
    if (typeof input !== 'string') {
        throw invalid('The path must be a string');
    }

    if (input.length > MAX_PATH_LENGTH) {
        throw invalid('The path is too long');
    }

    if (input.includes('\0') || input.includes('\\') || input.startsWith('/') || /^[A-Za-z]:/.test(input)) {
        throw outside('The path must be relative to the folder and use "/" separators');
    }

    const segments = input.split('/').filter(segment => segment !== '' && segment !== '.');

    if (segments.includes('..')) {
        throw outside('The path must not contain ".."');
    }

    return segments.join('/');
}

/** Whether a name found in a folder can be addressed back by a client: one with a backslash or a drive letter could not. */
export const isAddressable = (path: string) => !path.includes('\\') && !/^[A-Za-z]:/.test(path);

/** Whether a listing shows a name: one a client can address, that is not what the daemon keeps next to a file while it writes (a watcher never tells of those either). */
export const isListed = (name: string) => isAddressable(name) && !TRANSIENT_NAME.test(name);

/** Whether `path` is `ancestor`, or inside it; both normalized relative paths, `''` the folder. */
export const isWithin = (path: string, ancestor: string) => ancestor === '' || path === ancestor || path.startsWith(`${ ancestor }/`);

/** Whether the absolute path `path` is `root` or below it. */
export const isInside = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** Whether a path of the folder is one of, or below, a folder that nothing is listed, watched or searched under. */
export const underCutoff = (path: string) => path.split('/').slice(0, -1).some(name => CUTOFF_NAMES.has(name));

export const versionOf = (stat: BigIntStats) => `${ stat.size }:${ stat.mtimeNs }`;

/** Where a client's path leads on disk, found one component at a time so that no link is followed without being checked. */
export interface Located {
    /** The normalized relative path asked for. */
    rel: string;
    /** The path on disk, made only of real components: links along the way are replaced by their targets (the last one only when asked). */
    real: string;
    /** What is there (`lstat` of `real`), or `undefined` when nothing is, or a part of the path is a file. */
    stat?: BigIntStats;
    /** The deepest folder that exists on the way, a real path; when the whole path exists, the folder that holds its last component. */
    base: string;
    /** The names below `base` that do not exist (empty when the path does). */
    rest: string[];
    /** The relative path of a file the path runs through, when it does: nothing can be made below it. */
    blockedBy?: string;
}

/**
 * Walks `rel` from the real folder `root`. A link met on the way is resolved and must lead to a place inside `root`, else the path is
 * `outside` (so is a link that leads nowhere); the last component is resolved the same way only with `followLast`, so a delete or a move
 * of a link stays on the link itself. Everything an operation then touches is `real`, which has no unchecked link in it.
 */
export async function locate(root: string, rel: string, followLast: boolean): Promise<Located> {
    const names = rel === '' ? [] : rel.split('/');
    let base = root;

    for (const [index, name] of names.entries()) {
        const last = index === names.length - 1;
        let next = join(base, name);
        let info: BigIntStats;

        try {
            info = await lstat(next, { bigint: true });
        }
        catch (error) {
            const { code } = error as NodeJS.ErrnoException;

            if (code === 'ENOENT') {
                return { rel, real: join(base, ...names.slice(index)), base, rest: names.slice(index) };
            }

            throw error;
        }

        if (info.isSymbolicLink() && (!last || followLast)) {
            const target = await followLink(root, next, rel);

            next = target.real;
            info = target.stat;
        }

        if (!last && !info.isDirectory()) {
            return { rel, real: join(base, ...names.slice(index)), base, rest: names.slice(index), blockedBy: names.slice(0, index + 1).join('/') };
        }

        if (last) {
            return { rel, real: next, stat: info, base, rest: [] };
        }

        base = next;
    }

    return { rel, real: root, stat: await lstat(root, { bigint: true }), base: root, rest: [] };
}

/** The real target of a link and what is there, when it is inside `root`. */
export async function followLink(root: string, link: string, rel: string): Promise<{ real: string; stat: BigIntStats }> {
    let real: string;

    try {
        real = await realpath(link);
    }
    catch (error) {
        const { code } = error as NodeJS.ErrnoException;

        if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') {
            throw outside(`${ rel } runs through a symbolic link that leads nowhere`);
        }

        throw error;
    }

    if (!isInside(root, real)) {
        throw outside(`${ rel } runs through a symbolic link that leaves the folder`);
    }

    return { real, stat: await lstat(real, { bigint: true }) };
}

/** What the file system said, as the client may hear it (relative paths only). Anything that is not the client's doing is returned as it is. */
export function fsFailure(error: unknown, rel: string): unknown {
    if (error instanceof CommandError || !(error instanceof Error)) {
        return error;
    }

    const where = rel === '' ? 'the folder' : rel;

    switch ((error as NodeJS.ErrnoException).code) {
        case 'EACCES':
        case 'EPERM':
        case 'EROFS':
            return invalid(`Not allowed to change ${ where }`, reasoned('permission', { path: rel }));
        case 'ENOENT':
            return missing(rel);
        case 'ENOTDIR':
            return invalid(`A part of the path of ${ where } is a file`, { path: rel });
        case 'EISDIR':
            return invalid(`${ where } is a folder`, { path: rel });
        case 'ENAMETOOLONG':
            return invalid(`A name in ${ where } is too long`, { path: rel });
        case 'ELOOP':
            return invalid(`${ where } runs through a loop of symbolic links`, { path: rel });
        case 'EEXIST':
        case 'ENOTEMPTY':
            return exists(rel);
        case 'EXDEV':
            return invalid(`${ where } is on another file system`, { path: rel });
        case 'ENOSPC':
        case 'EDQUOT':
            return unavailable('The disk is full');
        default:
            return error;
    }
}
