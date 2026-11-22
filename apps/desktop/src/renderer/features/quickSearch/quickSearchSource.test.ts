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

    it('puts a hidden file after the others that name the words as well, whatever the length', () => {
        expect(mergeFiles('plan', ['.briefback/plan.md', 'docs/plan.md'])).toEqual(['docs/plan.md', '.briefback/plan.md']);
        expect(mergeFiles('plan', ['src/.cache/plan.ts', 'a/b/c/plan.ts', 'plan-notes-long.md'])).toEqual(['a/b/c/plan.ts', 'plan-notes-long.md', 'src/.cache/plan.ts']);
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
    function source({ listed, files }: { listed: (projectId: string, query: string) => Promise<Array<{ folderId: string; path: string }>>; files?: Record<string, string> }) {
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

    it('leave out the hidden files that only the tree knows, since it does not show them: git ignores those, such as caches and a local .env', async () => {
        const files = source({
            listed: async () => [],
            files: { '.env': '', '.DS_Store': '', 'src/.cache/e.ts': '', 'node_modules/x/e.js': '', 'src/e.ts': '' },
        });

        expect(await files('e')).toEqual(['src/e.ts']);
    });

    it('have the hidden files git tracks, which are part of the project, after the ones that are not hidden where they match alike', async () => {
        // The project's list answers for the words, as the daemon's does.
        const tracked = ['.briefback/acp/plan.md', '.github/workflows/ci.yml', 'plan.md', 'src/plan-view.ts'];
        const files = source({
            listed: async (_project, query) => tracked.filter(path => query.split(/\s+/).every(word => path.includes(word))).map(path => ({ folderId: FOLDER.id, path })),
            files: { '.briefback/acp/plan.md': '', 'plan.md': '', 'src/plan-view.ts': '', '.DS_Store': '' },
        });

        // Typed nearly as it is written, the hidden file is the one.
        expect(await files('acp/plan.md')).toEqual(['.briefback/acp/plan.md']);
        expect(await files('workflows ci')).toEqual(['.github/workflows/ci.yml']);

        // Its name starts with the word as the two others do, and it comes after them.
        expect(await files('plan')).toEqual(['plan.md', 'src/plan-view.ts', '.briefback/acp/plan.md']);
    });

    it('do not have what the project\'s list has in a folder of dependencies, which is vendored code, nor the files the system\'s file manager leaves', async () => {
        const files = source({
            listed: async () => ['node_modules/x/e.js', '.DS_Store', 'docs/Thumbs.db', 'src/e.js'].map(path => ({ folderId: FOLDER.id, path })),
            files: { 'src/e.js': '' },
        });

        expect(await files('e')).toEqual(['src/e.js']);
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
    it('need every word in the path, ranked as file names are (the name that starts with the word first), and keep the order they came in where they tie', () => {
        const paths = ['research/pricing-notes.md', 'decisions/2026-11-17-pricing.md', 'pricing.md', 'plan.md', 'decisions/Pricing/model.md', 'pricing.md'];

        expect(matchDocs('pricing', paths)).toEqual(['research/pricing-notes.md', 'pricing.md', 'decisions/2026-11-17-pricing.md', 'decisions/Pricing/model.md']);
        expect(matchDocs('PRICING decisions', paths)).toEqual(['decisions/2026-11-17-pricing.md', 'decisions/Pricing/model.md']);
        expect(matchDocs('nothing here', paths)).toEqual([]);
    });

    it('do not put a document in a dot folder after the others: that is where most of them are', () => {
        expect(matchDocs('plan', ['specs/001/plan.md', '.briefback/acp/plan.md', 'openspec/changes/plan.md'])).toEqual(['specs/001/plan.md', '.briefback/acp/plan.md', 'openspec/changes/plan.md']);
        expect(matchDocs('plan', ['.briefback/acp/plan.md', 'specs/001/plan.md'])).toEqual(['.briefback/acp/plan.md', 'specs/001/plan.md']);
    });

    const FOLDER = { id: 'f1' } as ProjectFolder;
    const tree: DocsTree = [
        {
            folderId: 'f1',
            sources: [
                { id: 'briefback', label: 'Briefback', root: '.briefback', nodes: [{ path: 'acp', name: 'acp', kind: 'dir', children: [{ path: 'acp/plan.md', name: 'plan.md', kind: 'file' }] }] },
                { id: 'documents', label: 'Documents', root: '.clowdy/docs', nodes: [{ path: 'decisions', name: 'decisions', kind: 'dir', children: [{ path: 'decisions/pricing.md', name: 'pricing.md', kind: 'file' }] }, { path: 'plan.md', name: 'plan.md', kind: 'file' }] },
            ],
        },
        { folderId: 'f2', sources: [{ id: 'documents', label: 'Documents', root: '.clowdy/docs', nodes: [{ path: 'pricing-api.md', name: 'pricing-api.md', kind: 'file' }] }] },
    ];

    function docs(read: () => Promise<DocsTree>) {
        const root = { transport: { getDocsTree: vi.fn(read) }, projects: [] } as unknown as RootStore;
        const project = { id: 'p1' as ProjectId, chats: new Map(), runs: new Map(), project: { folders: [FOLDER] } } as unknown as ProjectState;

        return { search: quickSearchSource(root, project, FOLDER).docs, getDocsTree: root.transport.getDocsTree };
    }

    it('are the folder\'s own, of every source, each by its own path from the folder, and not the files of another folder of the project', async () => {
        const { search, getDocsTree } = docs(async () => tree);

        expect(await search('pricing')).toEqual(['.clowdy/docs/decisions/pricing.md']);
        // Where they match alike, the sources keep their order: Briefback first.
        expect(await search('plan')).toEqual(['.briefback/acp/plan.md', '.clowdy/docs/plan.md']);
        expect(await search('briefback')).toEqual(['.briefback/acp/plan.md']);
        expect(getDocsTree).toHaveBeenCalledWith('p1');
    });

    it('are none when the folder has no source, and a failure to read them is the search\'s', async () => {
        expect(await docs(async () => [{ folderId: 'f1', sources: [] }]).search('a')).toEqual([]);
        expect(await docs(async () => [{ folderId: 'f2', sources: [] }]).search('a')).toEqual([]);
        await expect(docs(async () => Promise.reject(new Error('down'))).search('a')).rejects.toThrow('down');
    });
});
