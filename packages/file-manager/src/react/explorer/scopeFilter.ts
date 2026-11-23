import type { FileTree } from '../../tree/FileTree';
import type { ExplorerFilter, ExplorerScope } from './explorerContext';

/**
 * The files of a scope whose path below its root has every word of `query`, in the form the explorer takes a filter in; none for a query with no words. It looks in
 * every root of the scope (a file is matched on its path below the first root that holds it), reads the tree's own entries, so it finds what is listed (the daemon's
 * search leaves out the folders a scope may be made of), and it is the host of the view that asks again when the tree changes.
 */
export function scopeFilter(tree: FileTree, scope: ExplorerScope, query: string): ExplorerFilter | null {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);

    if (words.length === 0) {
        return null;
    }

    const prefixes = scope.roots.map(({ root }) => (root === '' ? '' : `${root}/`));
    const paths = new Set<string>();

    for (const entry of tree.entries.values()) {
        if (entry.kind !== 'file' || (scope.include && !scope.include(entry.path, entry.kind))) {
            continue;
        }

        const prefix = prefixes.find(candidate => entry.path.startsWith(candidate));

        if (prefix === undefined) {
            continue;
        }

        const below = entry.path.slice(prefix.length).toLowerCase();

        if (words.every(word => below.includes(word))) {
            paths.add(entry.path);
        }
    }

    return { query, paths };
}
