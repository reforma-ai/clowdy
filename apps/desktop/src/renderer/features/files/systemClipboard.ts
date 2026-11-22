import { absolutePath } from '../openWith';

import type { ClipboardEntry, FileClipboard } from '@clowdy/file-manager';
import type { DesktopBridge } from '../../../shared/bridge';

type ClipboardBridge = Pick<DesktopBridge, 'readClipboardFiles' | 'writeClipboardFiles' | 'pasteClipboardFiles'>;

/** A path with `/` between its parts, and in lower case when it is a Windows one, where `C:\\Web` and `c:\\web` are the same folder. */
function comparable(path: string): string {
    const slashed = path.replaceAll('\\', '/');

    return /^[A-Za-z]:/.test(slashed) ? slashed.toLowerCase() : slashed;
}

/** The path of `file` from `root` with `/` between its parts, or nothing when the file is not inside the folder. */
export function pathInside(root: string, file: string): string | undefined {
    const base = comparable(root).replace(/\/+$/, '');
    const target = comparable(file);

    if (!target.startsWith(`${ base }/`)) return undefined;

    // The case of the file's own name is kept: only the folder's part was compared in lower case.
    return file.replaceAll('\\', '/').slice(base.length + 1);
}

/**
 * The system clipboard's files for the file manager of one folder, over the desktop app's bridge. The manager names items of the folder by their paths from its
 * root, and the bridge knows only the disk's absolute ones, so the root is added on the way out and taken off, where the file is inside it, on the way in.
 */
export function systemFileClipboard(bridge: ClipboardBridge, root: string): FileClipboard {
    return {
        write: paths => bridge.writeClipboardFiles(paths.map(path => absolutePath(root, path))),
        read: async () => (await bridge.readClipboardFiles()).map((file): ClipboardEntry => {
            const local = pathInside(root, file.path);

            return { ...file, ...(local === undefined ? {} : { local }) };
        }),
        paste: (folder, items) => bridge.pasteClipboardFiles(absolutePath(root, folder), items),
    };
}

/** The clipboard of a folder's file manager: the system's in the desktop app, none in a page that is not (a browser has no way to name a file of the disk). */
export function clipboardOf(root: string | undefined): FileClipboard | undefined {
    const bridge = window.desktop;

    // A shell older than this renderer lacks the three methods together.
    return root !== undefined && bridge?.readClipboardFiles !== undefined ? systemFileClipboard(bridge, root) : undefined;
}
