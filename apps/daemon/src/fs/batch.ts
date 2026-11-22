import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

import { conflict, invalid } from '../errors';
import { makeFolders, removeFolders, transientName } from './content';
import { exists, fsFailure, isWithin, locate, missing } from './paths';

import type { Located } from './paths';

export interface Transfer {
    from: string;
    to: string;
}

type Mode = 'move' | 'copy';

/** What a failed batch has to undo, innermost first. */
type Action =
    | { type: 'moved'; from: string; to: string }
    | { type: 'copied'; to: string }
    | { type: 'folders'; made: string[] }
    | { type: 'aside'; original: string; aside: string };

const into = (mode: Mode, path: string) => conflict(`${ path } can't ${ mode } into itself`, { path });

/** Whether two real paths are the same file or one is below the other. */
const overlaps = (a: string, b: string) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);

const sameFile = (a: Located, b: Located) => a.stat !== undefined && b.stat !== undefined && a.stat.ino === b.stat.ino && a.stat.dev === b.stat.dev;

/** Checks the whole batch against what is on disk before anything changes, so a refusal changes nothing. */
async function check(root: string, mode: Mode, transfers: readonly Transfer[], overwrite: boolean): Promise<void> {
    const targets = new Set<string>();

    for (const { from, to } of transfers) {
        if (to === '') {
            throw invalid('The folder itself cannot be replaced', { path: '' });
        }

        if (mode === 'move' && from === '') {
            throw invalid('The folder itself cannot be moved', { path: '' });
        }

        if (isWithin(to, from)) {
            throw into(mode, to);
        }

        if (targets.has(to)) {
            throw exists(to, `Two items go to ${ to }`);
        }

        targets.add(to);

        const source = await locate(root, from, false);
        const target = await locate(root, to, false);

        if (!source.stat) {
            throw missing(from);
        }

        if (target.blockedBy) {
            throw exists(target.blockedBy, `A part of ${ to } is a file`);
        }

        if (overlaps(target.real, source.real) && target.real !== source.real) {
            throw into(mode, to);
        }

        // On a file system that ignores case `a.ts` and `A.ts` are one file: renaming it is not replacing something.
        const itself = target.stat && sameFile(source, target);

        if (itself && mode === 'copy') {
            throw into(mode, to);
        }

        if (target.stat && !overwrite && !itself) {
            throw exists(to);
        }
    }

    // Replacing what another item of the batch comes from or goes into would lose it, whatever order the items run in.
    if (overwrite) {
        for (const [index, { to }] of transfers.entries()) {
            const clash = transfers.find((other, position) => position !== index && (isWithin(to, other.from) || isWithin(other.from, to)));

            if (clash) {
                throw conflict(`${ to } is replaced while ${ clash.from } is in the same batch`, { path: to });
            }
        }
    }
}

/** A folder with everything in it, links as links (as `cp -R` does; a link is never followed, so none can lead the copy out of the folder). */
async function copyTree(source: string, target: string): Promise<void> {
    const info = await lstat(source);

    if (info.isSymbolicLink()) {
        await symlink(await readlink(source), target);
    }
    else if (info.isDirectory()) {
        await mkdir(target);

        for (const name of await readdir(source)) {
            await copyTree(join(source, name), join(target, name));
        }

        await chmod(target, info.mode & 0o7777).catch(() => undefined);
    }
    else if (info.isFile()) {
        // A clone where the file system has them; EXCL because nothing may be there (a replaced target was set aside first).
        await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    }
}

async function undo(actions: readonly Action[]): Promise<void> {
    for (const action of [...actions].reverse()) {
        try {
            if (action.type === 'moved') {
                await rename(action.to, action.from);
            }
            else if (action.type === 'copied') {
                await rm(action.to, { recursive: true, force: true });
            }
            else if (action.type === 'folders') {
                await removeFolders(action.made);
            }
            else {
                await rename(action.aside, action.original);
            }
        }
        catch (error) {
            console.warn('[clowdy] could not take back a step of a failed batch:', error);
        }
    }
}

/**
 * Moves or copies a batch: the whole of it, or nothing. Every item is checked first; then they run in order, and one that fails puts back
 * what the earlier ones did (the replaced targets were only set aside, so an overwrite is undone too). Replaced targets are deleted once the
 * whole batch has worked. A move is a rename, so it keeps what it moves (versions included); a copy makes new files. The caller holds the
 * folder's lock, so no other change of ours lands in between.
 */
export async function transfer(root: string, mode: Mode, transfers: readonly Transfer[], overwrite: boolean): Promise<void> {
    await check(root, mode, transfers, overwrite);

    const actions: Action[] = [];
    const asides: string[] = [];
    let at = '';

    try {
        for (const { from, to } of transfers) {
            at = from;

            const source = await locate(root, from, false);

            if (!source.stat) {
                throw missing(from);
            }

            at = to;

            const target = await locate(root, to, false);

            if (target.blockedBy) {
                throw exists(target.blockedBy, `A part of ${ to } is a file`);
            }

            const itself = target.stat && sameFile(source, target);

            if (target.stat && !overwrite && !itself) {
                throw exists(to);
            }

            if (overlaps(target.real, source.real) && target.real !== source.real) {
                throw into(mode, to);
            }

            const made = await makeFolders(target.base, target.rest.slice(0, -1), to);

            if (made.length > 0) {
                actions.push({ type: 'folders', made });
            }

            if (target.stat && !itself) {
                const aside = join(dirname(target.real), transientName('replaced'));

                await rename(target.real, aside);
                actions.push({ type: 'aside', original: target.real, aside });
                asides.push(aside);
            }

            if (mode === 'move') {
                await rename(source.real, target.real);
                actions.push({ type: 'moved', from: source.real, to: target.real });
            }
            else {
                actions.push({ type: 'copied', to: target.real });
                await copyTree(source.real, target.real);
            }
        }
    }
    catch (error) {
        await undo(actions);
        throw fsFailure(error, at);
    }

    for (const aside of asides) {
        await rm(aside, { recursive: true, force: true }).catch(() => undefined);
    }
}

/** Deletes paths, folders with everything in them; a path that is not there is fine. A link is deleted, never what it leads to. */
export async function remove(root: string, paths: readonly string[]): Promise<void> {
    for (const path of paths) {
        if (path === '') {
            throw invalid('The folder itself cannot be deleted', { path: '' });
        }
    }

    for (const path of paths) {
        const target = await locate(root, path, false);

        if (!target.stat) {
            continue;
        }

        try {
            await rm(target.real, { recursive: true, force: true });
        }
        catch (error) {
            throw fsFailure(error, path);
        }
    }
}

/** Makes a folder and the folders above it; one that is there is fine, a file in the way is `conflict`. */
export async function makeFolder(root: string, rel: string): Promise<void> {
    const target = await locate(root, rel, true);

    if (target.blockedBy) {
        throw exists(target.blockedBy, `A part of ${ rel } is a file`);
    }

    if (target.stat) {
        if (!target.stat.isDirectory()) {
            throw exists(rel, `${ rel } is a file`);
        }

        return;
    }

    try {
        await makeFolders(target.base, target.rest, rel);
    }
    catch (error) {
        throw fsFailure(error, rel);
    }
}
