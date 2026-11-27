import { realpathSync } from 'node:fs';
import { isMarkdownFile } from '@clowdy/protocol';

import { isBelow } from '../fs/paths';

/** Whether a name is a document: a Markdown file. */
export const isDocFile = isMarkdownFile;

/**
 * The real path of `path` when, its links followed, it lies below `folder` (never the folder itself); `undefined` when it leads elsewhere or
 * cannot be resolved. A source of documents (`.briefback`, `.clowdy/docs`, `specs`) must pass this before anything is read or listed in it.
 */
export function realPathBelow(folder: string, path: string): string | undefined {
    try {
        const real = realpathSync.native(path);

        return isBelow(realpathSync.native(folder), real) ? real : undefined;
    } catch {
        return undefined;
    }
}
