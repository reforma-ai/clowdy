import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Whether a live process holds the daemon's lock (`apps/daemon/src/instance.ts`: `daemon.lock` names its pid): a daemon
 * runs, even one that does not answer its health check yet.
 */
export async function daemonHoldsLock(dataDir: string): Promise<boolean> {
    const pid = Number.parseInt(await readFile(path.join(dataDir, 'daemon.lock'), 'utf8').catch(() => ''), 10);

    if (!Number.isSafeInteger(pid) || pid <= 0) return false;

    try {
        process.kill(pid, 0);

        return true;
    }
    catch (error) {
        // EPERM: the process exists but belongs to someone else.
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}
