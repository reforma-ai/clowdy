import { describe, expect, it } from 'vitest';

import { MemoryFileSystem } from '../src/memory/MemoryFileSystem';
import { FileSystemError } from '../src/provider';

import type { FileChange, WatchEvent } from '../src/provider';

function watchChanges(fs: MemoryFileSystem): FileChange[][] {
    const batches: FileChange[][] = [];

    fs.watch(event => {
        if (event.type === 'changes') {
            batches.push([...event.changes]);
        }
    });

    return batches;
}

async function rejection(promise: Promise<unknown>): Promise<FileSystemError> {
    const error = await promise.then(
        () => null,
        (reason: unknown) => reason
    );

    if (!FileSystemError.is(error)) {
        throw new Error('expected a FileSystemError');
    }

    return error;
}

const flush = () => new Promise(resolve => setTimeout(resolve));

describe('MemoryFileSystem', () => {
    it('should list files with their parent folders and byte sizes', async () => {
        const fs = new MemoryFileSystem({ 'app/blog/page.tsx': 'é', 'README.md': '' });

        expect(await fs.list()).toEqual(
            expect.arrayContaining([
                { path: 'app', kind: 'directory' },
                { path: 'app/blog', kind: 'directory' },
                { path: 'app/blog/page.tsx', kind: 'file', size: 2 },
                { path: 'README.md', kind: 'file', size: 0 },
            ])
        );
    });

    it('should read UTF-8 as text and other bytes as binary', async () => {
        const fs = new MemoryFileSystem({
            'utf8.txt': new TextEncoder().encode('héllo'),
            'latin1.txt': new Uint8Array([0x68, 0xe9, 0x6c]),
        });

        expect(await fs.read('utf8.txt')).toMatchObject({ kind: 'text', text: 'héllo' });

        const binary = await fs.read('latin1.txt');

        expect(binary.kind).toBe('binary');
        expect(binary.kind === 'binary' && binary.blob.size).toBe(3);
    });

    it('should give every write a new version and report it to watchers', async () => {
        const fs = new MemoryFileSystem({ 'a.ts': 'one' });
        const batches = watchChanges(fs);
        const before = (await fs.read('a.ts')).version;

        const version = await fs.write('a.ts', 'two');
        const created = await fs.write('src/b.ts', 'new');

        await flush();

        expect(version).not.toBe(before);
        expect(await fs.read('a.ts')).toEqual({ kind: 'text', text: 'two', version });
        expect(batches).toEqual([
            [{ type: 'changed', path: 'a.ts', version, size: 3 }],
            [
                { type: 'created', path: 'src', kind: 'directory' },
                { type: 'created', path: 'src/b.ts', kind: 'file', version: created, size: 3 },
            ],
        ]);
    });

    it('should refuse a write over a stale version with the current version', async () => {
        const fs = new MemoryFileSystem({ 'a.ts': 'one' });
        const stale = (await fs.read('a.ts')).version;
        const current = await fs.write('a.ts', 'two');

        const error = await rejection(fs.write('a.ts', 'three', { expectedVersion: stale }));

        expect(error.code).toBe('Conflict');
        expect(error.currentVersion).toBe(current);
        expect(await fs.read('a.ts')).toMatchObject({ text: 'two' });
    });

    it('should report a missing file as a conflict with no current version', async () => {
        const fs = new MemoryFileSystem();

        const error = await rejection(fs.write('gone.ts', 'x', { expectedVersion: '1' }));

        expect(error.code).toBe('Conflict');
        expect(error.currentVersion).toBeNull();
    });

    it('should create only when the expected version is null', async () => {
        const fs = new MemoryFileSystem({ 'a.ts': 'one' });

        expect((await rejection(fs.write('a.ts', 'two', { expectedVersion: null }))).code).toBe('Exists');
        await fs.write('b.ts', 'new', { expectedVersion: null });

        expect(await fs.read('a.ts')).toMatchObject({ text: 'one' });
        expect(await fs.read('b.ts')).toMatchObject({ text: 'new' });
    });

    it('should move a batch, and change nothing when one target exists', async () => {
        const fs = new MemoryFileSystem({ 'a.ts': 'a', 'b.ts': 'b', 'taken.ts': 'taken' });

        const error = await rejection(
            fs.move([
                { from: 'a.ts', to: 'moved/a.ts' },
                { from: 'b.ts', to: 'taken.ts' },
            ])
        );

        expect(error.code).toBe('Exists');
        expect((await fs.list()).map(entry => entry.path).sort()).toEqual(['a.ts', 'b.ts', 'taken.ts']);

        await fs.move(
            [
                { from: 'a.ts', to: 'moved/a.ts' },
                { from: 'b.ts', to: 'taken.ts' },
            ],
            { overwrite: true }
        );

        expect(await fs.read('moved/a.ts')).toMatchObject({ text: 'a' });
        expect(await fs.read('taken.ts')).toMatchObject({ text: 'b' });
        expect((await rejection(fs.read('a.ts'))).code).toBe('NotFound');
    });

    it('should move a folder with everything inside and report it', async () => {
        const fs = new MemoryFileSystem({ 'src/lib/a.ts': 'a' });
        const batches = watchChanges(fs);

        await fs.move([{ from: 'src', to: 'app' }]);
        await flush();

        expect((await fs.list()).map(entry => entry.path).sort()).toEqual(['app', 'app/lib', 'app/lib/a.ts']);
        expect(batches[0]).toEqual(
            expect.arrayContaining([
                { type: 'deleted', path: 'src' },
                { type: 'created', path: 'app/lib/a.ts', kind: 'file', version: expect.any(String), size: 1 },
            ])
        );
        expect((await rejection(fs.move([{ from: 'app', to: 'app/inner' }]))).code).toBe('Conflict');
    });

    it('should copy, create folders and delete', async () => {
        const fs = new MemoryFileSystem({ 'a.ts': 'a' });

        await fs.copy([{ from: 'a.ts', to: 'copy/a.ts' }]);
        await fs.createDirectory('empty');

        expect((await rejection(fs.copy([{ from: 'a.ts', to: 'copy/a.ts' }]))).code).toBe('Exists');
        expect((await rejection(fs.createDirectory('empty'))).code).toBe('Exists');

        await fs.delete(['copy', 'empty']);

        expect((await fs.list()).map(entry => entry.path)).toEqual(['a.ts']);
        expect((await rejection(fs.delete(['missing.ts']))).code).toBe('NotFound');
    });

    it('should leave versions out of changes when asked, and fire resync', async () => {
        const fs = new MemoryFileSystem({}, { omitEventVersions: true });
        const events: WatchEvent[] = [];

        fs.watch(event => events.push(event));
        await fs.write('a.ts', 'a');
        await flush();
        fs.resync();

        expect(events).toEqual([
            {
                type: 'changes',
                changes: [{ type: 'created', path: 'a.ts', kind: 'file', version: undefined, size: 1 }],
            },
            { type: 'resync' },
        ]);
    });
});
