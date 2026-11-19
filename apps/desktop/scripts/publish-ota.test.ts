import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { bundlesToPrune, decideOta, shellChangedSince } from './publish-ota';

import type { Release } from './github';

const release = (tagName: string, flags: Partial<Release> = {}): Release => ({ tagName, isDraft: false, isPrerelease: false, ...flags });
const BUNDLE = { version: 412, minShell: '0.2.0', protocol: 1 };
const RELEASES = [release('v0.1.0'), release('v0.2.0'), release('ota', { isPrerelease: true })];

describe('decideOta', () => {
    test('publishes a newer bundle for a released, unchanged shell', () => {
        expect(decideOta({ bundle: BUNDLE, releases: RELEASES, shellChanged: false, published: 411 }).decision).toBe('publish');
        expect(decideOta({ bundle: BUNDLE, releases: RELEASES, shellChanged: false, published: null }).decision).toBe('publish');
    });

    test('waits for the first shell release', () => {
        expect(decideOta({ bundle: BUNDLE, releases: [], shellChanged: undefined, published: null }).decision).toBe('skip');
    });

    test('waits while the shell it needs is not released', () => {
        const result = decideOta({ bundle: { ...BUNDLE, minShell: '0.3.0' }, releases: RELEASES, shellChanged: undefined, published: 400 });

        expect(result).toMatchObject({ decision: 'skip' });
        expect(result.reason).toContain('0.3.0');
    });

    test('waits when the shell changed since its release without a new version', () => {
        expect(decideOta({ bundle: BUNDLE, releases: RELEASES, shellChanged: true, published: 400 }).reason).toContain('raise its version');
    });

    test('skips a bundle that is not newer than the published one', () => {
        expect(decideOta({ bundle: BUNDLE, releases: RELEASES, shellChanged: false, published: 412 }).decision).toBe('skip');
        expect(decideOta({ bundle: BUNDLE, releases: RELEASES, shellChanged: false, published: 500 }).decision).toBe('skip');
    });
});

test('bundlesToPrune keeps the newest three archives', () => {
    expect(bundlesToPrune(['manifest.json', 'bundle-9.tar.gz', 'bundle-12.tar.gz', 'bundle-10.tar.gz', 'bundle-11.tar.gz', 'other.zip'])).toEqual(['bundle-9.tar.gz']);
    expect(bundlesToPrune(['bundle-1.tar.gz', 'manifest.json'])).toEqual([]);
});

describe('shellChangedSince', () => {
    let dir = '';
    // The person's own config may sign commits or run hooks.
    const git = (...args: string[]) => execFileSync('git', [
        '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'core.hooksPath=/dev/null', ...args,
    ], { cwd: dir, stdio: 'pipe' });
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
            'packages/protocol/src/api.ts': 'export const PROTOCOL_VERSION = 1;\nexport const ROUTES = {};\n',
            'package.json': JSON.stringify({ packageManager: 'bun@1.3.0', scripts: { dev: 'dev' } }),
        });

        expect(await shellChangedSince('v0.2.0', dir)).toBe(false);
    });

    test.each([
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
