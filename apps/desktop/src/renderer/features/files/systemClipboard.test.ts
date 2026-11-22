// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest';

import { clipboardOf, pathInside, systemFileClipboard } from './systemClipboard';

import type { DesktopBridge } from '../../../shared/bridge';

describe('the path of a file inside a folder', () => {
    test.each([
        ['/Users/dev/web', '/Users/dev/web/src/app.ts', 'src/app.ts'],
        ['/Users/dev/web/', '/Users/dev/web/README.md', 'README.md'],
        ['C:\\Users\\dev\\web', 'C:\\Users\\dev\\web\\src\\App.tsx', 'src/App.tsx'],
        ['C:\\Users\\dev\\web', 'c:\\users\\dev\\web\\src\\App.tsx', 'src/App.tsx'],
    ])('%s holds %s as %s', (root, file, expected) => {
        expect(pathInside(root, file)).toBe(expected);
    });

    test.each([
        ['/Users/dev/web', '/Users/dev/web'],
        ['/Users/dev/web', '/Users/dev/website/a.ts'],
        ['/Users/dev/web', '/Users/dev/Downloads/a.ts'],
        ['/Users/dev/web', '/users/dev/web/a.ts'],
    ])('%s does not hold %s', (root, file) => {
        expect(pathInside(root, file)).toBeUndefined();
    });
});

describe('the clipboard of a folder', () => {
    const bridge = () => ({
        readClipboardFiles: vi.fn<DesktopBridge['readClipboardFiles']>(async () => [
            { path: '/Users/dev/web/src/a.ts', name: 'a.ts', kind: 'file' },
            { path: '/Users/dev/Downloads/report.pdf', name: 'report.pdf', kind: 'file' },
        ]),
        writeClipboardFiles: vi.fn<DesktopBridge['writeClipboardFiles']>(async () => undefined),
        pasteClipboardFiles: vi.fn<DesktopBridge['pasteClipboardFiles']>(async () => undefined),
    });

    test('copies the paths of the folder as the disk names them', async () => {
        const host = bridge();

        await systemFileClipboard(host, '/Users/dev/web').write(['src/a.ts', 'docs']);

        expect(host.writeClipboardFiles).toHaveBeenCalledWith(['/Users/dev/web/src/a.ts', '/Users/dev/web/docs']);
    });

    test('says which of the files on the clipboard are the folder\'s own', async () => {
        const entries = await systemFileClipboard(bridge(), '/Users/dev/web').read();

        expect(entries).toEqual([
            { path: '/Users/dev/web/src/a.ts', name: 'a.ts', kind: 'file', local: 'src/a.ts' },
            { path: '/Users/dev/Downloads/report.pdf', name: 'report.pdf', kind: 'file' },
        ]);
    });

    test('pastes into the folder as the disk names it, the root of the folder included', async () => {
        const host = bridge();
        const clipboard = systemFileClipboard(host, 'C:\\Users\\dev\\web');
        const items = [{ path: 'C:\\Users\\dev\\Downloads\\a.txt', name: 'a.txt' }];

        await clipboard.paste('src', items);
        await clipboard.paste('', items);

        expect(host.pasteClipboardFiles.mock.calls).toEqual([['C:\\Users\\dev\\web\\src', items], ['C:\\Users\\dev\\web', items]]);
    });
});

describe('a refused paste', () => {
    test('says what main said, without the wrapper Electron puts around it', async () => {
        const host = {
            readClipboardFiles: vi.fn<DesktopBridge['readClipboardFiles']>(async () => []),
            writeClipboardFiles: vi.fn<DesktopBridge['writeClipboardFiles']>(async () => undefined),
            pasteClipboardFiles: vi.fn<DesktopBridge['pasteClipboardFiles']>(async () => Promise.reject(new Error('Error invoking remote method \'desktop:paste-files\': Error: My notes already exists'))),
        };

        await expect(systemFileClipboard(host, '/Users/dev/web').paste('', [{ path: '/Users/dev/My notes', name: 'My notes' }])).rejects.toThrow(/^My notes already exists$/);
    });
});

describe('the clipboard of a page', () => {
    afterEach(() => {
        delete window.desktop;
    });

    test('is the desktop app\'s when it has the bridge for it, and none in a browser, in an older shell or for a folder with no path', () => {
        expect(clipboardOf('/Users/dev/web')).toBeUndefined();

        window.desktop = { platform: 'darwin' } as DesktopBridge;

        expect(clipboardOf('/Users/dev/web')).toBeUndefined();

        window.desktop = { platform: 'darwin', readClipboardFiles: async () => [], writeClipboardFiles: async () => undefined, pasteClipboardFiles: async () => undefined } as unknown as DesktopBridge;

        expect(clipboardOf('/Users/dev/web')).toBeDefined();
        expect(clipboardOf(undefined)).toBeUndefined();
    });
});
