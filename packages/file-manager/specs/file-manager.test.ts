import { describe, expect, it, vi } from 'vitest';

import { FileManager, MAX_TABS } from '../src/FileManager';
import { MemoryFileSystem } from '../src/memory/MemoryFileSystem';
import { basename } from '../src/paths';
import { FileSystemError } from '../src/provider';

import type { ClipboardEntry, FileClipboard, FileSystemProvider, WatchEvent } from '../src/provider';

const flush = () => new Promise(resolve => setTimeout(resolve));

/** The memory provider behind a watch that can drop events, as a lost connection does. */
function lossy(fs: MemoryFileSystem) {
    let dropping = false;
    const provider: FileSystemProvider = {
        list: (dir, depth) => fs.list(dir, depth),
        read: path => fs.read(path),
        write: (path, text, options) => fs.write(path, text, options),
        createDirectory: path => fs.createDirectory(path),
        move: (moves, options) => fs.move(moves, options),
        copy: (copies, options) => fs.copy(copies, options),
        delete: paths => fs.delete(paths),
        watch: listener =>
            fs.watch((event: WatchEvent) => {
                if (!dropping || event.type === 'resync') {
                    listener(event);
                }
            }),
    };

    return {
        provider,
        drop(value: boolean) {
            dropping = value;
        },
    };
}

/**
 * The host's clipboard over a disk of its own: what was copied in the tree is under `/disk`, and `held` is what another program put there. A paste writes the
 * copies into `fs` as the host does, with the text `outside` has for each file (`null` for a folder).
 */
function hostClipboard(fs: MemoryFileSystem, outside: Record<string, string | null> = {}) {
    let held: ClipboardEntry[] = [];
    const pasted = vi.fn<FileClipboard['paste']>(async (folder, items) => {
        for (const { path, name } of items) {
            const target = folder === '' ? name : `${folder}/${name}`;

            // `null` is a folder.
            if (outside[path] === null) {
                await fs.createDirectory(target);
            } else {
                await fs.write(target, outside[path] ?? '');
            }
        }
    });
    const clipboard: FileClipboard = {
        write: async paths => {
            held = await Promise.all(
                paths.map(async path => {
                    const kind =
                        (await fs.list(path, 1)).length > 0 || !path.includes('.')
                            ? ('directory' as const)
                            : ('file' as const);

                    return { path: `/disk/${path}`, name: basename(path), kind, local: path };
                })
            );
        },
        read: async () => held,
        paste: pasted,
    };

    return {
        clipboard,
        pasted,
        /** What another program copied. */
        copyOutside(...entries: ClipboardEntry[]) {
            held = entries;
        },
    };
}

describe('FileManager', () => {
    it('should open a file at a 1-based selection and clamp past the end', async () => {
        const manager = new FileManager({ provider: new MemoryFileSystem({ 'a.ts': 'first\nsecond\n' }) });

        await manager.start();
        await manager.open('a.ts', { from: { line: 2, column: 1 }, to: { line: 2, column: 2147483647 } });

        expect(manager.activeEditor).toEqual({
            path: 'a.ts',
            selection: { from: { line: 2, column: 1 }, to: { line: 2, column: 7 } },
            lineCount: 3,
        });

        await manager.open('./a.ts', { from: { line: 99, column: 5 } });

        expect(manager.tabs.documents).toHaveLength(1);
        expect(manager.activeEditor?.selection).toEqual({ from: { line: 3, column: 1 } });
    });

    it('should paste the copied items into a folder, and a copied folder next to itself', async () => {
        const fs = new MemoryFileSystem({ 'app/page.tsx': 'page', 'lib/util.ts': 'util' });
        const host = hostClipboard(fs);
        const manager = new FileManager({ provider: fs, clipboard: host.clipboard });

        await manager.start();
        await manager.copy(['app/page.tsx']);
        await manager.paste('lib');

        expect(manager.revealed).toEqual({ path: 'lib/page.tsx' });
        await expect(fs.read('lib/page.tsx')).resolves.toMatchObject({ text: 'page' });

        await manager.copy(['lib']);
        await manager.paste('lib');

        expect(manager.revealed).toEqual({ path: 'lib copy' });
        await expect(fs.read('lib copy/util.ts')).resolves.toMatchObject({ text: 'util' });
        // The provider made both copies: the host copies only what comes from outside.
        expect(host.pasted).not.toHaveBeenCalled();
    });

    it('should copy a selection once, without what a selected folder holds', async () => {
        const fs = new MemoryFileSystem({ 'app/ui/button.tsx': '', 'app/page.tsx': '' });
        const host = hostClipboard(fs);
        const write = vi.spyOn(host.clipboard, 'write');
        const manager = new FileManager({ provider: fs, clipboard: host.clipboard });

        await manager.start();
        await manager.copy(['app/ui/button.tsx', 'app/ui', 'app/page.tsx', 'app/ui']);

        expect(write).toHaveBeenCalledWith(['app/page.tsx', 'app/ui']);
    });

    it('should paste what was copied outside under its name, and a taken name as a copy', async () => {
        const fs = new MemoryFileSystem({ 'docs/notes.md': 'notes' });
        const host = hostClipboard(fs, {
            '/Users/dev/Downloads/report.pdf': 'report',
            '/Users/dev/Downloads/notes.md': 'other',
            '/Users/dev/Downloads/photos': null,
        });
        const manager = new FileManager({ provider: fs, clipboard: host.clipboard });

        await manager.start();
        host.copyOutside(
            { path: '/Users/dev/Downloads/report.pdf', name: 'report.pdf', kind: 'file' },
            { path: '/Users/dev/Downloads/notes.md', name: 'notes.md', kind: 'file' },
            { path: '/Users/dev/Downloads/photos', name: 'photos', kind: 'directory' }
        );
        await manager.paste('docs');

        expect(host.pasted).toHaveBeenCalledWith('docs', [
            { path: '/Users/dev/Downloads/report.pdf', name: 'report.pdf' },
            { path: '/Users/dev/Downloads/notes.md', name: 'notes copy.md' },
            { path: '/Users/dev/Downloads/photos', name: 'photos' },
        ]);
        expect(manager.revealed).toEqual({ path: 'docs/report.pdf' });
        // The tree shows them before the provider's watch has said anything.
        expect(manager.tree.get('docs/notes copy.md')?.kind).toBe('file');
        expect(manager.tree.get('docs/photos')?.kind).toBe('directory');
        await expect(fs.read('docs/notes.md')).resolves.toMatchObject({ text: 'notes' });
        await expect(fs.read('docs/notes copy.md')).resolves.toMatchObject({ text: 'other' });

        // Pasted again, the files that came the first time are taken too.
        host.pasted.mockClear();
        await manager.paste('docs');

        expect(host.pasted.mock.calls[0]?.[1].map(item => item.name)).toEqual([
            'report copy.pdf',
            'notes copy 2.md',
            'photos copy',
        ]);
    });

    it('should treat a name that differs only in case as taken, as the disk does, and paste files of both kinds in one go', async () => {
        const fs = new MemoryFileSystem({ 'docs/README.md': '', 'app/page.tsx': 'page' });
        const host = hostClipboard(fs, { '/Users/dev/readme.md': 'other' });
        const manager = new FileManager({ provider: fs, clipboard: host.clipboard });

        await manager.start();
        host.copyOutside(
            { path: '/Users/dev/readme.md', name: 'readme.md', kind: 'file' },
            { path: '/disk/app/page.tsx', name: 'page.tsx', kind: 'file', local: 'app/page.tsx' }
        );
        await manager.paste('docs');

        // The provider copied the file it lists, the host the other one, under a name the disk would not refuse.
        expect(host.pasted).toHaveBeenCalledWith('docs', [{ path: '/Users/dev/readme.md', name: 'readme copy.md' }]);
        await expect(fs.read('docs/page.tsx')).resolves.toMatchObject({ text: 'page' });
        await expect(fs.read('docs/readme copy.md')).resolves.toMatchObject({ text: 'other' });
    });

    it('should paste a file of the root that the tree does not list as an outside one, and keep the tree when the host refuses', async () => {
        const fs = new MemoryFileSystem({ 'a.ts': 'a' });
        const notify = vi.fn();
        const host = hostClipboard(fs);
        const manager = new FileManager({ provider: fs, notify, clipboard: host.clipboard });

        await manager.start();
        host.copyOutside({ path: '/disk/dist/out.js', name: 'out.js', kind: 'file', local: 'dist/out.js' });
        await manager.paste('');

        expect(host.pasted).toHaveBeenCalledWith('', [{ path: '/disk/dist/out.js', name: 'out.js' }]);

        host.pasted.mockRejectedValueOnce(new Error('out.js already exists'));
        host.copyOutside({ path: '/Users/dev/x.txt', name: 'x.txt', kind: 'file' });
        await manager.paste('');
        await flush();

        expect(notify).toHaveBeenCalledWith(
            'Couldn’t paste x.txt',
            expect.objectContaining({ message: 'out.js already exists' })
        );
        expect(manager.tree.get('x.txt')).toBeUndefined();
    });

    it("should say there is nothing to paste, and do nothing without the host's clipboard or on a read only provider", async () => {
        const fs = new MemoryFileSystem({ 'a.ts': 'a' });
        const notify = vi.fn();
        const host = hostClipboard(fs);
        const manager = new FileManager({ provider: fs, notify, clipboard: host.clipboard });

        await manager.start();
        await manager.paste('');

        expect(notify).toHaveBeenCalledWith('Nothing to paste', undefined);
        expect(manager.canCopy).toBe(true);
        expect(manager.canPaste).toBe(true);

        const bare = new FileManager({ provider: fs });

        await bare.start();
        await bare.copy(['a.ts']);
        await bare.paste('');

        expect([bare.canCopy, bare.canPaste]).toEqual([false, false]);

        const locked = new FileManager({
            provider: { ...lossy(fs).provider, capabilities: { readonly: true } },
            clipboard: host.clipboard,
        });

        expect([locked.canCopy, locked.canPaste]).toEqual([true, false]);
    });

    it('should reveal a folder instead of opening it', async () => {
        const manager = new FileManager({ provider: new MemoryFileSystem({ 'app/page.tsx': '' }) });

        await manager.start();

        expect(await manager.open('app/')).toBeNull();
        expect(manager.revealed).toEqual({ path: 'app' });
        expect(manager.tabs.documents).toHaveLength(0);
        expect(manager.activeEditor).toBeNull();
    });

    it('should report a tab without text with no selection', async () => {
        const manager = new FileManager({ provider: new MemoryFileSystem({ 'a.bin': new Uint8Array([0xff]) }) });

        await manager.open('a.bin');

        expect(manager.activeEditor).toEqual({ path: 'a.bin', selection: null, lineCount: 0 });
    });

    it('should report no selection for rich text, and open at a line in source', async () => {
        const manager = new FileManager({ provider: new MemoryFileSystem({ 'README.md': '# Title\n\nBody\n' }) });

        await manager.open('README.md');

        expect(manager.activeEditor).toEqual({ path: 'README.md', selection: null, lineCount: 4 });

        const document = await manager.open('README.md', { from: { line: 3, column: 1 } });

        expect(document?.view).toBe('source');
        expect(manager.activeEditor?.selection).toEqual({ from: { line: 3, column: 1 } });
    });

    it('should close the least recently used tabs past the limit, keeping unsaved ones', async () => {
        const files = Object.fromEntries(Array.from({ length: MAX_TABS + 2 }, (_, index) => [`${index}.ts`, '']));
        const manager = new FileManager({ provider: new MemoryFileSystem(files) });

        await manager.start();

        for (let index = 0; index < MAX_TABS; index++) {
            await manager.open(`${index}.ts`);
        }

        manager.tabs.get('0.ts')?.dispatch({ changes: { from: 0, insert: '// ' } });
        await manager.open('1.ts');
        await manager.open(`${MAX_TABS}.ts`);
        await manager.open(`${MAX_TABS + 1}.ts`);

        expect(manager.snapshot()).toEqual({
            paths: Object.keys(files).filter(path => path !== '2.ts' && path !== '3.ts'),
            active: `${MAX_TABS + 1}.ts`,
        });
    });

    it('should restore open tabs from a snapshot, skipping files that are gone', async () => {
        const fs = new MemoryFileSystem({ 'a.ts': '', 'b.ts': '', 'c.ts': '' });
        const first = new FileManager({ provider: fs });

        await first.start();
        await first.open('a.ts');
        await first.open('b.ts');
        await first.open('c.ts');
        first.tabs.activate('b.ts');
        const snapshot = first.snapshot();

        first.dispose();
        await fs.delete(['a.ts']);

        const second = new FileManager({ provider: fs });

        void second.start();
        await second.restore(snapshot);

        expect(snapshot).toEqual({ paths: ['a.ts', 'b.ts', 'c.ts'], active: 'b.ts' });
        expect(second.snapshot()).toEqual({ paths: ['b.ts', 'c.ts'], active: 'b.ts' });
    });

    it('should restore and reload a tab on a file below the listed folders', async () => {
        const deep = 'src/app/blog/post/page.tsx';
        const fs = new MemoryFileSystem({ [deep]: 'old\n', 'page.tsx': 'new\n' });
        const manager = new FileManager({ provider: fs });

        void manager.start();
        await manager.restore({ paths: [deep, 'src/app/blog/post/gone.tsx'], active: deep });

        expect(manager.tree.get(deep)).toBeUndefined();
        expect(manager.snapshot()).toEqual({ paths: [deep], active: deep });

        // A move replaces it; the tab reads the new file instead of closing as gone.
        await expect(
            manager.operations.move(['page.tsx'], 'src/app/blog/post', { confirmReplace: () => true })
        ).resolves.toBe(true);
        await flush();

        expect(manager.tabs.get(deep)?.state?.doc.toString()).toBe('new\n');
        manager.dispose();
    });

    it('should save every dirty document without a view', async () => {
        const fs = new MemoryFileSystem({ 'a.ts': 'a\n', 'b.ts': 'b\n', 'c.ts': 'c\n' });
        const manager = new FileManager({ provider: fs });

        await manager.start();

        for (const path of ['a.ts', 'b.ts']) {
            const document = await manager.open(path);

            document?.dispatch({ changes: { from: 0, insert: '// ' } });
        }

        await manager.open('c.ts');

        expect(await manager.saveAll()).toBe(true);
        expect(await fs.read('a.ts')).toMatchObject({ text: '// a\n' });
        expect(await fs.read('b.ts')).toMatchObject({ text: '// b\n' });
        expect(manager.tabs.documents.some(document => document.dirty)).toBe(false);
    });

    it('should notify when a save fails', async () => {
        const fs = new MemoryFileSystem({ 'a.ts': 'a\n' });
        const notify = vi.fn();
        const manager = new FileManager({ provider: fs, notify });
        const document = await manager.open('a.ts');

        vi.spyOn(fs, 'write').mockRejectedValue(new FileSystemError('Unavailable', 'offline'));
        document?.dispatch({ changes: { from: 0, insert: 'b' } });

        expect(await manager.saveAll()).toBe(false);
        expect(notify).toHaveBeenCalledWith(expect.stringContaining('a.ts'), expect.any(FileSystemError));
        expect(document?.dirty).toBe(true);
    });

    it('should reload open files on resync', async () => {
        const fs = new MemoryFileSystem({ 'a.ts': 'one\n' });
        const { provider, drop } = lossy(fs);
        const manager = new FileManager({ provider });

        await manager.start();
        const document = await manager.open('a.ts');

        drop(true);
        await fs.write('a.ts', 'two\n');
        await flush();

        expect(document?.state?.doc.toString()).toBe('one\n');

        drop(false);
        fs.resync();
        await flush();

        expect(document?.state?.doc.toString()).toBe('two\n');
    });

    it('should close a clean tab and mark a dirty one when a resync finds their files deleted', async () => {
        const fs = new MemoryFileSystem({ 'a.ts': 'a\n', 'b.ts': 'b\n' });
        const { provider, drop } = lossy(fs);
        const manager = new FileManager({ provider });

        await manager.start();
        await manager.open('a.ts');
        const dirty = await manager.open('b.ts');

        dirty?.dispatch({ changes: { from: 0, insert: '// ' } });
        drop(true);
        await fs.delete(['a.ts', 'b.ts']);
        await flush();
        drop(false);
        fs.resync();
        await flush();

        expect(manager.tabs.documents.map(document => document.path)).toEqual(['b.ts']);
        expect(dirty?.deleted).toBe(true);
    });

    it('should restore tabs when a resync replaces the first listing', async () => {
        const fs = new MemoryFileSystem({ 'a.ts': '' });
        const listings: Array<() => void> = [];
        const manager = new FileManager({
            provider: {
                ...lossy(fs).provider,
                list: () =>
                    new Promise(resolve => {
                        listings.push(() => resolve(fs.list()));
                    }),
            },
        });

        void manager.start();
        const restoring = manager.restore({ paths: ['a.ts'], active: 'a.ts' });

        fs.resync();
        // The replaced listing finishes first.
        listings[0]?.();
        await flush();
        listings[1]?.();
        await restoring;

        expect(manager.snapshot()).toEqual({ paths: ['a.ts'], active: 'a.ts' });
    });

    it('should tell a folder from a file while the first listing runs', async () => {
        const manager = new FileManager({ provider: new MemoryFileSystem({ 'app/page.tsx': '' }) });

        void manager.start();

        expect(await manager.open('app')).toBeNull();
        expect(manager.tabs.documents).toHaveLength(0);
    });

    it('should stop following the provider once disposed', async () => {
        const fs = new MemoryFileSystem();
        const manager = new FileManager({ provider: fs });

        await manager.start();
        manager.dispose();
        await fs.write('a.ts', '');
        await flush();

        expect(manager.tree.get('a.ts')).toBeUndefined();
    });
});

describe('FileManager filter', () => {
    function filtered(files: Record<string, string>) {
        return new FileManager({
            provider: new MemoryFileSystem(files),
            exclude: ['**/node_modules'],
            hidden: ['**/.*'],
        });
    }

    it('should list a file below the loaded depth with the folders above it, skipping paths the tree hides', async () => {
        const manager = filtered({
            'src/app/foo/bar.ts': '',
            'src/app/other/x.ts': '',
            'node_modules/bar.js': '',
            '.bar.json': '',
        });

        await manager.start();

        expect(manager.tree.get('src/app/foo/bar.ts')).toBeUndefined();

        await manager.filter('bar');

        expect(manager.filterResult).toEqual({ query: 'bar', paths: new Set(['src/app/foo/bar.ts']) });
        expect(manager.tree.children('src').map(entry => entry.path)).toEqual(['src/app']);
        expect(manager.tree.children('src/app').map(entry => entry.path)).toEqual(['src/app/foo', 'src/app/other']);
        expect(manager.tree.children('src/app/foo').map(entry => entry.path)).toEqual(['src/app/foo/bar.ts']);
    });

    it('should clear the result when the query is emptied', async () => {
        const manager = filtered({ 'src/app/foo/bar.ts': '' });

        await manager.start();
        await manager.filter('bar');

        expect(manager.filterResult?.paths).toEqual(new Set(['src/app/foo/bar.ts']));

        await manager.filter('  ');

        expect(manager.filterQuery).toBe('  ');
        expect(manager.filterResult).toBeNull();
    });

    it("should find a file the tree lists although the provider's own search leaves it out, such as one git ignores, and words that are not one name", async () => {
        const fs = new MemoryFileSystem({ 'BACKLOG.md': '', 'src/booking/price.ts': '', 'src/other.ts': '' });
        const manager = new FileManager({ provider: fs });

        vi.spyOn(fs, 'findFiles').mockResolvedValue([]);
        await manager.start();
        await manager.filter('backlog');

        expect(manager.filterResult?.paths).toEqual(new Set(['BACKLOG.md']));
        expect(manager.listedFiles('booking price')).toEqual(['src/booking/price.ts']);
        expect(manager.listedFiles('  ')).toEqual([]);
    });

    it('should find hidden files once they are shown', async () => {
        const manager = filtered({ 'src/bar.ts': '', '.bar.json': '' });

        await manager.start();
        await manager.filter('bar');

        expect(manager.filterResult?.paths).toEqual(new Set(['src/bar.ts']));

        manager.tree.setShowHidden(true);
        await manager.filter(manager.filterQuery);

        expect(manager.filterResult?.paths).toEqual(new Set(['src/bar.ts', '.bar.json']));
    });

    it('should drop a result the query has moved past', async () => {
        const manager = filtered({ 'src/app/foo/bar.ts': '', 'src/baz.ts': '' });

        await manager.start();

        const cleared = manager.filter('bar');

        void manager.filter('');
        await cleared;

        expect(manager.filterResult).toBeNull();

        const first = manager.filter('bar');
        const second = manager.filter('baz');

        await Promise.all([first, second]);

        expect(manager.filterResult).toEqual({ query: 'baz', paths: new Set(['src/baz.ts']) });
    });

    it('should report a folder it can’t list and still show what it found', async () => {
        const fs = new MemoryFileSystem({ 'src/app/foo/bar.ts': '', 'bar.md': '' });
        const list = fs.list.bind(fs);
        const notify = vi.fn();
        const manager = new FileManager({ provider: fs, notify });

        vi.spyOn(fs, 'list').mockImplementation((dir, depth) =>
            dir === 'src/app/foo' ? Promise.reject(new Error('offline')) : list(dir, depth)
        );

        await manager.start();
        await manager.filter('bar');

        expect(notify).toHaveBeenCalledWith('Couldn’t list files', expect.objectContaining({ message: 'offline' }));
        expect(manager.filterResult?.paths.has('bar.md')).toBe(true);
    });
});
