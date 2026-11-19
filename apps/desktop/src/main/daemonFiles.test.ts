import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { daemonHoldsLock, restoreDatabase } from './daemonFiles';

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'clowdy-data-'));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('daemonHoldsLock', () => {
    test('is true for a live owner, false for a dead one, garbage, or no lock', async () => {
        const lock = (text: string) => writeFile(path.join(dir, 'daemon.lock'), text);

        await expect(daemonHoldsLock(dir)).resolves.toBe(false);

        await lock(String(process.pid));
        await expect(daemonHoldsLock(dir)).resolves.toBe(true);

        await lock('2147483646');
        await expect(daemonHoldsLock(dir)).resolves.toBe(false);

        await lock('garbage');
        await expect(daemonHoldsLock(dir)).resolves.toBe(false);
    });
});

describe('restoreDatabase', () => {
    const write = (name: string, text: string) => writeFile(path.join(dir, name), text);
    const read = (name: string) => readFile(path.join(dir, name), 'utf8');
    const since = () => Date.now() - 5000;

    test('puts back the backup a migration wrote since then, without the migrated write-ahead log', async () => {
        await write('clowdy.db', 'v4');
        await write('clowdy.db-wal', 'v4 pages');
        await write('clowdy.db-shm', 'index');
        await write('clowdy.db.bak-v3', 'v3');

        await expect(restoreDatabase(dir, since())).resolves.toBe('clowdy.db.bak-v3');
        expect(await read('clowdy.db')).toBe('v3');
        expect((await readdir(dir)).sort()).toEqual(['clowdy.db', 'clowdy.db.bak-v3']);
    });

    test('takes the oldest schema when daemons migrated in turn', async () => {
        await write('clowdy.db', 'v5');
        await write('clowdy.db.bak-v3', 'v3');
        await write('clowdy.db.bak-v4', 'v4');

        await expect(restoreDatabase(dir, since())).resolves.toBe('clowdy.db.bak-v3');
        expect(await read('clowdy.db')).toBe('v3');
    });

    test('a backup that cannot be copied leaves the migrated database with its log', async () => {
        await write('clowdy.db', 'v4');
        await write('clowdy.db-wal', 'v4 pages');
        await write('clowdy.db.bak-v3', 'v3');
        // Where the copy goes is taken, so the copy fails.
        await mkdir(path.join(dir, 'clowdy.db.restoring'));

        await expect(restoreDatabase(dir, since())).rejects.toThrow();
        expect(await read('clowdy.db')).toBe('v4');
        expect(await read('clowdy.db-wal')).toBe('v4 pages');
    });

    test('leaves the database alone when no backup is that recent', async () => {
        const hourAgo = new Date(Date.now() - 3_600_000);

        await write('clowdy.db', 'v4');
        await write('clowdy.db-wal', 'pages');
        await write('clowdy.db.bak-v3', 'v3');
        await utimes(path.join(dir, 'clowdy.db.bak-v3'), hourAgo, hourAgo);

        await expect(restoreDatabase(dir, since())).resolves.toBeUndefined();
        expect(await read('clowdy.db')).toBe('v4');
        expect(await read('clowdy.db-wal')).toBe('pages');
    });
});
