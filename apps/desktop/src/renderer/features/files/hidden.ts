/** The hidden files, which the tree shows only when asked to (`TreeLayout.showHidden`): every name that starts with a dot, as on macOS and Linux (a Windows folder has them too), and `node_modules`. Nothing is left out for good. */
export const HIDDEN_GLOBS = ['**/.*', '**/node_modules'];

/** Whether a path (relative, with `/`) is a hidden file, or lies in a hidden folder: the same names as `HIDDEN_GLOBS`, for what is listed without the tree. */
export function isHiddenPath(path: string): boolean {
    return path.split('/').some(name => name.startsWith('.') || name === 'node_modules');
}
