import { copyFile, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { processAlive } from './daemonHost';

const DATABASE = 'clowdy.db';
/** What the daemon copies the database to before it migrates it (`apps/daemon/src/db/connection.ts`). */
const BACKUP = /^clowdy\.db\.bak-v(\d+)$/;

/**
 * Whether a live process holds the daemon's lock (`apps/daemon/src/instance.ts`: `daemon.lock` names its pid): a daemon
 * runs, even one that does not answer its health check yet.
 */
export async function daemonHoldsLock(dataDir: string): Promise<boolean> {
    const pid = Number.parseInt(await readFile(path.join(dataDir, 'daemon.lock'), 'utf8').catch(() => ''), 10);

    return Number.isSafeInteger(pid) && pid > 0 && processAlive(pid);
}

/**
 * Puts back the database a daemon migrated since `since` (a time in milliseconds): the backup it wrote first, of the
 * oldest schema if daemons migrated in turn. Its write-ahead log goes too, or SQLite would replay the migrated pages onto
 * the backup. The backup stays. Resolves to the backup's name, or undefined when nothing migrated since. Only while no
 * daemon runs (`daemonHoldsLock`).
 */
export async function restoreDatabase(dataDir: string, since: number): Promise<string | undefined> {
    const backups: Array<{ name: string; schema: number }> = [];

    for (const name of await readdir(dataDir).catch(() => [] as string[])) {
        const match = BACKUP.exec(name);

        if (match && (await stat(path.join(dataDir, name))).mtimeMs >= since) backups.push({ name, schema: Number(match[1]) });
    }

    const [oldest] = backups.sort((a, b) => a.schema - b.schema);

    if (!oldest) return undefined;

    const database = path.join(dataDir, DATABASE);

    // The copy first: when it fails, the migrated database still has its log.
    await copyFile(path.join(dataDir, oldest.name), `${ database }.restoring`);
    await rm(`${ database }-wal`, { force: true });
    await rm(`${ database }-shm`, { force: true });
    await rename(`${ database }.restoring`, database);

    return oldest.name;
}
