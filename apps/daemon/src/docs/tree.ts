import { readdirSync } from 'node:fs';

import { isDocFile } from './paths';

import type { DocNode } from '@clowdy/protocol';

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

/** Every path in a tree, folders and files. */
export function flatten(nodes: DocNode[]): string[] {
    return nodes.flatMap(node => [node.path, ...flatten(node.children ?? [])]);
}
