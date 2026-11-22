import { isMarkdownFile } from '@clowdy/protocol';
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';

/** Whether a name is a document: a Markdown file. */
export const isDocFile = isMarkdownFile;

/**
 * The real path of `path` when, its links followed, it lies below `folder` (never the folder itself); `undefined` when it leads elsewhere or
 * cannot be resolved. A source of documents (`.briefback`, `.clowdy/docs`, `specs`) must pass this before anything is read or listed in it.
 */
export function realPathBelow(folder: string, path: string): string | undefined {
    try {
        const real = realpathSync.native(path);

        return real.startsWith(realpathSync.native(folder) + sep) ? real : undefined;
    }
    catch {
        return undefined;
    }
}
