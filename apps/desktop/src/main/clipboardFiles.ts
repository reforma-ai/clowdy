import { cp, lstat, realpath, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Clipboard, ClipboardItem } from 'electron';
import type { ClipboardFile } from '../shared/bridge';

/** The most files and folders one copy puts on the clipboard. */
const MAX_COPIED = 10_000;

/** What the files on the system clipboard need from the machine, so reading, writing and pasting can be tried without one. */
export interface ClipboardFilesDeps {
    platform: NodeJS.Platform;
    /** The `file:` addresses the system clipboard holds, one for each file or folder that was copied; none when it holds something else. */
    readUris: () => Promise<string[]>;
    /** Replaces the clipboard with these files, and with `text` for the places that take only text. */
    writeUris: (uris: readonly string[], text: string) => Promise<void>;
    /** What the path is, a link followed, or nothing when it is gone or cannot be read. */
    kindOf: (path: string) => Promise<ClipboardFile['kind'] | undefined>;
    /** Whether anything is at the path: a link counts, even one that goes nowhere. */
    exists: (path: string) => Promise<boolean>;
    /** Where the path really is, its links followed; the path itself when that cannot be told. */
    realPath: (path: string) => Promise<string>;
    /** Copies a file or a folder with everything in it, and never over what is there. */
    copy: (from: string, to: string) => Promise<void>;
}

/** What the person copied, one entry for each file or folder. */
export interface ClipboardFiles {
    /** The files and folders on the clipboard that are still on the disk, in the order they were copied. */
    read: () => Promise<ClipboardFile[]>;
    /** Puts files and folders on the clipboard, as the system's file manager does: they paste as files into it and into other programs, and as their paths into a text field. */
    write: (paths: unknown) => Promise<void>;
    /**
     * Copies files and folders of the clipboard into `folder`, each under the name given with it. The page names the entries by their paths, but only to say
     * which of what is on the clipboard now goes under which name: a path that is not there is refused. That keeps a page from copying a file it did not put on
     * the clipboard first; it is no wall against a page that can write the clipboard itself, which the daemon's shell lets it do anyway. Every name is checked
     * before the first copy is made: a name that is taken is refused rather than replaced, and so is a folder copied into itself. A copy that fails while it runs
     * leaves what was copied until then, and the error says what failed.
     */
    paste: (folder: unknown, items: unknown) => Promise<void>;
}

/** The deps for the real clipboard and disk. `clipboard` and `ClipboardItem` are Electron's. */
export function systemClipboardFilesDeps(
    clipboard: Pick<Clipboard, 'read' | 'write'>,
    Item: typeof ClipboardItem,
    platform: NodeJS.Platform = process.platform
): ClipboardFilesDeps {
    return {
        platform,
        readUris: async () => {
            const uris: string[] = [];

            for (const item of await clipboard.read()) {
                if (!item.types.includes('text/uri-list')) continue;

                const text = await (await item.getType('text/uri-list')).text();

                uris.push(...text.split(/\r?\n/).filter(line => line !== ''));
            }

            return uris;
        },
        writeUris: (uris, text) =>
            clipboard.write([new Item({ 'text/plain': text, 'text/uri-list': uris.join('\r\n') })]),
        kindOf: async path => {
            try {
                const found = await stat(path);

                return found.isDirectory() ? 'directory' : found.isFile() ? 'file' : undefined;
            } catch {
                return undefined;
            }
        },
        exists: path =>
            lstat(path).then(
                () => true,
                () => false
            ),
        realPath: path => realpath(path).catch(() => path),
        copy: (from, to) => cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true }),
    };
}

/** The names Windows keeps for devices, which a file cannot be named, with or without an extension. */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;

export function createClipboardFiles({
    platform,
    readUris,
    writeUris,
    kindOf,
    exists,
    realPath,
    copy,
}: ClipboardFilesDeps): ClipboardFiles {
    const api = platform === 'win32' ? win32 : posix;
    const windows = platform === 'win32';

    /** `path` without the separator at its end that a folder's address may have, a root (`/`, `C:\`) excepted. */
    const withoutTrailingSeparator = (path: string) =>
        (windows ? !/^[A-Za-z]:[\\/]*$/.test(path) && /[\\/]$/.test(path) : path.length > 1 && path.endsWith('/'))
            ? path.replace(windows ? /[\\/]+$/ : /\/+$/, '')
            : path;

    /** Whether `name` is one plain name: nothing that would take it out of the folder it is made in, or onto a device or into a stream of another file on Windows. */
    const isPlainName = (name: unknown): name is string =>
        typeof name === 'string' &&
        name !== '' &&
        name !== '.' &&
        name !== '..' &&
        !/[\\/\0]/.test(name) &&
        (!windows || !(/[<>:"|?*]/.test(name) || /[. ]$/.test(name) || DEVICE_NAME.test(name)));

    /** Whether `path` is inside the folder `parent`. */
    const isInside = (path: string, parent: string) => {
        const relative = api.relative(parent, path);

        return (
            relative !== '' && relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative)
        );
    };

    async function read(): Promise<ClipboardFile[]> {
        const files: ClipboardFile[] = [];
        const seen = new Set<string>();

        for (const uri of await readUris()) {
            let path: string;

            try {
                path = fileURLToPath(uri, { windows });
            } catch {
                // An address that is not a file's.
                continue;
            }

            path = withoutTrailingSeparator(path);

            if (seen.has(path)) continue;

            seen.add(path);

            const kind = await kindOf(path);

            if (kind) files.push({ path, name: api.basename(path), kind });
        }

        return files;
    }

    async function write(paths: unknown): Promise<void> {
        if (
            !Array.isArray(paths) ||
            paths.length === 0 ||
            paths.length > MAX_COPIED ||
            !paths.every((path): path is string => typeof path === 'string' && api.isAbsolute(path))
        ) {
            throw new Error('Bad paths');
        }

        await writeUris(
            paths.map(path => pathToFileURL(path, { windows }).href),
            paths.join('\n')
        );
    }

    async function paste(folder: unknown, items: unknown): Promise<void> {
        if (
            typeof folder !== 'string' ||
            !api.isAbsolute(folder) ||
            !Array.isArray(items) ||
            items.length === 0 ||
            items.length > MAX_COPIED
        ) {
            throw new Error('Bad paste');
        }

        const wanted = items.map((item: unknown) => {
            const { path, name } = (typeof item === 'object' && item !== null ? item : {}) as {
                path?: unknown;
                name?: unknown;
            };

            if (typeof path !== 'string' || !isPlainName(name)) throw new Error('Bad paste');

            return { path, name };
        });

        if (new Set(wanted.map(item => item.name)).size < wanted.length) throw new Error('Bad paste');

        if ((await kindOf(folder)) !== 'directory') throw new Error('The folder is gone');

        const held = await read();

        // Every copy is checked before the first one is made, so a refusal leaves the folder as it was.
        const copies = wanted.map(({ path, name }) => {
            const source = held.find(file => file.path === path);

            if (!source) throw new Error('The copied files have changed');

            return { source, to: api.join(folder, name) };
        });
        // Where the folder really is: a link in its path may lead into the folder that is copied, which the spelling of the path does not show.
        const real = await realPath(folder);

        for (const { source, to } of copies) {
            if (source.kind === 'directory') {
                const from = await realPath(source.path);

                if (real === from || isInside(real, from) || isInside(to, source.path))
                    throw new Error(`${source.name} can’t be copied into itself`);
            }

            if (await exists(to)) throw new Error(`${api.basename(to)} already exists`);
        }

        for (const { source, to } of copies) await copy(source.path, to);
    }

    return { read, write, paste };
}
