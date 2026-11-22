import { docSourcesOf, isDocumentPath, isMarkdownFile } from '@clowdy/protocol';

import type { FileManager } from '@clowdy/file-manager';
import type { ExplorerScope } from '@clowdy/file-manager/react';

export { isDocumentPath };

/**
 * Where `.clowdy/docs` is, the folder of project documents the agents' skills still write to, and the one a task's document result names (its path is below it). It is one
 * source of the Docs tab among the others (`DOC_SOURCES` of the protocol), not the only one.
 */
export const DOCS_ROOT = '.clowdy/docs';

const scopes = new WeakMap<FileManager, ExplorerScope>();

/**
 * The part of the file tree the Docs tab draws: the roots the project has (Briefback, `.clowdy/docs`, Spec Kit, OpenSpec, Kiro: `docSourcesOf` over the entries the tree holds,
 * so a root that an agent creates later shows up through the file manager's watch), each under a gray label, with its Markdown files and the folders that hold them in
 * the file tree's own rows, whatever the hidden globs say of the dot folder a root is in. A new file is a document: it gets `.md` when the name has no Markdown extension.
 * One scope for each manager, so that the explorer sees the same object while the manager lives.
 */
export function docsScopeOf(manager: FileManager): ExplorerScope {
    let scope = scopes.get(manager);

    if (!scope) {
        scope = {
            get roots() {
                return docSourcesOf(path => manager.tree.get(path)?.kind === 'directory').map(({ id, label, root }) => ({ id, label, root }));
            },
            label: 'Documents',
            include: (path, kind) => kind === 'directory' || isMarkdownFile(path),
            fileName: name => (isMarkdownFile(name) ? name : `${ name }.md`),
        };
        scopes.set(manager, scope);
    }

    return scope;
}
