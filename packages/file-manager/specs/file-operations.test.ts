import { describe, expect, it, vi } from 'vitest';

import { FileManager } from '../src/FileManager';
import { MemoryFileSystem } from '../src/memory/MemoryFileSystem';
import { FileSystemError } from '../src/provider';

import type { FileSystemProvider, WatchEvent } from '../src/provider';

const flush = () => new Promise(resolve => setTimeout(resolve));

const FILES = {
    'app/page.tsx': 'export default function Page() {}\n',
    'app/layout.tsx': 'export default function Layout() {}\n',
    'app/ui/button.tsx': 'export function Button() {}\n',
    '.env': 'KEY=1\n',
};

/** The memory provider with its watch events held until `release`, as a socket delivers them late. */
function heldWatch(fs: MemoryFileSystem) {
    const held: WatchEvent[] = [];
    let deliver: (event: WatchEvent) => void = () => {};
    const provider: FileSystemProvider = {
        list: (dir, depth) => fs.list(dir, depth),
        read: path => fs.read(path),
        write: (path, text, options) => fs.write(path, text, options),
        createDirectory: path => fs.createDirectory(path),
        move: (moves, options) => fs.move(moves, options),
        copy: (copies, options) => fs.copy(copies, options),
        delete: paths => fs.delete(paths),
        watch: listener => {
            deliver = listener;

            return fs.watch(event => held.push(event));
        },
    };

    return {
        provider,
        release() {
            for (const event of held.splice(0)) {
                deliver(event);
            }
        },
    };
}

async function setup(files: Record<string, string> = FILES, provider?: (fs: MemoryFileSystem) => FileSystemProvider) {
    const fs = new MemoryFileSystem(files);
    const notify = vi.fn();
    const manager = new FileManager({ provider: provider?.(fs) ?? fs, notify });
    const calls = {
        write: vi.spyOn(fs, 'write'),
        createDirectory: vi.spyOn(fs, 'createDirectory'),
        move: vi.spyOn(fs, 'move'),
        copy: vi.spyOn(fs, 'copy'),
        delete: vi.spyOn(fs, 'delete'),
        read: vi.spyOn(fs, 'read'),
    };

    await manager.start();

    return { fs, manager, notify, calls, operations: manager.operations };
}

async function listing(fs: MemoryFileSystem): Promise<string[]> {
    return (await fs.list()).map(entry => entry.path).sort();
}

function treePaths(manager: FileManager): string[] {
    return [...manager.tree.entries.keys()].sort();
}

describe('FileOperations', () => {
    it('should name copies made in their own folder “name copy”, then “name copy 2”, keeping the extension', async () => {
        const { fs, manager, operations } = await setup();

        await expect(operations.copy(['app/page.tsx'], 'app')).resolves.toEqual(['app/page copy.tsx']);
        await expect(operations.copy(['app/page.tsx'], 'app')).resolves.toEqual(['app/page copy 2.tsx']);
        await expect(operations.copy(['app/page copy.tsx'], 'app')).resolves.toEqual(['app/page copy 3.tsx']);
        await expect(operations.copy(['app/ui'], 'app')).resolves.toEqual(['app/ui copy']);
        await expect(operations.copy(['.env'], '')).resolves.toEqual(['.env copy']);

        await expect(fs.read('app/page copy 2.tsx')).resolves.toMatchObject({ text: FILES['app/page.tsx'] });
        await expect(fs.read('app/ui copy/button.tsx')).resolves.toMatchObject({ text: FILES['app/ui/button.tsx'] });
        expect(treePaths(manager)).toEqual(await listing(fs));
    });

    it('should copy a selection into a folder in one call, naming taken names “name copy”', async () => {
        const { fs, manager, calls, operations } = await setup({ ...FILES, 'lib/page.tsx': 'lib\n' });

        await expect(
            operations.copy(['app/page.tsx', 'app/ui', 'app/ui/button.tsx', 'app/layout.tsx'], 'lib')
        ).resolves.toEqual(['lib/layout.tsx', 'lib/page copy.tsx', 'lib/ui']);

        expect(calls.copy.mock.calls).toEqual([
            [
                [
                    { from: 'app/layout.tsx', to: 'lib/layout.tsx' },
                    { from: 'app/page.tsx', to: 'lib/page copy.tsx' },
                    { from: 'app/ui', to: 'lib/ui' },
                ],
            ],
        ]);
        await expect(fs.read('lib/page.tsx')).resolves.toMatchObject({ text: 'lib\n' });
        await expect(fs.read('lib/page copy.tsx')).resolves.toMatchObject({ text: FILES['app/page.tsx'] });
        expect(treePaths(manager)).toEqual(await listing(fs));
    });

    it('should list a folder before copying into it, so a taken name is not replaced', async () => {
        // Below the first listing's depth.
        const { fs, calls, operations } = await setup({ 'a.ts': 'a\n', 'src/app/lib/a.ts': 'lib\n' });

        await expect(operations.copy(['a.ts'], 'src/app/lib')).resolves.toEqual(['src/app/lib/a copy.ts']);
        expect(calls.copy).toHaveBeenCalledOnce();
        await expect(fs.read('src/app/lib/a.ts')).resolves.toMatchObject({ text: 'lib\n' });
    });

    it('should skip an item deleted while the target folder lists', async () => {
        const { fs, notify, operations } = await setup({ 'a.ts': 'a\n', 'b.ts': 'b\n', 'src/app/lib/a.ts': '' }, fs => {
            const list = fs.list.bind(fs);

            fs.list = async (dir, depth) => {
                if (dir === 'src/app/lib') {
                    await fs.delete(['a.ts']);
                }

                return list(dir, depth);
            };

            return fs;
        });

        await expect(operations.copy(['a.ts', 'b.ts'], 'src/app/lib')).resolves.toEqual(['src/app/lib/b.ts']);
        await expect(fs.read('src/app/lib/b.ts')).resolves.toMatchObject({ text: 'b\n' });
        expect(notify).not.toHaveBeenCalled();
    });

    it('should refuse to copy a folder into itself and report items that are gone', async () => {
        const { notify, calls, operations } = await setup();

        await expect(operations.copy(['app'], 'app/ui')).resolves.toEqual([]);
        await expect(operations.copy(['missing.ts'], 'app')).resolves.toEqual([]);
        await expect(operations.copy([], 'app')).resolves.toEqual([]);

        expect(calls.copy).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledTimes(2);
    });

    it('should upload files and folders into a folder, naming taken names “name copy”', async () => {
        const { fs, manager, calls, operations } = await setup();
        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

        await expect(
            operations.upload(
                [
                    { path: 'page.tsx', file: new Blob(['dropped\n']) },
                    { path: 'icons', file: null },
                    { path: 'icons/logo.png', file: new Blob([png]) },
                    { path: 'icons/empty', file: null },
                ],
                'app'
            )
        ).resolves.toEqual(['app/page copy.tsx', 'app/icons']);

        await expect(fs.read('app/page.tsx')).resolves.toMatchObject({ text: FILES['app/page.tsx'] });
        await expect(fs.read('app/page copy.tsx')).resolves.toMatchObject({ text: 'dropped\n' });

        const logo = await fs.read('app/icons/logo.png');

        expect(logo.kind === 'binary' && new Uint8Array(await logo.blob.arrayBuffer())).toEqual(png);
        expect(calls.write.mock.calls.map(([path]) => path)).toEqual(['app/page copy.tsx', 'app/icons/logo.png']);
        expect(calls.createDirectory.mock.calls).toEqual([['app/icons/empty']]);
        expect(treePaths(manager)).toEqual(await listing(fs));
    });

    it('should create files and folders with nested names and refuse names that are taken', async () => {
        const { fs, manager, notify, calls, operations } = await setup();

        await expect(operations.createFile('app', 'ui/forms/input.tsx')).resolves.toBe('app/ui/forms/input.tsx');
        await expect(operations.createDirectory('', 'lib/utils')).resolves.toBe('lib/utils');
        await expect(fs.read('app/ui/forms/input.tsx')).resolves.toMatchObject({ text: '' });
        expect(manager.tree.get('lib/utils')?.kind).toBe('directory');
        expect(manager.tree.get('app/ui/forms/input.tsx')).toBeUndefined();
        await manager.tree.load('app/ui/forms');
        expect(manager.tree.get('app/ui/forms/input.tsx')?.kind).toBe('file');
        expect(treePaths(manager)).toEqual(await listing(fs));

        calls.write.mockClear();

        for (const name of ['page.tsx', ' ', 'a//b.ts', '../escape.ts', 'page.tsx/inside.ts']) {
            expect(operations.validateName('app', name)).toEqual(expect.any(String));
            await expect(operations.createFile('app', name)).resolves.toBeNull();
        }

        expect(calls.write).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledTimes(5);
        expect(operations.validateName('app', 'page.tsx', 'app/page.tsx')).toBeNull();
    });

    it('should make each action one provider call, a multi-selection included', async () => {
        const { fs, calls, operations } = await setup();

        await operations.createFile('', 'notes/todo.md');
        await operations.createDirectory('', 'lib');
        await operations.rename('app/layout.tsx', 'root.tsx');
        await operations.move(['app/page.tsx', 'app/ui', 'app/ui/button.tsx'], 'lib');
        await operations.copy(['lib/page.tsx'], 'lib');
        await operations.delete(['notes', 'notes/todo.md', 'lib/page copy.tsx']);

        expect(calls.write).toHaveBeenCalledOnce();
        expect(calls.write).toHaveBeenCalledWith('notes/todo.md', '', { expectedVersion: null });
        expect(calls.createDirectory).toHaveBeenCalledOnce();
        expect(calls.move.mock.calls).toEqual([
            [[{ from: 'app/layout.tsx', to: 'app/root.tsx' }], { overwrite: false }],
            [
                [
                    { from: 'app/page.tsx', to: 'lib/page.tsx' },
                    { from: 'app/ui', to: 'lib/ui' },
                ],
                { overwrite: false },
            ],
        ]);
        expect(calls.copy).toHaveBeenCalledOnce();
        expect(calls.delete.mock.calls).toEqual([[['lib/page copy.tsx', 'notes']]]);
        expect(await listing(fs)).toEqual([
            '.env',
            'app',
            'app/root.tsx',
            'lib',
            'lib/page.tsx',
            'lib/ui',
            'lib/ui/button.tsx',
        ]);
    });

    it('should ask before replacing and move with overwrite only when the person agrees', async () => {
        const { fs, calls, operations } = await setup({ 'a/page.tsx': 'new\n', 'b/page.tsx': 'old\n' });
        const confirmReplace = vi.fn(() => false);

        await expect(operations.move(['a/page.tsx'], 'b', { confirmReplace })).resolves.toBe(false);
        await expect(operations.move(['a/page.tsx'], 'b')).resolves.toBe(false);
        expect(confirmReplace).toHaveBeenCalledWith(['page.tsx']);
        expect(calls.move).not.toHaveBeenCalled();

        confirmReplace.mockReturnValue(true);

        await expect(operations.move(['a/page.tsx'], 'b', { confirmReplace })).resolves.toBe(true);
        expect(calls.move.mock.calls).toEqual([[[{ from: 'a/page.tsx', to: 'b/page.tsx' }], { overwrite: true }]]);
        await expect(fs.read('b/page.tsx')).resolves.toMatchObject({ text: 'new\n' });
    });

    it('should ask and retry when the provider reports a target the tree did not know', async () => {
        const { fs, manager, calls, operations } = await setup({ 'a/page.tsx': 'new\n', 'b/other.tsx': '' });
        const confirmReplace = vi.fn(() => true);

        manager.dispose();
        await fs.write('b/page.tsx', 'old\n');

        await expect(operations.move(['a/page.tsx'], 'b', { confirmReplace })).resolves.toBe(true);
        expect(confirmReplace).toHaveBeenCalledOnce();
        expect(calls.move.mock.calls.map(([, options]) => options)).toEqual([
            { overwrite: false },
            { overwrite: true },
        ]);
        await expect(fs.read('b/page.tsx')).resolves.toMatchObject({ text: 'new\n' });
    });

    it('should refuse to move a folder into itself or a folder inside it', async () => {
        const { manager, notify, calls, operations } = await setup();
        const before = treePaths(manager);

        await expect(operations.move(['app'], 'app/ui')).resolves.toBe(false);
        await expect(operations.move(['app/ui', 'app/page.tsx'], 'app/ui')).resolves.toBe(false);
        expect(operations.validateName('app', 'ui/nested', 'app/ui')).toEqual(expect.any(String));
        await expect(operations.rename('app/ui', 'ui/nested')).resolves.toBeNull();

        expect(calls.move).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledTimes(3);
        expect(treePaths(manager)).toEqual(before);
    });

    it('should move open tabs with a rename or a move, unsaved edits and the active tab included', async () => {
        const { fs, manager, operations } = await setup();
        const page = (await manager.open('app/page.tsx'))!;
        const button = (await manager.open('app/ui/button.tsx'))!;

        page.dispatch({ changes: { from: 0, insert: '// mine\n' } });

        await operations.rename('app/page.tsx', 'home.tsx');
        await operations.move(['app/ui'], '');
        await flush();

        expect(manager.tabs.documents).toEqual([page, button]);
        expect(page.path).toBe('app/home.tsx');
        expect(page.dirty).toBe(true);
        expect(button.path).toBe('ui/button.tsx');
        expect(manager.activeEditor?.path).toBe('ui/button.tsx');

        await expect(page.save()).resolves.toBe(true);
        await expect(fs.read('app/home.tsx')).resolves.toMatchObject({ text: `// mine\n${FILES['app/page.tsx']}` });
    });

    it('should follow moves made elsewhere and close a tab whose file a move replaced', async () => {
        const { fs, manager, operations } = await setup({ 'a.ts': 'a\n', 'b.ts': 'b\n', 'dir/c.ts': 'c\n' });
        const a = (await manager.open('a.ts'))!;
        const c = (await manager.open('dir/c.ts'))!;

        await manager.open('b.ts');

        // An app undo moved them; the host passes the moves before the watch reports them.
        const moved = fs.move(
            [
                { from: 'a.ts', to: 'b.ts' },
                { from: 'dir', to: 'lib' },
            ],
            { overwrite: true }
        );

        operations.applyMoves([
            { from: 'a.ts', to: 'b.ts' },
            { from: 'dir', to: 'lib' },
        ]);
        await moved;
        await flush();

        expect(manager.tabs.documents).toEqual([a, c]);
        expect(a.path).toBe('b.ts');
        expect(a.state!.doc.toString()).toBe('a\n');
        expect(c.path).toBe('lib/c.ts');
        expect(treePaths(manager)).toEqual(await listing(fs));
    });

    it('should reload a clean tab on a replaced file and keep unsaved edits in “Changed on disk”', async () => {
        const { fs, manager, operations } = await setup({
            'a/page.tsx': 'new page\n',
            'a/layout.tsx': 'new layout\n',
            'b/page.tsx': 'old page\n',
            'b/layout.tsx': 'old layout\n',
        });
        const page = (await manager.open('b/page.tsx'))!;
        const layout = (await manager.open('b/layout.tsx'))!;

        await manager.open('a/page.tsx');
        page.dispatch({ changes: { from: 0, insert: '// mine\n' } });

        await expect(
            operations.move(['a/page.tsx', 'a/layout.tsx'], 'b', { confirmReplace: () => true })
        ).resolves.toBe(true);
        await flush();

        // The moved tab gives way to the unsaved one on its new path.
        expect(manager.tabs.documents).toEqual([page, layout]);
        expect(page.state!.doc.toString()).toBe('// mine\nold page\n');
        expect(page.conflict).toBe(true);
        expect(layout.state!.doc.toString()).toBe('new layout\n');
        expect(layout.dirty).toBe(false);

        await page.reload();

        expect(page.state!.doc.toString()).toBe('new page\n');
        expect(treePaths(manager)).toEqual(await listing(fs));
    });

    it('should put tabs and the tree back when a move fails', async () => {
        const { manager, notify, calls, operations } = await setup();
        const page = (await manager.open('app/page.tsx'))!;
        const before = treePaths(manager);

        calls.move.mockRejectedValueOnce(new FileSystemError('Unavailable', 'Offline'));

        await expect(operations.rename('app/page.tsx', 'home.tsx')).resolves.toBeNull();
        await flush();

        expect(page.path).toBe('app/page.tsx');
        expect(manager.activeEditor?.path).toBe('app/page.tsx');
        expect(treePaths(manager)).toEqual(before);
        expect(notify).toHaveBeenCalledOnce();
    });

    it('should change nothing when the watch reports an operation after the tree changed', async () => {
        let watch: ReturnType<typeof heldWatch> | undefined;
        const { manager, calls, operations } = await setup(FILES, fs => {
            watch = heldWatch(fs);

            return watch.provider;
        });
        const page = (await manager.open('app/page.tsx'))!;

        calls.read.mockClear();

        await operations.rename('app/page.tsx', 'home.tsx');
        await operations.copy(['app/ui'], 'app');
        await operations.createFile('app', 'new.tsx');
        await operations.delete(['app/layout.tsx']);

        const patched = treePaths(manager);

        watch!.release();
        await flush();

        expect(treePaths(manager)).toEqual(patched);
        expect(manager.tabs.documents).toEqual([page]);
        expect(page.path).toBe('app/home.tsx');
        expect(page.status).toBe('text');
        expect(calls.read).not.toHaveBeenCalled();
    });

    it('should close clean tabs on delete and keep unsaved ones marked deleted', async () => {
        const { manager, operations } = await setup();
        const page = (await manager.open('app/page.tsx'))!;
        const button = (await manager.open('app/ui/button.tsx'))!;

        button.dispatch({ changes: { from: 0, insert: '// mine\n' } });

        await expect(operations.delete(['app'])).resolves.toBe(true);
        await flush();

        expect(manager.tabs.documents).toEqual([button]);
        expect(page.path).toBe('app/page.tsx');
        expect(button.deleted).toBe(true);
    });
});
