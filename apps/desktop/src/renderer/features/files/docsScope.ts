import { docSourcesOf, isDocumentPath, isMarkdownFile } from '@clowdy/protocol';

import type { FileManager } from '@clowdy/file-manager';
import type { ExplorerScope } from '@clowdy/file-manager/react';

export { isDocumentPath };

/**
 * Where `.clowdy/docs` is, the folder of project documents the agents' skills still write to, and the one a task's document result names (its path is below it). It is one
 * source of the Docs tab among the others (`DOC_SOURCES` of the protocol), not the only one.
 */
export const DOCS_ROOT = '.clowdy/docs';

/**
 * The order of the documents found for the words typed: the ones whose name starts with the first word first, then the ones whose name has it, then the ones only the path has,
 * and, of those, the shorter name first (`pricing.md` before `pricing-notes.md`). The order they came in is kept where they tie, which is the sources' order and their trees',
 * so Briefback comes first. For a list that is cut short, the `@` menu and the quick search's Docs tab, so that one source does not fill it.
 */
export function compareDocs(query: string): (a: string, b: string) => number {
    const first = query.toLowerCase().split(/\s+/).find(Boolean) ?? '';
    const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    const score = (name: string) => (name.startsWith(first) ? 0 : name.includes(first) ? 1 : 2);

    return (a, b) => score(nameOf(a)) - score(nameOf(b)) || nameOf(a).length - nameOf(b).length;
}

const scopes = new WeakMap<FileManager, ExplorerScope>();

/**
 * The part of the file tree the Docs tab draws: the roots the project has (Briefback, `.clowdy/docs`, Spec Kit, OpenSpec, Kiro: `docSourcesOf` over the entries the tree holds,
 * so a root that an agent creates later shows up through the file manager's watch), each under a gray label, with its Markdown files and the folders that hold them in
 * the file tree's own rows, whatever the hidden globs say of the dot folder a root is in. A new file is a document: it gets `.md` when the name has no Markdown extension.
 * One scope for each manager, so that the explorer sees the same object while the manager lives. A folder that has no source yet has `.clowdy/docs` for its only root (a
 * root that holds nothing is not drawn, but a new file can be made in it), so the first document can be made from the tab.
 */
export function docsScopeOf(manager: FileManager): ExplorerScope {
    let scope = scopes.get(manager);

    if (!scope) {
        scope = {
            get roots() {
                const found = docSourcesOf(path => manager.tree.get(path)?.kind === 'directory').map(
                    ({ id, label, root }) => ({ id, label, root })
                );

                // A folder with no source still takes its first document: it is made in `.clowdy/docs`, which is drawn once it holds one.
                return found.length > 0 ? found : [{ id: 'documents', label: 'Documents', root: DOCS_ROOT }];
            },
            label: 'Documents',
            include: (path, kind) => kind === 'directory' || isMarkdownFile(path),
            fileName: name => (isMarkdownFile(name) ? name : `${name}.md`),
        };
        scopes.set(manager, scope);
    }

    return scope;
}
