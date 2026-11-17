import { describe, expect, test } from 'vitest';

import { daemonDataDir } from './paths';

describe('daemonDataDir', () => {
    test('macOS keeps the daemon under Application Support', () => {
        expect(daemonDataDir({ platform: 'darwin', home: '/Users/a', env: {} })).toBe('/Users/a/Library/Application Support/Clowdy/daemon');
    });

    test('Windows uses Local AppData, and falls back to it under the home folder', () => {
        expect(daemonDataDir({ platform: 'win32', home: 'C:\\Users\\a', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' } }))
            .toBe('C:\\Users\\a\\AppData\\Local\\Clowdy\\daemon');
        expect(daemonDataDir({ platform: 'win32', home: 'C:\\Users\\a\\', env: {} })).toBe('C:\\Users\\a\\AppData\\Local\\Clowdy\\daemon');
    });

    test('Linux uses a lowercase folder under ~/.local/share', () => {
        expect(daemonDataDir({ platform: 'linux', home: '/home/a', env: {} })).toBe('/home/a/.local/share/clowdy/daemon');
    });

    test('the dev profile gets its own folder on every platform', () => {
        const env = { CLOWDY_PROFILE: 'dev' };

        expect(daemonDataDir({ platform: 'darwin', home: '/Users/a', env })).toBe('/Users/a/Library/Application Support/Clowdy Dev/daemon');
        expect(daemonDataDir({ platform: 'win32', home: 'C:\\Users\\a', env: { ...env, LOCALAPPDATA: 'D:\\Local' } })).toBe('D:\\Local\\Clowdy Dev\\daemon');
        expect(daemonDataDir({ platform: 'linux', home: '/home/a', env })).toBe('/home/a/.local/share/clowdy-dev/daemon');
    });

    test('other profile values are ignored', () => {
        expect(daemonDataDir({ platform: 'linux', home: '/home/a', env: { CLOWDY_PROFILE: 'prod' } })).toBe('/home/a/.local/share/clowdy/daemon');
    });

    test('CLOWDY_DATA_DIR overrides everything, an empty one does not', () => {
        expect(daemonDataDir({ platform: 'darwin', home: '/Users/a', env: { CLOWDY_DATA_DIR: '/tmp/data', CLOWDY_PROFILE: 'dev' } })).toBe('/tmp/data');
        expect(daemonDataDir({ platform: 'linux', home: '/home/a', env: { CLOWDY_DATA_DIR: '' } })).toBe('/home/a/.local/share/clowdy/daemon');
    });
});
