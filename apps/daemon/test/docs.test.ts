import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openDatabase } from '../src/db/connection';
import { normalizeDocPath } from '../src/docs/paths';
import { DocsService } from '../src/docs/service';
import { Store } from '../src/store';
import { cleanTempDirs, Harness, startHarness, tempDir, waitFor } from './helpers';

import type { Project } from '@clowdy/protocol';

afterAll(cleanTempDirs);

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const symlinks = process.platform === 'win32' ? test.skip : test;

interface Fixture {
    store: Store;
    docs: DocsService;
    project: Project;
    root: string;
    outside: string;
}

let fx: Fixture;

beforeEach(() => {
    const path = tempDir('project');
    const outside = tempDir('outside');
    const store = new Store(openDatabase(':memory:'));

    writeFileSync(join(outside, 'secret.md'), 'top secret');
    fx = {
        store,
        docs: new DocsService(store),
        project: { id: 'prj_docs', name: 'Docs', path, taskPrefix: 'DOC', settings: {}, createdAt: 1, position: 1 },
        root: join(path, '.clowdy', 'docs'),
        outside,
    };
});

afterEach(() => fx.docs.stop());

const fails = (action: () => unknown, code: string) => {
    try {
        action();
    }
    catch (error) {
        expect((error as { code?: string }).code).toBe(code);

        return;
    }

    throw new Error(`expected a ${ code } error`);
};

describe('docs folder', () => {
    test('is created on first access and existing files are left alone', () => {
        mkdirSync(fx.root, { recursive: true });
        writeFileSync(join(fx.root, 'keep.md'), 'mine');
        fx.docs.root(fx.project);

        expect(readFileSync(join(fx.root, 'keep.md'), 'utf8')).toBe('mine');

        const fresh = { ...fx.project, id: 'prj_fresh', path: tempDir('fresh') };

        expect(fx.docs.tree(fresh)).toEqual([]);
        expect(statSync(join(fresh.path, '.clowdy', 'docs')).isDirectory()).toBe(true);
    });

    test('a missing project folder is not recreated', () => {
        rmSync(fx.project.path, { recursive: true });
        fails(() => fx.docs.root(fx.project), 'unavailable');
        expect(existsSync(fx.project.path)).toBe(false);
    });

    test('the tree lists Markdown files and folders only, folders first, in natural order', () => {
        for (const dir of ['zeta', 'notes/deep']) {
            mkdirSync(join(fx.root, dir), { recursive: true });
        }

        for (const file of ['doc10.md', 'doc2.md', 'Alpha.md', 'readme.markdown', 'image.png', 'todo.txt', 'notes/b.md', 'notes/deep/c.md', 'notes/a.txt']) {
            writeFileSync(join(fx.root, file), 'x');
        }

        const compact = (nodes: ReturnType<DocsService['tree']>): unknown[] => nodes.map(node => (node.children ? { [node.path]: compact(node.children) } : node.path));

        expect(compact(fx.docs.tree(fx.project))).toEqual([
            { notes: [{ 'notes/deep': ['notes/deep/c.md'] }, 'notes/b.md'] },
            { zeta: [] },
            'Alpha.md',
            'doc2.md',
            'doc10.md',
            'readme.markdown',
        ]);
    });

    symlinks('symbolic links are not listed', () => {
        mkdirSync(fx.root, { recursive: true });
        writeFileSync(join(fx.root, 'real.md'), 'x');
        symlinkSync(fx.outside, join(fx.root, 'linked-dir'));
        symlinkSync(join(fx.root, 'real.md'), join(fx.root, 'alias.md'));

        expect(fx.docs.tree(fx.project).map(node => node.path)).toEqual(['real.md']);
    });
});

describe('paths', () => {
    test('are normalized, and anything absolute, parent-relative, or odd is rejected', () => {
        expect(normalizeDocPath('./a//b/./c.md')).toBe('a/b/c.md');

        for (const bad of ['', '/etc/passwd', 'C:/x.md', 'c:x.md', '\\x.md', 'a\\b.md', '../x.md', 'a/../../x.md', 'a/..', 'a\0b.md', '.', './']) {
            fails(() => normalizeDocPath(bad), 'invalid');
        }
    });

    test('only Markdown files are served', () => {
        fails(() => fx.docs.read(fx.project, 'notes.txt'), 'invalid');
        fails(() => fx.docs.write(fx.project, { path: 'run.sh', content: 'x', baseHash: null }), 'invalid');
        expect(fx.docs.write(fx.project, { path: 'UPPER.MD', content: 'x', baseHash: null }).path).toBe('UPPER.MD');
    });

    test('a path that runs through a file, or has a name too long for the file system, is invalid and names no absolute path', () => {
        mkdirSync(fx.root, { recursive: true });
        writeFileSync(join(fx.root, 'a.md'), 'x');

        for (const path of ['a.md/b.md', `${ 'n'.repeat(300) }.md`]) {
            for (const action of [() => fx.docs.read(fx.project, path), () => fx.docs.write(fx.project, { path, content: 'x', baseHash: null })]) {
                try {
                    action();
                    throw new Error('expected an invalid error');
                }
                catch (error) {
                    expect((error as { code?: string }).code).toBe('invalid');
                    expect((error as Error).message).not.toContain(fx.root);
                }
            }
        }

        expect(readFileSync(join(fx.root, 'a.md'), 'utf8')).toBe('x');
    });

    symlinks('a symbolic link cannot lead out of the docs folder, for existing and new files', () => {
        mkdirSync(fx.root, { recursive: true });
        symlinkSync(fx.outside, join(fx.root, 'linked-dir'));
        symlinkSync(join(fx.outside, 'secret.md'), join(fx.root, 'evil.md'));
        symlinkSync(join(fx.outside, 'nope.md'), join(fx.root, 'dangling.md'));

        fails(() => fx.docs.read(fx.project, 'linked-dir/secret.md'), 'invalid');
        fails(() => fx.docs.read(fx.project, 'evil.md'), 'invalid');
        fails(() => fx.docs.write(fx.project, { path: 'linked-dir/new.md', content: 'x', baseHash: null }), 'invalid');
        fails(() => fx.docs.write(fx.project, { path: 'linked-dir/sub/deeper/new.md', content: 'x', baseHash: null }), 'invalid');
        fails(() => fx.docs.write(fx.project, { path: 'dangling.md', content: 'x', baseHash: null }), 'invalid');
        fails(() => fx.docs.write(fx.project, { path: 'evil.md', content: 'x', baseHash: sha256('top secret') }), 'invalid');

        expect(readdirSync(fx.outside)).toEqual(['secret.md']);
        expect(readFileSync(join(fx.outside, 'secret.md'), 'utf8')).toBe('top secret');
    });

    symlinks('a link that stays inside the docs folder works', () => {
        mkdirSync(fx.root, { recursive: true });
        writeFileSync(join(fx.root, 'real.md'), 'hello');
        symlinkSync(join(fx.root, 'real.md'), join(fx.root, 'alias.md'));

        expect(fx.docs.read(fx.project, 'alias.md').content).toBe('hello');
    });

    symlinks('a docs folder that is a link out of the project is refused', () => {
        mkdirSync(join(fx.project.path, '.clowdy'), { recursive: true });
        symlinkSync(fx.outside, fx.root);

        fails(() => fx.docs.root(fx.project), 'invalid');
        fails(() => fx.docs.read(fx.project, 'secret.md'), 'invalid');
    });
});

describe('read and write', () => {
    test('read returns the content and its SHA-256', () => {
        mkdirSync(fx.root, { recursive: true });
        writeFileSync(join(fx.root, 'a.md'), 'héllo\n');

        expect(fx.docs.read(fx.project, 'a.md')).toEqual({ path: 'a.md', content: 'héllo\n', hash: sha256('héllo\n') });
        fails(() => fx.docs.read(fx.project, 'missing.md'), 'not_found');

        mkdirSync(join(fx.root, 'dir.md'));
        fails(() => fx.docs.read(fx.project, 'dir.md'), 'invalid');
    });

    test('a null base hash creates the file with its folders, and fails when it exists', () => {
        const created = fx.docs.write(fx.project, { path: 'decisions/booking/flow.md', content: '# Flow', baseHash: null });

        expect(created).toEqual({ path: 'decisions/booking/flow.md', hash: sha256('# Flow'), change: 'created' });
        expect(readFileSync(join(fx.root, 'decisions/booking/flow.md'), 'utf8')).toBe('# Flow');

        try {
            fx.docs.write(fx.project, { path: 'decisions/booking/flow.md', content: 'again', baseHash: null });
            throw new Error('expected a conflict');
        }
        catch (error) {
            expect(error).toMatchObject({ code: 'conflict', details: { path: 'decisions/booking/flow.md', content: '# Flow', hash: sha256('# Flow') } });
        }
    });

    test('a matching base hash updates; a stale one is a conflict that carries the current version', () => {
        const { hash } = fx.docs.write(fx.project, { path: 'a.md', content: 'one', baseHash: null });
        const updated = fx.docs.write(fx.project, { path: 'a.md', content: 'two', baseHash: hash });

        expect(updated).toMatchObject({ hash: sha256('two'), change: 'modified' });

        try {
            fx.docs.write(fx.project, { path: 'a.md', content: 'three', baseHash: hash });
            throw new Error('expected a conflict');
        }
        catch (error) {
            expect(error).toMatchObject({ code: 'conflict', details: { content: 'two', hash: sha256('two') } });
        }

        writeFileSync(join(fx.root, 'a.md'), 'changed by an agent');
        fails(() => fx.docs.write(fx.project, { path: 'a.md', content: 'mine', baseHash: updated.hash }), 'conflict');
        expect(readFileSync(join(fx.root, 'a.md'), 'utf8')).toBe('changed by an agent');
        fails(() => fx.docs.write(fx.project, { path: 'gone.md', content: 'x', baseHash: sha256('x') }), 'not_found');
    });

    test('writes replace the file atomically through a temp file and leave nothing behind', () => {
        fx.docs.write(fx.project, { path: 'a.md', content: 'one', baseHash: null });

        const before = statSync(join(fx.root, 'a.md')).ino;

        fx.docs.write(fx.project, { path: 'a.md', content: 'two', baseHash: sha256('one') });

        expect(statSync(join(fx.root, 'a.md')).ino).not.toBe(before);
        expect(readdirSync(fx.root)).toEqual(['a.md']);
    });

    test('a document over the size limit is refused', () => {
        fails(() => fx.docs.write(fx.project, { path: 'big.md', content: 'x'.repeat(5 * 1024 * 1024 + 1), baseHash: null }), 'invalid');
        expect(existsSync(join(fx.root, 'big.md'))).toBe(false);
    });
});

describe('watcher', () => {
    test('reports outside changes once each, ignores other files, and stays quiet about its own writes', async () => {
        fx.docs.root(fx.project);
        // The platform watcher needs a moment before it sees anything.
        await Bun.sleep(150);

        const changes = () => fx.store.eventsAfter(0, undefined, 1000).flatMap(event => (event.data.type === 'docs.changed' ? [`${ event.data.change }:${ event.data.path }`] : []));

        writeFileSync(join(fx.root, 'outside.md'), 'v1');
        writeFileSync(join(fx.root, 'ignored.txt'), 'v1');
        await waitFor(() => changes().includes('created:outside.md'), 'the created event');

        writeFileSync(join(fx.root, 'outside.md'), 'v2');
        await waitFor(() => changes().includes('modified:outside.md'), 'the modified event');

        fx.docs.write(fx.project, { path: 'own.md', content: 'mine', baseHash: null });
        rmSync(join(fx.root, 'outside.md'));
        await waitFor(() => changes().includes('removed:outside.md'), 'the removed event');
        await new Promise(resolve => setTimeout(resolve, 300));

        expect(changes()).toEqual(['created:outside.md', 'modified:outside.md', 'removed:outside.md']);
    });

    test('an entry that vanishes while the watcher looks at it is skipped, and the next change is still reported', async () => {
        fx.docs.root(fx.project);
        await Bun.sleep(150);

        const changes = () => fx.store.eventsAfter(0, undefined, 1000).flatMap(event => (event.data.type === 'docs.changed' ? [`${ event.data.change }:${ event.data.path }`] : []));
        const spy = spyOn(fs, 'lstatSync').mockImplementationOnce(() => {
            throw Object.assign(new Error('ENOENT: no such file or directory, lstat'), { code: 'ENOENT' });
        });

        try {
            writeFileSync(join(fx.root, 'racy.md'), 'v1');
            await waitFor(() => spy.mock.calls.length > 0, 'the watcher to look at the file');
            await Bun.sleep(100);
            writeFileSync(join(fx.root, 'later.md'), 'v1');
            await waitFor(() => changes().includes('created:later.md'), 'the event after the failed look');
        }
        finally {
            spy.mockRestore();
        }
    });

    test('a watcher that cannot start is reported once and does not break the service', () => {
        const spy = spyOn(fs, 'watch').mockImplementation(() => {
            throw new Error('ENOSPC');
        });
        const warn = spyOn(console, 'warn').mockImplementation(() => undefined);

        try {
            fx.docs.root(fx.project);
            fx.docs.root(fx.project);
            expect(fx.docs.write(fx.project, { path: 'a.md', content: 'x', baseHash: null }).change).toBe('created');
            expect(fx.store.eventsAfter(0, undefined, 10).map(event => event.data)).toEqual([
                { type: 'notice', level: 'warn', text: expect.stringContaining('will not refresh') },
            ]);
        }
        finally {
            spy.mockRestore();
            warn.mockRestore();
        }
    });
});

describe('over the API', () => {
    let h: Harness;

    beforeEach(async () => {
        h = await startHarness();
    });

    afterEach(() => h.stop());

    test('docs.write publishes one docs.changed, repeats are idempotent, and GET serves the tree and the file', async () => {
        const { id } = h.openRepo();
        const request = { requestId: 'req-docs-write-1', projectId: id, path: 'plan/mvp.md', content: '# MVP', baseHash: null };
        const first = h.send('docs.write', request);
        const again = h.send('docs.write', request);

        expect(first).toEqual({ ok: true, requestId: 'req-docs-write-1', data: { path: 'plan/mvp.md', hash: sha256('# MVP') } });
        expect(again).toEqual(first);
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(h.events().filter(event => event.data.type === 'docs.changed').map(event => event.data)).toEqual([
            { type: 'docs.changed', path: 'plan/mvp.md', change: 'created' },
        ]);

        expect(await (await h.fetch(`/v1/projects/${ id }/docs`)).json()).toEqual([
            { path: 'plan', name: 'plan', kind: 'dir', children: [{ path: 'plan/mvp.md', name: 'mvp.md', kind: 'file' }] },
        ]);
        expect(await (await h.fetch(`/v1/projects/${ id }/docs/file?path=plan/mvp.md`)).json()).toEqual({ path: 'plan/mvp.md', content: '# MVP', hash: sha256('# MVP') });
        expect((await h.fetch(`/v1/projects/${ id }/docs/file?path=../../etc/passwd`)).status).toBe(400);
        expect((await h.fetch(`/v1/projects/${ id }/docs/file?path=nope.md`)).status).toBe(404);
    });

    test('a stale save answers a conflict result with the current content and hash', () => {
        const { id } = h.openRepo();

        h.ok('docs.write', { projectId: id, path: 'a.md', content: 'v1', baseHash: null });

        const result = h.send('docs.write', { projectId: id, path: 'a.md', content: 'v2', baseHash: sha256('something else') });

        expect(result).toMatchObject({ ok: false, error: { code: 'conflict', details: { path: 'a.md', content: 'v1', hash: sha256('v1') } } });
    });
});
