import { spawn } from 'node:child_process';
import { access, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

import { EDITORS, FILE_MANAGERS, MAC_APP_FOLDERS, TERMINALS, type FileManagerSpec, type TerminalSpec } from './openWithCatalog';

import type { OpenApp, OpenApps, OpenFolderApp } from '../shared/bridge';

/** What opening a folder needs from the machine, so the search and the launch can be tried without one. */
export interface OpenWithDeps {
    platform: NodeJS.Platform;
    home: string;
    env: Readonly<Record<string, string | undefined>>;
    /** The names in a folder, or none when it cannot be read. */
    list: (folder: string) => Promise<string[]>;
    exists: (path: string) => Promise<boolean>;
    isFolder: (path: string) => Promise<boolean>;
    /** Opens a folder in the system's file manager (`shell.openPath`): an error text, or an empty one. */
    openPath: (path: string) => Promise<string>;
    /** Starts a program and does not wait for it. Rejects when it cannot be started. */
    launch: (command: string, args: readonly string[]) => Promise<void>;
    /** The icon of a program as a `data:` image, or nothing when it cannot be read. */
    icon: (path: string) => Promise<string | undefined>;
}

/** A program found on this machine: where it is (the app bundle, or the executable), or empty for the system's own file manager. */
interface Found {
    id: string;
    name: string;
    path: string;
    /** The arguments that start it in a folder, when it takes more than the folder (a terminal that has to be told where to open). */
    args?: TerminalSpec['args'];
    /** Where the icon is read from: the program itself, or for the system's file manager a place of its own; empty when there is none. */
    iconPath: string;
}

export interface OpenWith {
    /** The editors, terminals and file managers this machine has, with their icons, in the order of the catalog; the system's file manager is first. */
    listApps: () => Promise<OpenApps>;
    /** Opens `folder` in the app. Rejects when the folder is not there or the app cannot be started. */
    openFolder: (folder: unknown, app: unknown) => Promise<void>;
}

const escapeRegExp = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

export function createOpenWith(deps: OpenWithDeps): OpenWith {
    const { platform, home, env, list, exists } = deps;
    /** The icons read so far: a program keeps its icon for as long as the app runs, and one that could not be read is tried again. */
    const icons = new Map<string, string>();

    /** The apps in the folders macOS keeps them in, the same name in two folders counted once, the first folder winning. */
    async function macApps(): Promise<Array<{ name: string; path: string }>> {
        const apps = new Map<string, string>();

        for (const folder of MAC_APP_FOLDERS) {
            const directory = folder.startsWith('~/') ? posix.join(home, folder.slice(2)) : folder;

            for (const entry of (await list(directory)).sort()) {
                const name = entry.endsWith('.app') ? entry.slice(0, -4) : undefined;

                if (name !== undefined && !apps.has(name)) apps.set(name, posix.join(directory, entry));
            }
        }

        return [...apps].map(([name, path]) => ({ name, path }));
    }

    /** `%NAME%` filled from the environment, or nothing when one of them is not set. */
    function fill(template: string): string | undefined {
        let missing = false;
        const filled = template.replace(/%([^%]+)%/g, (_, name: string) => {
            const value = env[name];

            missing ||= value === undefined;

            return value ?? '';
        });

        return missing ? undefined : filled;
    }

    /** The first file the path names, where a `*` in a part stands for any folder of that name; the newest of them (by name) first. */
    async function walk(parts: readonly string[], base: string): Promise<string | undefined> {
        const [head, ...rest] = parts;

        if (head === undefined) return await exists(base) ? base : undefined;

        if (!head.includes('*')) return walk(rest, win32.join(base, head));

        const pattern = new RegExp(`^${ head.split('*').map(escapeRegExp).join('.*') }$`, 'i');

        for (const entry of (await list(base)).sort().reverse()) {
            if (!pattern.test(entry)) continue;

            const found = await walk(rest, win32.join(base, entry));

            if (found) return found;
        }

        return undefined;
    }

    async function windowsProgram(templates: readonly string[]): Promise<string | undefined> {
        for (const template of templates) {
            const path = fill(template);
            const [drive, ...parts] = path?.split('\\').filter(Boolean) ?? [];

            if (drive === undefined) continue;

            const found = await walk(parts, `${ drive }\\`);

            if (found) return found;
        }

        return undefined;
    }

    /** The programs of a catalog this machine has, in the catalog's order (an editor's spec fits: it has no `args`). */
    async function programs(specs: readonly TerminalSpec[]): Promise<Found[]> {
        const found: Found[] = [];

        if (platform === 'darwin') {
            const apps = await macApps();

            for (const spec of specs) {
                const app = spec.mac && apps.find(candidate => spec.mac!.test(candidate.name));

                if (app) found.push({ id: spec.id, name: spec.name, path: app.path, iconPath: app.path, args: spec.args });
            }
        }
        else if (platform === 'win32') {
            for (const spec of specs) {
                const path = await windowsProgram(spec.win);

                if (path) found.push({ id: spec.id, name: spec.name, path, iconPath: path, args: spec.args });
            }
        }

        return found;
    }

    const editors = () => programs(EDITORS);
    const terminals = () => programs(TERMINALS);

    async function fileManagers(): Promise<Found[]> {
        const specs: readonly FileManagerSpec[] = platform === 'darwin' || platform === 'win32' ? FILE_MANAGERS[platform] : [];
        const apps = platform === 'darwin' ? await macApps() : [];
        const found: Found[] = [];

        for (const spec of specs) {
            if (spec.system) {
                found.push({ id: spec.id, name: spec.name, path: '', iconPath: (spec.icon && fill(spec.icon)) || '' });
                continue;
            }

            const app = spec.mac && apps.find(candidate => spec.mac!.test(candidate.name));

            if (app) found.push({ id: spec.id, name: spec.name, path: app.path, iconPath: app.path });
        }

        return found;
    }

    async function iconOf(path: string): Promise<string | undefined> {
        if (path === '') return undefined;

        const known = icons.get(path);

        if (known) return known;

        const icon = await deps.icon(path);

        if (icon) icons.set(path, icon);

        return icon;
    }

    /** What the page is told about a program: no path (the page never says where to start anything), and the icon when there is one. */
    async function describe({ id, name, iconPath }: Found): Promise<OpenApp> {
        const icon = await iconOf(iconPath);

        return icon ? { id, name, icon } : { id, name };
    }

    const isAbsolute = platform === 'win32' ? win32.isAbsolute : posix.isAbsolute;

    return {
        async listApps() {
            const describeAll = async (found: Promise<Found[]>) => Promise.all((await found).map(describe));
            const [editorApps, terminalApps, managerApps] = await Promise.all([describeAll(editors()), describeAll(terminals()), describeAll(fileManagers())]);

            return { editors: editorApps, terminals: terminalApps, fileManagers: managerApps };
        },

        async openFolder(folder, app) {
            // The page asked, so nothing it sends is trusted: a folder that is there, and one of the programs this machine has.
            if (typeof folder !== 'string' || !isAbsolute(folder)) throw new Error('Not a folder');

            if (typeof app !== 'object' || app === null) throw new Error('Unknown app');

            const { kind, id } = app as Partial<OpenFolderApp>;

            if ((kind !== 'editor' && kind !== 'terminal' && kind !== 'fileManager') || typeof id !== 'string') throw new Error('Unknown app');

            if (!await deps.isFolder(folder)) throw new Error('The folder no longer exists');

            const candidates = kind === 'editor' ? await editors() : kind === 'terminal' ? await terminals() : await fileManagers();
            const found = candidates.find(candidate => candidate.id === id);

            if (!found) throw new Error('That app is not installed');

            // The system's own file manager is opened by the system; every other program is told the folder, as a path and not as text for a shell.
            if (found.path === '') {
                const problem = await deps.openPath(folder);

                if (problem) throw new Error(problem);

                return;
            }

            // A program that is told where to open by its arguments is started as a new instance on macOS, since a running one would not read them.
            const args = found.args?.(folder);

            if (platform === 'darwin') await deps.launch('open', args ? ['-n', '-a', found.path, '--args', ...args] : ['-a', found.path, folder]);
            else await deps.launch(found.path, args ?? [folder]);
        },
    };
}

/** The real machine: its files, its environment, `openPath` of Electron's `shell`, and the way Electron reads an icon. */
export function systemOpenWithDeps(openPath: OpenWithDeps['openPath'], icon: OpenWithDeps['icon']): OpenWithDeps {
    return {
        platform: process.platform,
        home: homedir(),
        env: process.env,
        list: folder => readdir(folder).catch(() => []),
        exists: path => access(path).then(() => true, () => false),
        isFolder: path => stat(path).then(info => info.isDirectory(), () => false),
        openPath,
        icon,
        launch: (command, args) => new Promise<void>((resolve, reject) => {
            const child = spawn(command, [...args], { detached: true, stdio: 'ignore' });

            child.once('error', reject);

            // macOS's `open` hands the folder to the app and exits at once, and its exit code says whether the app could be started.
            // Any other program may stay running for as long as the person works in it, so it is enough that it started.
            if (command === 'open') {
                child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`open failed with code ${ code }`))));

                return;
            }

            child.once('spawn', () => {
                child.unref();
                resolve();
            });
        }),
    };
}
