import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { daemonHoldsLock } from './daemonFiles';

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
