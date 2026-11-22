import type { ExplorerScope } from '@clowdy/file-manager/react';

/** Where a folder's documents are: Markdown files below this path, in the folder the window works in. */
export const DOCS_ROOT = '.clowdy/docs';

/** Whether a path (from the folder's root) is a Markdown file. */
const isMarkdown = (path: string) => /\.(?:md|markdown)$/i.test(path);

/** Whether a path (from the folder's root) is a document: a Markdown file below `DOCS_ROOT`. */
export function isDocumentPath(path: string): boolean {
    return path.startsWith(`${ DOCS_ROOT }/`) && isMarkdown(path);
}

/**
 * The part of the file tree the Docs tab draws: the Markdown files below `.clowdy/docs` and the folders that hold them, in the file tree's own rows, whatever the hidden
 * globs say of the dot folder they are in. A new file is a document: it gets `.md` when the name has no Markdown extension.
 */
export const DOCS_SCOPE: ExplorerScope = {
    roots: [{ id: 'documents', label: 'Documents', root: DOCS_ROOT }],
    label: 'Documents',
    include: (path, kind) => kind === 'directory' || isMarkdown(path),
    fileName: name => (isMarkdown(name) ? name : `${ name }.md`),
};
