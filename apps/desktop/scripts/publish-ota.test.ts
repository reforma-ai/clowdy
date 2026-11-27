import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { PROTOCOL_VERSION } from '@clowdy/protocol';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { sha256, signManifest } from '../src/main/bundleManifest';
import { writeTar } from '../src/main/tar';
import { decideOta, shellChangedSince, verifyBootstrap } from './publish-ota';

import type { Release } from './github';

const release = (tagName: string, flags: Partial<Release> = {}): Release => ({
    tagName,
    isDraft: false,
    isPrerelease: false,
    ...flags,
});
const BUNDLE = { version: 412, minShell: '0.2.0', protocol: 1 };
const RELEASES = [release('v0.1.0'), release('v0.2.0'), release('ota', { isPrerelease: true })];

describe('decideOta', () => {
    test('publishes a newer bundle for a released, unchanged shell', () => {
        expect(decideOta({ bundle: BUNDLE, releases: RELEASES, shellChanged: false, published: 411 }).decision).toBe(
            'publish'
        );
        expect(decideOta({ bundle: BUNDLE, releases: RELEASES, shellChanged: false, published: null }).decision).toBe(
            'publish'
        );
    });

    test('waits for the first shell release', () => {
        expect(decideOta({ bundle: BUNDLE, releases: [], shellChanged: undefined, published: null }).decision).toBe(
            'skip'
        );
    });

    test('waits while the shell it needs is not released', () => {
        const result = decideOta({
            bundle: { ...BUNDLE, minShell: '0.3.0' },
            releases: RELEASES,
            shellChanged: undefined,
            published: 400,
        });

        expect(result).toMatchObject({ decision: 'skip' });
        expect(result.reason).toContain('0.3.0');
    });

    test('waits when the shell changed since its release without a new version', () => {
        expect(decideOta({ bundle: BUNDLE, releases: RELEASES, shellChanged: true, published: 400 }).reason).toContain(
            'raise its version'
        );
    });

    test('skips a bundle that is not newer than the published one', () => {
        expect(decideOta({ bundle: BUNDLE, releases: RELEASES, shellChanged: false, published: 412 }).decision).toBe(
            'skip'
        );
        expect(decideOta({ bundle: BUNDLE, releases: RELEASES, shellChanged: false, published: 500 }).decision).toBe(
            'skip'
        );
    });
});

describe('bootstrap artifact verification', () => {
    let dir = '';
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const files = [
        'renderer/index.html',
        'daemon/main.js',
        'daemon/mcp-stdio.js',
        'daemon/clowdy.js',
        'system-skills/.claude-plugin/plugin.json',
        'system-skills/skills/orchestrate/SKILL.md',
    ];

    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), 'clowdy-bootstrap-'));
        const entries = files.map(file => ({ path: file, data: Buffer.from(file) }));
        const archive = gzipSync(writeTar(entries));
        const manifest = {
            version: 1,
            minShell: '0.1.3',
            protocol: PROTOCOL_VERSION,
            archive: { name: 'bundle-1.tar.gz', size: archive.length, sha256: sha256(archive) },
            files: Object.fromEntries(
                entries.map(entry => [entry.path, { size: entry.data.length, sha256: sha256(entry.data) }])
            ),
        };
        writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(signManifest(manifest, privateKey)));
        writeFileSync(path.join(dir, 'bundle-1.tar.gz'), archive);
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    test('accepts a complete signed compatible archive', async () => {
        await expect(verifyBootstrap(dir, publicKey, '0.1.3')).resolves.toBe('bundle-1.tar.gz');
    });
    test('rejects an archive changed after signing', async () => {
        writeFileSync(path.join(dir, 'bundle-1.tar.gz'), 'wrong');
        await expect(verifyBootstrap(dir, publicKey, '0.1.3')).rejects.toThrow();
    });
    test('rejects an incompatible shell', async () => {
        await expect(verifyBootstrap(dir, publicKey, '0.1.4')).rejects.toThrow();
    });
    test('rejects a different public key', async () => {
        const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
        await expect(verifyBootstrap(dir, other, '0.1.3')).rejects.toThrow();
    });
    test('rejects a correctly signed manifest missing a required file', async () => {
        const signed = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { body: string };
        const manifest = JSON.parse(signed.body);
        delete manifest.files['daemon/main.js'];
        writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(signManifest(manifest, privateKey)));
        await expect(verifyBootstrap(dir, publicKey, '0.1.3')).rejects.toThrow();
    });
});

describe('shellChangedSince', () => {
    let dir = '';
    // The person's own config may sign commits or run hooks.
    const git = (...args: string[]) =>
        execFileSync(
            'git',
            [
                '-c',
                'user.name=Test',
                '-c',
                'user.email=test@example.com',
                '-c',
                'commit.gpgSign=false',
                '-c',
                'tag.gpgSign=false',
                '-c',
                'core.hooksPath=/dev/null',
                ...args,
            ],
            { cwd: dir, stdio: 'pipe' }
        );
    const commit = (files: Record<string, string>) => {
        for (const [file, content] of Object.entries(files)) {
            mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
            writeFileSync(path.join(dir, file), content);
        }

        git('add', '-A');
        git('commit', '-q', '-m', 'change');
    };

    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), 'clowdy-shell-'));
        git('init', '-q');
        commit({
            'package.json': JSON.stringify({ packageManager: 'bun@1.3.0' }),
            'packages/protocol/src/api.ts': 'export const PROTOCOL_VERSION = 1;\n',
            'apps/desktop/src/main/index.ts': 'main',
            'apps/desktop/src/renderer/main.tsx': 'renderer',
            'bun.lock':
                '    "node-api-headers": ["node-api-headers@1.9.0", "hash-a"],\n    "renderer": ["renderer@1"],\n',
        });
        git('tag', 'v0.2.0');
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test('is undefined without the release tag', async () => {
        expect(await shellChangedSince('v0.3.0', dir)).toBeUndefined();
    });

    test('ignores what only a bundle carries, protocol and root manifest included', async () => {
        commit({
            'apps/desktop/src/renderer/main.tsx': 'renderer 2',
            'bun.lock':
                '    "node-api-headers": ["node-api-headers@1.9.0", "hash-a"],\n    "renderer": ["renderer@2"],\n',
            'packages/protocol/src/api.ts': 'export const PROTOCOL_VERSION = 1;\nexport const ROUTES = {};\n',
            'package.json': JSON.stringify({ packageManager: 'bun@1.3.0', scripts: { dev: 'dev' } }),
        });

        expect(await shellChangedSince('v0.2.0', dir)).toBe(false);
    });

    test.each([
        ['the native headers', { 'bun.lock': '    "node-api-headers": ["node-api-headers@1.9.0", "hash-b"],\n' }],
        ['the main process', { 'apps/desktop/src/main/index.ts': 'main 2' }],
        ['the daemon data folder', { 'packages/protocol/src/paths.ts': 'paths' }],
        ['the Bun it ships', { 'package.json': JSON.stringify({ packageManager: 'bun@1.3.1' }) }],
        ['the protocol', { 'packages/protocol/src/api.ts': 'export const PROTOCOL_VERSION = 2;\n' }],
    ])('sees a change to %s', async (_, files) => {
        commit(files);

        expect(await shellChangedSince('v0.2.0', dir)).toBe(true);
    });

    test('refuses to guess when PROTOCOL_VERSION moved', async () => {
        commit({ 'packages/protocol/src/api.ts': 'export { PROTOCOL_VERSION } from "./version";\n' });

        await expect(shellChangedSince('v0.2.0', dir)).rejects.toThrow('No PROTOCOL_VERSION');
    });
});
