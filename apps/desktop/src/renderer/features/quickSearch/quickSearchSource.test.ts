// @vitest-environment happy-dom
import { MemoryFileSystem } from '@clowdy/file-manager/memory';
import { describe, expect, it, vi } from 'vitest';

import { mergeFiles, quickSearchSource } from './quickSearchSource';

import type { ProjectFolder, ProjectId } from '@clowdy/protocol';
import type { RootStore } from '../../stores';

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
        const root = { transport: { getProjectFiles: vi.fn(listed), fileSystem } } as unknown as RootStore;

        return quickSearchSource(root, 'p1' as ProjectId, FOLDER).files;
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
