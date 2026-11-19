import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { hashFolder, isBundlePath, openManifest, parseManifest, sha256, signManifest, type BundleManifest } from './bundleManifest';

const key = () => {
    const pair = generateKeyPairSync('ed25519');

    return {
        privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
};
const HASH = 'a'.repeat(64);
const MANIFEST: BundleManifest = {
    version: 412,
    minShell: '0.2.0',
    protocol: 1,
    archive: { name: 'bundle-412.tar.gz', sha256: HASH, size: 10 },
    files: { 'renderer/index.html': { sha256: HASH, size: 3 }, 'daemon/main.js': { sha256: HASH, size: 4 } },
};

describe('bundle manifests', () => {
    test('open with the key that signed them', () => {
        const { privateKey, publicKey } = key();

        expect(openManifest(JSON.stringify(signManifest(MANIFEST, privateKey)), publicKey)).toEqual(MANIFEST);
    });

    test('refuse another key and a changed body', () => {
        const { privateKey, publicKey } = key();
        const signed = signManifest(MANIFEST, privateKey);

        expect(() => openManifest(JSON.stringify(signed), key().publicKey)).toThrow('not signed');

        const changed = { ...signed, body: signed.body.replace('"version":412', '"version":413') };

        expect(changed.body).not.toBe(signed.body);
        expect(() => openManifest(JSON.stringify(changed), publicKey)).toThrow('not signed');
    });

    test('refuse a malformed manifest', () => {
        const bad = (patch: object) => () => parseManifest(JSON.stringify({ ...MANIFEST, ...patch }));

        expect(bad({ version: 0 })).toThrow('malformed');
        expect(bad({ minShell: '0.2' })).toThrow('malformed');
        expect(bad({ archive: { ...MANIFEST.archive, name: '../x.tar.gz' } })).toThrow('malformed');
        expect(bad({ files: { '../escape.js': { sha256: HASH, size: 1 } } })).toThrow('malformed');
        expect(bad({ files: { 'renderer/a.js': { sha256: 'nothex', size: 1 } } })).toThrow('malformed');
    });

    test('paths stay inside the bundle on every OS', () => {
        expect(['renderer/index.html', 'daemon/main.js'].every(isBundlePath)).toBe(true);
        expect(['', '/etc/passwd', 'a/../b', 'a\\b', 'C:/x', 'a//b', './a', 'manifest.json', 'a\0b'].some(isBundlePath)).toBe(false);
    });

    test('hashFolder hashes every file but the manifest, by its / path', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'clowdy-manifest-'));

        try {
            mkdirSync(path.join(dir, 'renderer/assets'), { recursive: true });
            writeFileSync(path.join(dir, 'renderer/assets/a.js'), 'a');
            writeFileSync(path.join(dir, 'manifest.json'), '{}');

            expect(await hashFolder(dir)).toEqual({ 'renderer/assets/a.js': { sha256: sha256(new TextEncoder().encode('a')), size: 1 } });
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('hashFolder refuses a link instead of leaving it out of the bundle', async () => {
        // Windows needs a privilege to make one.
        if (process.platform === 'win32') return;

        const dir = mkdtempSync(path.join(tmpdir(), 'clowdy-manifest-'));

        try {
            writeFileSync(path.join(dir, 'a.md'), 'a');
            symlinkSync('a.md', path.join(dir, 'b.md'));

            await expect(hashFolder(dir)).rejects.toThrow('b.md is not a regular file');
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
