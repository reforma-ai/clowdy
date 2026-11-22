import { docSourcesOf } from '@clowdy/protocol';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { CommandError, unavailable } from '../errors';
import { isDocFile, realPathBelow } from './paths';

import type { DocNode, DocsSource, DocsTree, Project, ProjectFolder } from '@clowdy/protocol';
import type { Dirent } from 'node:fs';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * The documents under `root`: Markdown files and folders only, folders first, names in natural order
 * (`doc2` before `doc10`). Symbolic links are not listed, and a folder that cannot be read lists nothing.
 */
export function listDocs(root: string, relative = ''): DocNode[] {
    const nodes: DocNode[] = [];
    let entries: Dirent[];

    try {
        entries = readdirSync(relative ? `${ root }/${ relative }` : root, { withFileTypes: true });
    }
    catch {
        return nodes;
    }

    for (const entry of entries) {
        const path = relative ? `${ relative }/${ entry.name }` : entry.name;

        if (entry.isDirectory()) {
            nodes.push({ path, name: entry.name, kind: 'dir', children: listDocs(root, path) });
        }
        else if (entry.isFile() && isDocFile(entry.name)) {
            nodes.push({ path, name: entry.name, kind: 'file' });
        }
    }

    return nodes.sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === 'dir' ? -1 : 1));
}

/** Whether `path` is a folder (a link to one is, and `realPathBelow` decides whether it may be read). */
function isFolder(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}

/** Whether a tree has a document in it, at any depth. */
const hasDocument = (nodes: readonly DocNode[]): boolean => nodes.some(node => (node.kind === 'file' ? true : hasDocument(node.children ?? [])));

/**
 * The document sources a folder has, each with its Markdown tree: the roots of the registry (`DOC_SOURCES`) that are folders on the disk, in its order. A root that is a link
 * out of the folder is left out (nothing is read through it, and it does not take the others down: a `specs` that is a link to a shared folder is no reason to list no
 * documents), and so is one with no Markdown file in it. Nothing here makes a folder.
 */
function sourcesOf(folder: ProjectFolder): DocsSource[] {
    return docSourcesOf(path => isFolder(join(folder.path, path))).flatMap((source) => {
        const root = realPathBelow(folder.path, join(folder.path, source.root));

        if (!root) {
            return [];
        }

        const nodes = listDocs(root);

        return hasDocument(nodes) ? [{ id: source.id, label: source.label, root: source.root, nodes }] : [];
    });
}

/**
 * The documents of a project, one entry per folder in the project's order, each with the sources it has. The main folder must be there, since the project cannot work
 * without it: a missing main folder is `unavailable`. Another folder that is missing is left out. A folder with no sources has an entry with none. Nothing here writes or
 * watches: the files are the file system's, which the app opens and edits through `fs`.
 */
export function docsTree(project: Project): DocsTree {
    return project.folders.flatMap((folder, index) => {
        try {
            if (!existsSync(folder.path)) {
                throw unavailable(`The folder ${ folder.path } is missing`);
            }

            return [{ folderId: folder.id, sources: sourcesOf(folder) }];
        }
        catch (error) {
            if (index === 0 || !(error instanceof CommandError)) {
                throw error;
            }

            return [];
        }
    });
}
