import type { DocNode } from '@clowdy/protocol';

/**
 * The nodes whose name contains `query` (any case), with the folders above them. A folder that matches keeps
 * everything below it, so searching for a folder name shows its documents.
 */
export function filterTree(nodes: DocNode[], query: string): DocNode[] {
    const needle = query.trim().toLowerCase();

    return needle ? prune(nodes, needle) : nodes;
}

function prune(nodes: DocNode[], needle: string): DocNode[] {
    return nodes.flatMap((node): DocNode[] => {
        if (node.name.toLowerCase().includes(needle)) return [node];

        const children = prune(node.children ?? [], needle);

        return children.length > 0 ? [{ ...node, children }] : [];
    });
}

/** Every file path, in the order the tree shows them. */
export function filePaths(nodes: DocNode[]): string[] {
    return nodes.flatMap(node => (node.kind === 'file' ? [node.path] : filePaths(node.children ?? [])));
}

/** The folders above a path: `a/b/c.md` gives `a` and `a/b`. */
export function ancestorDirs(path: string): string[] {
    const parts = path.split('/').slice(0, -1);

    return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

export interface TreeRow {
    node: DocNode;
    depth: number;
    open: boolean;
}

/** The rows on screen: a folder's children follow it only while it is open. */
export function visibleRows(nodes: DocNode[], isOpen: (dirPath: string) => boolean, depth = 0): TreeRow[] {
    return nodes.flatMap((node): TreeRow[] => {
        const open = node.kind === 'dir' && isOpen(node.path);

        return [{ node, depth, open }, ...open ? visibleRows(node.children ?? [], isOpen, depth + 1) : []];
    });
}
