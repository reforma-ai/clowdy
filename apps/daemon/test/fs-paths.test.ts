import { describe, expect, test } from 'bun:test';

import { isBelow } from '../src/fs/paths';

/** The paths are POSIX ones; Windows' own spelling is `relative()`'s to judge there. */
const onPosix = process.platform === 'win32' ? describe.skip : describe;

onPosix('isBelow', () => {
    test.each([
        ['a file in the folder', '/w/app/a.txt', {}, true],
        ['a name that starts with two dots', '/w/app/..env', {}, true],
        ['the folder itself', '/w/app', {}, false],
        ['the folder itself, when it may be', '/w/app', { allowSelf: true }, true],
        ['a sibling whose name starts with the folder name', '/w/application/a.txt', {}, false],
        ['the parent', '/w', { allowSelf: true }, false],
        ['a path that climbs out', '/w/app/../other', { allowSelf: true }, false],
    ])('%s', (_, path, options, below) => {
        expect(isBelow('/w/app', path, options)).toBe(below);
    });

    test('anything below the root of the disk is below it', () => {
        expect(isBelow('/', '/etc')).toBe(true);
    });
});
