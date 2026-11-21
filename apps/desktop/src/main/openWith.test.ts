import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createOpenWith, systemOpenWithDeps, type OpenWithDeps } from './openWith';

/** A machine of folders and files named by plain strings; `launch` and `openPath` only record what they were asked. */
function machine({ platform, folders = {}, files = [], env = {}, home = '/Users/dev' }: {
    platform: NodeJS.Platform;
    folders?: Record<string, string[]>;
    files?: string[];
    env?: Record<string, string>;
    home?: string;
}) {
    const launch = vi.fn<OpenWithDeps['launch']>(async () => undefined);
    const openPath = vi.fn<OpenWithDeps['openPath']>(async () => '');
    const deps: OpenWithDeps = {
        platform,
        home,
        env,
        list: async folder => folders[folder] ?? [],
        exists: async path => files.includes(path),
        isFolder: async path => path === '/Users/dev/web' || path === 'C:\\Users\\dev\\web',
        openPath,
        launch,
    };

    return { open: createOpenWith(deps), launch, openPath };
}

const MAC: Parameters<typeof machine>[0] = {
    platform: 'darwin',
    folders: {
        '/Applications': ['Safari.app', 'Visual Studio Code.app', 'Cursor.app', 'IntelliJ IDEA CE.app', 'Path Finder.app', 'notes.txt'],
        '/Users/dev/Applications': ['WebStorm.app', 'Cursor.app'],
        '/Users/dev/Applications/JetBrains Toolbox': ['PyCharm.app'],
    },
};

describe('what a Mac has', () => {
    test('lists the editors in the order of the catalog, and the system\'s file manager before the others found', async () => {
        const { open } = machine(MAC);

        expect(await open.listApps()).toEqual({
            editors: [
                { id: 'cursor', name: 'Cursor' },
                { id: 'vscode', name: 'Visual Studio Code' },
                { id: 'idea', name: 'IntelliJ IDEA' },
                { id: 'webstorm', name: 'WebStorm' },
                { id: 'pycharm', name: 'PyCharm' },
            ],
            fileManagers: [{ id: 'finder', name: 'Finder' }, { id: 'path-finder', name: 'Path Finder' }],
        });
    });

    test('finds a program by the name of its app, whatever edition or channel the name goes on with, and skips what is not an app', async () => {
        const { open } = machine({ platform: 'darwin', folders: { '/Applications': ['Zed Preview.app', 'Visual Studio Code - Insiders.app', 'Windsurf Next.app', 'zed.app', 'Nova.txt'] } });

        expect((await open.listApps()).editors.map(app => app.id)).toEqual(['windsurf', 'zed', 'vscode-insiders']);
    });

    test('has only the system\'s file manager when nothing else is installed', async () => {
        const { open } = machine({ platform: 'darwin' });

        expect(await open.listApps()).toEqual({ editors: [], fileManagers: [{ id: 'finder', name: 'Finder' }] });
    });
});

describe('opening a folder on a Mac', () => {
    test('has the system open it in Finder', async () => {
        const { open, launch, openPath } = machine(MAC);

        await open.openFolder('/Users/dev/web', { kind: 'fileManager', id: 'finder' });

        expect(openPath).toHaveBeenCalledWith('/Users/dev/web');
        expect(launch).not.toHaveBeenCalled();
    });

    test('tells the system\'s refusal', async () => {
        const { open, openPath } = machine(MAC);

        openPath.mockResolvedValueOnce('Failed to open path');

        await expect(open.openFolder('/Users/dev/web', { kind: 'fileManager', id: 'finder' })).rejects.toThrow('Failed to open path');
    });

    test('starts an editor with the folder as an argument of `open -a`, from the first place its app was found', async () => {
        const { open, launch } = machine(MAC);

        await open.openFolder('/Users/dev/web', { kind: 'editor', id: 'cursor' });
        await open.openFolder('/Users/dev/web', { kind: 'fileManager', id: 'path-finder' });

        expect(launch).toHaveBeenNthCalledWith(1, 'open', ['-a', '/Applications/Cursor.app', '/Users/dev/web']);
        expect(launch).toHaveBeenNthCalledWith(2, 'open', ['-a', '/Applications/Path Finder.app', '/Users/dev/web']);
    });

    test('refuses what the page should not have sent, and starts nothing', async () => {
        const { open, launch, openPath } = machine(MAC);
        const send = (folder: unknown, app: unknown) => open.openFolder(folder, app);

        await expect(send('web', { kind: 'editor', id: 'cursor' })).rejects.toThrow('Not a folder');
        await expect(send(7, { kind: 'editor', id: 'cursor' })).rejects.toThrow('Not a folder');
        await expect(send('/Users/dev/web', undefined)).rejects.toThrow('Unknown app');
        await expect(send('/Users/dev/web', { kind: 'shell', id: 'cursor' })).rejects.toThrow('Unknown app');
        await expect(send('/Users/dev/web', { kind: 'editor', id: 7 })).rejects.toThrow('Unknown app');
        await expect(send('/Users/dev/gone', { kind: 'editor', id: 'cursor' })).rejects.toThrow('The folder no longer exists');
        // A program of the catalog that is not here, a program that is not in it, and a file manager asked for as an editor.
        await expect(send('/Users/dev/web', { kind: 'editor', id: 'zed' })).rejects.toThrow('That app is not installed');
        await expect(send('/Users/dev/web', { kind: 'editor', id: '/bin/sh' })).rejects.toThrow('That app is not installed');
        await expect(send('/Users/dev/web', { kind: 'editor', id: 'finder' })).rejects.toThrow('That app is not installed');
        expect(launch).not.toHaveBeenCalled();
        expect(openPath).not.toHaveBeenCalled();
    });
});

describe('what a Windows machine has', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local', ProgramFiles: 'C:\\Program Files' };

    test('finds a program where its installer puts it, the newest version of one that names it, and only has File Explorer', async () => {
        const { open } = machine({
            platform: 'win32',
            env,
            folders: { 'C:\\Program Files\\JetBrains': ['WebStorm 2025.1', 'WebStorm 2025.2', 'PyCharm 2025.2'] },
            files: [
                'C:\\Users\\dev\\AppData\\Local\\Programs\\cursor\\Cursor.exe',
                'C:\\Program Files\\JetBrains\\WebStorm 2025.1\\bin\\webstorm64.exe',
                'C:\\Program Files\\JetBrains\\WebStorm 2025.2\\bin\\webstorm64.exe',
            ],
        });

        expect(await open.listApps()).toEqual({
            editors: [{ id: 'cursor', name: 'Cursor' }, { id: 'webstorm', name: 'WebStorm' }],
            fileManagers: [{ id: 'explorer', name: 'File Explorer' }],
        });
    });

    test('starts the executable it found with the folder as its argument, and File Explorer through the system', async () => {
        const { open, launch, openPath } = machine({
            platform: 'win32',
            env,
            folders: { 'C:\\Program Files\\JetBrains': ['WebStorm 2025.1', 'WebStorm 2025.2'] },
            files: ['C:\\Program Files\\JetBrains\\WebStorm 2025.1\\bin\\webstorm64.exe', 'C:\\Program Files\\JetBrains\\WebStorm 2025.2\\bin\\webstorm64.exe'],
        });

        await open.openFolder('C:\\Users\\dev\\web', { kind: 'editor', id: 'webstorm' });
        await open.openFolder('C:\\Users\\dev\\web', { kind: 'fileManager', id: 'explorer' });

        expect(launch).toHaveBeenCalledExactlyOnceWith('C:\\Program Files\\JetBrains\\WebStorm 2025.2\\bin\\webstorm64.exe', ['C:\\Users\\dev\\web']);
        expect(openPath).toHaveBeenCalledWith('C:\\Users\\dev\\web');
    });

    test('skips a place that names an environment variable the machine does not have', async () => {
        const { open } = machine({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, files: ['C:\\Users\\dev\\AppData\\Local\\Programs\\cursor\\Cursor.exe'] });

        expect((await open.listApps()).editors).toEqual([]);
    });

    test('refuses a path that is not absolute', async () => {
        const { open } = machine({ platform: 'win32', env });

        await expect(open.openFolder('web', { kind: 'fileManager', id: 'explorer' })).rejects.toThrow('Not a folder');
    });
});

test('has no program on a system the app does not run on', async () => {
    const { open } = machine({ platform: 'linux', folders: { '/Applications': ['Cursor.app'] } });

    expect(await open.listApps()).toEqual({ editors: [], fileManagers: [] });
    await expect(open.openFolder('/Users/dev/web', { kind: 'editor', id: 'cursor' })).rejects.toThrow('That app is not installed');
});

describe('the real machine', () => {
    const folders: string[] = [];
    const scratch = async () => {
        const folder = await mkdtemp(join(tmpdir(), 'clowdy-open-with-'));

        folders.push(folder);

        return folder;
    };

    afterEach(async () => {
        await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })));
    });

    test('tells a folder from a file and from nothing, and lists a folder it cannot read as empty', async () => {
        const deps = systemOpenWithDeps(async () => '');
        const root = await scratch();

        await mkdir(join(root, 'web'));
        await writeFile(join(root, 'notes.txt'), '');

        expect(await deps.isFolder(join(root, 'web'))).toBe(true);
        expect(await deps.isFolder(join(root, 'notes.txt'))).toBe(false);
        expect(await deps.isFolder(join(root, 'gone'))).toBe(false);
        expect(await deps.exists(join(root, 'notes.txt'))).toBe(true);
        expect(await deps.exists(join(root, 'gone'))).toBe(false);
        expect((await deps.list(root)).sort()).toEqual(['notes.txt', 'web']);
        expect(await deps.list(join(root, 'gone'))).toEqual([]);
    });

    test('starts a program with each argument as it is, and no shell reads them', async () => {
        const deps = systemOpenWithDeps(async () => '');
        const root = await scratch();
        const out = join(root, 'argv.json');
        const folder = 'my web; $(touch pwned) "q" \'s\' -x';

        await deps.launch(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))', out, folder]);

        await vi.waitFor(async () => expect(JSON.parse(await readFile(out, 'utf8'))).toEqual([folder]), { timeout: 10_000 });
    });

    test.runIf(process.platform === 'darwin')('rejects when `open` cannot start the app it is told to', async () => {
        const deps = systemOpenWithDeps(async () => '');
        const root = await scratch();

        await expect(deps.launch('open', ['-a', join(root, 'Missing.app'), root])).rejects.toThrow('open failed');
    });

    test('rejects when the program cannot be started', async () => {
        const deps = systemOpenWithDeps(async () => '');
        const root = await scratch();

        await expect(deps.launch(join(root, 'no-such-program'), [root])).rejects.toThrow();
    });
});
