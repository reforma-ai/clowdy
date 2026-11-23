import { describe, expect, it } from 'vitest';

import { MemoryFileSystem } from '../src/memory/MemoryFileSystem';
import { scopeFilter } from '../src/react/explorer/scopeFilter';
import { matchedRoots, rootAtIndex } from '../src/react/explorer/scopeRows';
import { FileTree } from '../src/tree/FileTree';

import type { ExplorerItem, ExplorerScope, ExplorerScopeRoot } from '../src/react/explorer/explorerContext';

const BRIEFBACK: ExplorerScopeRoot = { id: 'briefback', label: 'Briefback', root: '.briefback' };
const SPECS: ExplorerScopeRoot = { id: 'specs', label: 'Specs', root: 'specs' };
const isMarkdown = (path: string) => /\.md$/i.test(path);

describe('the filter of a scope with several roots', () => {
    async function treeOf(files: Record<string, string>) {
        const tree = new FileTree(new MemoryFileSystem(files), { hidden: ['**/.*'] });

        await tree.refresh();

        return tree;
    }

    const scope = (...roots: ExplorerScopeRoot[]): ExplorerScope => ({ roots, include: (path, kind) => kind === 'directory' || isMarkdown(path) });

    it('finds a file in any root by every word of its path below that root, and leaves out what no root holds or the scope does not include', async () => {
        const tree = await treeOf({
            '.briefback/acp/plan.md': '',
            '.briefback/acp/notes.txt': '',
            'specs/001-a/spec.md': '',
            'specs/001-a/tasks.md': '',
            'src/plan.md': '',
        });

        expect(scopeFilter(tree, scope(BRIEFBACK, SPECS), 'plan')?.paths).toEqual(new Set(['.briefback/acp/plan.md']));
        expect(scopeFilter(tree, scope(BRIEFBACK, SPECS), 'a tasks')?.paths).toEqual(new Set(['specs/001-a/tasks.md']));
        expect(scopeFilter(tree, scope(BRIEFBACK, SPECS), 'md')?.paths).toEqual(new Set(['.briefback/acp/plan.md', 'specs/001-a/spec.md', 'specs/001-a/tasks.md']));
        expect(scopeFilter(tree, scope(BRIEFBACK), 'tasks')?.paths).toEqual(new Set());
    });

    it('does not match the name of the root itself, only the path below it, and says nothing for a query with no words', async () => {
        const tree = await treeOf({ '.briefback/a.md': '', 'specs/b.md': '' });

        expect(scopeFilter(tree, scope(BRIEFBACK, SPECS), 'briefback')?.paths).toEqual(new Set());
        expect(scopeFilter(tree, scope(BRIEFBACK, SPECS), '  ')).toBeNull();
        expect(scopeFilter(tree, scope(), 'a')?.paths).toEqual(new Set());
    });
});

describe('the roots of a scope in the rows', () => {
    const row = (id: string, heading?: string): ExplorerItem => ({ id, name: id, kind: heading === undefined ? 'file' : 'directory', children: null, ...(heading === undefined ? {} : { heading }) });
    // The top level of a drawn scope: a label, its rows, the next label, its rows.
    const data = [row('/root:briefback', '.briefback'), row('.briefback/a.md'), row('.briefback/b.md'), row('/root:specs', 'specs'), row('specs/c.md')];

    it('puts a drop in the root whose label is nearest above the place, the first root above them all', () => {
        expect(rootAtIndex(data, 0, 'x')).toBe('.briefback');
        expect(rootAtIndex(data, 1, 'x')).toBe('.briefback');
        expect(rootAtIndex(data, 3, 'x')).toBe('.briefback');
        expect(rootAtIndex(data, 4, 'x')).toBe('specs');
        expect(rootAtIndex(data, 5, 'x')).toBe('specs');
        expect(rootAtIndex(data, 99, 'x')).toBe('specs');
    });

    it('falls back where there is no label', () => {
        expect(rootAtIndex([row('a.md')], 1, 'x')).toBe('x');
        expect(rootAtIndex([], 0, 'x')).toBe('x');
    });

    it('names the roots a filter found something in, and none for no filter', () => {
        const filter = { query: 'c', paths: new Set(['specs/c.md']) };

        expect(matchedRoots(filter, [BRIEFBACK, SPECS])).toEqual(new Set(['specs']));
        expect(matchedRoots({ query: 'x', paths: new Set(['.briefback/a.md', 'specs/c.md']) }, [BRIEFBACK, SPECS])).toEqual(new Set(['.briefback', 'specs']));
        expect(matchedRoots({ query: 'x', paths: new Set() }, [BRIEFBACK, SPECS])).toEqual(new Set());
        expect(matchedRoots(null, [BRIEFBACK, SPECS])).toEqual(new Set());
    });
});
