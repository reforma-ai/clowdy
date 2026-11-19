import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { bundleRuntime, installBun, installOwnBundle, parseBundleInfo, pruneBunCopies, updatesDir } from './bundle';

const BUNDLE = { version: 412, minShell: '0.1.0', protocol: 1 };

describe('parseBundleInfo', () => {
    test('reads a bundle.json', () => {
        expect(parseBundleInfo(JSON.stringify(BUNDLE))).toEqual(BUNDLE);
    });

    test('refuses one that does not describe a bundle', () => {
        expect(() => parseBundleInfo(JSON.stringify({ ...BUNDLE, version: 0 }))).toThrow();
        expect(() => parseBundleInfo(JSON.stringify({ ...BUNDLE, minShell: 1 }))).toThrow();
        expect(() => parseBundleInfo(JSON.stringify({ version: 1, minShell: '0.1.0' }))).toThrow();
    });
});

test('updatesDir sits beside the daemon data folder', () => {
    expect(updatesDir(path.join('/data', 'Clowdy', 'daemon'))).toBe(path.join('/data', 'Clowdy', 'updates'));
});

describe('installBun and installOwnBundle', () => {
    let root: string;
    let resources: string;
    let updates: string;

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'clowdy-bundle-'));
        resources = path.join(root, 'Resources');
        updates = path.join(root, 'updates');
        await mkdir(path.join(resources, 'bun'), { recursive: true });
        await mkdir(path.join(resources, 'bundle/daemon'), { recursive: true });
        await mkdir(path.join(resources, 'bundle/system-skills'), { recursive: true });
        await writeFile(path.join(resources, 'bun/bun'), 'bun');
        await writeFile(path.join(resources, 'bun/VERSION'), '1.4.4\n');
        await writeFile(path.join(resources, 'bundle/daemon/main.js'), 'daemon');
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    const installRuntime = async ({ platform, arch }: { platform: NodeJS.Platform; arch: string }) =>
        bundleRuntime(await installBun({ resources, updates, platform, arch }), await installOwnBundle({ resources, updates, version: BUNDLE.version }));

    test('runs the daemon from copies outside the install folder', async () => {
        const runtime = await installRuntime({ platform: 'darwin', arch: 'arm64' });

        expect(runtime).toEqual({
            bun: path.join(updates, 'bun/1.4.4-arm64/bun'),
            entry: path.join(updates, 'bundles/412/daemon/main.js'),
            skillsDir: path.join(updates, 'bundles/412/system-skills'),
        });
        expect(await readFile(runtime.entry, 'utf8')).toBe('daemon');
        expect((await stat(runtime.bun)).mode & 0o111).not.toBe(0);
    });

    test('reuses copies that exist, so a running daemon keeps its files', async () => {
        await installRuntime({ platform: 'darwin', arch: 'arm64' });
        await writeFile(path.join(resources, 'bundle/daemon/main.js'), 'changed');

        const runtime = await installRuntime({ platform: 'darwin', arch: 'arm64' });

        expect(await readFile(runtime.entry, 'utf8')).toBe('daemon');
    });

    // An unreadable file stops the copy halfway; root reads it anyway, and Windows has no such mode.
    test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('leaves no partial copy behind when copying fails, so the next start copies again', async () => {
        await writeFile(path.join(resources, 'bundle/daemon/unreadable.js'), '', { mode: 0o000 });

        await expect(installRuntime({ platform: 'darwin', arch: 'arm64' })).rejects.toThrow();
        expect(await readdir(path.join(updates, 'bundles'))).toEqual([]);

        await rm(path.join(resources, 'bundle/daemon/unreadable.js'));

        const runtime = await installRuntime({ platform: 'darwin', arch: 'arm64' });

        expect(await readFile(runtime.entry, 'utf8')).toBe('daemon');
    });

    test('names bun.exe on Windows', async () => {
        await writeFile(path.join(resources, 'bun/bun.exe'), 'bun');

        expect((await installRuntime({ platform: 'win32', arch: 'x64' })).bun).toBe(path.join(updates, 'bun/1.4.4-x64/bun.exe'));
    });
});

describe('pruneBunCopies', () => {
    let updates: string;

    beforeEach(async () => {
        updates = await mkdtemp(path.join(tmpdir(), 'clowdy-bun-'));
    });

    afterEach(async () => {
        await rm(updates, { recursive: true, force: true });
    });

    test('keeps only the copy of the Bun in use', async () => {
        for (const dir of ['1.4.4-arm64', '1.5.0-arm64', '1.5.0-arm64.tmp-ab12']) await mkdir(path.join(updates, 'bun', dir), { recursive: true });

        await pruneBunCopies(updates, path.join(updates, 'bun/1.5.0-arm64/bun'));

        expect(await readdir(path.join(updates, 'bun'))).toEqual(['1.5.0-arm64']);
    });

    test('does nothing without copies', async () => {
        await expect(pruneBunCopies(updates, path.join(updates, 'bun/1.5.0-arm64/bun'))).resolves.toBeUndefined();
    });
});
