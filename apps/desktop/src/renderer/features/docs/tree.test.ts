import { describe, expect, it } from 'vitest';

import { ancestorDirs, ancestorKeys, docKey, docsNodes, fileNodes, filterTree, visibleRows } from './tree';

import type { DocNode, DocsTree } from '@clowdy/protocol';

const docs: DocNode[] = [
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

const names = new Map([['f1', 'app'], ['f2', 'api']]);
const tree = docsNodes([{ folderId: 'f1', nodes: docs }], names);
const paths = (nodes: ReturnType<typeof fileNodes>) => nodes.map(node => node.path);

describe('docsNodes', () => {
    it('lists the documents of one folder at the top, keyed by their folder and path', () => {
        expect(tree.map(node => [node.kind, node.key, node.folderId, node.path])).toEqual([
            ['dir', 'f1/decisions', 'f1', 'decisions'],
            ['dir', 'f1/specs', 'f1', 'specs'],
            ['file', 'f1/README.md', 'f1', 'README.md'],
        ]);
        expect(tree[0]?.children?.map(node => node.key)).toEqual(['f1/decisions/booking-flow.md', 'f1/decisions/pricing.md']);
    });

    it('puts several folders first, in the order given and named, an empty one too', () => {
        const several: DocsTree = [{ folderId: 'f1', nodes: docs }, { folderId: 'f2', nodes: [] }, { folderId: 'f3', nodes: [{ path: 'README.md', name: 'README.md', kind: 'file' }] }];
        const nodes = docsNodes(several, names);

        expect(nodes.map(node => [node.kind, node.key, node.name, node.path, node.children?.length])).toEqual([
            ['folder', 'f1', 'app', '', 3],
            ['folder', 'f2', 'api', '', 0],
            ['folder', 'f3', 'f3', '', 1],
        ]);
        // The same path in two folders is two documents.
        expect(fileNodes(nodes).map(node => node.key)).toEqual(['f1/decisions/booking-flow.md', 'f1/decisions/pricing.md', 'f1/specs/booking.md', 'f1/README.md', 'f3/README.md']);
    });
});

describe('filterTree', () => {
    it('keeps every node for an empty or blank query', () => {
        expect(filterTree(tree, '')).toBe(tree);
        expect(filterTree(tree, '   ')).toBe(tree);
    });

    it('keeps the matching files with the folders above them, in any case', () => {
        expect(paths(fileNodes(filterTree(tree, 'BOOKING')))).toEqual(['decisions/booking-flow.md', 'specs/booking.md']);
        expect(filterTree(tree, 'pricing').map(node => node.path)).toEqual(['decisions']);
        expect(filterTree(tree, 'pricing')[0]?.children?.map(node => node.path)).toEqual(['decisions/pricing.md']);
    });

    it('keeps everything below a folder that matches, a folder of the project too', () => {
        expect(paths(fileNodes(filterTree(tree, 'specs')))).toEqual(['specs/booking.md']);
        expect(paths(fileNodes(filterTree(tree, 'decisions')))).toEqual(['decisions/booking-flow.md', 'decisions/pricing.md']);

        const several = docsNodes([{ folderId: 'f1', nodes: docs }, { folderId: 'f2', nodes: [{ path: 'notes.md', name: 'notes.md', kind: 'file' }] }], names);

        expect(fileNodes(filterTree(several, 'api')).map(node => node.key)).toEqual(['f2/notes.md']);
    });

    it('leaves nothing when nothing matches, and does not change the tree it was given', () => {
        expect(filterTree(tree, 'zzz')).toEqual([]);
        expect(tree[0]?.children).toHaveLength(2);
    });
});

describe('fileNodes', () => {
    it('lists files in the order the tree shows them, folders first', () => {
        expect(paths(fileNodes(tree))).toEqual(['decisions/booking-flow.md', 'decisions/pricing.md', 'specs/booking.md', 'README.md']);
    });
});

describe('ancestors', () => {
    it('names each folder above a path, outermost first', () => {
        expect(ancestorDirs('a/b/c.md')).toEqual(['a', 'a/b']);
        expect(ancestorDirs('README.md')).toEqual([]);
    });

    it('keys the folder of the project and each folder above a document', () => {
        expect(ancestorKeys({ folderId: 'f2', path: 'a/b/c.md' })).toEqual(['f2', 'f2/a', 'f2/a/b']);
        expect(docKey({ folderId: 'f2', path: '' })).toBe('f2');
    });
});

describe('visibleRows', () => {
    it('shows the children of open folders only, with their depth', () => {
        const rows = visibleRows(tree, key => key === 'f1/decisions');

        expect(rows.map(row => [row.node.path, row.depth, row.open])).toEqual([
            ['decisions', 0, true],
            ['decisions/booking-flow.md', 1, false],
            ['decisions/pricing.md', 1, false],
            ['specs', 0, false],
            ['README.md', 0, false],
        ]);
    });

    it('opens a folder of the project like any folder', () => {
        const several = docsNodes([{ folderId: 'f1', nodes: docs }, { folderId: 'f2', nodes: [] }], names);
        const rows = visibleRows(several, key => key === 'f1' || key === 'f2');

        expect(rows.map(row => [row.node.key, row.depth, row.open])).toEqual([
            ['f1', 0, true],
            ['f1/decisions', 1, false],
            ['f1/specs', 1, false],
            ['f1/README.md', 1, false],
            ['f2', 0, true],
        ]);
    });
});
