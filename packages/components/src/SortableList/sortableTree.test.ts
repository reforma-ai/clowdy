import { describe, expect, it } from 'vitest';

import {
    buildSortableTree,
    moveSortableTreeNodes,
    moveSortableTreeNodesToCollection,
    moveSortableTreeNodeToIndex,
    restoreSortableTree,
} from './sortableTree';

interface Item {
    name: string;
    children?: Item[];
}

const options = {
    getTextValue: (item: Item) => item.name,
    getChildren: (item: Item) => item.children ?? [],
    canHaveChildren: (item: Item) => item.children != null,
};

function restore(nodes: ReturnType<typeof buildSortableTree<Item>>): Item[] {
    return restoreSortableTree(nodes, (item, children) => ({ ...item, children }));
}

describe('sortable tree moves', () => {
    it('reorders flat items', () => {
        const nodes = buildSortableTree<Item>([{ name: 'A' }, { name: 'B' }, { name: 'C' }], options);

        const moved = moveSortableTreeNodes(nodes, new Set([nodes[0].id]), {
            key: nodes[2].id,
            dropPosition: 'after',
        });

        expect(restore(moved).map(item => item.name)).toEqual(['B', 'C', 'A']);
    });

    it('moves an item into a container', () => {
        const nodes = buildSortableTree<Item>([{ name: 'A' }, { name: 'Repeat', children: [{ name: 'B' }] }], options);

        const moved = moveSortableTreeNodes(nodes, new Set([nodes[0].id]), {
            key: nodes[1].id,
            dropPosition: 'on',
        });

        expect(restore(moved)).toEqual([
            {
                name: 'Repeat',
                children: [{ name: 'B' }, { name: 'A' }],
            },
        ]);
    });

    it('moves a nested item back to the root level', () => {
        const nodes = buildSortableTree<Item>(
            [{ name: 'A' }, { name: 'Repeat', children: [{ name: 'B' }, { name: 'C' }] }],
            options
        );
        const nested = nodes[1].children[0];

        const moved = moveSortableTreeNodes(nodes, new Set([nested.id]), {
            key: nodes[0].id,
            dropPosition: 'before',
        });

        expect(restore(moved)).toEqual([{ name: 'B' }, { name: 'A' }, { name: 'Repeat', children: [{ name: 'C' }] }]);
    });

    it('does not move a container into one of its descendants', () => {
        const nodes = buildSortableTree<Item>([{ name: 'Repeat', children: [{ name: 'A' }] }, { name: 'B' }], options);

        const moved = moveSortableTreeNodes(nodes, new Set([nodes[0].id]), {
            key: nodes[0].children[0].id,
            dropPosition: 'after',
        });

        expect(restore(moved)).toEqual([{ name: 'Repeat', children: [{ name: 'A' }] }, { name: 'B' }]);
    });

    it('moves selected siblings together in their visual order', () => {
        const nodes = buildSortableTree<Item>([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }], options);

        const moved = moveSortableTreeNodes(nodes, new Set([nodes[2].id, nodes[1].id]), {
            key: nodes[0].id,
            dropPosition: 'before',
        });

        expect(restore(moved).map(item => item.name)).toEqual(['B', 'C', 'A', 'D']);
    });

    it('appends an item to a nested collection', () => {
        const nodes = buildSortableTree<Item>([{ name: 'A' }, { name: 'Repeat', children: [{ name: 'B' }] }], options);

        const moved = moveSortableTreeNodesToCollection(nodes, new Set([nodes[0].id]), nodes[1].id);

        expect(restore(moved)).toEqual([
            {
                name: 'Repeat',
                children: [{ name: 'B' }, { name: 'A' }],
            },
        ]);
    });

    it('appends a nested item to the root collection', () => {
        const nodes = buildSortableTree<Item>([{ name: 'A' }, { name: 'Repeat', children: [{ name: 'B' }] }], options);

        const moved = moveSortableTreeNodesToCollection(nodes, new Set([nodes[1].children[0].id]), null);

        expect(restore(moved)).toEqual([{ name: 'A' }, { name: 'Repeat', children: [] }, { name: 'B' }]);
    });

    it('moves an item to the final index reported by a sortable group', () => {
        const nodes = buildSortableTree<Item>([{ name: 'A' }, { name: 'B' }, { name: 'C' }], options);

        const moved = moveSortableTreeNodeToIndex(nodes, nodes[0].id, null, 2);

        expect(restore(moved).map(item => item.name)).toEqual(['B', 'C', 'A']);
    });

    it('moves an item between sortable groups at the reported index', () => {
        const nodes = buildSortableTree<Item>(
            [{ name: 'A' }, { name: 'Repeat', children: [{ name: 'B' }, { name: 'C' }] }],
            options
        );

        const moved = moveSortableTreeNodeToIndex(nodes, nodes[0].id, nodes[1].id, 1);

        expect(restore(moved)).toEqual([
            {
                name: 'Repeat',
                children: [{ name: 'B' }, { name: 'A' }, { name: 'C' }],
            },
        ]);
    });

    it('moves a nested item to a root sortable index', () => {
        const nodes = buildSortableTree<Item>(
            [{ name: 'A' }, { name: 'Repeat', children: [{ name: 'B' }] }, { name: 'C' }],
            options
        );

        const moved = moveSortableTreeNodeToIndex(nodes, nodes[1].children[0].id, null, 1);

        expect(restore(moved)).toEqual([{ name: 'A' }, { name: 'B' }, { name: 'Repeat', children: [] }, { name: 'C' }]);
    });

    it('does not move a sortable container into its own child group', () => {
        const nodes = buildSortableTree<Item>([{ name: 'Repeat', children: [{ name: 'A' }] }, { name: 'B' }], options);

        const moved = moveSortableTreeNodeToIndex(nodes, nodes[0].id, nodes[0].id, 0);

        expect(restore(moved)).toEqual([{ name: 'Repeat', children: [{ name: 'A' }] }, { name: 'B' }]);
    });

    it('uses caller-provided stable keys for nodes', () => {
        const itemA = { name: 'A' };
        const itemB = { name: 'B' };
        const nodes = buildSortableTree<Item>([itemA, itemB], {
            ...options,
            getKey: item => `item:${item.name}`,
        });

        expect(nodes.map(node => node.id)).toEqual(['item:A', 'item:B']);
    });
});
