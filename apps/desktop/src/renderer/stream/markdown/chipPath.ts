import { basename } from '@clowdy/lib';

/** The project folder as a message writes it: `.`, `./`, or nothing. */
export function isWorkspaceRoot(path: string): boolean {
    return path === '.' || path === './' || path === '.\\' || path === '';
}

export function isDirectoryPath(path: string | undefined): boolean {
    return typeof path === 'string' && path.endsWith('/') && path.replace(/[/\\]+$/, '').length > 0;
}

/** A path as a message names it, for the chip to show and copy: forward slashes, no leading `./`. An absolute path stays absolute. */
export function normalizeChipPath(path: string): string {
    const normalized = path.trim().replaceAll('\\', '/');

    if (isWorkspaceRoot(normalized)) return '';

    return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

/** What a chip for a path shows: the file or folder name, or `workspace` for the project folder. */
export function chipLabelFromPath(path: string): string {
    const normalized = normalizeChipPath(path);

    return isWorkspaceRoot(normalized) ? 'workspace' : basename(normalized);
}
