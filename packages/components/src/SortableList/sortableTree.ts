import type { Key } from 'react-aria-components';

export interface SortableTreeNode<T> {
    id: string;
    value: T;
    textValue: string;
    canHaveChildren: boolean;
    children: SortableTreeNode<T>[];
    parent: T | null;
    index: number;
    siblingCount: number;
    level: number;
}

export interface SortableTreeTarget {
    key: Key;
    dropPosition: 'on' | 'before' | 'after';
}

interface BuildSortableTreeOptions<T> {
    getTextValue: (item: T) => string;
    getKey?: (item: T, path: readonly number[]) => string;
    getChildren?: (item: T) => readonly T[];
    canHaveChildren?: (item: T) => boolean;
}

export function buildSortableTree<T>(
    items: readonly T[],
    options: BuildSortableTreeOptions<T>,
    parent: T | null = null,
    path: readonly number[] = []
): SortableTreeNode<T>[] {
    return items.map((item, index) => {
        const childItems = options.getChildren?.(item) ?? [];
        const itemPath = [...path, index];

        return {
            id: options.getKey?.(item, itemPath) ?? `sortable:${itemPath.join('.')}`,
            value: item,
            textValue: options.getTextValue(item),
            canHaveChildren: options.canHaveChildren?.(item) ?? childItems.length > 0,
            children: buildSortableTree(childItems, options, item, itemPath),
            parent,
            index,
            siblingCount: items.length,
            level: itemPath.length,
        };
    });
}

export function restoreSortableTree<T>(
    nodes: readonly SortableTreeNode<T>[],
    setChildren?: (item: T, children: T[]) => T
): T[] {
    return nodes.map(node => {
        if (!setChildren || !node.canHaveChildren) {
            return node.value;
        }

        return setChildren(node.value, restoreSortableTree(node.children, setChildren));
    });
}

export function findSortableTreeNode<T>(nodes: readonly SortableTreeNode<T>[], key: Key): SortableTreeNode<T> | null {
    for (const node of nodes) {
        if (node.id === key) {
            return node;
        }

        const child = findSortableTreeNode(node.children, key);

        if (child) {
            return child;
        }
    }

    return null;
}

export function moveSortableTreeNodes<T>(
    nodes: readonly SortableTreeNode<T>[],
    keys: ReadonlySet<Key>,
    target: SortableTreeTarget
): SortableTreeNode<T>[] {
    const movableKeys = removeDescendantKeys(nodes, keys);
    const extracted: SortableTreeNode<T>[] = [];
    const remaining = extractSortableTreeNodes(nodes, movableKeys, extracted);

    if (extracted.length === 0) {
        return [...nodes];
    }

    const targetNode = findSortableTreeNode(remaining, target.key);

    if (!targetNode || (target.dropPosition === 'on' && !targetNode.canHaveChildren)) {
        return [...nodes];
    }

    const inserted = insertSortableTreeNodes(remaining, target, extracted);

    return inserted ?? [...nodes];
}

export function moveSortableTreeNodesToCollection<T>(
    nodes: readonly SortableTreeNode<T>[],
    keys: ReadonlySet<Key>,
    parentKey: Key | null
): SortableTreeNode<T>[] {
    const movableKeys = removeDescendantKeys(nodes, keys);
    const extracted: SortableTreeNode<T>[] = [];
    const remaining = extractSortableTreeNodes(nodes, movableKeys, extracted);

    if (extracted.length === 0) {
        return [...nodes];
    }

    if (parentKey == null) {
        return refreshSortableTreeMetadata([...remaining, ...extracted.map(node => ({ ...node, parent: null }))]);
    }

    const parent = findSortableTreeNode(remaining, parentKey);

    if (!parent?.canHaveChildren) {
        return [...nodes];
    }

    const inserted = mapSortableTreeNode(remaining, parentKey, node => ({
        ...node,
        children: refreshSortableTreeMetadata([
            ...node.children,
            ...extracted.map(item => ({ ...item, parent: node.value })),
        ]),
    }));

    return inserted ?? [...nodes];
}

export function moveSortableTreeNodeToIndex<T>(
    nodes: readonly SortableTreeNode<T>[],
    key: Key,
    parentKey: Key | null,
    index: number
): SortableTreeNode<T>[] {
    const source = findSortableTreeNode(nodes, key);

    const movesIntoDescendant =
        source != null && parentKey != null && findSortableTreeNode(source.children, parentKey) != null;

    if (!source || parentKey === key || movesIntoDescendant) {
        return [...nodes];
    }

    const extracted: SortableTreeNode<T>[] = [];
    const remaining = extractSortableTreeNodes(nodes, new Set([key]), extracted);
    const item = extracted[0];

    if (!item) {
        return [...nodes];
    }

    if (parentKey == null) {
        const nextNodes = [...remaining];
        const insertionIndex = Math.max(0, Math.min(index, nextNodes.length));

        nextNodes.splice(insertionIndex, 0, { ...item, parent: null });

        return refreshSortableTreeMetadata(nextNodes);
    }

    const parent = findSortableTreeNode(remaining, parentKey);

    if (!parent?.canHaveChildren) {
        return [...nodes];
    }

    const inserted = mapSortableTreeNode(remaining, parentKey, node => {
        const nextChildren = [...node.children];
        const insertionIndex = Math.max(0, Math.min(index, nextChildren.length));

        nextChildren.splice(insertionIndex, 0, { ...item, parent: node.value });

        return {
            ...node,
            children: refreshSortableTreeMetadata(nextChildren),
        };
    });

    return inserted ?? [...nodes];
}

function removeDescendantKeys<T>(
    nodes: readonly SortableTreeNode<T>[],
    keys: ReadonlySet<Key>,
    ancestorSelected = false,
    result = new Set<Key>()
): Set<Key> {
    for (const node of nodes) {
        const selected = keys.has(node.id);

        if (selected && !ancestorSelected) {
            result.add(node.id);
        }

        removeDescendantKeys(node.children, keys, ancestorSelected || selected, result);
    }

    return result;
}

function extractSortableTreeNodes<T>(
    nodes: readonly SortableTreeNode<T>[],
    keys: ReadonlySet<Key>,
    extracted: SortableTreeNode<T>[]
): SortableTreeNode<T>[] {
    const remaining: SortableTreeNode<T>[] = [];

    for (const node of nodes) {
        if (keys.has(node.id)) {
            extracted.push(node);

            continue;
        }

        remaining.push({
            ...node,
            children: extractSortableTreeNodes(node.children, keys, extracted),
        });
    }

    return refreshSortableTreeMetadata(remaining);
}

function insertSortableTreeNodes<T>(
    nodes: readonly SortableTreeNode<T>[],
    target: SortableTreeTarget,
    inserted: readonly SortableTreeNode<T>[]
): SortableTreeNode<T>[] | null {
    if (target.dropPosition === 'on') {
        return mapSortableTreeNode(nodes, target.key, node => ({
            ...node,
            children: refreshSortableTreeMetadata([
                ...node.children,
                ...inserted.map(item => ({ ...item, parent: node.value })),
            ]),
        }));
    }

    for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];

        if (!node) {
            continue;
        }

        if (node.id === target.key) {
            const insertionIndex = target.dropPosition === 'before' ? index : index + 1;
            const nextNodes = [...nodes];
            const parent = node.parent;

            nextNodes.splice(insertionIndex, 0, ...inserted.map(item => ({ ...item, parent })));

            return refreshSortableTreeMetadata(nextNodes);
        }

        const nextChildren = insertSortableTreeNodes(node.children, target, inserted);

        if (nextChildren) {
            const nextNodes = [...nodes];

            nextNodes[index] = { ...node, children: nextChildren };

            return refreshSortableTreeMetadata(nextNodes);
        }
    }

    return null;
}

function mapSortableTreeNode<T>(
    nodes: readonly SortableTreeNode<T>[],
    key: Key,
    update: (node: SortableTreeNode<T>) => SortableTreeNode<T>
): SortableTreeNode<T>[] | null {
    for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];

        if (!node) {
            continue;
        }

        if (node.id === key) {
            const nextNodes = [...nodes];

            nextNodes[index] = update(node);

            return refreshSortableTreeMetadata(nextNodes);
        }

        const nextChildren = mapSortableTreeNode(node.children, key, update);

        if (nextChildren) {
            const nextNodes = [...nodes];

            nextNodes[index] = { ...node, children: nextChildren };

            return refreshSortableTreeMetadata(nextNodes);
        }
    }

    return null;
}

function refreshSortableTreeMetadata<T>(nodes: readonly SortableTreeNode<T>[]): SortableTreeNode<T>[] {
    return nodes.map((node, index) => ({
        ...node,
        index,
        siblingCount: nodes.length,
    }));
}
