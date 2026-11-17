import { describe, expect, it } from 'vitest';

import { ancestorDirs, filePaths, filterTree, visibleRows } from './tree';

import type { DocNode } from '@clowdy/protocol';

const tree: DocNode[] = [
    {
        path: 'decisions',
        name: 'decisions',
        kind: 'dir',
        children: [
            { path: 'decisions/booking-flow.md', name: 'booking-flow.md', kind: 'file' },
            { path: 'decisions/pricing.md', name: 'pricing.md', kind: 'file' },
        ],
    },
    {
        path: 'specs',
        name: 'specs',
        kind: 'dir',
        children: [{ path: 'specs/booking.md', name: 'booking.md', kind: 'file' }],
    },
    { path: 'README.md', name: 'README.md', kind: 'file' },
];

describe('filterTree', () => {
    it('keeps every node for an empty or blank query', () => {
        expect(filterTree(tree, '')).toBe(tree);
        expect(filterTree(tree, '   ')).toBe(tree);
    });

    it('keeps the matching files with the folders above them, in any case', () => {
        expect(filePaths(filterTree(tree, 'BOOKING'))).toEqual(['decisions/booking-flow.md', 'specs/booking.md']);
        expect(filterTree(tree, 'pricing').map(node => node.path)).toEqual(['decisions']);
        expect(filterTree(tree, 'pricing')[0]?.children?.map(node => node.path)).toEqual(['decisions/pricing.md']);
    });

    it('keeps everything below a folder that matches', () => {
        expect(filePaths(filterTree(tree, 'specs'))).toEqual(['specs/booking.md']);
        expect(filePaths(filterTree(tree, 'decisions'))).toEqual(['decisions/booking-flow.md', 'decisions/pricing.md']);
    });

    it('leaves nothing when nothing matches, and does not change the tree it was given', () => {
        expect(filterTree(tree, 'zzz')).toEqual([]);
        expect(tree[0]?.children).toHaveLength(2);
    });
});

describe('filePaths', () => {
    it('lists files in the order the tree shows them, folders first', () => {
        expect(filePaths(tree)).toEqual(['decisions/booking-flow.md', 'decisions/pricing.md', 'specs/booking.md', 'README.md']);
    });
});

describe('ancestorDirs', () => {
    it('names each folder above a path, outermost first', () => {
        expect(ancestorDirs('a/b/c.md')).toEqual(['a', 'a/b']);
        expect(ancestorDirs('README.md')).toEqual([]);
    });
});

describe('visibleRows', () => {
    it('shows the children of open folders only, with their depth', () => {
        const rows = visibleRows(tree, path => path === 'decisions');

        expect(rows.map(row => [row.node.path, row.depth, row.open])).toEqual([
            ['decisions', 0, true],
            ['decisions/booking-flow.md', 1, false],
            ['decisions/pricing.md', 1, false],
            ['specs', 0, false],
            ['README.md', 0, false],
        ]);
    });
});
