import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { conflict, invalid, TooLargeError } from '../errors';
import { exists, outside, reasoned, versionOf } from './paths';

import type { BigIntStats } from 'node:fs';
import type { FsErrorReason } from '@clowdy/protocol';

/** Opening a link in place of the file that was checked fails instead of following it (Windows has no such flag). */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

/** A name for what the daemon keeps next to a file for a moment; `TRANSIENT_NAME` is what a watcher leaves out. */
export const transientName = (kind: 'tmp' | 'replaced') => `.clowdy-${randomBytes(4).toString('hex')}.${kind}`;

const tooLargeDetails = (path: string, maxBytes: number, size?: number) =>
    reasoned('too_large', { path, maxBytes, ...(size !== undefined && { size }) });

/** A file to read that is over the limit: `invalid`, HTTP 400. */
export const tooLargeToRead = (path: string, maxBytes: number, size: number) =>
    invalid(`${path} is over ${maxBytes} bytes`, tooLargeDetails(path, maxBytes, size));

/** A body to write that is over the limit: `invalid`, HTTP 413 as an upload is. */
export const tooLargeToWrite = (path: string, maxBytes: number) =>
    new TooLargeError(`${path} is over ${maxBytes} bytes`, tooLargeDetails(path, maxBytes));

const READ_ATTEMPTS = 3;

/**
 * The whole file and its version. The version is taken before and after the read, and the read repeated when the file changed under it, so
 * the version never belongs to older bytes than it names (a version older than the bytes would only make a later save conflict).
 */
export async function readFileBytes(
    real: string,
    rel: string,
    maxBytes: number
): Promise<{ bytes: Buffer; version: string }> {
    const handle = await open(real, constants.O_RDONLY | NO_FOLLOW);

    try {
        for (let attempt = 1; ; attempt++) {
            const before = await handle.stat({ bigint: true });

            if (!before.isFile()) {
                throw invalid(`${rel} is not a file`, { path: rel });
            }

            if (before.size > BigInt(maxBytes)) {
                throw tooLargeToRead(rel, maxBytes, Number(before.size));
            }

            const bytes = Buffer.allocUnsafe(Number(before.size));
            let length = 0;

            while (length < bytes.length) {
                const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);

                if (bytesRead === 0) {
                    break;
                }

                length += bytesRead;
            }

            const after = await handle.stat({ bigint: true });

            if (versionOf(after) === versionOf(before) || attempt === READ_ATTEMPTS) {
                return { bytes: bytes.subarray(0, length), version: versionOf(after) };
            }
        }
    } finally {
        await handle.close();
    }
}

/** The request's body, cut off at `maxBytes`: a declared length over it is refused unread, and a body that hides its length is cut while it is read. */
export async function readBody(
    body: AsyncIterable<Uint8Array> | null,
    declaredLength: number,
    rel: string,
    maxBytes: number
): Promise<Buffer> {
    if (declaredLength > maxBytes) {
        throw tooLargeToWrite(rel, maxBytes);
    }

    const chunks: Uint8Array[] = [];
    let size = 0;

    if (body) {
        for await (const chunk of body) {
            size += chunk.length;

            if (size > maxBytes) {
                throw tooLargeToWrite(rel, maxBytes);
            }

            chunks.push(chunk);
        }
    }

    return Buffer.concat(chunks);
}

/**
 * Makes the folders `names` below the real folder `base`, one at a time so that none is made through something planted meanwhile: a name
 * that turned up as a link is `outside`, as a file `exists`. Answers the folders it made, so a failed operation can take them back.
 */
export async function makeFolders(base: string, names: readonly string[], rel: string): Promise<string[]> {
    const made: string[] = [];
    let current = base;

    for (const name of names) {
        current = join(current, name);

        try {
            await mkdir(current);
            made.push(current);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                await removeFolders(made);
                throw error;
            }

            const info = await lstat(current);

            if (info.isSymbolicLink()) {
                await removeFolders(made);
                throw outside(`${rel} runs through a symbolic link that appeared while it was made`);
            }

            if (!info.isDirectory()) {
                await removeFolders(made);
                throw exists(rel, `A part of ${rel} is a file`);
            }
        }
    }

    return made;
}

/** Takes back folders `makeFolders` made, the innermost first; one that holds something now stays. */
export async function removeFolders(made: readonly string[]): Promise<void> {
    for (const folder of [...made].reverse()) {
        await rmdir(folder).catch(() => undefined);
    }
}

/** What a write must find on disk: `version` is the one the caller read, `null` means nothing there. */
export interface Preconditions {
    /** `If-None-Match: *`: only a file that is not there yet. */
    create: boolean;
    /** `If-Match`: only over this version. */
    version?: string;
}

/** `current` is the version of the file that is there now, `null` when nothing is. */
export function checkPreconditions(rel: string, current: string | null, { create, version }: Preconditions): void {
    if (create && current !== null) {
        throw conflict(`${rel} already exists`, reasoned('exists' satisfies FsErrorReason, { path: rel }));
    }

    if (version !== undefined && current !== version) {
        throw conflict(
            `${rel} changed on disk`,
            reasoned('version' satisfies FsErrorReason, { path: rel, currentVersion: current })
        );
    }
}

const versionAt = (stat: BigIntStats | undefined) => (stat?.isFile() ? versionOf(stat) : null);

/**
 * Replaces the file at `real` (or makes it) with `bytes`, atomically enough that a crash leaves the old file or the new one: the bytes go to a
 * temp file in the same folder, are flushed, and the temp file is renamed over the target, which keeps the mode of the file it replaces.
 * The preconditions are checked once more right before the rename, so the window in which another process can slip a change in is the time
 * between that check and the rename; a write that loses that race overwrites it (a lock cannot reach a process outside the daemon).
 * Answers the version of the file written.
 */
export async function writeFileAtomically(
    real: string,
    rel: string,
    bytes: Uint8Array,
    existing: BigIntStats | undefined,
    preconditions: Preconditions
): Promise<string> {
    if (existing) {
        await access(real, constants.W_OK).catch(() => {
            throw invalid(`${rel} is read only`, reasoned('permission', { path: rel }));
        });
    }

    const mode = existing ? Number(existing.mode) & 0o7777 : 0o666;
    const temp = join(dirname(real), transientName('tmp'));
    const handle = await open(temp, 'wx', mode);

    try {
        try {
            await handle.writeFile(bytes);

            if (existing) {
                // The mode given to `open` went through the umask; the file this replaces keeps its own.
                await handle.chmod(mode);
            }

            await handle.sync();
        } finally {
            await handle.close();
        }

        // The rename keeps size and modification time, so this is the version the file has once it is in place.
        const version = versionOf(await lstat(temp, { bigint: true }));

        checkPreconditions(rel, versionAt(await lstat(real, { bigint: true }).catch(() => undefined)), preconditions);
        await rename(temp, real);

        return version;
    } catch (error) {
        await rm(temp, { force: true });
        throw error;
    }
}
