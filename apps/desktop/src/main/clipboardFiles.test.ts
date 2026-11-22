import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createClipboardFiles, systemClipboardFilesDeps, type ClipboardFilesDeps } from './clipboardFiles';

/** A machine of the files and folders named, with a clipboard that holds the addresses given; `copy` and `writeUris` only record what they were asked. */
function machine({ platform = 'darwin', uris = [], files = [], directories = [], links = {}, dangling = [] }: {
    platform?: NodeJS.Platform;
    uris?: string[];
    files?: string[];
    directories?: string[];
    /** Where a link goes, by the link's path. */
    links?: Record<string, string>;
    /** Links that go nowhere: there is something at the path, and it is neither a file nor a folder. */
    dangling?: string[];
}) {
    const copy = vi.fn<ClipboardFilesDeps['copy']>(async () => undefined);
    const writeUris = vi.fn<ClipboardFilesDeps['writeUris']>(async () => undefined);
    const deps: ClipboardFilesDeps = {
        platform,
        readUris: async () => uris,
        writeUris,
        kindOf: async path => (files.includes(path) ? 'file' : directories.includes(path) ? 'directory' : undefined),
        exists: async path => files.includes(path) || directories.includes(path) || dangling.includes(path),
        realPath: async path => links[path] ?? path,
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

describe('pasting where the spelling of a path says too little', () => {
    const base = {
        uris: ['file:///Users/dev/web/'],
        directories: ['/Users/dev/web', '/Users/dev/web/sub', '/Users/dev/out', '/Users/dev/out/x'],
    };

    test('reads a folder\'s address with a separator at its end as the folder', async () => {
        const { clipboard } = machine(base);

        expect(await clipboard.read()).toEqual([{ path: '/Users/dev/web', name: 'web', kind: 'directory' }]);
    });

    test('does not copy a folder into a folder that a link leads into it', async () => {
        const { clipboard, copy } = machine({ ...base, directories: [...base.directories, '/Users/dev/out/x/y'], links: { '/Users/dev/out/x/y': '/Users/dev/web/sub' } });

        await expect(clipboard.paste('/Users/dev/out/x/y', [{ path: '/Users/dev/web', name: 'web' }])).rejects.toThrow('web can’t be copied into itself');
        expect(copy).not.toHaveBeenCalled();
    });

    test('does not copy a folder into a link that leads to the folder itself', async () => {
        const { clipboard, copy } = machine({ ...base, directories: [...base.directories, '/Users/dev/out/self'], links: { '/Users/dev/out/self': '/Users/dev/web' } });

        await expect(clipboard.paste('/Users/dev/out/self', [{ path: '/Users/dev/web', name: 'web' }])).rejects.toThrow('web can’t be copied into itself');
        expect(copy).not.toHaveBeenCalled();
    });

    test('counts a name with a name inside the folder that starts with two dots as inside it', async () => {
        const { clipboard, copy } = machine({ ...base, directories: [...base.directories, '/Users/dev/web/..hidden'] });

        await expect(clipboard.paste('/Users/dev/web/..hidden', [{ path: '/Users/dev/web', name: 'web' }])).rejects.toThrow('web can’t be copied into itself');
        expect(copy).not.toHaveBeenCalled();
    });

    test('counts a link that goes nowhere as a name that is taken', async () => {
        const { clipboard, copy } = machine({ ...base, dangling: ['/Users/dev/out/web'] });

        await expect(clipboard.paste('/Users/dev/out', [{ path: '/Users/dev/web', name: 'web' }])).rejects.toThrow('web already exists');
        expect(copy).not.toHaveBeenCalled();
    });
});

describe('pasting on Windows', () => {
    const held = {
        platform: 'win32' as const,
        uris: ['file:///C:/Users/dev/Downloads/My%20notes.md'],
        files: ['C:\\Users\\dev\\Downloads\\My notes.md'],
        directories: ['C:\\Users\\dev\\web'],
    };

    test('copies into a folder under the name given, in the way Windows writes the path', async () => {
        const { clipboard, copy } = machine(held);

        await clipboard.paste('C:\\Users\\dev\\web', [{ path: 'C:\\Users\\dev\\Downloads\\My notes.md', name: 'notes.md' }]);

        expect(copy).toHaveBeenCalledWith('C:\\Users\\dev\\Downloads\\My notes.md', 'C:\\Users\\dev\\web\\notes.md');
    });

    test.each([['x:stream'], ['NUL'], ['com1.txt'], ['name.'], ['a?b'], ['..\\a']])('refuses the name %s', async (name) => {
        const { clipboard, copy } = machine(held);

        await expect(clipboard.paste('C:\\Users\\dev\\web', [{ path: 'C:\\Users\\dev\\Downloads\\My notes.md', name }])).rejects.toThrow('Bad paste');
        expect(copy).not.toHaveBeenCalled();
    });

    test('does not copy a folder into itself, whatever the case of its path', async () => {
        const { clipboard, copy } = machine({ ...held, uris: ['file:///C:/Users/dev/web'], directories: ['C:\\Users\\dev\\web', 'c:\\users\\dev\\WEB\\dist'] });

        await expect(clipboard.paste('c:\\users\\dev\\WEB\\dist', [{ path: 'C:\\Users\\dev\\web', name: 'web' }])).rejects.toThrow('web can’t be copied into itself');
        expect(copy).not.toHaveBeenCalled();
    });

    test('keeps the root of a drive as it is', async () => {
        const { clipboard } = machine({ ...held, uris: ['file:///C:/'], directories: ['C:\\'] });

        expect((await clipboard.read()).map(file => file.path)).toEqual(['C:\\']);
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

    test('refuse a folder copied into itself through a link, and a name that a link that goes nowhere has', async () => {
        folder = await mkdtemp(join(tmpdir(), 'clowdy-clipboard-'));

        const source = join(folder, 'src');
        const target = join(folder, 't');

        await mkdir(join(source, 'sub'), { recursive: true });
        await mkdir(join(target, 'x'), { recursive: true });
        await symlink(join('..', '..', 'src', 'sub'), join(target, 'x', 'y'));
        await symlink('nowhere', join(target, 'src'));

        const { clipboard: fake, Item } = fakeClipboard();
        const files = createClipboardFiles(systemClipboardFilesDeps(fake, Item));

        await files.write([source]);

        await expect(files.paste(join(target, 'x', 'y'), [{ path: source, name: 'src' }])).rejects.toThrow('src can’t be copied into itself');
        await expect(files.paste(target, [{ path: source, name: 'src' }])).rejects.toThrow('src already exists');
        // Nothing was made inside the source on the way.
        await expect(readdir(join(source, 'sub'))).resolves.toEqual([]);
    });

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
