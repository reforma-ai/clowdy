import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

import { invalid } from '../errors';

export const CLOWDY_DIR = '.clowdy';
export const DOCS_DIR = `${ CLOWDY_DIR }/docs`;
export const MAX_DOC_BYTES = 5 * 1024 * 1024;

const DOC_EXTENSION = /\.(md|markdown)$/i;

export const isDocFile = (name: string) => DOC_EXTENSION.test(name);

/** What the file system says about a path that cannot exist, as the client may hear it (no absolute paths). */
const UNUSABLE_PATH = {
    ENOTDIR: 'A part of the document path is a file, not a folder',
    ENAMETOOLONG: 'A name in the document path is too long',
    ELOOP: 'The document path runs through a loop of symbolic links',
} as const;

/**
 * Validates a client-supplied path and returns it normalized: `/`-separated, relative, no `.` or empty segments.
 * Rejects absolute paths, drive letters, backslashes, `..` and NUL.
 */
export function normalizeDocPath(input: string): string {
    if (typeof input !== 'string' || input === '') {
        throw invalid('The document path is empty');
    }

    if (input.includes('\0')) {
        throw invalid('The document path contains a NUL byte');
    }

    if (input.includes('\\') || input.startsWith('/') || /^[A-Za-z]:/.test(input)) {
        throw invalid('The document path must be relative and use "/" separators');
    }

    const segments = input.split('/').filter(segment => segment !== '' && segment !== '.');

    if (segments.includes('..')) {
        throw invalid('The document path must not contain ".."');
    }

    if (segments.length === 0) {
        throw invalid('The document path is empty');
    }

    return segments.join('/');
}

function isInside(root: string, path: string): boolean {
    return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

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

/**
 * Resolves a normalized relative path under the real docs root and checks that following symbolic links does not
 * leave the root. A file that does not exist yet is judged by its deepest existing ancestor.
 */
export function resolveInside(root: string, relative: string): string {
    const target = join(root, ...relative.split('/'));
    let probe = target;

    for (;;) {
        try {
            const real = realpathSync.native(probe);

            if (!isInside(root, real)) {
                throw invalid('The document path leaves the docs folder');
            }

            return target;
        }
        catch (error) {
            const { code } = error as NodeJS.ErrnoException;

            if (code === 'ENOTDIR' || code === 'ENAMETOOLONG' || code === 'ELOOP') {
                throw invalid(UNUSABLE_PATH[code]);
            }

            if (code !== 'ENOENT') {
                throw error;
            }
        }

        // ENOENT: a missing entry, or a symbolic link whose target is missing. The latter is never safe to write through.
        try {
            if (lstatSync(probe).isSymbolicLink()) {
                throw invalid('The document path is a dangling symbolic link');
            }
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }

        const parent = dirname(probe);

        if (parent === probe) {
            throw invalid('The document path cannot be resolved');
        }

        probe = parent;
    }
}
