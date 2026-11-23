import { describe, expect, test } from 'vitest';

import { decideShell, newestShell } from './release-shell';

import type { Release } from './github';

const release = (tagName: string, flags: Partial<Release> = {}): Release => ({
    tagName,
    isDraft: false,
    isPrerelease: false,
    ...flags,
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
