import { realpathSync } from 'node:fs';
import { sep } from 'node:path';

export const CLOWDY_DIR = '.clowdy';
export const DOCS_DIR = `${ CLOWDY_DIR }/docs`;

const DOC_EXTENSION = /\.(md|markdown)$/i;

export const isDocFile = (name: string) => DOC_EXTENSION.test(name);

/**
 * The real path of `path` when, its links followed, it lies below `folder` (never the folder itself); `undefined` when it leads elsewhere or
 * cannot be resolved. A folder's `.clowdy` and `.clowdy/docs` must pass this before anything is read, listed or made in them.
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
