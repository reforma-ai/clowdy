import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { checkShellListing, decideShell, newestShell, validateShellArtifacts } from './release-shell';

import type { Release } from './github';

const release = (tagName: string, flags: Partial<Release> = {}): Release => ({
    tagName,
    isDraft: false,
    isPrerelease: false,
    ...flags,
});

describe('shell archive contents', () => {
    const windows =
        'Path = Clowdy.exe\nSize = 15\n\nPath = resources/app.asar\nSize = 12\n\nPath = resources/bun/bun.exe\nSize = 42\n\nPath = resources/bun/rg.exe\nSize = 23\n';
    const mac =
        'Path = Clowdy.app/Contents/MacOS/Clowdy\nSize = 15\n\nPath = Clowdy.app/Contents/Resources/app.asar\nSize = 12\n\nPath = Clowdy.app/Contents/Resources/bun/bun\nSize = 42\n\nPath = Clowdy.app/Contents/Resources/bun/rg\nSize = 23\n';
    test('accepts required runtime files on each platform', () => {
        expect(() => checkShellListing(windows, 'win')).not.toThrow();
        expect(() => checkShellListing(mac, 'mac')).not.toThrow();
    });
    test('rejects a structurally valid archive missing the app', () => {
        expect(() =>
            checkShellListing(windows.replace('Path = resources/app.asar', 'Path = unrelated'), 'win')
        ).toThrow();
    });
    test('rejects an empty runtime file', () => {
        expect(() => checkShellListing(mac.replace('Size = 23', 'Size = 0'), 'mac')).toThrow();
    });
    test('checks the application and runtime under the same disk image folder', () => {
        const dmg = mac.replaceAll('Path = Clowdy.app', 'Path = Clowdy 0.1.3-arm64/Clowdy.app');
        expect(() => checkShellListing(dmg, 'mac-dmg')).not.toThrow();
        expect(() => checkShellListing(dmg.replace('MacOS/Clowdy', 'MacOS/missing'), 'mac-dmg')).toThrow();
        expect(() =>
            checkShellListing(
                dmg.replace(
                    '0.1.3-arm64/Clowdy.app/Contents/Resources/bun/rg',
                    'other/Clowdy.app/Contents/Resources/bun/rg'
                ),
                'mac-dmg'
            )
        ).toThrow();
    });
});

describe('release artifact validation', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), 'clowdy-release-'));
        const dmg = Buffer.alloc(512);
        dmg.write('koly');
        for (const name of ['Clowdy-arm64.dmg', 'Clowdy-x64.dmg']) writeFileSync(path.join(dir, name), dmg);
        for (const name of ['Clowdy-0.1.3-arm64.zip', 'Clowdy-0.1.3-x64.zip'])
            writeFileSync(path.join(dir, name), Buffer.from('504b0304', 'hex'));
        for (const name of ['clowdy-0.1.3-x64.nsis.7z', 'clowdy-0.1.3-arm64.nsis.7z'])
            writeFileSync(path.join(dir, name), Buffer.from('377abcaf271c', 'hex'));
        writeFileSync(path.join(dir, 'Clowdy-Setup.exe'), 'MZ');
        const info = (bytes: Buffer) => ({
            size: bytes.length,
            sha512: createHash('sha512').update(bytes).digest('base64'),
        });
        const zip = info(Buffer.from('504b0304', 'hex'));
        const exe = info(Buffer.from('MZ'));
        const archive = info(Buffer.from('377abcaf271c', 'hex'));
        writeFileSync(
            path.join(dir, 'latest-mac.yml'),
            JSON.stringify({
                version: '0.1.3',
                files: ['arm64', 'x64'].map(arch => ({ url: `Clowdy-0.1.3-${arch}.zip`, ...zip })),
            })
        );
        writeFileSync(
            path.join(dir, 'latest.yml'),
            JSON.stringify({
                version: '0.1.3',
                files: [{ url: 'Clowdy-Setup.exe', sha512: exe.sha512 }],
                packages: {
                    x64: { path: 'clowdy-0.1.3-x64.nsis.7z', ...archive },
                    arm64: { path: 'clowdy-0.1.3-arm64.nsis.7z', ...archive },
                },
            })
        );
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    test('accepts the expected artifact types and feeds', async () => {
        await expect(validateShellArtifacts(dir, '0.1.3')).resolves.toBeUndefined();
    });
    test('rejects a missing architecture package', async () => {
        rmSync(path.join(dir, 'clowdy-0.1.3-arm64.nsis.7z'));
        await expect(validateShellArtifacts(dir, '0.1.3')).rejects.toThrow();
    });
    test('rejects a malformed installer', async () => {
        writeFileSync(path.join(dir, 'Clowdy-Setup.exe'), 'bad');
        await expect(validateShellArtifacts(dir, '0.1.3')).rejects.toThrow();
    });
    test('rejects a feed for another version', async () => {
        writeFileSync(path.join(dir, 'latest.yml'), 'version: 0.1.2\nsha512: abc\n');
        await expect(validateShellArtifacts(dir, '0.1.3')).rejects.toThrow();
    });
    test('rejects an altered archive even when its type is correct', async () => {
        writeFileSync(path.join(dir, 'clowdy-0.1.3-x64.nsis.7z'), Buffer.from('377abcaf271c00', 'hex'));
        await expect(validateShellArtifacts(dir, '0.1.3')).rejects.toThrow();
    });
});

describe('decideShell', () => {
    test('a raised version is released', () => {
        expect(decideShell({ version: '0.2.0', previous: '0.1.0', releases: [release('v0.1.0')] }).decision).toBe(
            'build'
        );
    });

    test('the first release needs no earlier one', () => {
        expect(decideShell({ version: '0.1.0', previous: '0.0.1', releases: [] }).decision).toBe('build');
    });

    test('a push that keeps the version releases nothing, even when that version is not out', () => {
        expect(decideShell({ version: '0.0.1', previous: '0.0.1', releases: [] }).decision).toBe('skip');
    });

    test('a manual run releases the current version when it is not out', () => {
        expect(decideShell({ version: '0.0.1', releases: [] }).decision).toBe('build');
    });

    test('a version that is out is never released again', () => {
        expect(decideShell({ version: '0.2.0', releases: [release('v0.2.0')] }).decision).toBe('skip');
        expect(decideShell({ version: '0.2.0', previous: '0.1.0', releases: [release('v0.2.0')] }).decision).toBe(
            'skip'
        );
    });

    test('a draft left by a failed run does not count as out', () => {
        expect(
            decideShell({ version: '0.2.0', releases: [release('v0.2.0', { isDraft: true }), release('v0.1.0')] })
                .decision
        ).toBe('build');
    });

    test('a version below the newest release fails', () => {
        expect(
            decideShell({ version: '0.1.5', previous: '0.1.4', releases: [release('v0.2.0'), release('v0.1.0')] })
                .decision
        ).toBe('fail');
    });

    test('OTA prereleases and other tags are not shell releases', () => {
        expect(
            decideShell({
                version: '0.1.0',
                releases: [release('ota', { isPrerelease: true }), release('v9.0.0', { isPrerelease: true })],
            }).decision
        ).toBe('build');
    });

    test('a version with a prerelease suffix fails', () => {
        expect(decideShell({ version: '0.2.0-beta.1', releases: [] }).decision).toBe('fail');
    });
});

test('newestShell counts published shell releases only, by version', () => {
    expect(
        newestShell([
            release('v0.3.0', { isDraft: true }),
            release('v0.4.0', { isPrerelease: true }),
            release('ota', { isPrerelease: true }),
            release('v0.2.0'),
            release('v0.10.0'),
        ])
    ).toBe('0.10.0');
    expect(newestShell([release('ota', { isPrerelease: true })])).toBeNull();
});
