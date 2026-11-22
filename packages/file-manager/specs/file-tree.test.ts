import { describe, expect, it } from 'vitest';

import { FileManager } from '../src/FileManager';
import { MemoryFileSystem } from '../src/memory/MemoryFileSystem';
import { FileTree } from '../src/tree/FileTree';

import type { FileEntry, FileSystemProvider } from '../src/provider';

const flush = () => new Promise(resolve => setTimeout(resolve));

function names(tree: FileTree, path?: string): string[] {
    return tree.children(path).map(entry => entry.path);
}

describe('FileTree', () => {
    it('should list folders first, then names in natural order', async () => {
        const tree = new FileTree(
            new MemoryFileSystem({
                'file10.ts': '',
                'file2.ts': '',
                'B.ts': '',
                'a.ts': '',
                'zeta/x.ts': '',
                'Alpha/y.ts': '',
            })
        );

        await tree.refresh();

        expect(tree.status).toBe('ready');
        expect(names(tree)).toEqual(['Alpha', 'zeta', 'a.ts', 'B.ts', 'file2.ts', 'file10.ts']);
        expect(names(tree, 'zeta')).toEqual(['zeta/x.ts']);
        expect(tree.get('zeta')?.kind).toBe('directory');
    });

    it('should add parent folders a listing leaves out', async () => {
        const provider = { list: async (): Promise<FileEntry[]> => [{ path: 'a/b/c.ts', kind: 'file' }] };
        const tree = new FileTree(provider as FileSystemProvider);

        await tree.refresh();

        expect(names(tree)).toEqual(['a']);
        expect(names(tree, 'a')).toEqual(['a/b']);
    });

    it('should patch created, changed and deleted paths', async () => {
        const tree = new FileTree(new MemoryFileSystem({ 'src/lib/a.ts': '', 'src/b.ts': '' }));

        await tree.refresh();
        tree.applyChanges([
            { type: 'created', path: 'app/new/page.tsx', kind: 'file', size: 4 },
            { type: 'changed', path: 'src/b.ts', size: 10 },
            { type: 'deleted', path: 'src/lib' },
        ]);

        expect(names(tree)).toEqual(['app', 'src']);
        expect(names(tree, 'app/new')).toEqual(['app/new/page.tsx']);
        expect(tree.get('src/b.ts')?.size).toBe(10);
        expect(tree.get('src/lib/a.ts')).toBeUndefined();
        expect(names(tree, 'src')).toEqual(['src/b.ts']);
    });

    it('should keep changes that arrive while a listing is in flight', async () => {
        let resolveList: (entries: FileEntry[]) => void = () => {};
        const provider = {
            list: () =>
                new Promise<FileEntry[]>(resolve => {
                    resolveList = resolve;
                }),
        };
        const tree = new FileTree(provider as unknown as FileSystemProvider);

        const listing = tree.refresh();

        tree.applyChanges([
            { type: 'created', path: 'late.ts', kind: 'file' },
            { type: 'deleted', path: 'old.ts' },
        ]);
        resolveList([
            { path: 'old.ts', kind: 'file' },
            { path: 'kept.ts', kind: 'file' },
        ]);
        await listing;

        expect(names(tree)).toEqual(['kept.ts', 'late.ts']);
    });

    it('should never show excluded paths and show hidden ones only with showHidden', async () => {
        const tree = new FileTree(
            new MemoryFileSystem({
                'bun.lock': '',
                '.env.example': '',
                '.github/workflows/ci.yml': '',
                'node_modules/react/index.js': '',
                'app/node_modules/x.js': '',
                'app/page.tsx': '',
                'app/bun.lock': '',
                'app/reforma/stories.tsx': '',
            }),
            {
                exclude: ['**/node_modules', 'bun.lock'],
                hidden: ['**/.*', 'app/reforma'],
            }
        );

        await tree.refresh();

        expect(names(tree)).toEqual(['app']);
        expect(names(tree, 'app')).toEqual(['app/bun.lock', 'app/page.tsx']);
        expect(tree.isVisible('app/reforma/stories.tsx')).toBe(false);
        // Hidden paths stay listed, so links to them still open.
        expect(tree.get('app/reforma/stories.tsx')?.kind).toBe('file');

        tree.setShowHidden(true);

        expect(names(tree)).toEqual(['.github', 'app', '.env.example']);
        expect(names(tree, 'app')).toEqual(['app/reforma', 'app/bun.lock', 'app/page.tsx']);
        expect(tree.isVisible('app/reforma/stories.tsx')).toBe(true);
        expect(tree.isVisible('node_modules/react/index.js')).toBe(false);
    });

    it('should tell a hidden path, or one inside a hidden folder, from a shown one', () => {
        const tree = new FileTree(new MemoryFileSystem({}), {
            exclude: ['bun.lock'],
            hidden: ['**/.*', '**/node_modules'],
        });

        expect(tree.isHidden('.env')).toBe(true);
        expect(tree.isHidden('.briefback/plan/notes.md')).toBe(true);
        expect(tree.isHidden('app/node_modules/x/index.js')).toBe(true);
        expect(tree.isHidden('app/page.tsx')).toBe(false);
        expect(tree.isHidden('app')).toBe(false);
        expect(tree.isHidden('bun.lock')).toBe(false);
    });

    it('should keep the sorted children between reads outside a reaction', async () => {
        const tree = new FileTree(new MemoryFileSystem({ 'b.ts': '', 'a.ts': '' }));

        await tree.refresh();

        expect(tree.children()).toBe(tree.children());
    });

    it('should follow the provider through a manager and list again on resync', async () => {
        const fs = new MemoryFileSystem({ 'a.ts': '' });
        const manager = new FileManager({ provider: fs });

        await manager.start();
        await fs.write('b.ts', '');
        await fs.delete(['a.ts']);
        await flush();

        expect(names(manager.tree)).toEqual(['b.ts']);

        // A change the watch never delivered.
        manager.tree.applyChanges([{ type: 'deleted', path: 'b.ts' }]);
        fs.resync();
        await flush();

        expect(names(manager.tree)).toEqual(['b.ts']);
    });

    it('should list three segments and load the next folder when it is opened', async () => {
        const tree = new FileTree(
            new MemoryFileSystem({
                'src/app/foo/bar.ts': 'export {};\n',
                'src/app/readme.md': '',
            })
        );

        await tree.refresh();

        expect(tree.get('src/app/foo')?.kind).toBe('directory');
        expect(tree.get('src/app/foo')?.hasChildren).toBe(true);
        expect(tree.get('src/app/readme.md')?.kind).toBe('file');
        expect(tree.get('src/app/foo/bar.ts')).toBeUndefined();

        tree.applyChanges([{ type: 'created', path: 'src/app/foo/bar.ts', kind: 'file', size: 1 }]);
        expect(tree.get('src/app/foo/bar.ts')).toBeUndefined();

        await tree.load('src/app/foo');

        expect(names(tree, 'src/app/foo')).toEqual(['src/app/foo/bar.ts']);
    });

    it('should say the children of a folder whatever the hidden and excluded globs say', async () => {
        const tree = new FileTree(
            new MemoryFileSystem({ '.clowdy/docs/a.md': '', '.clowdy/docs/plans/b.md': '', 'node_modules/x/index.js': '', 'src/a.ts': '' }),
            { exclude: ['**/node_modules'], hidden: ['**/.*'] }
        );

        await tree.refresh();

        // The folder is hidden, so the tree's own rows leave it out; the entries below it are listed all the same.
        expect(names(tree)).toEqual(['src']);
        expect(tree.isVisible('.clowdy/docs/a.md')).toBe(false);
        expect(tree.entriesOf('.clowdy/docs').map(entry => entry.path)).toEqual(['.clowdy/docs/plans', '.clowdy/docs/a.md']);
        expect(tree.entriesOf('').map(entry => entry.path)).toEqual(['.clowdy', 'node_modules', 'src']);
        expect(tree.entriesOf('missing')).toEqual([]);
    });

    it('should list a folder with everything below it, count the folders as opened, and take a folder that is not there for empty', async () => {
        const fs = new MemoryFileSystem({ 'a.ts': '', 'docs/deep/er/x.md': '', 'docs/top.md': '' });
        const tree = new FileTree(fs);

        await tree.refresh();

        expect(tree.get('docs/deep/er/x.md')).toBeUndefined();

        await tree.loadDeep('docs');

        expect(tree.get('docs/deep/er/x.md')?.kind).toBe('file');

        // A change below a folder it listed shows, and a resync lists those folders again.
        tree.applyChanges([{ type: 'created', path: 'docs/deep/er/y.md', kind: 'file' }]);
        expect(tree.get('docs/deep/er/y.md')?.kind).toBe('file');

        await fs.write('docs/deep/er/z.md', '');
        await tree.refresh();
        expect(tree.get('docs/deep/er/z.md')?.kind).toBe('file');

        await expect(tree.loadDeep('nothing/here')).resolves.toBeUndefined();
    });

    it('should list a folder deep that was asked for while a refresh was in flight, once the refresh has committed', async () => {
        const fs = new MemoryFileSystem({ 'a.ts': '', '.clowdy/docs/plans/deep/b.md': '', '.clowdy/docs/index.md': '' });
        const tree = new FileTree(fs, { hidden: ['**/.*'] });

        await tree.refresh();

        // The refresh starts after the deep listing was asked for and before it answers, as a watch stream's first resync does.
        const deep = tree.loadDeep('.clowdy/docs');
        const refreshed = tree.refresh();

        await Promise.all([deep, refreshed]);
        expect(tree.get('.clowdy/docs/plans/deep/b.md')?.kind).toBe('file');

        // A refresh already in flight when it is asked for.
        const second = tree.refresh();

        await Promise.all([tree.loadDeep('.clowdy/docs'), second]);
        expect(tree.get('.clowdy/docs/plans/deep/b.md')?.kind).toBe('file');

        await fs.write('.clowdy/docs/plans/deep/c.md', '');
        await tree.refresh();
        expect(tree.get('.clowdy/docs/plans/deep/c.md')?.kind).toBe('file');
    });

    it('should list an opened folder again on refresh and leave an unloaded one out', async () => {
        const calls: string[] = [];
        const provider = {
            list: async (dir = '', depth = 1): Promise<FileEntry[]> => {
                calls.push(`${dir}:${depth}`);

                if (dir === '') {
                    return [{ path: 'src/app/foo', kind: 'directory', hasChildren: true }];
                }

                return [{ path: 'src/app/foo/bar.ts', kind: 'file', size: 1 }];
            },
        };
        const tree = new FileTree(provider as FileSystemProvider);

        await tree.refresh();
        expect(tree.get('src/app/foo/bar.ts')).toBeUndefined();
        await tree.load('src/app/foo');
        expect(tree.get('src/app/foo/bar.ts')?.kind).toBe('file');

        calls.length = 0;
        await tree.refresh();

        expect(calls).toEqual([':3', 'src/app/foo:1']);
        expect(tree.get('src/app/foo/bar.ts')?.kind).toBe('file');
    });

    it('should keep a cutoff chevron when the folder changes, and show one when a file appears inside', async () => {
        const fs = new MemoryFileSystem({ 'src/app/foo/bar.ts': '' });

        await fs.createDirectory('src/app/empty');

        const tree = new FileTree(fs);

        await tree.refresh();
        expect(tree.get('src/app/empty')?.hasChildren).toBe(false);

        tree.applyChanges([{ type: 'created', path: 'src/app/foo', kind: 'directory' }]);

        expect(tree.get('src/app/foo')?.hasChildren).toBe(true);
        expect(tree.get('src/app/foo/bar.ts')).toBeUndefined();

        tree.applyChanges([{ type: 'created', path: 'src/app/empty/new.ts', kind: 'file', size: 1 }]);

        expect(tree.get('src/app/empty')?.hasChildren).toBe(true);
        expect(tree.get('src/app/empty/new.ts')).toBeUndefined();
    });

    it('should show a chevron when the folder arrives after a file inside it', async () => {
        const tree = new FileTree(new MemoryFileSystem({ 'src/app/readme.md': '' }));

        await tree.refresh();
        tree.applyChanges([
            { type: 'created', path: 'src/app/foo/bar.ts', kind: 'file', size: 1 },
            { type: 'created', path: 'src/app/foo', kind: 'directory' },
        ]);

        expect(tree.get('src/app/foo')?.hasChildren).toBe(true);
        expect(tree.get('src/app/foo/bar.ts')).toBeUndefined();
    });

    it('should list a folder opened while the root listing is in flight', async () => {
        let releaseRoot: (entries: FileEntry[]) => void = () => {};
        const provider = {
            list: async (dir = ''): Promise<FileEntry[]> => {
                if (dir === '') {
                    return new Promise(resolve => {
                        releaseRoot = resolve;
                    });
                }

                return [{ path: `${dir}/bar.ts`, kind: 'file', size: 1 }];
            },
        };
        const tree = new FileTree(provider as FileSystemProvider);
        const listing = tree.refresh();

        await tree.load('src/app/foo');
        releaseRoot([{ path: 'src/app/foo', kind: 'directory', hasChildren: true }]);
        await listing;

        expect(tree.get('src/app/foo/bar.ts')?.kind).toBe('file');
    });

    it('should try again when opening a folder failed', async () => {
        let fail = true;
        const provider = {
            list: async (dir = ''): Promise<FileEntry[]> => {
                if (dir === 'src/app/foo') {
                    if (fail) {
                        throw new Error('offline');
                    }

                    return [{ path: 'src/app/foo/bar.ts', kind: 'file', size: 1 }];
                }

                return [{ path: 'src/app/foo', kind: 'directory', hasChildren: true }];
            },
        };
        const tree = new FileTree(provider as FileSystemProvider);

        await tree.refresh();
        await expect(tree.load('src/app/foo')).rejects.toThrow('offline');
        fail = false;
        await tree.load('src/app/foo');

        expect(tree.get('src/app/foo/bar.ts')?.kind).toBe('file');
    });

    it('should find a held file by a word or a glob, and cap the list', async () => {
        const fs = new MemoryFileSystem({
            'src/app/foo/bar.ts': 'export {}',
            'src/app/foo/other.md': '',
        });

        expect(await fs.findFiles('bar')).toEqual(['src/app/foo/bar.ts']);
        expect(await fs.findFiles('*.ts')).toEqual(['src/app/foo/bar.ts']);
        expect(await fs.findFiles('src/**/bar.ts')).toEqual(['src/app/foo/bar.ts']);

        const many = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`f${index}.ts`, '']));

        expect(await new MemoryFileSystem(many).findFiles('f')).toHaveLength(50);
    });
});
