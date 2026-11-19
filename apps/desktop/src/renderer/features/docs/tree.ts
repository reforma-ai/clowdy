import type { DocNode, DocsTree, FolderId } from '@clowdy/protocol';

/** A document by where it lives: a folder of the project, and its path under that folder's `.clowdy/docs`. */
export interface DocRef {
    folderId: FolderId;
    path: string;
}

/** One row of the Documents tree: a folder of the project, or a folder or document under its `.clowdy/docs`. */
export interface DocsNode extends DocRef {
    /** Unique across the project's folders (`docKey`); the row of a folder of the project has an empty `path`. */
    key: string;
    name: string;
    kind: 'folder' | 'dir' | 'file';
    children?: DocsNode[];
}

/** What tells a document apart from the documents of the project's other folders, which may have the same path. */
export const docKey = ({ folderId, path }: DocRef): string => (path ? `${ folderId }/${ path }` : folderId);

/**
 * The rows of the Documents tree, from the daemon's answer. One folder lists its documents at the top level, as a project of one folder
 * always has; several put the folders first, in the project's order, each named by `names` and listed even when it has no documents yet.
 */
export function docsNodes(tree: DocsTree, names: ReadonlyMap<FolderId, string>): DocsNode[] {
    const nodesOf = (folderId: FolderId, nodes: readonly DocNode[]): DocsNode[] => nodes.map(node => ({
        key: docKey({ folderId, path: node.path }),
        folderId,
        path: node.path,
        name: node.name,
        kind: node.kind,
        ...node.children && { children: nodesOf(folderId, node.children) },
    }));

    const [only] = tree;

    if (tree.length === 1 && only) return nodesOf(only.folderId, only.nodes);

    return tree.map(({ folderId, nodes }) => ({
        key: docKey({ folderId, path: '' }),
        folderId,
        path: '',
        name: names.get(folderId) ?? folderId,
        kind: 'folder',
        children: nodesOf(folderId, nodes),
    }));
}

/**
 * The nodes whose name contains `query` (any case), with the folders above them. A folder that matches keeps
 * everything below it, so searching for a folder name shows its documents.
 */
export function filterTree(nodes: DocsNode[], query: string): DocsNode[] {
    const needle = query.trim().toLowerCase();

    return needle ? prune(nodes, needle) : nodes;
}

function prune(nodes: DocsNode[], needle: string): DocsNode[] {
    return nodes.flatMap((node): DocsNode[] => {
        if (node.name.toLowerCase().includes(needle)) return [node];

        const children = prune(node.children ?? [], needle);

        return children.length > 0 ? [{ ...node, children }] : [];
    });
}

/** Every document, in the order the tree shows them. */
export function fileNodes(nodes: DocsNode[]): DocsNode[] {
    return nodes.flatMap(node => (node.kind === 'file' ? [node] : fileNodes(node.children ?? [])));
}

/** The folders above a path: `a/b/c.md` gives `a` and `a/b`. */
export function ancestorDirs(path: string): string[] {
    const parts = path.split('/').slice(0, -1);

    return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

/** The keys of the rows above a document or a folder: its folder of the project, then the folders of its path. */
export function ancestorKeys({ folderId, path }: DocRef): string[] {
    return [docKey({ folderId, path: '' }), ...ancestorDirs(path).map(dir => docKey({ folderId, path: dir }))];
}

export interface TreeRow {
    node: DocsNode;
    depth: number;
    open: boolean;
}

/** The rows on screen: a folder's children follow it only while it is open. */
export function visibleRows(nodes: DocsNode[], isOpen: (key: string) => boolean, depth = 0): TreeRow[] {
    return nodes.flatMap((node): TreeRow[] => {
        const open = node.kind !== 'file' && isOpen(node.key);

        return [{ node, depth, open }, ...open ? visibleRows(node.children ?? [], isOpen, depth + 1) : []];
    });
}
