import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import type { DaemonInfo } from '@clowdy/protocol';

export class AlreadyRunningError extends Error {
    constructor(readonly pid: number, readonly dataDir: string) {
        super(`A Clowdy daemon is already running on ${ dataDir } (pid ${ pid }). Stop it first, or use another CLOWDY_DATA_DIR.`);
    }
}

export const lockPath = (dataDir: string) => join(dataDir, 'daemon.lock');
export const infoPath = (dataDir: string) => join(dataDir, 'daemon.json');

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);

        return true;
    }
    catch (error) {
        // EPERM: the process exists but belongs to someone else.
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

function readPid(path: string): number {
    return Number.parseInt(readFileSync(path, 'utf8'), 10);
}

/**
 * Takes the single-instance lock of a data directory: a file holding the owner's pid. A lock whose process is
 * gone is taken over; a live one throws `AlreadyRunningError`. Returns the function that releases the lock.
 */
export function acquireLock(dataDir: string): () => void {
    const path = lockPath(dataDir);

    mkdirSync(dataDir, { recursive: true });

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const fd = openSync(path, 'wx');

            writeSync(fd, String(process.pid));
            closeSync(fd);

            return () => {
                if (readPidSafely(path) === process.pid) {
                    rmSync(path, { force: true });
                }
            };
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }
        }

        const owner = readPidSafely(path);

        if (owner !== undefined && Number.isInteger(owner) && owner > 0 && isAlive(owner)) {
            throw new AlreadyRunningError(owner, dataDir);
        }

        // Stale: the owner died without cleaning up (or the file is unreadable garbage). Take over and retry.
        rmSync(path, { force: true });
    }

    throw new Error(`Could not take the lock ${ path }`);
}

function readPidSafely(path: string): number | undefined {
    try {
        return readPid(path);
    }
    catch {
        return undefined;
    }
}

/** Writes `daemon.json` (mode 0600) so clients can find this daemon. Returns the function that removes it. */
export function writeDaemonInfo(dataDir: string, info: DaemonInfo): () => void {
    const path = infoPath(dataDir);
    const temp = `${ path }.${ process.pid }.tmp`;

    writeFileSync(temp, JSON.stringify(info, null, 4), { mode: 0o600 });
    renameSync(temp, path);

    return () => {
        try {
            if ((JSON.parse(readFileSync(path, 'utf8')) as DaemonInfo).pid === info.pid) {
                rmSync(path, { force: true });
            }
        }
        catch {
            // already gone
        }
    };
}
