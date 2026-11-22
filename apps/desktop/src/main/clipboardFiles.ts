import { cp, stat } from 'node:fs/promises';
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
    /** What the path is, or nothing when it is gone or cannot be read. */
    kindOf: (path: string) => Promise<ClipboardFile['kind'] | undefined>;
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
     * Copies files and folders of the clipboard into `folder`, each under the name given with it. The page names the entries by their paths,
     * but only to say which of what is on the clipboard now goes under which name: a path that is not there is refused, so the page can copy
     * nothing it was not given by the person. A name that is taken is refused rather than replaced.
     */
    paste: (folder: unknown, items: unknown) => Promise<void>;
}

/** The deps for the real clipboard and disk. `clipboard` and `ClipboardItem` are Electron's. */
export function systemClipboardFilesDeps(clipboard: Pick<Clipboard, 'read' | 'write'>, Item: typeof ClipboardItem, platform: NodeJS.Platform = process.platform): ClipboardFilesDeps {
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
        writeUris: (uris, text) => clipboard.write([new Item({ 'text/plain': text, 'text/uri-list': uris.join('\r\n') })]),
        kindOf: async (path) => {
            try {
                const found = await stat(path);

                return found.isDirectory() ? 'directory' : found.isFile() ? 'file' : undefined;
            }
            catch {
                return undefined;
            }
        },
        copy: (from, to) => cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true }),
    };
}

/** Whether `name` is one plain name: nothing that would take it out of the folder it is made in. */
function isPlainName(name: unknown): name is string {
    return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && !/[\\/\0]/.test(name);
}

export function createClipboardFiles({ platform, readUris, writeUris, kindOf, copy }: ClipboardFilesDeps): ClipboardFiles {
    const api = platform === 'win32' ? win32 : posix;
    const windows = platform === 'win32';

    /** Whether `path` is inside the folder `parent`. */
    const isInside = (path: string, parent: string) => {
        const relative = api.relative(parent, path);

        return relative !== '' && !relative.startsWith('..') && !api.isAbsolute(relative);
    };

    async function read(): Promise<ClipboardFile[]> {
        const files: ClipboardFile[] = [];
        const seen = new Set<string>();

        for (const uri of await readUris()) {
            let path: string;

            try {
                path = fileURLToPath(uri, { windows });
            }
            catch {
                // An address that is not a file's.
                continue;
            }

            if (seen.has(path)) continue;

            seen.add(path);

            const kind = await kindOf(path);

            if (kind) files.push({ path, name: api.basename(path), kind });
        }

        return files;
    }

    async function write(paths: unknown): Promise<void> {
        if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_COPIED || !paths.every((path): path is string => typeof path === 'string' && api.isAbsolute(path))) {
            throw new Error('Bad paths');
        }

        await writeUris(paths.map(path => pathToFileURL(path, { windows }).href), paths.join('\n'));
    }

    async function paste(folder: unknown, items: unknown): Promise<void> {
        if (typeof folder !== 'string' || !api.isAbsolute(folder) || !Array.isArray(items) || items.length === 0 || items.length > MAX_COPIED) {
            throw new Error('Bad paste');
        }

        const wanted = items.map((item: unknown) => {
            const { path, name } = (typeof item === 'object' && item !== null ? item : {}) as { path?: unknown; name?: unknown };

            if (typeof path !== 'string' || !isPlainName(name)) throw new Error('Bad paste');

            return { path, name };
        });

        if (new Set(wanted.map(item => item.name)).size < wanted.length) throw new Error('Bad paste');

        if (await kindOf(folder) !== 'directory') throw new Error('The folder is gone');

        const held = await read();

        // Every copy is checked before the first one is made, so a refusal leaves the folder as it was.
        const copies = wanted.map(({ path, name }) => {
            const source = held.find(file => file.path === path);

            if (!source) throw new Error('The copied files have changed');

            return { source, to: api.join(folder, name) };
        });

        for (const { source, to } of copies) {
            if (source.kind === 'directory' && isInside(to, source.path)) throw new Error(`${ source.name } can’t be copied into itself`);

            if (await kindOf(to)) throw new Error(`${ api.basename(to) } already exists`);
        }

        for (const { source, to } of copies) await copy(source.path, to);
    }

    return { read, write, paste };
}
