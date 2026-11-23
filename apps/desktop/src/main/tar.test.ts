import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';

import { readTar, type TarEntry, writeTar } from './tar';

const text = (value: string) => new TextEncoder().encode(value);
const LONG = `renderer/${'assets/'.repeat(14)}chunk-with-a-long-name-0123456789.js`;
const ENTRIES: TarEntry[] = [
    { path: 'renderer/index.html', data: text('<!doctype html>') },
    { path: 'daemon/main.js', data: new Uint8Array(1500).fill(7) },
    { path: 'system-skills/skills/empty.md', data: new Uint8Array(0) },
    { path: LONG, data: text('long') },
];

describe('tar', () => {
    test('reads back what it writes, long paths included', () => {
        expect(readTar(writeTar(ENTRIES))).toEqual(ENTRIES);
    });

    test('writes an archive the system tar reads', () => {
        if (process.platform === 'win32') return;

        const dir = mkdtempSync(path.join(tmpdir(), 'clowdy-tar-'));

        try {
            writeFileSync(path.join(dir, 'a.tar.gz'), gzipSync(writeTar(ENTRIES)));
            execFileSync('tar', ['-xzf', 'a.tar.gz'], { cwd: dir });

            expect(readFileSync(path.join(dir, 'renderer/index.html'), 'utf8')).toBe('<!doctype html>');
            expect(readFileSync(path.join(dir, LONG), 'utf8')).toBe('long');
            expect(readFileSync(path.join(dir, 'daemon/main.js')).length).toBe(1500);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('refuses a damaged header, a body past the end, and an archive without its end', () => {
        const archive = writeTar(ENTRIES);
        const damaged = archive.slice();

        damaged[0] = 'X'.charCodeAt(0);

        expect(() => readTar(damaged)).toThrow('checksum');
        // The second entry's header, without its body.
        expect(() => readTar(archive.slice(0, 512 * 3))).toThrow('daemon/main.js runs past the end');
        // The first entry whole, then nothing.
        expect(() => readTar(archive.slice(0, 512 * 2))).toThrow('without its end marker');
    });

    test('refuses links and other kinds of entries', () => {
        const archive = writeTar([{ path: 'link', data: new Uint8Array(0) }]);

        // A symbolic link, with the checksum written again.
        archive[156] = '2'.charCodeAt(0);
        archive.fill(0x20, 148, 156);
        archive.set(
            text(
                `${archive
                    .subarray(0, 512)
                    .reduce((sum, byte) => sum + byte, 0)
                    .toString(8)
                    .padStart(6, '0')}\0 `
            ),
            148
        );

        expect(() => readTar(archive)).toThrow('not a regular file');
    });

    test('refuses a path too long for ustar', () => {
        expect(() => writeTar([{ path: 'x'.repeat(300), data: new Uint8Array(0) }])).toThrow('too long');
    });
});
