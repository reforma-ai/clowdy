import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createOpenWith, systemOpenWithDeps, type OpenWithDeps } from './openWith';

/** A machine of folders and files named by plain strings; `launch` and `openPath` only record what they were asked. */
function machine({ platform, folders = {}, directories = [], links = {}, files = [], env = {}, home = '/Users/dev', icons = {} }: {
    platform: NodeJS.Platform;
    folders?: Record<string, string[]>;
    /** Folders there are besides `web` in the home folder, which every machine has. */
    directories?: string[];
    /** Where a link goes, by the link's path. */
    links?: Record<string, string>;
    /** The files there are, and what a program is looked for by (`exists`). */
    files?: string[];
    env?: Record<string, string>;
    home?: string;
    /** The icon each place has, by path; a program at another place has none. */
    icons?: Record<string, string>;
}) {
    const launch = vi.fn<OpenWithDeps['launch']>(async () => undefined);
    const openPath = vi.fn<OpenWithDeps['openPath']>(async () => '');
    const showItem = vi.fn<OpenWithDeps['showItem']>();
    const icon = vi.fn<OpenWithDeps['icon']>(async path => icons[path]);
    const deps: OpenWithDeps = {
        platform,
        home,
        env,
        list: async folder => folders[folder] ?? [],
        exists: async path => files.includes(path),
        isFolder: async path => path === '/Users/dev/web' || path === 'C:\\Users\\dev\\web' || directories.includes(path),
        realPath: async path => links[path] ?? path,
        openPath,
        showItem,
        launch,
        icon,
    };

    return { open: createOpenWith(deps), launch, openPath, showItem, icon };
}

const MAC: Parameters<typeof machine>[0] = {
    platform: 'darwin',
    folders: {
        '/Applications': ['Safari.app', 'Visual Studio Code.app', 'Cursor.app', 'IntelliJ IDEA CE.app', 'Path Finder.app', 'Ghostty.app', 'notes.txt'],
        '/System/Applications/Utilities': ['Terminal.app', 'Activity Monitor.app'],
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
            terminals: [{ id: 'ghostty', name: 'Ghostty' }, { id: 'terminal', name: 'Terminal' }],
            fileManagers: [{ id: 'finder', name: 'Finder' }, { id: 'path-finder', name: 'Path Finder' }],
        });
    });

    test('finds a program by the name of its app, whatever edition or channel the name goes on with, and skips what is not an app', async () => {
        const { open } = machine({ platform: 'darwin', folders: { '/Applications': ['Zed Preview.app', 'Visual Studio Code - Insiders.app', 'Windsurf Next.app', 'zed.app', 'Nova.txt'] } });

        expect((await open.listApps()).editors.map(app => app.id)).toEqual(['windsurf', 'zed', 'vscode-insiders']);
    });

    test('has only the system\'s file manager when nothing else is installed', async () => {
        const { open } = machine({ platform: 'darwin' });

        expect(await open.listApps()).toEqual({ editors: [], terminals: [], fileManagers: [{ id: 'finder', name: 'Finder' }] });
    });
});

describe('opening a folder on a Mac', () => {
    test('has the system open it in Finder', async () => {
        const { open, launch, openPath } = machine(MAC);

        await open.openPath('/Users/dev/web', { kind: 'fileManager', id: 'finder' });

        expect(openPath).toHaveBeenCalledWith('/Users/dev/web');
        expect(launch).not.toHaveBeenCalled();
    });

    test('tells the system\'s refusal', async () => {
        const { open, openPath } = machine(MAC);

        openPath.mockResolvedValueOnce('Failed to open path');

        await expect(open.openPath('/Users/dev/web', { kind: 'fileManager', id: 'finder' })).rejects.toThrow('Failed to open path');
    });

    test('has the system show an app bundle in its folder, and not open it: that would start the program', async () => {
        const bundle = '/Users/dev/web/Evil.app';
        const { open, launch, openPath, showItem } = machine({ ...MAC, directories: [bundle, '/Users/dev/web/docs'], links: { '/Users/dev/web/docs': bundle } });

        await open.openPath(bundle, { kind: 'fileManager', id: 'finder' });
        // A link in the folder that goes to the bundle is no way round it.
        await open.openPath('/Users/dev/web/docs', { kind: 'fileManager', id: 'finder' });

        expect(showItem.mock.calls).toEqual([[bundle], ['/Users/dev/web/docs']]);
        expect(openPath).not.toHaveBeenCalled();
        expect(launch).not.toHaveBeenCalled();
    });

    test('opens a folder with a name like an app\'s on Windows, which the system does not run', async () => {
        const { open, openPath, showItem } = machine({ platform: 'win32', directories: ['C:\\Users\\dev\\web\\Evil.app'] });

        await open.openPath('C:\\Users\\dev\\web\\Evil.app', { kind: 'fileManager', id: 'explorer' });

        expect(openPath).toHaveBeenCalledExactlyOnceWith('C:\\Users\\dev\\web\\Evil.app');
        expect(showItem).not.toHaveBeenCalled();
    });

    test('starts an editor with the folder as an argument of `open -a`, from the first place its app was found', async () => {
        const { open, launch } = machine(MAC);

        await open.openPath('/Users/dev/web', { kind: 'editor', id: 'cursor' });
        await open.openPath('/Users/dev/web', { kind: 'fileManager', id: 'path-finder' });

        expect(launch).toHaveBeenNthCalledWith(1, 'open', ['-a', '/Applications/Cursor.app', '/Users/dev/web']);
        expect(launch).toHaveBeenNthCalledWith(2, 'open', ['-a', '/Applications/Path Finder.app', '/Users/dev/web']);
    });

    test('refuses what the page should not have sent, and starts nothing', async () => {
        const { open, launch, openPath } = machine(MAC);
        const send = (folder: unknown, app: unknown) => open.openPath(folder, app);

        await expect(send('web', { kind: 'editor', id: 'cursor' })).rejects.toThrow('Not a path');
        await expect(send(7, { kind: 'editor', id: 'cursor' })).rejects.toThrow('Not a path');
        await expect(send('/Users/dev/web', undefined)).rejects.toThrow('Unknown app');
        await expect(send('/Users/dev/web', { kind: 'shell', id: 'cursor' })).rejects.toThrow('Unknown app');
        await expect(send('/Users/dev/web', { kind: 'editor', id: 7 })).rejects.toThrow('Unknown app');
        await expect(send('/Users/dev/gone', { kind: 'editor', id: 'cursor' })).rejects.toThrow('That path no longer exists');
        // A program of the catalog that is not here, a program that is not in it, and a file manager asked for as an editor.
        await expect(send('/Users/dev/web', { kind: 'editor', id: 'zed' })).rejects.toThrow('That app is not installed');
        await expect(send('/Users/dev/web', { kind: 'editor', id: '/bin/sh' })).rejects.toThrow('That app is not installed');
        await expect(send('/Users/dev/web', { kind: 'editor', id: 'finder' })).rejects.toThrow('That app is not installed');
        expect(launch).not.toHaveBeenCalled();
        expect(openPath).not.toHaveBeenCalled();
    });
});

describe('opening a file', () => {
    const FILE = '/Users/dev/web/src/index.ts';
    const withFile = { ...MAC, files: [FILE] };

    test('has an editor open the file itself', async () => {
        const { open, launch } = machine(withFile);

        await open.openPath(FILE, { kind: 'editor', id: 'cursor' });

        expect(launch).toHaveBeenCalledExactlyOnceWith('open', ['-a', '/Applications/Cursor.app', FILE]);
    });

    test('has the system show the file in its folder, and does not open it', async () => {
        const { open, launch, openPath, showItem } = machine(withFile);

        await open.openPath(FILE, { kind: 'fileManager', id: 'finder' });

        expect(showItem).toHaveBeenCalledExactlyOnceWith(FILE);
        expect(openPath).not.toHaveBeenCalled();
        expect(launch).not.toHaveBeenCalled();
    });

    test('gives another file manager the folder the file is in, since it cannot select a file', async () => {
        const { open, launch } = machine(withFile);

        await open.openPath(FILE, { kind: 'fileManager', id: 'path-finder' });

        expect(launch).toHaveBeenCalledExactlyOnceWith('open', ['-a', '/Applications/Path Finder.app', '/Users/dev/web/src']);
    });

    test('is refused by a terminal, which opens folders', async () => {
        const { open, launch } = machine(withFile);

        await expect(open.openPath(FILE, { kind: 'terminal', id: 'ghostty' })).rejects.toThrow('A terminal opens a folder');
        expect(launch).not.toHaveBeenCalled();
    });

    test('is refused when the file is not there', async () => {
        const { open, launch, showItem } = machine(MAC);

        await expect(open.openPath(FILE, { kind: 'editor', id: 'cursor' })).rejects.toThrow('That path no longer exists');
        await expect(open.openPath(FILE, { kind: 'fileManager', id: 'finder' })).rejects.toThrow('That path no longer exists');
        expect(launch).not.toHaveBeenCalled();
        expect(showItem).not.toHaveBeenCalled();
    });

    test('has an editor open a file on Windows, and File Explorer show it', async () => {
        const file = 'C:\\Users\\dev\\web\\index.ts';
        const cursor = 'C:\\Users\\dev\\AppData\\Local\\Programs\\cursor\\Cursor.exe';
        const { open, launch, showItem } = machine({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' }, files: [file, cursor] });

        await open.openPath(file, { kind: 'editor', id: 'cursor' });
        await open.openPath(file, { kind: 'fileManager', id: 'explorer' });

        expect(launch).toHaveBeenCalledExactlyOnceWith(cursor, [file]);
        expect(showItem).toHaveBeenCalledExactlyOnceWith(file);
    });
});

describe('opening a folder in a terminal', () => {
    const machineWith = (applications: string[]) => machine({ platform: 'darwin', folders: { '/Applications': applications, '/System/Applications/Utilities': ['Terminal.app'] } });

    test('puts a person\'s own terminal before the system\'s, so installing one is enough to make it the default', async () => {
        const { open } = machineWith(['kitty.app', 'iTerm.app', 'Warp.app']);

        expect((await open.listApps()).terminals.map(app => app.id)).toEqual(['iterm', 'warp', 'kitty', 'terminal']);
    });

    test('hands the folder to a terminal that opens a window in it, with `open -a`', async () => {
        const { open, launch } = machineWith(['Ghostty.app']);

        await open.openPath('/Users/dev/web', { kind: 'terminal', id: 'ghostty' });
        await open.openPath('/Users/dev/web', { kind: 'terminal', id: 'terminal' });

        expect(launch).toHaveBeenNthCalledWith(1, 'open', ['-a', '/Applications/Ghostty.app', '/Users/dev/web']);
        expect(launch).toHaveBeenNthCalledWith(2, 'open', ['-a', '/System/Applications/Utilities/Terminal.app', '/Users/dev/web']);
    });

    test('starts a terminal that has to be told where to open as a new instance, with the folder as one argument of its own', async () => {
        const { open, launch } = machineWith(['Alacritty.app', 'WezTerm.app', 'kitty.app']);

        await open.openPath('/Users/dev/web', { kind: 'terminal', id: 'alacritty' });
        await open.openPath('/Users/dev/web', { kind: 'terminal', id: 'wezterm' });
        await open.openPath('/Users/dev/web', { kind: 'terminal', id: 'kitty' });

        expect(launch.mock.calls).toEqual([
            ['open', ['-n', '-a', '/Applications/Alacritty.app', '--args', '--working-directory', '/Users/dev/web']],
            ['open', ['-n', '-a', '/Applications/WezTerm.app', '--args', 'start', '--cwd', '/Users/dev/web']],
            ['open', ['-n', '-a', '/Applications/kitty.app', '--args', '--directory', '/Users/dev/web']],
        ]);
    });

    test('hands a folder whose name has spaces, quotes or shell characters over as one argument', async () => {
        const folder = '/Users/dev/my "web" --x; $(id) `id`';
        const { open, launch } = machine({ platform: 'darwin', directories: [folder], folders: { '/Applications': ['Ghostty.app', 'Alacritty.app'] } });

        await open.openPath(folder, { kind: 'terminal', id: 'ghostty' });
        await open.openPath(folder, { kind: 'terminal', id: 'alacritty' });

        expect(launch.mock.calls).toEqual([
            ['open', ['-a', '/Applications/Ghostty.app', folder]],
            ['open', ['-n', '-a', '/Applications/Alacritty.app', '--args', '--working-directory', folder]],
        ]);
    });

    test('is a kind of its own: an editor is not asked for as a terminal, nor a terminal as an editor', async () => {
        const { open, launch } = machineWith(['Ghostty.app', 'Cursor.app']);

        await expect(open.openPath('/Users/dev/web', { kind: 'terminal', id: 'cursor' })).rejects.toThrow('That app is not installed');
        await expect(open.openPath('/Users/dev/web', { kind: 'editor', id: 'ghostty' })).rejects.toThrow('That app is not installed');
        expect(launch).not.toHaveBeenCalled();
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
            terminals: [],
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

        await open.openPath('C:\\Users\\dev\\web', { kind: 'editor', id: 'webstorm' });
        await open.openPath('C:\\Users\\dev\\web', { kind: 'fileManager', id: 'explorer' });

        expect(launch).toHaveBeenCalledExactlyOnceWith('C:\\Program Files\\JetBrains\\WebStorm 2025.2\\bin\\webstorm64.exe', ['C:\\Users\\dev\\web']);
        expect(openPath).toHaveBeenCalledWith('C:\\Users\\dev\\web');
    });

    test('matches the folder a star stands for whatever its case, and a name with brackets or parentheses in it', async () => {
        const { open } = machine({
            platform: 'win32',
            env,
            folders: { 'C:\\Program Files\\JetBrains': ['webstorm (EAP) [2025.2]'] },
            files: ['C:\\Program Files\\JetBrains\\webstorm (EAP) [2025.2]\\bin\\webstorm64.exe'],
        });

        expect((await open.listApps()).editors).toEqual([{ id: 'webstorm', name: 'WebStorm' }]);
    });

    test('skips a place that names an environment variable the machine does not have', async () => {
        const { open } = machine({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, files: ['C:\\Users\\dev\\AppData\\Local\\Programs\\cursor\\Cursor.exe'] });

        expect((await open.listApps()).editors).toEqual([]);
    });

    test('finds Windows Terminal and Git Bash, and starts each with the folder in its own arguments', async () => {
        const wt = 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe';
        const bash = 'C:\\Program Files\\Git\\git-bash.exe';
        const { open, launch } = machine({ platform: 'win32', env, files: [wt, bash] });

        expect((await open.listApps()).terminals).toEqual([{ id: 'windows-terminal', name: 'Windows Terminal' }, { id: 'git-bash', name: 'Git Bash' }]);

        await open.openPath('C:\\Users\\dev\\web', { kind: 'terminal', id: 'windows-terminal' });
        await open.openPath('C:\\Users\\dev\\web', { kind: 'terminal', id: 'git-bash' });

        expect(launch.mock.calls).toEqual([
            [wt, ['-d', 'C:\\Users\\dev\\web']],
            [bash, ['--cd=C:\\Users\\dev\\web']],
        ]);
    });

    test('hands a folder with spaces or quotes to Windows Terminal and Git Bash as one argument, and refuses Windows Terminal one with a semicolon', async () => {
        const wt = 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe';
        const bash = 'C:\\Program Files\\Git\\git-bash.exe';
        const folder = 'C:\\Users\\dev\\my web & \'x\'';
        const odd = 'C:\\Users\\dev\\web;powershell -c calc';
        const { open, launch } = machine({ platform: 'win32', env, files: [wt, bash], directories: [folder, odd] });

        await open.openPath(folder, { kind: 'terminal', id: 'windows-terminal' });
        await open.openPath(folder, { kind: 'terminal', id: 'git-bash' });
        await open.openPath(odd, { kind: 'terminal', id: 'git-bash' });
        await expect(open.openPath(odd, { kind: 'terminal', id: 'windows-terminal' })).rejects.toThrow('semicolon');

        expect(launch.mock.calls).toEqual([
            [wt, ['-d', folder]],
            [bash, [`--cd=${ folder }`]],
            [bash, [`--cd=${ odd }`]],
        ]);
    });

    test('refuses a path that is not absolute', async () => {
        const { open } = machine({ platform: 'win32', env });

        await expect(open.openPath('web', { kind: 'fileManager', id: 'explorer' })).rejects.toThrow('Not a path');
    });
});

describe('the icons of the programs', () => {
    test('tells each program\'s icon, read from its app, and the system\'s file manager\'s from its own place', async () => {
        const { open } = machine({
            ...MAC,
            icons: {
                '/Applications/Cursor.app': 'data:image/png;base64,cursor',
                '/Applications/Path Finder.app': 'data:image/png;base64,path-finder',
                '/System/Library/CoreServices/Finder.app': 'data:image/png;base64,finder',
            },
        });

        const { editors, fileManagers } = await open.listApps();

        expect(editors.find(app => app.id === 'cursor')).toEqual({ id: 'cursor', name: 'Cursor', icon: 'data:image/png;base64,cursor' });
        expect(fileManagers).toEqual([
            { id: 'finder', name: 'Finder', icon: 'data:image/png;base64,finder' },
            { id: 'path-finder', name: 'Path Finder', icon: 'data:image/png;base64,path-finder' },
        ]);
    });

    test('lists a program whose icon cannot be read, with no icon, and tells the page no path', async () => {
        const { open } = machine({ ...MAC, icons: { '/Applications/Cursor.app': 'data:image/png;base64,cursor' } });
        const { editors, fileManagers } = await open.listApps();
        const apps = [...editors, ...fileManagers];

        expect(apps.map(app => Object.keys(app).sort().join())).toEqual(apps.map(app => app.id === 'cursor' ? 'icon,id,name' : 'id,name'));
    });

    test('reads an icon once while it is read, and tries again one that could not be read', async () => {
        const { open, icon } = machine({ platform: 'darwin', folders: { '/Applications': ['Cursor.app', 'Zed.app'] }, icons: { '/Applications/Cursor.app': 'data:image/png;base64,cursor' } });

        await open.listApps();
        await open.listApps();

        const reads = icon.mock.calls.map(([path]) => path);

        expect(reads.filter(path => path === '/Applications/Cursor.app')).toHaveLength(1);
        expect(reads.filter(path => path === '/Applications/Zed.app')).toHaveLength(2);
    });

    test('reads the icon of File Explorer and of an executable on Windows, and skips a place that needs a variable the machine does not have', async () => {
        const executable = 'C:\\Users\\dev\\AppData\\Local\\Programs\\cursor\\Cursor.exe';
        const { open, icon } = machine({
            platform: 'win32',
            env: { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local', SystemRoot: 'C:\\Windows' },
            files: [executable],
            icons: { [executable]: 'data:image/png;base64,cursor', 'C:\\Windows\\explorer.exe': 'data:image/png;base64,explorer' },
        });

        expect(await open.listApps()).toEqual({
            editors: [{ id: 'cursor', name: 'Cursor', icon: 'data:image/png;base64,cursor' }],
            terminals: [],
            fileManagers: [{ id: 'explorer', name: 'File Explorer', icon: 'data:image/png;base64,explorer' }],
        });

        const bare = machine({ platform: 'win32', env: {} });

        expect(await bare.open.listApps()).toEqual({ editors: [], terminals: [], fileManagers: [{ id: 'explorer', name: 'File Explorer' }] });
        expect(bare.icon).not.toHaveBeenCalled();
        expect(icon).toHaveBeenCalledTimes(2);
    });
});

test('has no program on a system the app does not run on', async () => {
    const { open } = machine({ platform: 'linux', folders: { '/Applications': ['Cursor.app'] } });

    expect(await open.listApps()).toEqual({ editors: [], terminals: [], fileManagers: [] });
    await expect(open.openPath('/Users/dev/web', { kind: 'editor', id: 'cursor' })).rejects.toThrow('That app is not installed');
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
        const deps = systemOpenWithDeps(async () => '', async () => undefined, () => undefined);
        const root = await scratch();

        await mkdir(join(root, 'web'));
        await writeFile(join(root, 'notes.txt'), '');

        expect(await deps.isFolder(join(root, 'web'))).toBe(true);
        expect(await deps.isFolder(join(root, 'notes.txt'))).toBe(false);
        expect(await deps.isFolder(join(root, 'gone'))).toBe(false);
        expect(await deps.realPath(join(root, 'web'))).toBe(await realpath(join(root, 'web')));
        expect(await deps.realPath(join(root, 'gone'))).toBe(join(root, 'gone'));
        expect(await deps.exists(join(root, 'notes.txt'))).toBe(true);
        expect(await deps.exists(join(root, 'gone'))).toBe(false);
        expect((await deps.list(root)).sort()).toEqual(['notes.txt', 'web']);
        expect(await deps.list(join(root, 'gone'))).toEqual([]);
    });

    test.runIf(process.platform !== 'win32')('follows a link to where a path really is', async () => {
        const deps = systemOpenWithDeps(async () => '', async () => undefined, () => undefined);
        const root = await scratch();

        await mkdir(join(root, 'Real.app'));
        await symlink(join(root, 'Real.app'), join(root, 'docs'));

        expect(await deps.realPath(join(root, 'docs'))).toBe(await realpath(join(root, 'Real.app')));
    });

    test('starts a program with each argument as it is, and no shell reads them', async () => {
        const deps = systemOpenWithDeps(async () => '', async () => undefined, () => undefined);
        const root = await scratch();
        const out = join(root, 'argv.json');
        const folder = 'my web; $(touch pwned) "q" \'s\' -x';

        await deps.launch(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))', out, folder]);

        await vi.waitFor(async () => expect(JSON.parse(await readFile(out, 'utf8'))).toEqual([folder]), { timeout: 10_000 });
    });

    test.runIf(process.platform === 'darwin')('rejects when `open` cannot start the app it is told to', async () => {
        const deps = systemOpenWithDeps(async () => '', async () => undefined, () => undefined);
        const root = await scratch();

        await expect(deps.launch('open', ['-a', join(root, 'Missing.app'), root])).rejects.toThrow('open failed');
    });

    test('rejects when the program cannot be started', async () => {
        const deps = systemOpenWithDeps(async () => '', async () => undefined, () => undefined);
        const root = await scratch();

        await expect(deps.launch(join(root, 'no-such-program'), [root])).rejects.toThrow();
    });
});
