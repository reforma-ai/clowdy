// @vitest-environment happy-dom
import { MemoryFileSystem } from '@clowdy/file-manager/memory';
import { describe, expect, it, vi } from 'vitest';

import { matchDocs, mergeFiles, quickSearchSource } from './quickSearchSource';

import type { DocsTree, ProjectFolder, ProjectId } from '@clowdy/protocol';
import type { ProjectState, RootStore } from '../../stores';

describe('the files of two lists as one', () => {
    it('puts the names that start with the word first, then the ones that have it, then the paths, the shorter first, each file once', () => {
        expect(mergeFiles('price', ['docs/price-list.md', 'src/booking/price.ts'], ['src/booking/price.ts', 'price.config.ts', 'src/price/index.ts', 'src/booking/old-price.ts'])).toEqual([
            'price.config.ts',
            'docs/price-list.md',
            'src/booking/price.ts',
            'src/booking/old-price.ts',
            'src/price/index.ts',
        ]);
    });

    it('keeps the first list ahead of the second where they tie', () => {
        expect(mergeFiles('a b', ['aa.ts'], ['ab.ts'])).toEqual(['aa.ts', 'ab.ts']);
        expect(mergeFiles('', ['b.ts'], ['a.ts'])).toEqual(['b.ts', 'a.ts']);
    });
});

describe('the names the palette looks for', () => {
    const FOLDER = { id: 'f1' } as ProjectFolder;
    const OTHER = 'f2';

    /** A folder whose project list says `listed` and whose tree has `files`; a folder that cannot be listed with `files` left out. */
    function source({ listed, files }: { listed: () => Promise<Array<{ folderId: string; path: string }>>; files?: Record<string, string> }) {
        const fileSystem = vi.fn(() => {
            if (!files) throw new Error('unreachable');

            return new MemoryFileSystem(files);
        });
        const root = { transport: { getProjectFiles: vi.fn(listed), fileSystem }, projects: [] } as unknown as RootStore;

        const project = { id: 'p1' as ProjectId, chats: new Map(), runs: new Map(), project: { folders: [FOLDER] } } as unknown as ProjectState;

        return quickSearchSource(root, project, FOLDER).files;
    }

    it('are the project\'s files of this folder and the ones in the folder\'s tree, such as a file that git ignores', async () => {
        const files = source({
            listed: async () => [{ folderId: FOLDER.id, path: 'src/backlog.ts' }, { folderId: OTHER, path: 'other/backlog.md' }],
            files: { 'BACKLOG.md': '', 'src/backlog.ts': '', 'src/other.ts': '' },
        });

        expect(await files('backlog')).toEqual(['BACKLOG.md', 'src/backlog.ts']);
        expect((await files('BACKLOG.md'))[0]).toBe('BACKLOG.md');
    });

    it('need every word, as the project\'s list does', async () => {
        const files = source({ listed: async () => [], files: { 'src/booking/price.ts': '', 'src/booking/index.ts': '', 'src/price.ts': '' } });

        expect(await files('booking price')).toEqual(['src/booking/price.ts']);
    });

    it('leave out the hidden files, since the tree does', async () => {
        const files = source({
            listed: async () => [{ folderId: FOLDER.id, path: 'src/.cache/e.ts' }],
            files: { '.env': '', 'src/.cache/e.ts': '', 'node_modules/x/e.js': '', 'src/e.ts': '' },
        });

        expect(await files('e')).toEqual(['src/e.ts']);
    });

    it('are the answer of the one list that came, when the other failed', async () => {
        const treeOnly = source({ listed: async () => Promise.reject(new Error('not a repository')), files: { 'a.ts': '' } });

        expect(await treeOnly('a')).toEqual(['a.ts']);

        const listOnly = source({ listed: async () => [{ folderId: FOLDER.id, path: 'b.ts' }] });

        expect(await listOnly('b')).toEqual(['b.ts']);
    });

    it('fail when both lists do', async () => {
        const files = source({ listed: async () => Promise.reject(new Error('down')) });

        await expect(files('a')).rejects.toThrow('down');
    });
});

describe('the documents the palette looks for', () => {
    it('need every word in the path, ranked as file names are: the name that starts with the word first', () => {
        const paths = ['research/pricing-notes.md', 'decisions/2026-11-17-pricing.md', 'pricing.md', 'plan.md', 'decisions/Pricing/model.md'];

        expect(matchDocs('pricing', paths)).toEqual(['pricing.md', 'research/pricing-notes.md', 'decisions/2026-11-17-pricing.md', 'decisions/Pricing/model.md']);
        expect(matchDocs('PRICING decisions', paths)).toEqual(['decisions/2026-11-17-pricing.md', 'decisions/Pricing/model.md']);
        expect(matchDocs('nothing here', paths)).toEqual([]);
    });

    const FOLDER = { id: 'f1' } as ProjectFolder;
    const tree: DocsTree = [
        { folderId: 'f1', nodes: [{ path: 'decisions', name: 'decisions', kind: 'dir', children: [{ path: 'decisions/pricing.md', name: 'pricing.md', kind: 'file' }] }, { path: 'plan.md', name: 'plan.md', kind: 'file' }] },
        { folderId: 'f2', nodes: [{ path: 'pricing-api.md', name: 'pricing-api.md', kind: 'file' }] },
    ];

    function docs(read: () => Promise<DocsTree>) {
        const root = { transport: { getDocsTree: vi.fn(read) }, projects: [] } as unknown as RootStore;
        const project = { id: 'p1' as ProjectId, chats: new Map(), runs: new Map(), project: { folders: [FOLDER] } } as unknown as ProjectState;

        return { search: quickSearchSource(root, project, FOLDER).docs, getDocsTree: root.transport.getDocsTree };
    }

    it('are the folder\'s own, read from the daemon\'s list of documents, and not the files of another folder of the project', async () => {
        const { search, getDocsTree } = docs(async () => tree);

        expect(await search('pricing')).toEqual(['decisions/pricing.md']);
        expect(await search('p')).toEqual(['plan.md', 'decisions/pricing.md']);
        expect(getDocsTree).toHaveBeenCalledWith('p1');
    });

    it('are none when the folder has no documents, and a failure to read them is the search\'s', async () => {
        expect(await docs(async () => [{ folderId: 'f2', nodes: [] }]).search('a')).toEqual([]);
        await expect(docs(async () => Promise.reject(new Error('down'))).search('a')).rejects.toThrow('down');
    });
});
