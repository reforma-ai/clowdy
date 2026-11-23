// @vitest-environment happy-dom
import { MemoryFileSystem } from '@clowdy/file-manager/memory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_PROJECT_ID,
    FIXTURE_WORKSPACE_CHAT_ID,
    withFixtureWorkspace,
} from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore as Root } from '../../stores';
import { filesStoreOf } from '../files/useFilesStore';
import { chatPlace } from '../sidePanel/currentPlace';
import { matchDocs, mergeFiles, quickSearchSource } from './quickSearchSource';

import type { ChatWorkspace, DocsTree, ProjectFolder, ProjectId } from '@clowdy/protocol';
import type { ProjectState, RootStore } from '../../stores';

describe('the files of two lists as one', () => {
    it('puts the names that start with the word first, then the ones that have it, then the paths, the shorter first, each file once', () => {
        expect(
            mergeFiles(
                'price',
                ['docs/price-list.md', 'src/booking/price.ts'],
                ['src/booking/price.ts', 'price.config.ts', 'src/price/index.ts', 'src/booking/old-price.ts']
            )
        ).toEqual([
            'price.config.ts',
            'docs/price-list.md',
            'src/booking/price.ts',
            'src/booking/old-price.ts',
            'src/price/index.ts',
        ]);
    });

    it('puts a hidden file after the others that name the words as well, whatever the length', () => {
        expect(mergeFiles('plan', ['.briefback/plan.md', 'docs/plan.md'])).toEqual([
            'docs/plan.md',
            '.briefback/plan.md',
        ]);
        expect(mergeFiles('plan', ['src/.cache/plan.ts', 'a/b/c/plan.ts', 'plan-notes-long.md'])).toEqual([
            'a/b/c/plan.ts',
            'plan-notes-long.md',
            'src/.cache/plan.ts',
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
    function source({
        listed,
        files,
    }: {
        listed: (projectId: string, query: string) => Promise<Array<{ folderId: string; path: string }>>;
        files?: Record<string, string>;
    }) {
        const fileSystem = vi.fn(() => {
            if (!files) throw new Error('unreachable');

            return new MemoryFileSystem(files);
        });
        const root = {
            transport: { getProjectFiles: vi.fn(listed), fileSystem },
            projects: [],
        } as unknown as RootStore;

        const project = {
            id: 'p1' as ProjectId,
            chats: new Map(),
            runs: new Map(),
            project: { folders: [FOLDER] },
        } as unknown as ProjectState;

        return quickSearchSource(root, project, { folder: FOLDER }).files;
    }

    it("are the project's files of this folder and the ones in the folder's tree, such as a file that git ignores", async () => {
        const files = source({
            listed: async () => [
                { folderId: FOLDER.id, path: 'src/backlog.ts' },
                { folderId: OTHER, path: 'other/backlog.md' },
            ],
            files: { 'BACKLOG.md': '', 'src/backlog.ts': '', 'src/other.ts': '' },
        });

        expect(await files('backlog')).toEqual(['BACKLOG.md', 'src/backlog.ts']);
        expect((await files('BACKLOG.md'))[0]).toBe('BACKLOG.md');
    });

    it("need every word, as the project's list does", async () => {
        const files = source({
            listed: async () => [],
            files: { 'src/booking/price.ts': '', 'src/booking/index.ts': '', 'src/price.ts': '' },
        });

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
            listed: async (_project, query) =>
                tracked
                    .filter(path => query.split(/\s+/).every(word => path.includes(word)))
                    .map(path => ({ folderId: FOLDER.id, path })),
            files: { '.briefback/acp/plan.md': '', 'plan.md': '', 'src/plan-view.ts': '', '.DS_Store': '' },
        });

        // Typed nearly as it is written, the hidden file is the one.
        expect(await files('acp/plan.md')).toEqual(['.briefback/acp/plan.md']);
        expect(await files('workflows ci')).toEqual(['.github/workflows/ci.yml']);

        // Its name starts with the word as the two others do, and it comes after them.
        expect(await files('plan')).toEqual(['plan.md', 'src/plan-view.ts', '.briefback/acp/plan.md']);
    });

    it("do not have what the project's list has in a folder of dependencies, which is vendored code, nor the files the system's file manager leaves", async () => {
        const files = source({
            listed: async () =>
                ['node_modules/x/e.js', '.DS_Store', 'docs/Thumbs.db', 'src/e.js'].map(path => ({
                    folderId: FOLDER.id,
                    path,
                })),
            files: { 'src/e.js': '' },
        });

        expect(await files('e')).toEqual(['src/e.js']);
    });

    it('are the answer of the one list that came, when the other failed', async () => {
        const treeOnly = source({
            listed: async () => Promise.reject(new Error('not a repository')),
            files: { 'a.ts': '' },
        });

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
    it('need every word in the path, ranked by name (the name that starts with the word first, the shorter name first), and keep the order they came in where they tie', () => {
        const paths = [
            'research/pricing-notes.md',
            'decisions/2026-11-17-pricing.md',
            'pricing.md',
            'plan.md',
            'decisions/Pricing/model.md',
            'pricing.md',
        ];

        expect(matchDocs('pricing', paths)).toEqual([
            'pricing.md',
            'research/pricing-notes.md',
            'decisions/2026-11-17-pricing.md',
            'decisions/Pricing/model.md',
        ]);
        expect(matchDocs('PRICING decisions', paths)).toEqual([
            'decisions/2026-11-17-pricing.md',
            'decisions/Pricing/model.md',
        ]);
        expect(matchDocs('nothing here', paths)).toEqual([]);
    });

    it('do not put a document in a dot folder after the others: that is where most of them are', () => {
        expect(matchDocs('plan', ['specs/001/plan.md', '.briefback/acp/plan.md', 'openspec/changes/plan.md'])).toEqual([
            'specs/001/plan.md',
            '.briefback/acp/plan.md',
            'openspec/changes/plan.md',
        ]);
        expect(matchDocs('plan', ['.briefback/acp/plan.md', 'specs/001/plan.md'])).toEqual([
            '.briefback/acp/plan.md',
            'specs/001/plan.md',
        ]);
    });

    const FOLDER = { id: 'f1' } as ProjectFolder;
    const tree: DocsTree = [
        {
            folderId: 'f1',
            sources: [
                {
                    id: 'briefback',
                    label: 'Briefback',
                    root: '.briefback',
                    nodes: [
                        {
                            path: 'acp',
                            name: 'acp',
                            kind: 'dir',
                            children: [{ path: 'acp/plan.md', name: 'plan.md', kind: 'file' }],
                        },
                    ],
                },
                {
                    id: 'documents',
                    label: 'Documents',
                    root: '.clowdy/docs',
                    nodes: [
                        {
                            path: 'decisions',
                            name: 'decisions',
                            kind: 'dir',
                            children: [{ path: 'decisions/pricing.md', name: 'pricing.md', kind: 'file' }],
                        },
                        { path: 'plan.md', name: 'plan.md', kind: 'file' },
                    ],
                },
            ],
        },
        {
            folderId: 'f2',
            sources: [
                {
                    id: 'documents',
                    label: 'Documents',
                    root: '.clowdy/docs',
                    nodes: [{ path: 'pricing-api.md', name: 'pricing-api.md', kind: 'file' }],
                },
            ],
        },
    ];

    function docs(read: () => Promise<DocsTree>) {
        const root = { transport: { getDocsTree: vi.fn(read) }, projects: [] } as unknown as RootStore;
        const project = {
            id: 'p1' as ProjectId,
            chats: new Map(),
            runs: new Map(),
            project: { folders: [FOLDER] },
        } as unknown as ProjectState;

        return {
            search: quickSearchSource(root, project, { folder: FOLDER }).docs,
            getDocsTree: root.transport.getDocsTree,
        };
    }

    it("are the folder's own, of every source, each by its own path from the folder, and not the files of another folder of the project", async () => {
        const { search, getDocsTree } = docs(async () => tree);

        expect(await search('pricing')).toEqual(['.clowdy/docs/decisions/pricing.md']);
        // Where they match alike, the sources keep their order: Briefback first.
        expect(await search('plan')).toEqual(['.briefback/acp/plan.md', '.clowdy/docs/plan.md']);
        expect(await search('briefback')).toEqual(['.briefback/acp/plan.md']);
        expect(getDocsTree).toHaveBeenCalledWith('p1', undefined);
    });

    it("are none when the folder has no source, and a failure to read them is the search's", async () => {
        expect(await docs(async () => [{ folderId: 'f1', sources: [] }]).search('a')).toEqual([]);
        expect(await docs(async () => [{ folderId: 'f2', sources: [] }]).search('a')).toEqual([]);
        await expect(docs(async () => Promise.reject(new Error('down'))).search('a')).rejects.toThrow('down');
    });
});

describe('the palette over a worktree', () => {
    const FOLDER = { id: 'f1', path: '/Users/dev/web' } as ProjectFolder;
    const WORKSPACE: ChatWorkspace = {
        id: 'wks_1',
        folderId: 'f1',
        path: '/Users/dev/Clowdy/workspaces/web/ab12cd34/web',
        branch: 'clowdy/ab12cd34',
        managed: true,
        ready: true,
    };
    const project = {
        id: 'p1' as ProjectId,
        chats: new Map(),
        runs: new Map(),
        project: { folders: [FOLDER] },
    } as unknown as ProjectState;

    function over(workspace: ChatWorkspace) {
        const getProjectFiles = vi.fn(async () => [{ folderId: FOLDER.id, path: 'src/weekend.ts' }]);
        const getDocsTree = vi.fn(
            async (): Promise<DocsTree> => [
                {
                    folderId: FOLDER.id,
                    sources: [
                        {
                            id: 'briefback',
                            label: 'Briefback',
                            root: '.briefback',
                            nodes: [{ path: 'surcharge/plan.md', name: 'plan.md', kind: 'file' }],
                        },
                    ],
                },
            ]
        );
        const fileSystem = vi.fn(() => new MemoryFileSystem({ 'src/weekend.ts': 'export const surcharge = 1;\n' }));
        const root = { transport: { getProjectFiles, getDocsTree, fileSystem }, projects: [] } as unknown as RootStore;

        return {
            source: quickSearchSource(root, project, { folder: FOLDER, workspace }),
            getProjectFiles,
            getDocsTree,
            fileSystem,
        };
    }

    it('asks for the files and the documents of the worktree, and for the file system of it', async () => {
        const { source, getProjectFiles, getDocsTree, fileSystem } = over(WORKSPACE);

        expect(await source.files('weekend')).toEqual(['src/weekend.ts']);
        expect(await source.docs('plan')).toEqual(['.briefback/surcharge/plan.md']);
        expect(getProjectFiles).toHaveBeenCalledWith('p1', 'weekend', 100, 'wks_1');
        expect(getDocsTree).toHaveBeenCalledWith('p1', 'wks_1');
        expect(fileSystem).toHaveBeenCalledWith('p1', 'f1', 'wks_1');
    });

    it("lists nothing for a worktree that is not made yet, and asks for nothing: it is no reason to show the folder's own checkout", async () => {
        const { source, getProjectFiles, getDocsTree, fileSystem } = over({ ...WORKSPACE, ready: false });

        expect(await source.files('weekend')).toEqual([]);
        expect(await source.docs('plan')).toEqual([]);
        expect(await source.text('surcharge')).toEqual({ files: [], truncated: false });
        expect(getProjectFiles).not.toHaveBeenCalled();
        expect(getDocsTree).not.toHaveBeenCalled();
        expect(fileSystem).not.toHaveBeenCalled();
    });
});

describe("the palette over the fixture's worktree of Car Rental", () => {
    let store: Root;

    beforeEach(async () => {
        localStorage.clear();
        store = new Root(new FixtureTransport({ data: withFixtureWorkspace(createFixtureData()) }));
        await store.load();
        store.selectProject(FIXTURE_PROJECT_ID);
    });

    afterEach(() => {
        filesStoreOf(store).dispose();
        store.dispose();
        localStorage.clear();
    });

    const sourceOf = (chatId?: string) => {
        const project = store.selectedProject!;
        const chat = chatId ? project.chats.get(chatId) : undefined;

        return quickSearchSource(
            store,
            project,
            chat ? chatPlace(project.project.folders, chat) : { folder: project.project.folders[0]! }
        );
    };

    it("finds a file and a plan that only the worktree has, and not in the folder's own checkout", async () => {
        const worktree = sourceOf(FIXTURE_WORKSPACE_CHAT_ID);
        const own = sourceOf();

        expect(await worktree.files('weekend')).toEqual(['src/booking/weekend.ts']);
        expect(await worktree.docs('surcharge')).toEqual(['.briefback/weekend-surcharge/plan.md']);
        expect(await own.files('weekend')).toEqual([]);
        expect(await own.docs('surcharge')).toEqual([]);

        // What both have is found in both.
        expect(await worktree.files('price')).toContain('src/booking/price.ts');
        expect(await own.files('price')).toContain('src/booking/price.ts');
    });

    it("searches the text of the worktree's files", async () => {
        const worktree = sourceOf(FIXTURE_WORKSPACE_CHAT_ID);
        const own = sourceOf();

        expect((await worktree.text('weekendSurcharge')).files.map(file => file.path)).toEqual([
            'src/booking/weekend.ts',
        ]);
        expect((await own.text('weekendSurcharge')).files).toEqual([]);

        worktree.dispose?.();
        own.dispose?.();
    });
});
