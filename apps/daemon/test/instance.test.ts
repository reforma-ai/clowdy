import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

import { startDaemon } from '../src/daemon';
import { AlreadyRunningError, acquireLock, infoPath, lockPath } from '../src/instance';
import { cleanTempDirs, tempDir, testConfig } from './helpers';

afterAll(cleanTempDirs);

function deadPid(): number {
    const child = Bun.spawnSync(['true']);

    return child.pid;
}

describe('single-instance lock', () => {
    test('a second lock on the same directory fails and names the owner', () => {
        const dir = tempDir();
        const release = acquireLock(dir);

        expect(readFileSync(lockPath(dir), 'utf8')).toBe(String(process.pid));
        expect(() => acquireLock(dir)).toThrow(AlreadyRunningError);
        expect(() => acquireLock(dir)).toThrow(String(process.pid));

        release();
        expect(existsSync(lockPath(dir))).toBe(false);
        acquireLock(dir)();
    });

    test('a lock whose process is dead is taken over', () => {
        const dir = tempDir();

        mkdirSync(dir, { recursive: true });
        writeFileSync(lockPath(dir), String(deadPid()));

        const release = acquireLock(dir);

        expect(readFileSync(lockPath(dir), 'utf8')).toBe(String(process.pid));
        release();
    });

    test('a garbage lock file counts as stale', () => {
        const dir = tempDir();

        writeFileSync(lockPath(dir), 'not a pid');
        acquireLock(dir)();
    });
});

describe('daemon lifecycle', () => {
    test('writes daemon.json (0600) and the lock, and removes both on stop', async () => {
        const config = testConfig();
        const daemon = await startDaemon(config);
        const info = JSON.parse(readFileSync(infoPath(config.dataDir), 'utf8'));

        expect(info).toEqual({
            pid: process.pid,
            port: daemon.info.port,
            token: 'test-token',
            protocol: 1,
            startedAt: daemon.info.startedAt,
        });
        expect(daemon.info.port).toBeGreaterThan(0);

        if (process.platform !== 'win32') {
            expect(statSync(infoPath(config.dataDir)).mode & 0o777).toBe(0o600);
        }

        expect(existsSync(lockPath(config.dataDir))).toBe(true);

        await daemon.stop();
        expect(existsSync(infoPath(config.dataDir))).toBe(false);
        expect(existsSync(lockPath(config.dataDir))).toBe(false);
    });

    test('a second daemon on the same data directory refuses to start and leaves the first intact', async () => {
        const config = testConfig();
        const first = await startDaemon(config);

        await expect(startDaemon(config)).rejects.toThrow(AlreadyRunningError);
        expect(existsSync(lockPath(config.dataDir))).toBe(true);
        expect((await fetch(`http://127.0.0.1:${first.info.port}/v1/health`)).status).toBe(200);

        await first.stop();
    });

    test('binds the loopback interface only', async () => {
        const daemon = await startDaemon(testConfig());
        const external = Object.values(networkInterfaces())
            .flat()
            .find(address => address?.family === 'IPv4' && !address.internal)?.address;

        expect((await fetch(`http://127.0.0.1:${daemon.info.port}/v1/health`)).status).toBe(200);

        if (external) {
            await expect(fetch(`http://${external}:${daemon.info.port}/v1/health`)).rejects.toThrow();
        }

        await daemon.stop();
    });
});
