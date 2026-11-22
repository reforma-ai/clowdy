import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { bundleRuntime, installBun, installedRipgrep, installOwnBundle, parseBundleInfo, pruneBunCopies, RG_VERSION_FILE, updatesDir } from './bundle';

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

        // Windows has no executable bit.
        if (process.platform !== 'win32') expect((await stat(runtime.bun)).mode & 0o111).not.toBe(0);
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

describe('the ripgrep beside Bun', () => {
    let root: string;
    let resources: string;
    let updates: string;

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'clowdy-rg-'));
        resources = path.join(root, 'Resources');
        updates = path.join(root, 'updates');
        await mkdir(path.join(resources, 'bun'), { recursive: true });
        await writeFile(path.join(resources, 'bun/bun'), 'bun');
        await writeFile(path.join(resources, 'bun/bun.exe'), 'bun');
        await writeFile(path.join(resources, 'bun/VERSION'), '1.4.4\n');
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    const shipRipgrep = async (version: string) => {
        await writeFile(path.join(resources, 'bun/rg'), `rg ${ version }`);
        await writeFile(path.join(resources, 'bun/rg.exe'), `rg ${ version }`);
        await writeFile(path.join(resources, 'bun', RG_VERSION_FILE), `${ version }\n`);
    };

    test('is copied with Bun into a folder that names both versions, and handed to the daemon', async () => {
        await shipRipgrep('15.2.0');

        const bun = await installBun({ resources, updates, platform: 'darwin', arch: 'arm64' });
        const rg = await installedRipgrep(bun, 'darwin');

        expect(bun).toBe(path.join(updates, 'bun/1.4.4-rg15.2.0-arm64/bun'));
        expect(rg).toBe(path.join(updates, 'bun/1.4.4-rg15.2.0-arm64/rg'));
        expect(await readFile(rg!, 'utf8')).toBe('rg 15.2.0');
        expect(bundleRuntime(bun, path.join(updates, 'bundles/412'), rg)).toEqual({
            bun,
            entry: path.join(updates, 'bundles/412/daemon/main.js'),
            skillsDir: path.join(updates, 'bundles/412/system-skills'),
            rg,
        });

        // Windows has no executable bit.
        if (process.platform !== 'win32') expect((await stat(rg!)).mode & 0o111).not.toBe(0);
    });

    test('is rg.exe on Windows', async () => {
        await shipRipgrep('15.2.0');

        const bun = await installBun({ resources, updates, platform: 'win32', arch: 'x64' });

        expect(bun).toBe(path.join(updates, 'bun/1.4.4-rg15.2.0-x64/bun.exe'));
        expect(await installedRipgrep(bun, 'win32')).toBe(path.join(updates, 'bun/1.4.4-rg15.2.0-x64/rg.exe'));
    });

    test('is not handed over when the runtime has none, and the daemon starts without it', async () => {
        const bun = await installBun({ resources, updates, platform: 'darwin', arch: 'arm64' });

        expect(bun).toBe(path.join(updates, 'bun/1.4.4-arm64/bun'));
        expect(await installedRipgrep(bun, 'darwin')).toBeUndefined();
        expect(bundleRuntime(bun, path.join(updates, 'bundles/412'), undefined)).not.toHaveProperty('rg');
    });

    test('a shell that ships it does not reuse the copy of an older one without it, which a running daemon keeps', async () => {
        const older = await installBun({ resources, updates, platform: 'darwin', arch: 'arm64' });

        await shipRipgrep('15.2.0');

        const bun = await installBun({ resources, updates, platform: 'darwin', arch: 'arm64' });

        expect(bun).not.toBe(older);
        expect(await installedRipgrep(bun, 'darwin')).toBeDefined();
        expect(await installedRipgrep(older, 'darwin')).toBeUndefined();
        expect(await readFile(older, 'utf8')).toBe('bun');
    });

    test('a newer ripgrep with the same Bun is a new copy, and the same one is reused', async () => {
        await shipRipgrep('15.2.0');

        const first = await installBun({ resources, updates, platform: 'darwin', arch: 'arm64' });

        await writeFile(path.join(resources, 'bun/rg'), 'changed');
        expect(await installBun({ resources, updates, platform: 'darwin', arch: 'arm64' })).toBe(first);
        expect(await readFile((await installedRipgrep(first, 'darwin'))!, 'utf8')).toBe('rg 15.2.0');

        await shipRipgrep('15.3.0');

        const next = await installBun({ resources, updates, platform: 'darwin', arch: 'arm64' });

        expect(next).toBe(path.join(updates, 'bun/1.4.4-rg15.3.0-arm64/bun'));
        expect(await readFile((await installedRipgrep(next, 'darwin'))!, 'utf8')).toBe('rg 15.3.0');
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

    test('keeps the copy that holds the ripgrep in use, and drops the older ones', async () => {
        for (const dir of ['1.4.4-arm64', '1.4.4-rg15.1.0-arm64', '1.4.4-rg15.2.0-arm64']) await mkdir(path.join(updates, 'bun', dir), { recursive: true });

        await pruneBunCopies(updates, path.join(updates, 'bun/1.4.4-rg15.2.0-arm64/bun'));

        expect(await readdir(path.join(updates, 'bun'))).toEqual(['1.4.4-rg15.2.0-arm64']);
    });

    test('does nothing without copies', async () => {
        await expect(pruneBunCopies(updates, path.join(updates, 'bun/1.5.0-arm64/bun'))).resolves.toBeUndefined();
    });
});
