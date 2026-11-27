import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { openFolder, put } from './fs-helpers';
import { cleanTempDirs, git, Harness, startHarness, tempDir } from './helpers';

import type { FsEntry } from '@clowdy/protocol';

afterAll(cleanTempDirs);

const posix = process.platform !== 'win32';
const link = posix ? test : test.skip;

let h: Harness;

beforeEach(async () => {
    h = await startHarness();
});

afterEach(() => h.stop());

const text = (path: string) => readFileSync(path, 'utf8');
const paths = (entries: FsEntry[]) => entries.map(entry => entry.path).sort();
const byPath = (entries: FsEntry[]) => Object.fromEntries(entries.map(entry => [entry.path, entry]));
const body = (content: string | Uint8Array) =>
    (async function* () {
        yield typeof content === 'string' ? new TextEncoder().encode(content) : content;
    })();
const neither = { create: false, declaredLength: 0 };

describe('list', () => {
    test('lists every entry below the folder, files with their size and folders without hasChildren', async () => {
        const { fs, project, folderId } = openFolder(h, {
            'a.txt': 'hello',
            'src/app/main.ts': 'xy',
            'src/empty/.keep': '',
            'docs/readme.md': '#',
        });
        const entries = await fs.list(project, folderId, '');

        expect(paths(entries)).toEqual([
            'a.txt',
            'docs',
            'docs/readme.md',
            'src',
            'src/app',
            'src/app/main.ts',
            'src/empty',
            'src/empty/.keep',
        ]);
        expect(byPath(entries)['a.txt']).toEqual({ path: 'a.txt', kind: 'file', size: 5 });
        expect(byPath(entries).src).toEqual({ path: 'src', kind: 'directory' });
    });

    test('puts every parent before what is in it', async () => {
        const { fs, project, folderId } = openFolder(h, { 'a/b/c/d.txt': '1', 'a/e.txt': '2', 'z.txt': '3' });
        const seen = new Set<string>();

        for (const { path } of await fs.list(project, folderId, '')) {
            const parent = path.slice(0, Math.max(path.lastIndexOf('/'), 0));

            expect(parent === '' || seen.has(parent)).toBe(true);
            seen.add(path);
        }
    });

    test('stops at depth path segments and marks a folder at the cutoff with whether it has anything below', async () => {
        const { fs, project, folderId, dir } = openFolder(h, {
            'src/app/foo/x.ts': '1',
            'src/empty/.keep': '',
            'top.txt': '2',
        });

        mkdirSync(join(dir, 'src/void'));

        expect(byPath(await fs.list(project, folderId, '', 1))).toEqual({
            src: { path: 'src', kind: 'directory', hasChildren: true },
            'top.txt': { path: 'top.txt', kind: 'file', size: 1 },
        });

        const two = byPath(await fs.list(project, folderId, '', 2));

        expect(Object.keys(two).sort()).toEqual(['src', 'src/app', 'src/empty', 'src/void', 'top.txt']);
        expect(two.src).toEqual({ path: 'src', kind: 'directory' });
        expect(two['src/app']).toEqual({ path: 'src/app', kind: 'directory', hasChildren: true });
        expect(two['src/empty']).toEqual({ path: 'src/empty', kind: 'directory', hasChildren: true });
        expect(two['src/void']).toEqual({ path: 'src/void', kind: 'directory', hasChildren: false });
        expect(await fs.list(project, folderId, '', 0)).toEqual([]);
    });

    test('lists below a path with paths relative to the folder, and counts depth from that path', async () => {
        const { fs, project, folderId } = openFolder(h, {
            'src/app/foo/x.ts': '1',
            'src/app/y.ts': '22',
            'other.txt': '3',
        });

        expect(byPath(await fs.list(project, folderId, 'src', 1))).toEqual({
            'src/app': { path: 'src/app', kind: 'directory', hasChildren: true },
        });
        expect(paths(await fs.list(project, folderId, 'src/app'))).toEqual([
            'src/app/foo',
            'src/app/foo/x.ts',
            'src/app/y.ts',
        ]);
        expect(paths(await fs.list(project, folderId, './src//app/'))).toEqual([
            'src/app/foo',
            'src/app/foo/x.ts',
            'src/app/y.ts',
        ]);
    });

    test('a missing path is not_found and a file is invalid', async () => {
        const { fs, project, folderId } = openFolder(h, { 'a.txt': '1' });

        await expect(fs.list(project, folderId, 'nope')).rejects.toMatchObject({ code: 'not_found' });
        await expect(fs.list(project, folderId, 'a.txt/inside')).rejects.toMatchObject({ code: 'not_found' });
        await expect(fs.list(project, folderId, 'a.txt')).rejects.toMatchObject({ code: 'invalid' });
    });

    test('lists .git and node_modules only as cutoff folders, however deep, and their content when asked for by path', async () => {
        const { fs, project, folderId, dir } = openFolder(h, {
            '.git/HEAD': 'ref',
            'node_modules/left-pad/index.js': '1',
            'node_modules/left-pad/node_modules/dep/i.js': '2',
            'pkg/node_modules/x.js': '3',
            'pkg/.git/config': '4',
            'pkg/src.ts': '5',
        });

        mkdirSync(join(dir, 'empty/node_modules'), { recursive: true });

        const all = byPath(await fs.list(project, folderId, ''));

        expect(Object.keys(all).sort()).toEqual([
            '.git',
            'empty',
            'empty/node_modules',
            'node_modules',
            'pkg',
            'pkg/.git',
            'pkg/node_modules',
            'pkg/src.ts',
        ]);
        expect(all['.git']).toEqual({ path: '.git', kind: 'directory', hasChildren: true });
        expect(all.node_modules).toEqual({ path: 'node_modules', kind: 'directory', hasChildren: true });
        expect(all['empty/node_modules']).toEqual({
            path: 'empty/node_modules',
            kind: 'directory',
            hasChildren: false,
        });
        expect(all['pkg/.git']?.hasChildren).toBe(true);

        const inside = await fs.list(project, folderId, 'node_modules');

        expect(paths(inside)).toEqual([
            'node_modules/left-pad',
            'node_modules/left-pad/index.js',
            'node_modules/left-pad/node_modules',
        ]);
        expect(byPath(inside)['node_modules/left-pad/node_modules']?.hasChildren).toBe(true);
        expect(paths(await fs.list(project, folderId, '.git'))).toEqual(['.git/HEAD']);
    });

    test('a .git that is a file is a file', async () => {
        const { fs, project, folderId } = openFolder(h, { '.git': 'gitdir: ../elsewhere', 'a.txt': '1' });

        expect(byPath(await fs.list(project, folderId, ''))['.git']).toEqual({ path: '.git', kind: 'file', size: 20 });
    });

    test('answers what it has when the cap is reached, with the folders left unread as cutoffs and the shallow levels whole', async () => {
        const files: Record<string, string> = {};

        for (const dir of ['a', 'b', 'c']) {
            for (const sub of ['x', 'y']) {
                for (let n = 0; n < 5; n++) {
                    files[`${dir}/${sub}/f${n}.txt`] = '1';
                }
            }
        }

        const { fs, project, folderId } = openFolder(h, { ...files, 'top1.txt': '1', 'top2.txt': '1' });

        // Level one (a, b, c and two files) fits; reading a, b, c adds six folders; reading those would add thirty files.
        fs.maxListEntries = 13;

        const entries = await fs.list(project, folderId, '');
        const found = byPath(entries);

        expect(entries.length).toBeLessThanOrEqual(13);

        for (const path of ['a', 'b', 'c', 'top1.txt', 'top2.txt', 'a/x', 'a/y', 'b/x', 'b/y', 'c/x', 'c/y']) {
            expect(found[path]).toBeDefined();
        }

        // A folder whose content did not fit is a cutoff, not an empty folder.
        const unread = ['a/x', 'a/y', 'b/x', 'b/y', 'c/x', 'c/y'].filter(
            path => !entries.some(entry => entry.path.startsWith(`${path}/`))
        );

        expect(unread.length).toBeGreaterThan(0);

        for (const path of unread) {
            expect(found[path]?.hasChildren).toBe(true);
        }
    });

    test.skipIf(!posix)('leaves out a name a client could not address back', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'plain.txt': '1' });

        writeFileSync(join(dir, 'back\\slash.txt'), '2');

        expect(paths(await fs.list(project, folderId, ''))).toEqual(['plain.txt']);
    });

    test('leaves out what the daemon keeps next to a file while it writes', async () => {
        const { fs, project, folderId } = openFolder(h, {
            'a.txt': '1',
            '.clowdy-0123abcd.tmp': 'half',
            '.clowdy-0123abcd.replaced': 'old',
            '.clowdy-notours.tmp': 'mine',
        });

        expect(paths(await fs.list(project, folderId, ''))).toEqual(['.clowdy-notours.tmp', 'a.txt']);
    });

    test.skipIf(!posix || process.getuid?.() === 0)(
        'a folder that cannot be read is a cutoff in a deeper listing and permission when asked for',
        async () => {
            const { fs, project, folderId, dir } = openFolder(h, { 'open/a.txt': '1', 'locked/b.txt': '2' });

            chmodSync(join(dir, 'locked'), 0o000);

            try {
                expect(byPath(await fs.list(project, folderId, '')).locked).toEqual({
                    path: 'locked',
                    kind: 'directory',
                    hasChildren: true,
                });
                await expect(fs.list(project, folderId, 'locked')).rejects.toMatchObject({
                    code: 'invalid',
                    details: { reason: 'permission' },
                });
            } finally {
                chmodSync(join(dir, 'locked'), 0o755);
            }
        }
    );

    link(
        'lists a link to a folder as a folder that no listing enters, a link to a file as a file, and leaves out links that lead out or nowhere',
        async () => {
            const outside = tempDir('outside');

            put(outside, { 'secret.txt': 'no', 'dir/s.txt': 'no' });

            const { fs, project, folderId, dir } = openFolder(h, {
                'real/inner/a.txt': '1',
                'file.txt': 'abc',
                'empty/.keep': '',
            });

            symlinkSync('real', join(dir, 'to-real'));
            symlinkSync('file.txt', join(dir, 'to-file'));
            symlinkSync('empty', join(dir, 'to-empty'));
            symlinkSync(outside, join(dir, 'to-outside'));
            symlinkSync(join(outside, 'secret.txt'), join(dir, 'to-secret'));
            symlinkSync('does-not-exist', join(dir, 'dangling'));

            const all = byPath(await fs.list(project, folderId, ''));

            expect(Object.keys(all).sort()).toEqual([
                'empty',
                'empty/.keep',
                'file.txt',
                'real',
                'real/inner',
                'real/inner/a.txt',
                'to-empty',
                'to-file',
                'to-real',
            ]);
            expect(all['to-real']).toEqual({ path: 'to-real', kind: 'directory', hasChildren: true });
            expect(all['to-empty']).toEqual({ path: 'to-empty', kind: 'directory', hasChildren: true });
            expect(all['to-file']).toEqual({ path: 'to-file', kind: 'file', size: 3 });

            // Asked for by its own path, a link inside the folder is listed like the folder it leads to.
            expect(paths(await fs.list(project, folderId, 'to-real'))).toEqual([
                'to-real/inner',
                'to-real/inner/a.txt',
            ]);
        }
    );
});

describe('containment', () => {
    const escapes = ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'a\\b', 'a/..', '..', 'a\0b'];

    test('refuses a path that leaves the folder by its spelling, on every route', async () => {
        const { fs, project, folderId } = openFolder(h, { 'a/keep.txt': '1' });

        for (const path of escapes) {
            const outside = { code: 'invalid', details: { reason: 'outside' } };

            await expect(fs.list(project, folderId, path)).rejects.toMatchObject(outside);
            await expect(fs.read(project, folderId, path)).rejects.toMatchObject(outside);
            await expect(fs.write(project, folderId, path, body('x'), neither)).rejects.toMatchObject(outside);
            await expect(fs.makeFolder(project, folderId, path)).rejects.toMatchObject(outside);
            await expect(fs.move(project, folderId, [{ from: 'a/keep.txt', to: path }])).rejects.toMatchObject(outside);
            await expect(fs.move(project, folderId, [{ from: path, to: 'z' }])).rejects.toMatchObject(outside);
            await expect(fs.copy(project, folderId, [{ from: path, to: 'z' }])).rejects.toMatchObject(outside);
            await expect(fs.remove(project, folderId, [path])).rejects.toMatchObject(outside);
        }

        expect(text(join(project.folders[0].path, 'a/keep.txt'))).toBe('1');
    });

    test('takes . and empty segments for nothing', async () => {
        const { fs, project, folderId } = openFolder(h, { 'a/b.txt': 'hi' });

        expect(Buffer.from((await fs.read(project, folderId, './a//b.txt')).bytes).toString()).toBe('hi');
    });

    link(
        'never follows a link out of the folder: not to read, write, make a folder, list, copy or move through',
        async () => {
            const outside = tempDir('outside');

            put(outside, { 'secret.txt': 'no', 'dir/s.txt': 'no' });

            const { fs, project, folderId, dir } = openFolder(h, { 'mine.txt': 'mine' });

            symlinkSync(outside, join(dir, 'out'));
            symlinkSync(join(outside, 'secret.txt'), join(dir, 'secret'));
            symlinkSync(join(dir, 'nowhere'), join(dir, 'dangling'));

            const refused = { code: 'invalid', details: { reason: 'outside' } };

            await expect(fs.read(project, folderId, 'secret')).rejects.toMatchObject(refused);
            await expect(fs.read(project, folderId, 'out/secret.txt')).rejects.toMatchObject(refused);
            await expect(fs.list(project, folderId, 'out')).rejects.toMatchObject(refused);
            await expect(fs.write(project, folderId, 'out/new.txt', body('x'), neither)).rejects.toMatchObject(refused);
            await expect(fs.write(project, folderId, 'out/deep/er/new.txt', body('x'), neither)).rejects.toMatchObject(
                refused
            );
            await expect(fs.write(project, folderId, 'secret', body('x'), neither)).rejects.toMatchObject(refused);
            await expect(fs.write(project, folderId, 'dangling', body('x'), neither)).rejects.toMatchObject(refused);
            await expect(fs.makeFolder(project, folderId, 'out/made')).rejects.toMatchObject(refused);
            await expect(fs.copy(project, folderId, [{ from: 'mine.txt', to: 'out/mine.txt' }])).rejects.toMatchObject(
                refused
            );
            await expect(fs.move(project, folderId, [{ from: 'mine.txt', to: 'out/mine.txt' }])).rejects.toMatchObject(
                refused
            );
            await expect(
                fs.copy(project, folderId, [{ from: 'out/secret.txt', to: 'stolen.txt' }])
            ).rejects.toMatchObject(refused);
            await expect(fs.move(project, folderId, [{ from: 'out/dir', to: 'stolen' }])).rejects.toMatchObject(
                refused
            );

            expect(readdirSync(outside).sort()).toEqual(['dir', 'secret.txt']);
            expect(text(join(outside, 'secret.txt'))).toBe('no');
            expect(existsSync(join(dir, 'stolen.txt'))).toBe(false);
            expect(text(join(dir, 'mine.txt'))).toBe('mine');
        }
    );

    link('works through a link that stays inside the folder', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'real/a.txt': 'inside' });

        symlinkSync('real', join(dir, 'alias'));

        expect(Buffer.from((await fs.read(project, folderId, 'alias/a.txt')).bytes).toString()).toBe('inside');

        await fs.write(project, folderId, 'alias/b.txt', body('through'), neither);

        expect(text(join(dir, 'real/b.txt'))).toBe('through');
    });

    link('writes a link to a file inside the folder through to the file and keeps the link', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'real.txt': 'before' });

        symlinkSync('real.txt', join(dir, 'alias.txt'));

        const { version } = await fs.write(project, folderId, 'alias.txt', body('after'), neither);

        expect(lstatSync(join(dir, 'alias.txt')).isSymbolicLink()).toBe(true);
        expect(text(join(dir, 'real.txt'))).toBe('after');
        expect((await fs.read(project, folderId, 'real.txt')).version).toBe(version);
        expect(readdirSync(dir).sort()).toEqual(['alias.txt', 'real.txt']);
    });

    link('deletes a link and never what it leads to, even from inside a folder that is deleted', async () => {
        const outside = tempDir('outside');

        put(outside, { 'secret.txt': 'keep', 'dir/s.txt': 'keep' });

        const { fs, project, folderId, dir } = openFolder(h, { 'tree/leaf.txt': '1' });

        symlinkSync(outside, join(dir, 'out'));
        symlinkSync(join(outside, 'secret.txt'), join(dir, 'tree/secret'));
        symlinkSync(join(outside, 'dir'), join(dir, 'tree/dir'));

        await fs.remove(project, folderId, ['out', 'tree']);

        expect(existsSync(join(dir, 'out'))).toBe(false);
        expect(existsSync(join(dir, 'tree'))).toBe(false);
        expect(readdirSync(outside).sort()).toEqual(['dir', 'secret.txt']);
        expect(text(join(outside, 'secret.txt'))).toBe('keep');
        expect(text(join(outside, 'dir/s.txt'))).toBe('keep');
    });

    link('moves and copies a link as a link', async () => {
        const outside = tempDir('outside');

        put(outside, { 'secret.txt': 'keep' });

        const { fs, project, folderId, dir } = openFolder(h, { 'tree/leaf.txt': '1' });

        symlinkSync(join(outside, 'secret.txt'), join(dir, 'tree/secret'));

        await fs.copy(project, folderId, [{ from: 'tree', to: 'tree2' }]);
        await fs.move(project, folderId, [{ from: 'tree/secret', to: 'moved-link' }]);

        expect(lstatSync(join(dir, 'tree2/secret')).isSymbolicLink()).toBe(true);
        expect(readlinkSync(join(dir, 'tree2/secret'))).toBe(join(outside, 'secret.txt'));
        expect(lstatSync(join(dir, 'moved-link')).isSymbolicLink()).toBe(true);
        expect(text(join(outside, 'secret.txt'))).toBe('keep');
        await expect(fs.read(project, folderId, 'moved-link')).rejects.toMatchObject({
            details: { reason: 'outside' },
        });
    });

    test('a folder that is gone from the disk is unavailable, one the project lacks is not_found, none given is invalid', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'a.txt': '1' });

        await expect(fs.list(project, 'fld_nope', '')).rejects.toMatchObject({ code: 'not_found' });
        await expect(fs.list(project, '', '')).rejects.toMatchObject({ code: 'invalid' });

        rmSync(dir, { recursive: true });

        await expect(fs.list(project, folderId, '')).rejects.toMatchObject({ code: 'unavailable' });
    });
});

describe("git's own folder", () => {
    const refused = { code: 'invalid', details: { reason: 'permission' } };

    test("is never written, made, moved, copied or deleted, a nested repository's too, and is still read", async () => {
        const { fs, project, folderId, dir } = openFolder(h, {
            '.git/config': 'config',
            'sub/.git/HEAD': 'head',
            'a.txt': 'a',
        });

        await expect(fs.write(project, folderId, '.git/config', body('x'), neither)).rejects.toMatchObject(refused);
        await expect(fs.write(project, folderId, '.git/hooks/pre-commit', body('x'), neither)).rejects.toMatchObject(
            refused
        );
        await expect(fs.makeFolder(project, folderId, '.git/hooks')).rejects.toMatchObject(refused);
        await expect(fs.move(project, folderId, [{ from: '.git/config', to: 'config' }])).rejects.toMatchObject(
            refused
        );
        await expect(fs.move(project, folderId, [{ from: 'a.txt', to: 'sub/.git/a.txt' }])).rejects.toMatchObject(
            refused
        );
        await expect(fs.copy(project, folderId, [{ from: 'a.txt', to: '.git/a.txt' }])).rejects.toMatchObject(refused);
        await expect(fs.remove(project, folderId, ['a.txt', '.git'])).rejects.toMatchObject(refused);
        await expect(fs.remove(project, folderId, ['sub/.git.'])).rejects.toMatchObject(refused);

        expect([text(join(dir, '.git/config')), text(join(dir, 'sub/.git/HEAD')), text(join(dir, 'a.txt'))]).toEqual([
            'config',
            'head',
            'a',
        ]);
        expect(existsSync(join(dir, '.git/hooks'))).toBe(false);
        expect(new TextDecoder().decode((await fs.read(project, folderId, '.git/config')).bytes)).toBe('config');
    });

    test('is only .git itself: .gitignore, .github and .gitattributes are changed as any file', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { '.gitignore': 'old', 'a.txt': 'a' });
        const create = { create: true, declaredLength: 0 };

        await fs.write(project, folderId, '.gitignore', body('dist'), neither);
        await fs.makeFolder(project, folderId, '.github/workflows');
        await fs.write(project, folderId, '.github/workflows/ci.yml', body('on: push'), create);
        await fs.copy(project, folderId, [{ from: 'a.txt', to: '.gitattributes' }]);
        await fs.remove(project, folderId, ['a.txt']);

        expect(paths(await fs.list(project, folderId, '', 3))).toEqual([
            '.gitattributes',
            '.github',
            '.github/workflows',
            '.github/workflows/ci.yml',
            '.gitignore',
        ]);
        expect([text(join(dir, '.gitignore')), text(join(dir, '.github/workflows/ci.yml'))]).toEqual([
            'dist',
            'on: push',
        ]);
    });
});

describe('read', () => {
    test('answers the bytes of a text file, of a binary one and of an empty one, with a version', async () => {
        const binary = new Uint8Array([0, 255, 128, 7, 0]);
        const { fs, project, folderId } = openFolder(h, { 'a.txt': 'héllo', 'b.bin': binary, 'empty.txt': '' });

        const a = await fs.read(project, folderId, 'a.txt');

        expect(Buffer.from(a.bytes).toString()).toBe('héllo');
        expect(a.version).toMatch(/^\d+:\d+$/);
        expect([...(await fs.read(project, folderId, 'b.bin')).bytes]).toEqual([...binary]);
        expect((await fs.read(project, folderId, 'empty.txt')).bytes.length).toBe(0);
    });

    test('a missing file is not_found, a folder is invalid', async () => {
        const { fs, project, folderId } = openFolder(h, { 'dir/a.txt': '1' });

        await expect(fs.read(project, folderId, 'nope.txt')).rejects.toMatchObject({ code: 'not_found' });
        await expect(fs.read(project, folderId, 'dir')).rejects.toMatchObject({ code: 'invalid' });
        await expect(fs.read(project, folderId, '')).rejects.toMatchObject({ code: 'invalid' });
    });

    test('a file over the limit is invalid with the reason too_large', async () => {
        const { fs, project, folderId } = openFolder(h, { 'small.txt': '12345', 'big.txt': '123456' });

        fs.maxFileBytes = 5;

        expect((await fs.read(project, folderId, 'small.txt')).bytes.length).toBe(5);
        await expect(fs.read(project, folderId, 'big.txt')).rejects.toMatchObject({
            code: 'invalid',
            details: { reason: 'too_large', maxBytes: 5, size: 6 },
        });
    });

    test('the version changes with the content and stays while nothing changes', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'a.txt': 'one' });
        const first = (await fs.read(project, folderId, 'a.txt')).version;

        expect((await fs.read(project, folderId, 'a.txt')).version).toBe(first);

        writeFileSync(join(dir, 'a.txt'), 'two!');

        expect((await fs.read(project, folderId, 'a.txt')).version).not.toBe(first);
    });
});

describe('write', () => {
    test('makes the file and its parent folders, and answers the version a read gives', async () => {
        const { fs, project, folderId, dir } = openFolder(h);
        const { version } = await fs.write(project, folderId, 'deep/er/new.txt', body('hello'), neither);

        expect(text(join(dir, 'deep/er/new.txt'))).toBe('hello');
        expect((await fs.read(project, folderId, 'deep/er/new.txt')).version).toBe(version);
    });

    test('writes an empty body as an empty file and bytes as they are', async () => {
        const { fs, project, folderId, dir } = openFolder(h);
        const bytes = new Uint8Array([0, 1, 2, 255]);

        await fs.write(project, folderId, 'empty.txt', null, neither);
        await fs.write(project, folderId, 'b.bin', body(bytes), neither);

        expect(readFileSync(join(dir, 'empty.txt')).length).toBe(0);
        expect([...readFileSync(join(dir, 'b.bin'))]).toEqual([...bytes]);
    });

    test('If-None-Match writes only a new file: conflict exists otherwise, and the file is left alone', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'a.txt': 'one' });

        await expect(
            fs.write(project, folderId, 'a.txt', body('two'), { create: true, declaredLength: 0 })
        ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'exists', path: 'a.txt' } });
        expect(text(join(dir, 'a.txt'))).toBe('one');

        await fs.write(project, folderId, 'b.txt', body('new'), { create: true, declaredLength: 0 });

        expect(text(join(dir, 'b.txt'))).toBe('new');
    });

    test('If-Match writes only over that version: conflict version with the current one, null when the file is gone', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'a.txt': 'one' });
        const stale = (await fs.read(project, folderId, 'a.txt')).version;
        const { version: current } = await fs.write(project, folderId, 'a.txt', body('two (longer)'), {
            create: false,
            declaredLength: 0,
            version: stale,
        });

        expect(current).not.toBe(stale);
        await expect(
            fs.write(project, folderId, 'a.txt', body('three'), { create: false, declaredLength: 0, version: stale })
        ).rejects.toMatchObject({
            code: 'conflict',
            details: { reason: 'version', path: 'a.txt', currentVersion: current },
        });
        expect(text(join(dir, 'a.txt'))).toBe('two (longer)');
        await expect(
            fs.write(project, folderId, 'gone.txt', body('x'), { create: false, declaredLength: 0, version: '1:1' })
        ).rejects.toMatchObject({
            code: 'conflict',
            details: { reason: 'version', currentVersion: null },
        });
        expect(existsSync(join(dir, 'gone.txt'))).toBe(false);
        expect(existsSync(join(dir, 'a.txt.tmp'))).toBe(false);
    });

    test('without a precondition writes over whatever is there', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'a.txt': 'one' });

        await fs.write(project, folderId, 'a.txt', body('two'), neither);

        expect(text(join(dir, 'a.txt'))).toBe('two');
    });

    test('leaves no temp file behind, whether it worked or was refused', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'a.txt': 'one' });

        await fs.write(project, folderId, 'a.txt', body('two'), neither);
        await fs
            .write(project, folderId, 'a.txt', body('three'), { create: true, declaredLength: 0 })
            .catch(() => undefined);
        await fs
            .write(project, folderId, 'sub/b.txt', body('x'), { create: false, declaredLength: 0, version: '1:1' })
            .catch(() => undefined);

        expect(readdirSync(dir).sort()).toEqual(['a.txt']);
    });

    test('a refused write does not leave the parent folders it would have made', async () => {
        const { fs, project, folderId, dir } = openFolder(h);

        await expect(
            fs.write(project, folderId, 'x/y/z.txt', body('1'), { create: false, declaredLength: 0, version: '9:9' })
        ).rejects.toMatchObject({ code: 'conflict' });

        expect(readdirSync(dir)).toEqual([]);
    });

    test('a write over a folder, or below a file, is conflict exists', async () => {
        const { fs, project, folderId } = openFolder(h, { 'dir/a.txt': '1', 'file.txt': '2' });

        await expect(fs.write(project, folderId, 'dir', body('x'), neither)).rejects.toMatchObject({
            code: 'conflict',
            details: { reason: 'exists', path: 'dir' },
        });
        await expect(fs.write(project, folderId, '', body('x'), neither)).rejects.toMatchObject({
            code: 'conflict',
            details: { reason: 'exists' },
        });
        await expect(fs.write(project, folderId, 'file.txt/inner.txt', body('x'), neither)).rejects.toMatchObject({
            code: 'conflict',
            details: { reason: 'exists', path: 'file.txt' },
        });
        await expect(fs.write(project, folderId, 'dir/a.txt/x/y.txt', body('x'), neither)).rejects.toMatchObject({
            code: 'conflict',
            details: { reason: 'exists', path: 'dir/a.txt' },
        });
    });

    test.skipIf(!posix)('keeps the mode of the file it replaces', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'run.sh': '#!/bin/sh\n' });

        chmodSync(join(dir, 'run.sh'), 0o755);
        await fs.write(project, folderId, 'run.sh', body('#!/bin/sh\necho hi\n'), neither);

        expect(statSync(join(dir, 'run.sh')).mode & 0o777).toBe(0o755);
    });

    test.skipIf(!posix || process.getuid?.() === 0)('refuses to replace a read-only file', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'locked.txt': 'one' });

        chmodSync(join(dir, 'locked.txt'), 0o444);

        await expect(fs.write(project, folderId, 'locked.txt', body('two'), neither)).rejects.toMatchObject({
            code: 'invalid',
            details: { reason: 'permission' },
        });
        expect(text(join(dir, 'locked.txt'))).toBe('one');
    });

    test('refuses a body over the limit, declared or not, with the reason too_large, and writes nothing', async () => {
        const { fs, project, folderId, dir } = openFolder(h);

        fs.maxFileBytes = 4;

        await expect(fs.write(project, folderId, 'big.txt', body('12345'), neither)).rejects.toMatchObject({
            code: 'invalid',
            details: { reason: 'too_large', maxBytes: 4 },
        });
        await expect(
            fs.write(project, folderId, 'big.txt', null, { create: false, declaredLength: 5 })
        ).rejects.toMatchObject({ details: { reason: 'too_large' } });
        await fs.write(project, folderId, 'ok.txt', body('1234'), neither);

        expect(readdirSync(dir)).toEqual(['ok.txt']);
    });

    test('writes that follow each other in one folder never mix', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'a.txt': 'start' });
        const version = (await fs.read(project, folderId, 'a.txt')).version;

        // Both want to replace the version they read: one wins, the other must be told it lost. Which one reaches the folder's lock first depends on how
        // fast each body is read, so the winner is the one whose text is in the file.
        const texts = ['first', 'second'];
        const results = await Promise.allSettled(
            texts.map(content =>
                fs.write(project, folderId, 'a.txt', body(content), { create: false, declaredLength: 0, version })
            )
        );

        expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
        expect(text(join(dir, 'a.txt'))).toBe(texts[results.findIndex(result => result.status === 'fulfilled')]!);
    });
});

describe('makeFolder', () => {
    test('makes a folder and its parents, and leaves one that is there alone', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'old/keep.txt': '1' });

        await fs.makeFolder(project, folderId, 'a/b/c');
        await fs.makeFolder(project, folderId, 'old');
        await fs.makeFolder(project, folderId, '');

        expect(statSync(join(dir, 'a/b/c')).isDirectory()).toBe(true);
        expect(text(join(dir, 'old/keep.txt'))).toBe('1');
    });

    test('a file in the way is conflict exists', async () => {
        const { fs, project, folderId } = openFolder(h, { 'file.txt': '1' });

        await expect(fs.makeFolder(project, folderId, 'file.txt')).rejects.toMatchObject({
            code: 'conflict',
            details: { reason: 'exists', path: 'file.txt' },
        });
        await expect(fs.makeFolder(project, folderId, 'file.txt/inner/deep')).rejects.toMatchObject({
            code: 'conflict',
            details: { reason: 'exists', path: 'file.txt' },
        });
    });
});

describe('move', () => {
    test('moves a batch, folders with everything in them, and makes the folders above the targets', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'a.txt': 'a', 'b.txt': 'b', 'src/lib/c.ts': 'c' });

        await fs.move(project, folderId, [
            { from: 'a.txt', to: 'moved/a.txt' },
            { from: 'b.txt', to: 'b2.txt' },
            { from: 'src', to: 'app' },
        ]);

        expect(text(join(dir, 'moved/a.txt'))).toBe('a');
        expect(text(join(dir, 'b2.txt'))).toBe('b');
        expect(text(join(dir, 'app/lib/c.ts'))).toBe('c');
        expect(existsSync(join(dir, 'a.txt'))).toBe(false);
        expect(existsSync(join(dir, 'src'))).toBe(false);
    });

    test('keeps the version of what it moves', async () => {
        const { fs, project, folderId } = openFolder(h, { 'a.txt': 'a' });
        const { version } = await fs.read(project, folderId, 'a.txt');

        await fs.move(project, folderId, [{ from: 'a.txt', to: 'b.txt' }]);

        expect((await fs.read(project, folderId, 'b.txt')).version).toBe(version);
    });

    test('changes nothing when one target is there: conflict exists with the path, until overwrite replaces it', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'a.ts': 'a', 'b.ts': 'b', 'taken.ts': 'taken' });
        const moves = [
            { from: 'a.ts', to: 'moved/a.ts' },
            { from: 'b.ts', to: 'taken.ts' },
        ];

        await expect(fs.move(project, folderId, moves)).rejects.toMatchObject({
            code: 'conflict',
            details: { reason: 'exists', path: 'taken.ts' },
        });
        expect(readdirSync(dir).sort()).toEqual(['a.ts', 'b.ts', 'taken.ts']);

        await fs.move(project, folderId, moves, true);

        expect(text(join(dir, 'moved/a.ts'))).toBe('a');
        expect(text(join(dir, 'taken.ts'))).toBe('b');
        expect(readdirSync(dir).sort()).toEqual(['moved', 'taken.ts']);
    });

    test('overwrite replaces a folder with a file and a file with a folder', async () => {
        const { fs, project, folderId, dir } = openFolder(h, {
            'file.txt': 'f',
            'dir/inner.txt': 'i',
            'target-dir/old.txt': 'o',
            'target-file.txt': 't',
        });

        await fs.move(
            project,
            folderId,
            [
                { from: 'file.txt', to: 'target-dir' },
                { from: 'dir', to: 'target-file.txt' },
            ],
            true
        );

        expect(text(join(dir, 'target-dir'))).toBe('f');
        expect(text(join(dir, 'target-file.txt/inner.txt'))).toBe('i');
        expect(readdirSync(dir).sort()).toEqual(['target-dir', 'target-file.txt']);
    });

    test('a batch that fails halfway puts back what it moved, and what it replaced', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'a.txt': 'a', 'taken/old.txt': 'old' });

        // The same source twice passes the check against the disk and fails when the second item runs.
        await expect(
            fs.move(
                project,
                folderId,
                [
                    { from: 'a.txt', to: 'taken' },
                    { from: 'a.txt', to: 'other/a.txt' },
                ],
                true
            )
        ).rejects.toMatchObject({ code: 'not_found' });

        expect(readdirSync(dir).sort()).toEqual(['a.txt', 'taken']);
        expect(text(join(dir, 'a.txt'))).toBe('a');
        expect(text(join(dir, 'taken/old.txt'))).toBe('old');
        expect(existsSync(join(dir, 'other'))).toBe(false);
    });

    test('a failure without overwrite puts back too, and takes back the folders it made', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'a.txt': 'a' });

        await expect(
            fs.move(project, folderId, [
                { from: 'a.txt', to: 'new/dir/a.txt' },
                { from: 'a.txt', to: 'x.txt' },
            ])
        ).rejects.toMatchObject({ code: 'not_found' });

        expect(readdirSync(dir)).toEqual(['a.txt']);
    });

    test('a missing source is not_found and changes nothing', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'a.txt': 'a' });

        await expect(
            fs.move(project, folderId, [
                { from: 'a.txt', to: 'b.txt' },
                { from: 'nope.txt', to: 'c.txt' },
            ])
        ).rejects.toMatchObject({ code: 'not_found', details: { path: 'nope.txt' } });
        expect(readdirSync(dir)).toEqual(['a.txt']);
    });

    test('refuses a folder moved into itself or onto itself, and two items to one target', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'app/a.txt': '1', 'x.txt': '2', 'y.txt': '3' });

        await expect(fs.move(project, folderId, [{ from: 'app', to: 'app/inner' }])).rejects.toMatchObject({
            code: 'conflict',
            details: { path: 'app/inner' },
        });
        await expect(fs.move(project, folderId, [{ from: 'app', to: 'app' }], true)).rejects.toMatchObject({
            code: 'conflict',
        });
        await expect(
            fs.move(project, folderId, [
                { from: 'x.txt', to: 'same' },
                { from: 'y.txt', to: 'same' },
            ])
        ).rejects.toMatchObject({ code: 'conflict' });
        expect(readdirSync(dir).sort()).toEqual(['app', 'x.txt', 'y.txt']);
    });

    link('refuses a folder moved into itself through a link', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'app/a.txt': '1' });

        symlinkSync('app', join(dir, 'alias'));

        await expect(fs.move(project, folderId, [{ from: 'app', to: 'alias/inner' }])).rejects.toMatchObject({
            code: 'conflict',
        });
        await expect(fs.copy(project, folderId, [{ from: 'app', to: 'alias/inner' }])).rejects.toMatchObject({
            code: 'conflict',
        });
        expect(readdirSync(join(dir, 'app'))).toEqual(['a.txt']);
    });

    test('with overwrite, never replaces what another item of the batch comes from', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'a.txt': 'a', 'b.txt': 'b' });

        await expect(
            fs.move(
                project,
                folderId,
                [
                    { from: 'a.txt', to: 'b.txt' },
                    { from: 'b.txt', to: 'a.txt' },
                ],
                true
            )
        ).rejects.toMatchObject({ code: 'conflict' });
        expect(text(join(dir, 'a.txt'))).toBe('a');
        expect(text(join(dir, 'b.txt'))).toBe('b');
    });

    test('never moves or replaces the folder itself', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'a.txt': 'a' });

        await expect(fs.move(project, folderId, [{ from: '', to: 'inside' }])).rejects.toMatchObject({
            code: 'invalid',
        });
        await expect(fs.move(project, folderId, [{ from: 'a.txt', to: '' }], true)).rejects.toMatchObject({
            code: 'invalid',
        });
        await expect(fs.copy(project, folderId, [{ from: 'a.txt', to: '' }], true)).rejects.toMatchObject({
            code: 'invalid',
        });
        await expect(fs.copy(project, folderId, [{ from: '', to: 'inside' }])).rejects.toMatchObject({
            code: 'conflict',
        });
        expect(readdirSync(dir)).toEqual(['a.txt']);
    });

    test('a target below a file is conflict exists with the file', async () => {
        const { fs, project, folderId } = openFolder(h, { 'a.txt': 'a', 'file.txt': 'f' });

        await expect(fs.move(project, folderId, [{ from: 'a.txt', to: 'file.txt/a.txt' }])).rejects.toMatchObject({
            code: 'conflict',
            details: { reason: 'exists', path: 'file.txt' },
        });
    });

    test('renames a file by its case only, on a file system that ignores case', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'readme.md': 'r' });
        const ignoresCase = existsSync(join(dir, 'README.MD'));

        if (!ignoresCase) {
            return;
        }

        await fs.move(project, folderId, [{ from: 'readme.md', to: 'README.md' }]);

        expect(readdirSync(dir)).toEqual(['README.md']);
        expect(text(join(dir, 'README.md'))).toBe('r');
    });
});

describe('copy', () => {
    test('copies files and folders with everything in them, and keeps the sources', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'a.txt': 'a', 'src/lib/c.ts': 'c', 'src/d.ts': 'd' });

        await fs.copy(project, folderId, [
            { from: 'a.txt', to: 'copy/a.txt' },
            { from: 'src', to: 'src2' },
        ]);

        expect(text(join(dir, 'copy/a.txt'))).toBe('a');
        expect(text(join(dir, 'src2/lib/c.ts'))).toBe('c');
        expect(text(join(dir, 'src2/d.ts'))).toBe('d');
        expect(text(join(dir, 'a.txt'))).toBe('a');
        expect(text(join(dir, 'src/lib/c.ts'))).toBe('c');
    });

    test('copies .git and node_modules with the rest of a folder', async () => {
        const { fs, project, folderId, dir } = openFolder(h, {
            'pkg/.git/HEAD': 'ref',
            'pkg/node_modules/x/i.js': '1',
        });

        await fs.copy(project, folderId, [{ from: 'pkg', to: 'pkg2' }]);

        expect(text(join(dir, 'pkg2/.git/HEAD'))).toBe('ref');
        expect(text(join(dir, 'pkg2/node_modules/x/i.js'))).toBe('1');
    });

    test('a file copied is a new file: its own version', async () => {
        const { fs, project, folderId } = openFolder(h, { 'a.txt': 'a' });
        const { version } = await fs.read(project, folderId, 'a.txt');

        await new Promise(resolve => setTimeout(resolve, 5));
        await fs.copy(project, folderId, [{ from: 'a.txt', to: 'b.txt' }]);

        expect(Buffer.from((await fs.read(project, folderId, 'b.txt')).bytes).toString()).toBe('a');
        expect((await fs.read(project, folderId, 'b.txt')).version).not.toBe(version);
    });

    test('conflict exists when a target is there, until overwrite replaces it, and a failed batch takes its copies back', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'a.txt': 'a', 'b.txt': 'b', 'taken.txt': 'taken' });

        await expect(
            fs.copy(project, folderId, [
                { from: 'a.txt', to: 'new.txt' },
                { from: 'b.txt', to: 'taken.txt' },
            ])
        ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'exists', path: 'taken.txt' } });
        expect(existsSync(join(dir, 'new.txt'))).toBe(false);

        await expect(
            fs.copy(project, folderId, [
                { from: 'a.txt', to: 'new.txt' },
                { from: 'gone.txt', to: 'x.txt' },
            ])
        ).rejects.toMatchObject({ code: 'not_found' });
        expect(existsSync(join(dir, 'new.txt'))).toBe(false);

        await fs.copy(project, folderId, [{ from: 'b.txt', to: 'taken.txt' }], true);

        expect(text(join(dir, 'taken.txt'))).toBe('b');
        expect(readdirSync(dir).sort()).toEqual(['a.txt', 'b.txt', 'taken.txt']);
    });

    test('a failure after an overwrite puts the replaced file back', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'a.txt': 'a', 'taken.txt': 'taken' });

        await expect(
            fs.copy(
                project,
                folderId,
                [
                    { from: 'a.txt', to: 'taken.txt' },
                    { from: 'a.txt', to: 'b.txt' },
                    { from: 'a.txt', to: 'b.txt/x' },
                ],
                true
            )
        ).rejects.toMatchObject({ code: 'conflict' });
        expect(text(join(dir, 'taken.txt'))).toBe('taken');
        expect(readdirSync(dir).sort()).toEqual(['a.txt', 'taken.txt']);
    });
});

describe('remove', () => {
    test('deletes files and folders with everything in them, and a path that is not there is fine', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'a.txt': 'a', 'dir/deep/b.txt': 'b', 'keep.txt': 'k' });

        await fs.remove(project, folderId, ['a.txt', 'dir', 'nope.txt', 'dir/deep/b.txt', 'file/under/missing']);

        expect(readdirSync(dir)).toEqual(['keep.txt']);
    });

    test('never deletes the folder itself, and then deletes nothing of the batch', async () => {
        const { fs, project, folderId, dir } = openFolder(h, { 'a.txt': 'a' });

        await expect(fs.remove(project, folderId, ['a.txt', ''])).rejects.toMatchObject({ code: 'invalid' });
        await expect(fs.remove(project, folderId, ['./'])).rejects.toMatchObject({ code: 'invalid' });
        await expect(fs.remove(project, folderId, ['dir/..'])).rejects.toMatchObject({
            code: 'invalid',
            details: { reason: 'outside' },
        });
        expect(existsSync(dir)).toBe(true);
        expect(text(join(dir, 'a.txt'))).toBe('a');
    });

    test('refuses a batch over the limit', async () => {
        const { fs, project, folderId } = openFolder(h);

        await expect(
            fs.remove(
                project,
                folderId,
                Array.from({ length: 10_001 }, (_, index) => `f${index}`)
            )
        ).rejects.toMatchObject({ code: 'invalid' });
    });
});

describe('find', () => {
    function repo(files: Record<string, string>) {
        const dir = tempDir('find');

        git(dir, 'init', '-q', '-b', 'main');
        put(dir, files);
        git(dir, 'add', '.');
        git(dir, 'commit', '-q', '-m', 'Start');

        const { project } = h.ok('project.add', { folders: [dir] });

        return {
            project,
            folderId: project.folders[0].id as string,
            dir: project.folders[0].path as string,
            fs: h.daemon.services.fs,
        };
    }

    test('a word matches anywhere in the path, case does not matter, and the name that starts with it comes first', async () => {
        const { fs, project, folderId } = repo({
            'docs/notebook/x.md': '1',
            'src/booking/index.ts': '2',
            'lib/rebook.ts': '3',
            'src/app/Book.tsx': '4',
        });

        expect(await fs.find(project, folderId, 'book')).toEqual([
            'src/app/Book.tsx',
            'lib/rebook.ts',
            'docs/notebook/x.md',
            'src/booking/index.ts',
        ]);
        expect(await fs.find(project, folderId, 'BOOK.TSX')).toEqual(['src/app/Book.tsx']);
        expect(await fs.find(project, folderId, '  book.tsx  ')).toEqual(['src/app/Book.tsx']);
        expect(await fs.find(project, folderId, 'nothing-like-it')).toEqual([]);
        expect(await fs.find(project, folderId, '')).toEqual([]);
        expect(await fs.find(project, folderId, '   ')).toEqual([]);
    });

    test('a query with * or ? is a glob: on the file name when it has no slash, on the path when it has', async () => {
        const { fs, project, folderId } = repo({
            'a.ts': '1',
            'src/b.ts': '2',
            'src/b.tsx': '3',
            'src/deep/c.ts': '4',
            'lib/d.ts': '5',
        });

        expect((await fs.find(project, folderId, '*.ts')).sort()).toEqual([
            'a.ts',
            'lib/d.ts',
            'src/b.ts',
            'src/deep/c.ts',
        ]);
        expect((await fs.find(project, folderId, 'b.ts?')).sort()).toEqual(['src/b.tsx']);
        expect((await fs.find(project, folderId, 'src/*.ts')).sort()).toEqual(['src/b.ts']);
        expect((await fs.find(project, folderId, 'src/**/*.ts')).sort()).toEqual(['src/b.ts', 'src/deep/c.ts']);
        expect((await fs.find(project, folderId, '*.TS')).length).toBe(4);
    });

    test('answers at most 50 paths', async () => {
        const files: Record<string, string> = {};

        for (let n = 0; n < 60; n++) {
            files[`many/file${String(n).padStart(2, '0')}.txt`] = '1';
        }

        const { fs, project, folderId } = repo(files);

        expect((await fs.find(project, folderId, 'file')).length).toBe(50);
        expect((await fs.find(project, folderId, '*.txt')).length).toBe(50);
    });

    test('leaves out .git and node_modules, files git ignores and what is not a file, and offers new files', async () => {
        const { fs, project, folderId, dir } = repo({
            'src/keep.ts': '1',
            '.gitignore': 'dist/\n',
            'node_modules/x/keep.js': '2',
        });

        put(dir, { 'dist/keep.js': '3', 'src/fresh.ts': '4' });
        mkdirSync(join(dir, 'inner'));
        git(join(dir, 'inner'), 'init', '-q', '-b', 'main');
        put(dir, { 'inner/keep.md': '5' });

        expect((await fs.find(project, folderId, 'keep')).sort()).toEqual(['src/keep.ts']);
        expect(await fs.find(project, folderId, 'fresh')).toEqual(['src/fresh.ts']);
        expect(await fs.find(project, folderId, 'inner')).toEqual([]);
    });

    test('walks a folder that is not a repository', async () => {
        const { fs, project, folderId } = openFolder(h, { 'a/b/target.txt': '1', 'node_modules/x/target.js': '2' });

        expect(await fs.find(project, folderId, 'target')).toEqual(['a/b/target.txt']);
    });
});
