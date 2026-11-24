import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FolderWatch } from '../src/fs/watcher';
import { EventReader, openFolder, put } from './fs-helpers';
import { cleanTempDirs, Harness, startHarness, tempDir, waitFor } from './helpers';

import type { FsChange, FsWatchEvent } from '@clowdy/protocol';
import type { OpenFolder } from './fs-helpers';

afterAll(cleanTempDirs);

let h: Harness;
const readers: EventReader[] = [];

beforeEach(async () => {
    h = await startHarness();
});

afterEach(async () => {
    await Promise.all(readers.splice(0).map(reader => reader.close()));
    await h.stop();
});

async function listen(folder: OpenFolder): Promise<EventReader> {
    const reader = new EventReader(await folder.fs.watch(folder.project, folder.folderId));

    readers.push(reader);

    // The watcher reads what the folder holds before it tells anything: let it settle.
    await new Promise(resolve => setTimeout(resolve, 300));

    return reader;
}

const changesOf = (events: FsWatchEvent[]): FsChange[] =>
    events.flatMap(event => (event.type === 'changes' ? event.changes : []));
const sorted = (changes: FsChange[]) => [...changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const watchesOf = (folder: OpenFolder) => (folder.fs as unknown as { watches: Map<string, unknown> }).watches.size;

describe('watch', () => {
    test('starts with a retry line and no event', async () => {
        const folder = openFolder(h, { 'a.txt': '1' });
        const reader = await listen(folder);

        expect(reader.text).toStartWith('retry: 2000\n\n');
        expect(reader.events).toEqual([]);
    });

    test('a burst of changes comes as one batch', async () => {
        const folder = openFolder(h, { 'existing.txt': 'one' });
        const reader = await listen(folder);

        for (let n = 0; n < 20; n++) {
            writeFileSync(join(folder.dir, `file${n}.txt`), String(n));
        }

        writeFileSync(join(folder.dir, 'existing.txt'), 'changed!');

        const [event] = await reader.next();

        expect(await reader.quiet()).toEqual([]);
        expect(event?.type).toBe('changes');
        expect(
            changesOf([event as FsWatchEvent])
                .map(change => change.path)
                .sort()
        ).toEqual(['existing.txt', ...Array.from({ length: 20 }, (_, n) => `file${n}.txt`)].sort());
    });

    test('tells created, changed and deleted, with the version and size a read gives', async () => {
        const folder = openFolder(h, { 'old.txt': 'old' });
        const reader = await listen(folder);

        writeFileSync(join(folder.dir, 'new.txt'), 'hello');

        const created = changesOf(await reader.next());

        expect(created).toEqual([
            {
                type: 'created',
                path: 'new.txt',
                kind: 'file',
                version: (await folder.fs.read(folder.project, folder.folderId, 'new.txt')).version,
                size: 5,
            },
        ]);

        appendFileSync(join(folder.dir, 'new.txt'), ' world');

        const changed = changesOf(await reader.next());

        expect(changed).toEqual([
            {
                type: 'changed',
                path: 'new.txt',
                version: (await folder.fs.read(folder.project, folder.folderId, 'new.txt')).version,
                size: 11,
            },
        ]);
        expect((changed[0] as { version: string }).version).not.toBe((created[0] as { version: string }).version);

        rmSync(join(folder.dir, 'old.txt'));

        expect(changesOf(await reader.next())).toEqual([{ type: 'deleted', path: 'old.txt' }]);
        expect(await reader.quiet()).toEqual([]);
    });

    test('a folder is created with its kind, and deleted with one change for everything in it', async () => {
        const folder = openFolder(h, { 'tree/a/b.txt': '1', 'tree/c.txt': '2' });
        const reader = await listen(folder);

        mkdirSync(join(folder.dir, 'fresh'));

        expect(changesOf(await reader.next())).toEqual([{ type: 'created', path: 'fresh', kind: 'directory' }]);

        rmSync(join(folder.dir, 'tree'), { recursive: true });

        expect(changesOf(await reader.next())).toEqual([{ type: 'deleted', path: 'tree' }]);
        expect(await reader.quiet()).toEqual([]);
    });

    test('a folder that arrives with its content is told with the content', async () => {
        const folder = openFolder(h, { 'keep.txt': '1' });
        const staging = tempDir('staging');

        put(staging, { 'moved/deep/a.txt': 'a', 'moved/b.txt': 'bb' });

        const reader = await listen(folder);

        renameSync(join(staging, 'moved'), join(folder.dir, 'moved'));

        const changes = sorted(changesOf(await reader.next()));

        expect(changes.map(change => `${change.type} ${change.path}`)).toEqual([
            'created moved',
            'created moved/b.txt',
            'created moved/deep',
            'created moved/deep/a.txt',
        ]);
        expect(changes.find(change => change.path === 'moved/b.txt')).toMatchObject({
            kind: 'file',
            size: 2,
            version: expect.any(String),
        });
    });

    test('tells nothing from .git or node_modules, and tells what else changed', async () => {
        const folder = openFolder(h, { '.git/HEAD': 'ref', 'node_modules/x/index.js': '1', 'src/a.ts': '1' });
        const reader = await listen(folder);

        writeFileSync(join(folder.dir, '.git/index.lock'), 'x');
        writeFileSync(join(folder.dir, '.git/HEAD'), 'ref2');
        mkdirSync(join(folder.dir, 'node_modules/y'));
        writeFileSync(join(folder.dir, 'node_modules/y/new.js'), '2');
        rmSync(join(folder.dir, 'node_modules/x'), { recursive: true });
        writeFileSync(join(folder.dir, 'src/b.ts'), '2');

        const changes = changesOf(await reader.next());

        expect(changes.map(change => change.path)).toEqual(['src/b.ts']);
        expect(await reader.quiet()).toEqual([]);
    });

    test('a folder named node_modules appearing is told, and nothing in it', async () => {
        const folder = openFolder(h, { 'a.txt': '1' });
        const reader = await listen(folder);

        put(folder.dir, { 'node_modules/p/index.js': '1', '.git/config': '2' });

        const changes = sorted(changesOf(await reader.next()));

        expect(changes).toEqual([
            { type: 'created', path: '.git', kind: 'directory' },
            { type: 'created', path: 'node_modules', kind: 'directory' },
        ]);
        expect(await reader.quiet()).toEqual([]);
    });

    test("the daemon's own writes are told like anyone's, with the version the write answered", async () => {
        const folder = openFolder(h);
        const reader = await listen(folder);
        const encoded = new TextEncoder().encode('from the daemon');
        const { version } = await folder.fs.write(
            folder.project,
            folder.folderId,
            'sub/own.txt',
            (async function* () {
                yield encoded;
            })(),
            { create: false, declaredLength: 0 }
        );
        const changes = sorted(changesOf(await reader.next()));

        expect(changes).toEqual([
            { type: 'created', path: 'sub', kind: 'directory' },
            { type: 'created', path: 'sub/own.txt', kind: 'file', version, size: encoded.length },
        ]);
        // Neither the temp file of the write nor anything else follows.
        expect(await reader.quiet()).toEqual([]);
    });

    test('a move and a copy through the daemon are told as what appeared and what vanished', async () => {
        const folder = openFolder(h, { 'a.txt': 'a', 'dir/b.txt': 'b' });
        const reader = await listen(folder);

        await folder.fs.move(folder.project, folder.folderId, [{ from: 'a.txt', to: 'moved.txt' }]);
        await folder.fs.copy(folder.project, folder.folderId, [{ from: 'dir', to: 'dir2' }]);
        await folder.fs.remove(folder.project, folder.folderId, ['dir']);

        await reader.next();
        await reader.quiet();

        const all = changesOf(reader.events).map(change => `${change.type} ${change.path}`);

        for (const wanted of [
            'created moved.txt',
            'deleted a.txt',
            'created dir2',
            'created dir2/b.txt',
            'deleted dir',
        ]) {
            expect(all).toContain(wanted);
        }
    });

    test('one watcher serves every client of a folder and is closed when the last leaves', async () => {
        const folder = openFolder(h, { 'a.txt': '1' });
        const first = await listen(folder);
        const second = await listen(folder);

        expect(watchesOf(folder)).toBe(1);

        writeFileSync(join(folder.dir, 'b.txt'), '2');

        expect(changesOf(await first.next()).map(change => change.path)).toEqual(['b.txt']);
        expect(changesOf(await second.next()).map(change => change.path)).toEqual(['b.txt']);

        await first.close();

        expect(watchesOf(folder)).toBe(1);

        writeFileSync(join(folder.dir, 'c.txt'), '3');

        expect(changesOf(await second.next()).map(change => change.path)).toEqual(['c.txt']);

        await second.close();

        expect(watchesOf(folder)).toBe(0);
    });

    test('a folder two projects share is watched once', async () => {
        const folder = openFolder(h);
        // The same set of folders would be the same project: a second project has one folder more.
        const twin = h.ok('project.add', { name: 'Twin', folders: [folder.dir, tempDir('extra')] }).project;
        const first = await listen(folder);
        const second = new EventReader(await folder.fs.watch(twin, twin.folders[0].id));

        readers.push(second);

        expect(watchesOf(folder)).toBe(1);

        writeFileSync(join(folder.dir, 'shared.txt'), '1');

        expect(changesOf(await first.next()).map(change => change.path)).toEqual(['shared.txt']);
        expect(changesOf(await second.next()).map(change => change.path)).toEqual(['shared.txt']);
    });

    test('stopping the service ends every stream', async () => {
        const folder = openFolder(h);
        const reader = await listen(folder);

        folder.fs.stop();

        await reader.ended;

        expect(watchesOf(folder)).toBe(0);
    });

    test('a link that leaves the folder is not told, and neither is what is behind it', async () => {
        if (process.platform === 'win32') {
            return;
        }

        const outside = tempDir('outside');
        const folder = openFolder(h, { 'a.txt': '1' });
        const reader = await listen(folder);

        put(outside, { 'secret.txt': 's' });
        symlinkSync(outside, join(folder.dir, 'out'));
        writeFileSync(join(outside, 'later.txt'), 'l');
        writeFileSync(join(folder.dir, 'b.txt'), '2');

        expect(changesOf(await reader.next()).map(change => change.path)).toEqual(['b.txt']);
        expect(await reader.quiet()).toEqual([]);
    });

    test('a folder that cannot be found is unavailable', async () => {
        const folder = openFolder(h);

        rmSync(folder.dir, { recursive: true });

        await expect(folder.fs.watch(folder.project, folder.folderId)).rejects.toMatchObject({ code: 'unavailable' });
    });
});

describe('a watcher that cannot tell exactly', () => {
    function watching(files: Record<string, string>, options: ConstructorParameters<typeof FolderWatch>[1]) {
        const dir = realpathSync(tempDir('watcher'));

        put(dir, files);

        const watcher = new FolderWatch(dir, options);
        const events: FsWatchEvent[] = [];

        watcher.subscribe({ send: event => events.push(event), end: () => undefined });
        watcher.start();
        cleanup.push(() => watcher.close());

        // Files made just before the watch began may still be reported by the platform; a watcher that knows the folder tells nothing of them.
        const ready = new Promise<void>(resolve =>
            setTimeout(() => {
                events.length = 0;
                resolve();
            }, 300)
        );

        return { dir, events, ready };
    }

    const cleanup: Array<() => void> = [];

    afterEach(() => cleanup.splice(0).forEach(close => close()));

    test('answers a burst bigger than it works through with resync, and goes on telling the changes after it', async () => {
        const { dir, events, ready } = watching({ 'a.txt': '1' }, { maxBurst: 5 });

        await ready;

        for (let n = 0; n < 12; n++) {
            writeFileSync(join(dir, `burst${n}.txt`), '1');
        }

        await waitFor(() => events.length > 0 && events, 'the resync');

        expect(events).toEqual([{ type: 'resync' }]);

        // What it knows was read anew, so the next change is told as what it is.
        await new Promise(resolve => setTimeout(resolve, 300));
        writeFileSync(join(dir, 'burst3.txt'), 'changed!');

        await waitFor(() => events.length > 1 && events, 'the change after the resync');

        expect(changesOf(events)).toEqual([
            { type: 'changed', path: 'burst3.txt', version: expect.any(String), size: 8 },
        ]);
    });

    test('with more entries than it can remember it tells a path it does not know as created and one that vanished as deleted', async () => {
        const { dir, events, ready } = watching(
            { 'a.txt': '1', 'b.txt': '2', 'c.txt': '3', 'd.txt': '4', 'e.txt': '5' },
            { maxKnown: 2 }
        );

        await ready;

        writeFileSync(join(dir, 'new.txt'), 'made');
        rmSync(join(dir, 'd.txt'));

        await waitFor(() => changesOf(events).length >= 2 && events, 'both changes');

        expect(sorted(changesOf(events)).map(change => `${change.type} ${change.path}`)).toEqual([
            'deleted d.txt',
            'created new.txt',
        ]);
    });

    test('a folder that appears with more in it than it tells is followed by a resync', async () => {
        const { dir, events, ready } = watching({}, {});
        const staging = tempDir('staging');
        const files: Record<string, string> = {};

        for (let n = 0; n < 2100; n++) {
            files[`big/f${n}.txt`] = '1';
        }

        put(staging, files);
        await ready;
        renameSync(join(staging, 'big'), join(dir, 'big'));

        await waitFor(() => events.some(event => event.type === 'resync') && events, 'the resync');

        const created = changesOf(events);

        expect(created[0]).toEqual({ type: 'created', path: 'big', kind: 'directory' });
        expect(created.length).toBeGreaterThan(1000);
        // The walk tells 2000 of the 2100 files at most. Where the platform also reports the files one by one (inotify does), the rest comes as events of its own: all of them, each path once.
        expect(created.length).toBeLessThanOrEqual(2101);
        expect(new Set(created.map(change => change.path)).size).toBe(created.length);
    });
});
