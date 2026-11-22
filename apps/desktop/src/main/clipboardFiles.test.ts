import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createClipboardFiles, systemClipboardFilesDeps, type ClipboardFilesDeps } from './clipboardFiles';

/** A machine of the files and folders named, with a clipboard that holds the addresses given; `copy` and `writeUris` only record what they were asked. */
function machine({ platform = 'darwin', uris = [], files = [], directories = [] }: {
    platform?: NodeJS.Platform;
    uris?: string[];
    files?: string[];
    directories?: string[];
}) {
    const copy = vi.fn<ClipboardFilesDeps['copy']>(async () => undefined);
    const writeUris = vi.fn<ClipboardFilesDeps['writeUris']>(async () => undefined);
    const deps: ClipboardFilesDeps = {
        platform,
        readUris: async () => uris,
        writeUris,
        kindOf: async path => (files.includes(path) ? 'file' : directories.includes(path) ? 'directory' : undefined),
        copy,
    };

    return { clipboard: createClipboardFiles(deps), copy, writeUris };
}

describe('the files on the clipboard', () => {
    test('are the files and folders that were copied, by their paths and names, with what is not a file address or is gone left out', async () => {
        const { clipboard } = machine({
            uris: ['file:///Users/dev/My%20notes.md', 'file:///Users/dev/web', 'file:///Users/dev/gone.txt', 'https://example.com/a.png', 'file:///Users/dev/My%20notes.md'],
            files: ['/Users/dev/My notes.md'],
            directories: ['/Users/dev/web'],
        });

        expect(await clipboard.read()).toEqual([
            { path: '/Users/dev/My notes.md', name: 'My notes.md', kind: 'file' },
            { path: '/Users/dev/web', name: 'web', kind: 'directory' },
        ]);
    });

    test('are read the way Windows writes a path', async () => {
        const { clipboard } = machine({ platform: 'win32', uris: ['file:///C:/Users/dev/My%20notes.md'], files: ['C:\\Users\\dev\\My notes.md'] });

        expect(await clipboard.read()).toEqual([{ path: 'C:\\Users\\dev\\My notes.md', name: 'My notes.md', kind: 'file' }]);
    });

    test('are none when the clipboard holds something else', async () => {
        expect(await machine({}).clipboard.read()).toEqual([]);
    });
});

describe('copying files to the clipboard', () => {
    test('puts their addresses on it, and their paths as the text', async () => {
        const { clipboard, writeUris } = machine({});

        await clipboard.write(['/Users/dev/My notes.md', '/Users/dev/web']);

        expect(writeUris).toHaveBeenCalledWith(['file:///Users/dev/My%20notes.md', 'file:///Users/dev/web'], '/Users/dev/My notes.md\n/Users/dev/web');
    });

    test('writes a Windows path as an address too', async () => {
        const { clipboard, writeUris } = machine({ platform: 'win32' });

        await clipboard.write(['C:\\Users\\dev\\notes.md']);

        expect(writeUris).toHaveBeenCalledWith(['file:///C:/Users/dev/notes.md'], 'C:\\Users\\dev\\notes.md');
    });

    test.each([[undefined], ['/Users/dev/a'], [[]], [['relative/path']], [[1]], [['/Users/dev/a', 2]]])('refuses %j', async (paths) => {
        const { clipboard, writeUris } = machine({});

        await expect(clipboard.write(paths)).rejects.toThrow('Bad paths');
        expect(writeUris).not.toHaveBeenCalled();
    });
});

describe('pasting files from the clipboard', () => {
    const held = {
        uris: ['file:///Users/dev/a.txt', 'file:///Users/dev/web'],
        files: ['/Users/dev/a.txt', '/Users/dev/out/b.txt'],
        directories: ['/Users/dev/web', '/Users/dev/out'],
    };

    test('copies each file under its name in the folder', async () => {
        const { clipboard, copy } = machine(held);

        await clipboard.paste('/Users/dev/out', [{ path: '/Users/dev/a.txt', name: 'a copy.txt' }, { path: '/Users/dev/web', name: 'web' }]);

        expect(copy.mock.calls).toEqual([['/Users/dev/a.txt', '/Users/dev/out/a copy.txt'], ['/Users/dev/web', '/Users/dev/out/web']]);
    });

    test('copies nothing that is not on the clipboard now, whatever the page names', async () => {
        const { clipboard, copy } = machine(held);

        await expect(clipboard.paste('/Users/dev/out', [{ path: '/Users/dev/.ssh/id_ed25519', name: 'key' }])).rejects.toThrow('The copied files have changed');
        expect(copy).not.toHaveBeenCalled();
    });

    test('does not replace a name that is taken, and copies none of the others then', async () => {
        const { clipboard, copy } = machine(held);

        await expect(clipboard.paste('/Users/dev/out', [{ path: '/Users/dev/web', name: 'web' }, { path: '/Users/dev/a.txt', name: 'b.txt' }])).rejects.toThrow('b.txt already exists');
        expect(copy).not.toHaveBeenCalled();
    });

    test('does not copy a folder into itself', async () => {
        const { clipboard, copy } = machine({ ...held, directories: [...held.directories, '/Users/dev/web/dist'] });

        await expect(clipboard.paste('/Users/dev/web/dist', [{ path: '/Users/dev/web', name: 'web' }])).rejects.toThrow('web can’t be copied into itself');
        expect(copy).not.toHaveBeenCalled();
    });

    test('refuses a folder that is gone, a name that leaves the folder, repeated names and what is not an entry', async () => {
        const { clipboard, copy } = machine(held);
        const entry = { path: '/Users/dev/a.txt', name: 'a.txt' };

        await expect(clipboard.paste('/Users/dev/missing', [entry])).rejects.toThrow('The folder is gone');
        await expect(clipboard.paste('relative', [entry])).rejects.toThrow('Bad paste');

        for (const name of ['../a.txt', 'x/a.txt', 'x\\a.txt', '..', '.', '', 'a\0.txt', 3]) {
            await expect(clipboard.paste('/Users/dev/out', [{ path: entry.path, name }])).rejects.toThrow('Bad paste');
        }

        await expect(clipboard.paste('/Users/dev/out', [entry, { path: '/Users/dev/web', name: 'a.txt' }])).rejects.toThrow('Bad paste');
        await expect(clipboard.paste('/Users/dev/out', [])).rejects.toThrow('Bad paste');
        await expect(clipboard.paste('/Users/dev/out', ['/Users/dev/a.txt'])).rejects.toThrow('Bad paste');
        expect(copy).not.toHaveBeenCalled();
    });
});

describe('the system clipboard and disk', () => {
    let folder: string | undefined;

    afterEach(async () => {
        if (folder) await rm(folder, { recursive: true, force: true });

        folder = undefined;
    });

    /** A clipboard that holds what was last written to it, as the addresses of the files. */
    function fakeClipboard() {
        let uris = '';
        const clipboard = {
            read: async () => (uris === '' ? [] : [{ types: ['text/plain', 'text/uri-list'], getType: async () => new Blob([uris]) }]),
            write: vi.fn(async (items: Array<{ items: Record<string, string> }>) => {
                uris = items[0]!.items['text/uri-list']!;
            }),
        };

        class Item {
            constructor(readonly items: Record<string, string>) {}
        }

        return { clipboard: clipboard as never, Item: Item as never, written: () => uris };
    }

    test('copy a folder with what it holds and a link in it as it is, and read back what was written', async () => {
        folder = await mkdtemp(join(tmpdir(), 'clowdy-clipboard-'));

        const source = join(folder, 'My notes');
        const target = join(folder, 'out');

        await mkdir(join(source, 'deep'), { recursive: true });
        await mkdir(target);
        await writeFile(join(source, 'a.txt'), 'a');
        await writeFile(join(source, 'deep', 'b.txt'), 'b');
        await symlink('a.txt', join(source, 'link'));

        const { clipboard: fake, Item, written } = fakeClipboard();
        const files = createClipboardFiles(systemClipboardFilesDeps(fake, Item));

        await files.write([source]);

        expect(written()).toMatch(/^file:\/\/.*My%20notes$/);

        const [found] = await files.read();

        expect(found).toEqual({ path: source, name: 'My notes', kind: 'directory' });

        await files.paste(target, [{ path: source, name: 'My notes' }]);

        expect(await readFile(join(target, 'My notes', 'deep', 'b.txt'), 'utf8')).toBe('b');
        expect(await readFile(join(target, 'My notes', 'link'), 'utf8')).toBe('a');

        // Pasting again must not replace the copy.
        await expect(files.paste(target, [{ path: source, name: 'My notes' }])).rejects.toThrow('My notes already exists');
    });
});
