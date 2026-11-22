import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { layoutRipgrep, RG_ARCHIVES, RG_VERSION, rgExecutable, rgUrl, ripgrepLaidOut } from './ripgrep';

import type { RuntimeTarget } from './bun-runtime';

const TARGETS: RuntimeTarget[] = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64'];

describe('the pinned archives', () => {
    test('cover every target the app ships for, and no other', () => {
        expect(Object.keys(RG_ARCHIVES).sort()).toEqual([...TARGETS].sort());
    });

    test('each is a SHA-256 of 64 hex digits, and no two share a file or a hash', () => {
        const archives = Object.values(RG_ARCHIVES);

        for (const { sha256 } of archives) expect(sha256).toMatch(/^[0-9a-f]{64}$/);

        expect(new Set(archives.map(({ file }) => file)).size).toBe(TARGETS.length);
        expect(new Set(archives.map(({ sha256 }) => sha256)).size).toBe(TARGETS.length);
    });

    test('are the release builds of the pinned version for the target\'s own platform and architecture', () => {
        expect(RG_ARCHIVES['darwin-arm64'].file).toBe(`ripgrep-${ RG_VERSION }-aarch64-apple-darwin.tar.gz`);
        expect(RG_ARCHIVES['darwin-x64'].file).toBe(`ripgrep-${ RG_VERSION }-x86_64-apple-darwin.tar.gz`);
        // The MSVC builds carry their C runtime, so they run without a redistributable; the GNU ones need MinGW's DLLs.
        expect(RG_ARCHIVES['win32-x64'].file).toBe(`ripgrep-${ RG_VERSION }-x86_64-pc-windows-msvc.zip`);
        expect(RG_ARCHIVES['win32-arm64'].file).toBe(`ripgrep-${ RG_VERSION }-aarch64-pc-windows-msvc.zip`);
    });

    test('are downloaded from the release of the pinned version', () => {
        expect(rgUrl('darwin-arm64')).toBe(`https://github.com/BurntSushi/ripgrep/releases/download/${ RG_VERSION }/ripgrep-${ RG_VERSION }-aarch64-apple-darwin.tar.gz`);
        expect(rgUrl('win32-x64')).toBe(`https://github.com/BurntSushi/ripgrep/releases/download/${ RG_VERSION }/ripgrep-${ RG_VERSION }-x86_64-pc-windows-msvc.zip`);
    });
});

test('the executable is rg.exe on Windows and rg elsewhere', () => {
    expect(TARGETS.map(rgExecutable)).toEqual(['rg', 'rg', 'rg.exe', 'rg.exe']);
});

describe('laying ripgrep out', () => {
    let root: string;
    let unpacked: string;
    let out: string;

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'clowdy-rg-layout-'));
        unpacked = path.join(root, 'unpacked');
        out = path.join(root, 'runtime/darwin-arm64');
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    /** What an archive holds: a folder named after it with the executable, the licences, and what the app leaves behind. */
    const unpack = async (exe: string) => {
        const folder = path.join(unpacked, `ripgrep-${ RG_VERSION }-some-target`);

        await mkdir(path.join(folder, 'doc'), { recursive: true });
        await mkdir(path.join(folder, 'complete'), { recursive: true });
        await writeFile(path.join(folder, exe), 'rg');
        await writeFile(path.join(folder, 'COPYING'), 'dual-licensed');
        await writeFile(path.join(folder, 'LICENSE-MIT'), 'MIT');
        await writeFile(path.join(folder, 'UNLICENSE'), 'Unlicense');
        await writeFile(path.join(folder, 'README.md'), 'readme');
        await writeFile(path.join(folder, 'doc/rg.1'), 'man');
        await writeFile(path.join(folder, 'complete/_rg'), 'completion');
    };

    test('keeps the executable, the licences, and the version, and leaves the rest of the archive', async () => {
        await unpack('rg');
        await layoutRipgrep(unpacked, out, 'darwin-arm64');

        expect((await readdir(out)).sort()).toEqual(['RG_VERSION', 'ripgrep-COPYING', 'ripgrep-LICENSE-MIT', 'ripgrep-UNLICENSE', 'rg'].sort());
        expect(await readFile(path.join(out, 'rg'), 'utf8')).toBe('rg');
        expect(await readFile(path.join(out, 'ripgrep-LICENSE-MIT'), 'utf8')).toBe('MIT');
        expect(await readFile(path.join(out, 'RG_VERSION'), 'utf8')).toBe(`${ RG_VERSION }\n`);

        // Windows has no executable bit.
        if (process.platform !== 'win32') expect((await stat(path.join(out, 'rg'))).mode & 0o111).not.toBe(0);
    });

    test('names the executable rg.exe for a Windows target', async () => {
        await unpack('rg.exe');
        await layoutRipgrep(unpacked, out, 'win32-x64');

        expect(await readFile(path.join(out, 'rg.exe'), 'utf8')).toBe('rg');
    });

    test('lays out beside what is there, which stays', async () => {
        await mkdir(out, { recursive: true });
        await writeFile(path.join(out, 'bun'), 'bun');
        await writeFile(path.join(out, 'VERSION'), '1.4.4\n');
        await unpack('rg');
        await layoutRipgrep(unpacked, out, 'darwin-arm64');

        expect(await readFile(path.join(out, 'bun'), 'utf8')).toBe('bun');
        expect(await readFile(path.join(out, 'VERSION'), 'utf8')).toBe('1.4.4\n');
    });

    test('refuses an empty archive and a folder without the executable, and records no version for them', async () => {
        await mkdir(unpacked, { recursive: true });
        await expect(layoutRipgrep(unpacked, out, 'darwin-arm64')).rejects.toThrow('is empty');

        await unpack('rg.exe');
        await expect(layoutRipgrep(unpacked, out, 'darwin-arm64')).rejects.toThrow();
        expect(await ripgrepLaidOut(out, 'darwin-arm64')).toBe(false);
    });

    describe('ripgrepLaidOut', () => {
        test('is false for a folder without it, and true once it is laid out', async () => {
            await mkdir(out, { recursive: true });
            expect(await ripgrepLaidOut(out, 'darwin-arm64')).toBe(false);

            await unpack('rg');
            await layoutRipgrep(unpacked, out, 'darwin-arm64');
            expect(await ripgrepLaidOut(out, 'darwin-arm64')).toBe(true);
        });

        test('is false for another version, so a raised pin fetches again', async () => {
            await unpack('rg');
            await layoutRipgrep(unpacked, out, 'darwin-arm64');
            await writeFile(path.join(out, 'RG_VERSION'), '14.1.1\n');

            expect(await ripgrepLaidOut(out, 'darwin-arm64')).toBe(false);
        });

        test('is false when the executable is gone, or belongs to the other platform', async () => {
            await unpack('rg');
            await layoutRipgrep(unpacked, out, 'darwin-arm64');

            expect(await ripgrepLaidOut(out, 'win32-x64')).toBe(false);

            await rm(path.join(out, 'rg'));
            expect(await ripgrepLaidOut(out, 'darwin-arm64')).toBe(false);
        });
    });
});
