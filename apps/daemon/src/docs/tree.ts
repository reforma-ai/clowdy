import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { CommandError, invalid, unavailable } from '../errors';
import { DOCS_DIR, isDocFile, realPathBelow } from './paths';

import type { DocNode, DocsTree, Project, ProjectFolder } from '@clowdy/protocol';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * The documents under `root`: Markdown files and folders only, folders first, names in natural order
 * (`doc2` before `doc10`). Symbolic links are not listed.
 */
export function listDocs(root: string, relative = ''): DocNode[] {
    const nodes: DocNode[] = [];

    for (const entry of readdirSync(relative ? `${ root }/${ relative }` : root, { withFileTypes: true })) {
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

/**
 * The real path of a folder's docs folder, or `undefined` while it does not exist (nothing makes it for a read). A missing folder and a docs
 * folder that is not a folder are `unavailable`; one that is a link out of its folder is `invalid`.
 */
function docsRoot(folder: ProjectFolder): string | undefined {
    if (!existsSync(folder.path)) {
        throw unavailable(`The folder ${ folder.path } is missing`);
    }

    const docs = join(folder.path, DOCS_DIR);

    if (!existsSync(docs)) {
        return undefined;
    }

    if (!statSync(docs).isDirectory()) {
        throw unavailable(`${ DOCS_DIR } in ${ basename(folder.path) } is not a folder`);
    }

    const root = realPathBelow(folder.path, docs);

    if (!root) {
        throw invalid(`The docs folder of ${ basename(folder.path) } leads out of it`);
    }

    return root;
}

/**
 * The documents of a project, one entry per folder in the project's order. The main folder's must be readable, since the project cannot work
 * without it: a missing main folder is `unavailable`, a docs folder that leads out of it `invalid`. Another folder whose documents cannot be read
 * (missing, or its docs folder leads out of it) is left out. A folder without a docs folder has no documents, and a read does not make one.
 * Nothing here writes or watches: the files are the file system's, which the app opens and edits through `fs`.
 */
export function docsTree(project: Project): DocsTree {
    return project.folders.flatMap((folder, index) => {
        try {
            const root = docsRoot(folder);

            return [{ folderId: folder.id, nodes: root ? listDocs(root) : [] }];
        }
        catch (error) {
            if (index === 0 || !(error instanceof CommandError)) {
                throw error;
            }

            return [];
        }
    });
}
