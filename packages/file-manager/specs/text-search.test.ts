import { describe, expect, it, vi } from 'vitest';

import { FileManager } from '../src/FileManager';
import { MemoryFileSystem } from '../src/memory/MemoryFileSystem';

import type { SearchQuery, SearchResult, SearchService } from '../src/provider';

const PAGE = `import { useState } from 'react';

export default function Page() {
  const [count, setCount] = useState(0); // useState again
  return <main>{count}</main>;
}
`;

const RESULT: SearchResult = {
    files: [
        {
            path: 'app/page.tsx',
            matches: [
                { line: 4, column: 28, preview: 'const [count] = useState(0);', ranges: [{ start: 16, end: 24 }] },
            ],
        },
    ],
    truncated: false,
};

function withService(service: SearchService) {
    return new FileManager({ provider: new MemoryFileSystem(), search: service });
}

/** A file manager without a search service, so search scans the memory file system. */
async function scanning(
    files: Record<string, string | Uint8Array>,
    filters: { exclude?: string[]; hidden?: string[] } = {}
) {
    const manager = new FileManager({ provider: new MemoryFileSystem(files), ...filters });

    await manager.start();

    return manager;
}

async function find(manager: FileManager, query: string, options: Parameters<FileManager['search']['set']>[0] = {}) {
    manager.search.set({ query, ...options });
    await manager.search.run();

    return manager.search.result;
}

function pathsOf(result: SearchResult | null): string[] {
    return result?.files.map(file => file.path) ?? [];
}

describe('TextSearch', () => {
    it('should send the query with its options to the search service and keep its result', async () => {
        const service = vi.fn<SearchService>(async () => RESULT);
        const manager = withService(service);

        manager.search.set({
            query: 'useState',
            matchCase: true,
            wholeWord: true,
        });
        await manager.search.run();

        expect(service).toHaveBeenCalledWith(
            {
                query: 'useState',
                matchCase: true,
                wholeWord: true,
                exclude: [],
            } satisfies SearchQuery,
            expect.any(AbortSignal)
        );
        expect(manager.search.result).toEqual(RESULT);
        expect(manager.search.loading).toBe(false);
    });

    it('should leave out of the service search the paths the tree does not show', async () => {
        const service = vi.fn<SearchService>(async () => RESULT);
        const manager = new FileManager({
            provider: new MemoryFileSystem(),
            exclude: ['**/.Trash-*'],
            hidden: ['**/.*'],
            search: service,
        });

        await find(manager, 'useState');
        manager.tree.setShowHidden(true);
        await find(manager, 'useState');

        expect(service.mock.calls.map(([query]) => query.exclude)).toEqual([['**/.Trash-*', '**/.*'], ['**/.Trash-*']]);
    });

    it('should cancel a running search when a new one starts and keep only the newer result', async () => {
        const pending: Array<{ signal: AbortSignal; resolve: (result: SearchResult) => void }> = [];
        const manager = withService(
            (_query, signal) =>
                new Promise(resolve => {
                    pending.push({ signal, resolve });
                })
        );
        const older = find(manager, 'use');

        expect(manager.search.loading).toBe(true);

        const newer = find(manager, 'useState');

        expect(pending[0]!.signal.aborted).toBe(true);
        expect(pending[1]!.signal.aborted).toBe(false);

        pending[1]!.resolve(RESULT);
        await newer;
        pending[0]!.resolve({ files: [], truncated: false });
        await older;

        expect(manager.search.result).toEqual(RESULT);
        expect(manager.search.loading).toBe(false);
    });

    it('should show why a search failed until one succeeds, and clear the result for an empty query', async () => {
        const service = vi
            .fn<SearchService>()
            .mockRejectedValueOnce(new Error('The sandbox is not connected'))
            .mockResolvedValueOnce(RESULT);
        const manager = withService(service);

        await find(manager, 'use');

        expect(manager.search.error).toBe('The sandbox is not connected');
        expect(manager.search.result).toBeNull();

        await find(manager, 'use');

        expect(manager.search.error).toBeNull();
        expect(manager.search.result).toEqual(RESULT);

        await find(manager, '');

        expect(manager.search.result).toBeNull();
        expect(service).toHaveBeenCalledTimes(2);
    });

    it('should offer a one-line selection of the active editor as what to search for', async () => {
        const manager = new FileManager({
            provider: new MemoryFileSystem({ 'app/page.tsx': PAGE, 'README.md': '# Title\n' }),
            search: vi.fn<SearchService>(async () => RESULT),
        });

        await manager.start();
        expect(manager.selectedText()).toBeUndefined();

        await manager.open('app/page.tsx', { from: { line: 1, column: 10 }, to: { line: 1, column: 18 } });
        expect(manager.selectedText()).toBe('useState');

        // A selection over lines is not one.
        await manager.open('app/page.tsx', { from: { line: 1, column: 1 }, to: { line: 3, column: 1 } });
        expect(manager.selectedText()).toBeUndefined();

        // Rich text shows no code editor selection to take.
        const readme = await manager.open('README.md', { from: { line: 1, column: 3 }, to: { line: 1, column: 8 } });

        readme?.setView('rich');
        expect(manager.selectedText()).toBeUndefined();
    });
});

describe('TextSearch scan', () => {
    it('should find text on the memory file system with the story’s filters, grouped by file in path order', async () => {
        const manager = await scanning(
            {
                'components/Counter.tsx': 'export const Counter = () => useState(1);\n',
                'app/page.tsx': PAGE,
                'app/layout.tsx': 'export default function Layout() {}\n',
                '.env.example': 'USESTATE=1\n',
                'node_modules/react/index.js': 'export function useState() {}\n',
            },
            { exclude: ['**/node_modules'], hidden: ['**/.*'] }
        );

        const result = await find(manager, 'usestate');

        expect(result).toEqual({
            files: [
                {
                    path: 'app/page.tsx',
                    matches: [
                        {
                            line: 1,
                            column: 10,
                            preview: 'import { useState } from \'react\';',
                            ranges: [{ start: 9, end: 17 }],
                        },
                        {
                            line: 4,
                            column: 29,
                            preview: '  const [count, setCount] = useState(0); // useState again',
                            ranges: [
                                { start: 28, end: 36 },
                                { start: 44, end: 52 },
                            ],
                        },
                    ],
                },
                {
                    path: 'components/Counter.tsx',
                    matches: [
                        {
                            line: 1,
                            column: 30,
                            preview: 'export const Counter = () => useState(1);',
                            ranges: [{ start: 29, end: 37 }],
                        },
                    ],
                },
            ],
            truncated: false,
        });
    });

    it('should take the query literally and apply match case and whole word', async () => {
        const manager = await scanning({
            'app/page.tsx': 'const Item = item + items;\n',
            'app/globals.css': '.item { color: red; }\n',
            'lib/item.ts': 'export const item = 1;\n',
        });

        expect(pathsOf(await find(manager, 'Item', { matchCase: true }))).toEqual(['app/page.tsx']);
        const wholeWords = await find(manager, 'item', { matchCase: false, wholeWord: true });

        expect(wholeWords!.files.find(file => file.path === 'app/page.tsx')!.matches[0]!.ranges).toEqual([
            { start: 6, end: 10 },
            { start: 13, end: 17 },
        ]);
        expect(pathsOf(await find(manager, '.item', { wholeWord: false }))).toEqual(['app/globals.css']);
    });

    it('should skip excluded, hidden, binary, media and oversized files, and search hidden files once shown', async () => {
        const manager = await scanning(
            {
                'app/page.tsx': 'needle\n',
                'dist/page.js': 'needle\n',
                '.github/ci.yml': 'needle\n',
                'data/latin1.txt': new Uint8Array([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0xe9]),
                'public/needle.svg': '<svg>needle</svg>\n',
                'public/needle.png': 'needle\n',
                'logs/huge.log': `needle${'x'.repeat(1024 * 1024)}`,
            },
            { exclude: ['**/dist'], hidden: ['**/.*'] }
        );

        expect(pathsOf(await find(manager, 'needle'))).toEqual(['app/page.tsx', 'public/needle.svg']);

        manager.tree.setShowHidden(true);

        expect(pathsOf(await find(manager, 'needle'))).toEqual(['.github/ci.yml', 'app/page.tsx', 'public/needle.svg']);
    });

    it('should stop at 2,000 matches and report the result truncated', async () => {
        const manager = await scanning({
            'a.txt': 'hit\n'.repeat(1_500),
            'b.txt': 'hit hit\n'.repeat(1_500),
            'c.txt': 'hit\n',
        });
        const result = await find(manager, 'hit');
        const count = result!.files.flatMap(file => file.matches).reduce((sum, match) => sum + match.ranges.length, 0);

        expect(result!.truncated).toBe(true);
        expect(pathsOf(result)).toEqual(['a.txt', 'b.txt']);
        expect(count).toBe(2_000);
    });
});
