import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openDatabase } from '../src/db/connection';
import { getProject, upsertProject } from '../src/db/projects';
import { normalizeDocPath } from '../src/docs/paths';
import { DocsService } from '../src/docs/service';
import { Store } from '../src/store';
import { cleanTempDirs, Harness, makeRepo, startHarness, tempDir, waitFor } from './helpers';

import type { DocNode, Project } from '@clowdy/protocol';

afterAll(cleanTempDirs);

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const symlinks = process.platform === 'win32' ? test.skip : test;

interface Fixture {
    store: Store;
    docs: DocsService;
    project: Project;
    root: string;
    outside: string;
    read: (path: string) => ReturnType<DocsService['read']>;
    write: (input: Parameters<DocsService['write']>[2]) => ReturnType<DocsService['write']>;
}

let fx: Fixture;

/** A project of the fixture's store, so that announcements find it. */
function addProject(store: Store, id: string, folders: Project['folders']): Project {
    const project: Project = { id, name: id, folders, taskPrefix: 'DOC', settings: {}, createdAt: 1, position: 1 };

    store.tx(() => upsertProject(store.db, project));

    return project;
}

beforeEach(() => {
    const path = tempDir('project');
    const outside = tempDir('outside');
    const store = new Store(openDatabase(':memory:'));
    const docs = new DocsService(store);
    const project = addProject(store, 'prj_docs', [{ id: 'fld_docs', path }]);

    writeFileSync(join(outside, 'secret.md'), 'top secret');
    fx = {
        store,
        docs,
        project,
        root: join(path, '.clowdy', 'docs'),
        outside,
        read: path => docs.read(project, 'fld_docs', path),
        write: input => docs.write(project, 'fld_docs', input),
    };
});

/** The `docs.changed` events of the fixture's store, as `project:folder:change:path`. */
const changes = () => fx.store.eventsAfter(0, undefined, 1000).flatMap(event => (
    event.data.type === 'docs.changed' ? [`${ event.projectId }:${ event.data.folderId }:${ event.data.change }:${ event.data.path }`] : []
));

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
    test('is made only by the first write: reading the tree or a file leaves the folder as it was', () => {
        const folder = fx.project.folders[0].path;

        expect(fx.docs.tree(fx.project)).toEqual([{ folderId: 'fld_docs', nodes: [] }]);
        fails(() => fx.read('plan.md'), 'not_found');
        fails(() => fx.write({ path: 'plan.md', content: 'x', baseHash: sha256('x') }), 'not_found');
        expect(existsSync(join(folder, '.clowdy'))).toBe(false);

        expect(fx.write({ path: 'plan.md', content: '# Plan', baseHash: null }).change).toBe('created');
        expect(readFileSync(join(fx.root, 'plan.md'), 'utf8')).toBe('# Plan');
    });

    test('a first write that fails leaves no docs folder behind', () => {
        fails(() => fx.write({ path: `${ 'n'.repeat(300) }.md`, content: 'x', baseHash: null }), 'invalid');
        expect(existsSync(join(fx.project.folders[0].path, '.clowdy'))).toBe(false);

        mkdirSync(join(fx.project.folders[0].path, '.clowdy'));
        writeFileSync(join(fx.project.folders[0].path, '.clowdy', 'other.json'), '{}');
        fails(() => fx.write({ path: `${ 'n'.repeat(300) }.md`, content: 'x', baseHash: null }), 'invalid');
        expect(readdirSync(join(fx.project.folders[0].path, '.clowdy'))).toEqual(['other.json']);
    });

    test('existing files are left alone', () => {
        mkdirSync(fx.root, { recursive: true });
        writeFileSync(join(fx.root, 'keep.md'), 'mine');

        expect(fx.docs.tree(fx.project)).toEqual([{ folderId: 'fld_docs', nodes: [{ path: 'keep.md', name: 'keep.md', kind: 'file' }] }]);
        expect(readFileSync(join(fx.root, 'keep.md'), 'utf8')).toBe('mine');
    });

    test('a missing project folder is unavailable and is not recreated', () => {
        rmSync(fx.project.folders[0].path, { recursive: true });
        fails(() => fx.docs.tree(fx.project), 'unavailable');
        fails(() => fx.write({ path: 'a.md', content: 'x', baseHash: null }), 'unavailable');
        expect(existsSync(fx.project.folders[0].path)).toBe(false);
    });

    test('the tree lists Markdown files and folders only, folders first, in natural order', () => {
        for (const dir of ['zeta', 'notes/deep']) {
            mkdirSync(join(fx.root, dir), { recursive: true });
        }

        for (const file of ['doc10.md', 'doc2.md', 'Alpha.md', 'readme.markdown', 'image.png', 'todo.txt', 'notes/b.md', 'notes/deep/c.md', 'notes/a.txt']) {
            writeFileSync(join(fx.root, file), 'x');
        }

        const compact = (nodes: DocNode[]): unknown[] => nodes.map(node => (node.children ? { [node.path]: compact(node.children) } : node.path));

        expect(compact(fx.docs.tree(fx.project)[0]?.nodes ?? [])).toEqual([
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

        expect(fx.docs.tree(fx.project)[0]?.nodes.map(node => node.path)).toEqual(['real.md']);
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
        fails(() => fx.read('notes.txt'), 'invalid');
        fails(() => fx.write({ path: 'run.sh', content: 'x', baseHash: null }), 'invalid');
        expect(fx.write({ path: 'UPPER.MD', content: 'x', baseHash: null }).path).toBe('UPPER.MD');
    });

    test('a path that runs through a file, or has a name too long for the file system, is invalid and names no absolute path', () => {
        mkdirSync(fx.root, { recursive: true });
        writeFileSync(join(fx.root, 'a.md'), 'x');

        for (const path of ['a.md/b.md', `${ 'n'.repeat(300) }.md`]) {
            for (const action of [() => fx.read(path), () => fx.write({ path, content: 'x', baseHash: null })]) {
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

        fails(() => fx.read('linked-dir/secret.md'), 'invalid');
        fails(() => fx.read('evil.md'), 'invalid');
        fails(() => fx.write({ path: 'linked-dir/new.md', content: 'x', baseHash: null }), 'invalid');
        fails(() => fx.write({ path: 'linked-dir/sub/deeper/new.md', content: 'x', baseHash: null }), 'invalid');
        fails(() => fx.write({ path: 'dangling.md', content: 'x', baseHash: null }), 'invalid');
        fails(() => fx.write({ path: 'evil.md', content: 'x', baseHash: sha256('top secret') }), 'invalid');

        expect(readdirSync(fx.outside)).toEqual(['secret.md']);
        expect(readFileSync(join(fx.outside, 'secret.md'), 'utf8')).toBe('top secret');
    });

    symlinks('a link that stays inside the docs folder works', () => {
        mkdirSync(fx.root, { recursive: true });
        writeFileSync(join(fx.root, 'real.md'), 'hello');
        symlinkSync(join(fx.root, 'real.md'), join(fx.root, 'alias.md'));

        expect(fx.read('alias.md').content).toBe('hello');
    });

    symlinks('a docs folder that is a link out of its folder is refused, and nothing is written through it', () => {
        mkdirSync(join(fx.project.folders[0].path, '.clowdy'), { recursive: true });
        symlinkSync(fx.outside, fx.root);

        fails(() => fx.docs.tree(fx.project), 'invalid');
        fails(() => fx.read('secret.md'), 'invalid');
        fails(() => fx.write({ path: 'new.md', content: 'x', baseHash: null }), 'invalid');
        expect(readdirSync(fx.outside)).toEqual(['secret.md']);
    });

    symlinks('a .clowdy that is a link out of its folder takes no docs folder there, not even for a moment', () => {
        symlinkSync(fx.outside, join(fx.project.folders[0].path, '.clowdy'));

        const mkdir = spyOn(fs, 'mkdirSync');

        try {
            fails(() => fx.write({ path: 'new.md', content: 'x', baseHash: null }), 'invalid');
            expect(mkdir).not.toHaveBeenCalled();
        }
        finally {
            mkdir.mockRestore();
        }

        expect(readdirSync(fx.outside)).toEqual(['secret.md']);
    });

    symlinks('a docs folder that is a dangling link is not followed to make its target', () => {
        const target = join(fx.outside, 'made-here');

        mkdirSync(join(fx.project.folders[0].path, '.clowdy'));
        symlinkSync(target, fx.root);

        expect(fx.docs.tree(fx.project)).toEqual([{ folderId: 'fld_docs', nodes: [] }]);
        expect(() => fx.write({ path: 'new.md', content: 'x', baseHash: null })).toThrow();
        expect(existsSync(target)).toBe(false);
    });

    symlinks('another folder whose docs folder leads out of it is left out of the tree, and refused to read and write', () => {
        const second = tempDir('second');
        const project = addProject(fx.store, 'prj_two', [{ id: 'fld_first', path: fx.project.folders[0].path }, { id: 'fld_out', path: second }]);

        mkdirSync(join(second, '.clowdy'));
        symlinkSync(fx.outside, join(second, '.clowdy', 'docs'));

        expect(fx.docs.tree(project)).toEqual([{ folderId: 'fld_first', nodes: [] }]);
        fails(() => fx.docs.read(project, 'fld_out', 'secret.md'), 'invalid');
        fails(() => fx.docs.write(project, 'fld_out', { path: 'new.md', content: 'x', baseHash: null }), 'invalid');
        expect(readdirSync(fx.outside)).toEqual(['secret.md']);
    });
});

describe('read and write', () => {
    test('read returns the content and its SHA-256', () => {
        mkdirSync(fx.root, { recursive: true });
        writeFileSync(join(fx.root, 'a.md'), 'héllo\n');

        expect(fx.read('a.md')).toEqual({ path: 'a.md', content: 'héllo\n', hash: sha256('héllo\n') });
        fails(() => fx.read('missing.md'), 'not_found');

        mkdirSync(join(fx.root, 'dir.md'));
        fails(() => fx.read('dir.md'), 'invalid');
    });

    test('a null base hash creates the file with its folders, and fails when it exists', () => {
        const created = fx.write({ path: 'decisions/booking/flow.md', content: '# Flow', baseHash: null });

        expect(created).toEqual({ folder: fx.project.folders[0].path, path: 'decisions/booking/flow.md', hash: sha256('# Flow'), change: 'created' });
        expect(readFileSync(join(fx.root, 'decisions/booking/flow.md'), 'utf8')).toBe('# Flow');

        try {
            fx.write({ path: 'decisions/booking/flow.md', content: 'again', baseHash: null });
            throw new Error('expected a conflict');
        }
        catch (error) {
            expect(error).toMatchObject({ code: 'conflict', details: { path: 'decisions/booking/flow.md', content: '# Flow', hash: sha256('# Flow') } });
        }
    });

    test('a matching base hash updates; a stale one is a conflict that carries the current version', () => {
        const { hash } = fx.write({ path: 'a.md', content: 'one', baseHash: null });
        const updated = fx.write({ path: 'a.md', content: 'two', baseHash: hash });

        expect(updated).toMatchObject({ hash: sha256('two'), change: 'modified' });

        try {
            fx.write({ path: 'a.md', content: 'three', baseHash: hash });
            throw new Error('expected a conflict');
        }
        catch (error) {
            expect(error).toMatchObject({ code: 'conflict', details: { content: 'two', hash: sha256('two') } });
        }

        writeFileSync(join(fx.root, 'a.md'), 'changed by an agent');
        fails(() => fx.write({ path: 'a.md', content: 'mine', baseHash: updated.hash }), 'conflict');
        expect(readFileSync(join(fx.root, 'a.md'), 'utf8')).toBe('changed by an agent');
        fails(() => fx.write({ path: 'gone.md', content: 'x', baseHash: sha256('x') }), 'not_found');
    });

    test('writes replace the file atomically through a temp file and leave nothing behind', () => {
        fx.write({ path: 'a.md', content: 'one', baseHash: null });

        const before = statSync(join(fx.root, 'a.md')).ino;

        fx.write({ path: 'a.md', content: 'two', baseHash: sha256('one') });

        expect(statSync(join(fx.root, 'a.md')).ino).not.toBe(before);
        expect(readdirSync(fx.root)).toEqual(['a.md']);
    });

    test('a document over the size limit is refused', () => {
        fails(() => fx.write({ path: 'big.md', content: 'x'.repeat(5 * 1024 * 1024 + 1), baseHash: null }), 'invalid');
        expect(existsSync(join(fx.root, 'big.md'))).toBe(false);
    });
});

describe('watcher', () => {
    test('reports outside changes once each, ignores other files, and stays quiet about its own writes', async () => {
        mkdirSync(fx.root, { recursive: true });
        fx.docs.tree(fx.project);
        // The platform watcher needs a moment before it sees anything.
        await Bun.sleep(150);

        writeFileSync(join(fx.root, 'outside.md'), 'v1');
        writeFileSync(join(fx.root, 'ignored.txt'), 'v1');
        await waitFor(() => changes().includes('prj_docs:fld_docs:created:outside.md'), 'the created event');

        writeFileSync(join(fx.root, 'outside.md'), 'v2');
        await waitFor(() => changes().includes('prj_docs:fld_docs:modified:outside.md'), 'the modified event');

        fx.write({ path: 'own.md', content: 'mine', baseHash: null });
        rmSync(join(fx.root, 'outside.md'));
        await waitFor(() => changes().includes('prj_docs:fld_docs:removed:outside.md'), 'the removed event');
        await new Promise(resolve => setTimeout(resolve, 300));

        expect(changes()).toEqual(['prj_docs:fld_docs:created:outside.md', 'prj_docs:fld_docs:modified:outside.md', 'prj_docs:fld_docs:removed:outside.md']);
    });

    test('a docs folder an agent makes after the tree was read is picked up, and its files are announced', async () => {
        fx.docs.tree(fx.project);
        await Bun.sleep(150);

        mkdirSync(join(fx.root, 'plans'), { recursive: true });
        writeFileSync(join(fx.root, 'plans', 'first.md'), '# First');
        await waitFor(() => changes().includes('prj_docs:fld_docs:created:plans/first.md'), 'the document of the new docs folder');
        expect(changes()).toContain('prj_docs:fld_docs:created:plans');

        writeFileSync(join(fx.root, 'second.md'), '# Second');
        await waitFor(() => changes().includes('prj_docs:fld_docs:created:second.md'), 'a later document in it');
    });

    test('the first write from the app into a watched folder is not announced by the watcher', async () => {
        fx.docs.tree(fx.project);
        await Bun.sleep(150);

        fx.write({ path: 'notes/mine.md', content: 'mine', baseHash: null });
        await Bun.sleep(400);
        writeFileSync(join(fx.root, 'theirs.md'), 'theirs');
        await waitFor(() => changes().includes('prj_docs:fld_docs:created:theirs.md'), 'the next outside change');

        expect(changes()).toEqual(['prj_docs:fld_docs:created:theirs.md']);
    });

    test('an entry that vanishes while the watcher looks at it is skipped, and the next change is still reported', async () => {
        mkdirSync(fx.root, { recursive: true });
        fx.docs.tree(fx.project);
        await Bun.sleep(150);

        const spy = spyOn(fs, 'lstatSync').mockImplementationOnce(() => {
            throw Object.assign(new Error('ENOENT: no such file or directory, lstat'), { code: 'ENOENT' });
        });

        try {
            writeFileSync(join(fx.root, 'racy.md'), 'v1');
            await waitFor(() => spy.mock.calls.length > 0, 'the watcher to look at the file');
            await Bun.sleep(100);
            writeFileSync(join(fx.root, 'later.md'), 'v1');
            await waitFor(() => changes().includes('prj_docs:fld_docs:created:later.md'), 'the event after the failed look');
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
            fx.docs.tree(fx.project);
            fx.docs.tree(fx.project);
            expect(fx.write({ path: 'a.md', content: 'x', baseHash: null }).change).toBe('created');
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

describe('folders', () => {
    test('the tree has one entry per folder in the project\'s order, an empty folder too, and a write lands in the folder it names', () => {
        const second = tempDir('second');
        const project = addProject(fx.store, 'prj_two', [{ id: 'fld_first', path: fx.project.folders[0].path }, { id: 'fld_second', path: second }]);

        mkdirSync(fx.root, { recursive: true });
        writeFileSync(join(fx.root, 'main.md'), '# Main');

        expect(fx.docs.tree(project)).toEqual([
            { folderId: 'fld_first', nodes: [{ path: 'main.md', name: 'main.md', kind: 'file' }] },
            { folderId: 'fld_second', nodes: [] },
        ]);
        expect(existsSync(join(second, '.clowdy'))).toBe(false);

        expect(fx.docs.write(project, 'fld_second', { path: 'api/plan.md', content: '# Plan', baseHash: null })).toMatchObject({ folder: second, path: 'api/plan.md', change: 'created' });
        expect(readFileSync(join(second, '.clowdy', 'docs', 'api', 'plan.md'), 'utf8')).toBe('# Plan');
        expect(existsSync(join(fx.root, 'api'))).toBe(false);
        expect(fx.docs.read(project, 'fld_second', 'api/plan.md').content).toBe('# Plan');
        fails(() => fx.docs.read(project, 'fld_first', 'api/plan.md'), 'not_found');
        expect(fx.docs.tree(project)[1]).toEqual({ folderId: 'fld_second', nodes: [{ path: 'api', name: 'api', kind: 'dir', children: [{ path: 'api/plan.md', name: 'plan.md', kind: 'file' }] }] });
    });

    test('a folder the project does not have is not found, and none named is invalid', () => {
        fails(() => fx.docs.read(fx.project, 'fld_other', 'a.md'), 'not_found');
        fails(() => fx.docs.write(fx.project, 'fld_other', { path: 'a.md', content: 'x', baseHash: null }), 'not_found');
        fails(() => fx.docs.read(fx.project, '', 'a.md'), 'invalid');
    });

    test('a missing folder other than the main one is left out of the tree and cannot be written into', () => {
        const second = join(tempDir('parent'), 'gone');
        const project = addProject(fx.store, 'prj_two', [{ id: 'fld_first', path: fx.project.folders[0].path }, { id: 'fld_gone', path: second }]);

        expect(fx.docs.tree(project)).toEqual([{ folderId: 'fld_first', nodes: [] }]);
        fails(() => fx.docs.write(project, 'fld_gone', { path: 'a.md', content: 'x', baseHash: null }), 'unavailable');
        expect(existsSync(second)).toBe(false);
    });

    test('a folder two projects have is watched once and its changes reach both, each with its own folder id', async () => {
        const other = addProject(fx.store, 'prj_other', [{ id: 'fld_mine', path: tempDir('mine') }, { id: 'fld_shared', path: fx.project.folders[0].path }]);

        fx.docs.tree(fx.project);
        fx.docs.tree(other);
        expect((fx.docs as unknown as { watchers: Map<string, unknown> }).watchers.size).toBe(2);
        await Bun.sleep(150);

        mkdirSync(fx.root, { recursive: true });
        writeFileSync(join(fx.root, 'shared.md'), '# Shared');
        await waitFor(() => changes().includes('prj_other:fld_shared:created:shared.md'), 'the change in the other project');
        expect(changes()).toContain('prj_docs:fld_docs:created:shared.md');

        // The other project leaves: the folder stays watched for the one that still has it.
        fx.store.tx(() => upsertProject(fx.store.db, { ...other, folders: [other.folders[0]] }));
        fx.docs.release();
        writeFileSync(join(fx.root, 'later.md'), '# Later');
        await waitFor(() => changes().includes('prj_docs:fld_docs:created:later.md'), 'the change for the project that has the folder');
        expect(changes()).not.toContain('prj_other:fld_shared:created:later.md');
    });
});

describe('over the API', () => {
    let h: Harness;

    beforeEach(async () => {
        h = await startHarness();
    });

    afterEach(() => h.stop());

    const folderIdOf = (projectId: string, index = 0) => getProject(h.store.db, projectId)?.folders[index]?.id as string;

    test('docs.write publishes one docs.changed, repeats are idempotent, and GET serves the tree and the file', async () => {
        const { id, path: folder } = h.openRepo();
        const folderId = folderIdOf(id);

        // The tree of a folder without documents is read first, so its watcher waits for the docs folder the write makes.
        expect(await (await h.fetch(`/v1/projects/${ id }/docs`)).json()).toEqual([{ folderId, nodes: [] }]);
        expect(existsSync(join(folder, '.clowdy'))).toBe(false);

        const request = { requestId: 'req-docs-write-1', projectId: id, folderId, path: 'plan/mvp.md', content: '# MVP', baseHash: null };
        const first = h.send('docs.write', request);
        const again = h.send('docs.write', request);

        expect(first).toEqual({ ok: true, requestId: 'req-docs-write-1', data: { path: 'plan/mvp.md', hash: sha256('# MVP') } });
        expect(again).toEqual(first);
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(h.events().filter(event => event.data.type === 'docs.changed').map(event => event.data)).toEqual([
            { type: 'docs.changed', folderId, path: 'plan/mvp.md', change: 'created' },
        ]);

        expect(await (await h.fetch(`/v1/projects/${ id }/docs`)).json()).toEqual([
            { folderId, nodes: [{ path: 'plan', name: 'plan', kind: 'dir', children: [{ path: 'plan/mvp.md', name: 'mvp.md', kind: 'file' }] }] },
        ]);
        expect(await (await h.fetch(`/v1/projects/${ id }/docs/file?folderId=${ folderId }&path=plan/mvp.md`)).json()).toEqual({ path: 'plan/mvp.md', content: '# MVP', hash: sha256('# MVP') });
        expect((await h.fetch(`/v1/projects/${ id }/docs/file?folderId=${ folderId }&path=../../etc/passwd`)).status).toBe(400);
        expect((await h.fetch(`/v1/projects/${ id }/docs/file?folderId=${ folderId }&path=nope.md`)).status).toBe(404);
        expect((await h.fetch(`/v1/projects/${ id }/docs/file?folderId=fld_nope&path=plan/mvp.md`)).status).toBe(404);
        expect((await h.fetch(`/v1/projects/${ id }/docs/file?path=plan/mvp.md`)).status).toBe(400);
        expect(h.send('docs.write', { projectId: id, folderId: 'fld_nope', path: 'a.md', content: 'x', baseHash: null })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    });

    test('a write into a folder two projects have is announced to both', () => {
        const shared = makeRepo(h.config.projectsDir, 'shared');
        const { project: first } = h.ok('project.add', { folders: [shared] });
        const { project: second } = h.ok('project.add', { folders: [makeRepo(h.config.projectsDir, 'own'), shared] });
        const cursor = h.store.headCursor();

        h.ok('docs.write', { projectId: second.id, folderId: second.folders[1].id, path: 'shared.md', content: '# Shared', baseHash: null });

        expect(h.events(cursor).map(event => [event.projectId, event.data])).toEqual([
            [first.id, { type: 'docs.changed', folderId: first.folders[0].id, path: 'shared.md', change: 'created' }],
            [second.id, { type: 'docs.changed', folderId: second.folders[1].id, path: 'shared.md', change: 'created' }],
        ]);
    });

    test('a stale save answers a conflict result with the current content and hash', () => {
        const { id } = h.openRepo();
        const folderId = folderIdOf(id);

        h.ok('docs.write', { projectId: id, folderId, path: 'a.md', content: 'v1', baseHash: null });

        const result = h.send('docs.write', { projectId: id, folderId, path: 'a.md', content: 'v2', baseHash: sha256('something else') });

        expect(result).toMatchObject({ ok: false, error: { code: 'conflict', details: { path: 'a.md', content: 'v1', hash: sha256('v1') } } });
    });
});
