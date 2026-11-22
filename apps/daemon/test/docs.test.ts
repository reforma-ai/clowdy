import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isDocFile } from '../src/docs/paths';
import { docsTree } from '../src/docs/tree';
import { cleanTempDirs, startHarness, tempDir } from './helpers';

import type { DocNode, Project } from '@clowdy/protocol';

afterAll(cleanTempDirs);

const symlinks = process.platform === 'win32' ? test.skip : test;

interface Fixture {
    project: Project;
    root: string;
    outside: string;
}

let fx: Fixture;

/** A project over the folders given, in the order given. */
const projectOf = (folders: Project['folders']): Project => ({ id: 'prj_docs', name: 'docs', folders, taskPrefix: 'DOC', settings: {}, createdAt: 1, position: 1 });

beforeEach(() => {
    const path = tempDir('project');
    const outside = tempDir('outside');

    writeFileSync(join(outside, 'secret.md'), 'top secret');
    fx = { project: projectOf([{ id: 'fld_docs', path }]), root: join(path, '.clowdy', 'docs'), outside };
});

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

describe('docs tree', () => {
    test('a read never makes the docs folder: a folder without one has no nodes', () => {
        expect(docsTree(fx.project)).toEqual([{ folderId: 'fld_docs', nodes: [] }]);
        expect(existsSync(join(fx.project.folders[0].path, '.clowdy'))).toBe(false);
    });

    test('lists Markdown files and folders only, folders first, in natural order', () => {
        for (const dir of ['zeta', 'notes/deep']) {
            mkdirSync(join(fx.root, dir), { recursive: true });
        }

        for (const file of ['doc10.md', 'doc2.md', 'Alpha.md', 'readme.markdown', 'image.png', 'todo.txt', 'notes/b.md', 'notes/deep/c.md', 'notes/a.txt']) {
            writeFileSync(join(fx.root, file), 'x');
        }

        const compact = (nodes: DocNode[]): unknown[] => nodes.map(node => (node.children ? { [node.path]: compact(node.children) } : node.path));

        expect(compact(docsTree(fx.project)[0]?.nodes ?? [])).toEqual([
            { notes: [{ 'notes/deep': ['notes/deep/c.md'] }, 'notes/b.md'] },
            { zeta: [] },
            'Alpha.md',
            'doc2.md',
            'doc10.md',
            'readme.markdown',
        ]);
    });

    test('existing files are left alone', () => {
        mkdirSync(fx.root, { recursive: true });
        writeFileSync(join(fx.root, 'keep.md'), 'mine');

        expect(docsTree(fx.project)).toEqual([{ folderId: 'fld_docs', nodes: [{ path: 'keep.md', name: 'keep.md', kind: 'file' }] }]);
    });

    test('a missing main folder is unavailable and is not recreated', () => {
        rmSync(fx.project.folders[0].path, { recursive: true });
        fails(() => docsTree(fx.project), 'unavailable');
        expect(existsSync(fx.project.folders[0].path)).toBe(false);
    });

    test('a docs folder that is a file is unavailable', () => {
        mkdirSync(join(fx.project.folders[0].path, '.clowdy'));
        writeFileSync(fx.root, 'not a folder');
        fails(() => docsTree(fx.project), 'unavailable');
    });

    test('has one entry per folder in the project\'s order, an empty folder too', () => {
        const second = tempDir('second');
        const project = projectOf([{ id: 'fld_first', path: fx.project.folders[0].path }, { id: 'fld_second', path: second }]);

        mkdirSync(fx.root, { recursive: true });
        writeFileSync(join(fx.root, 'main.md'), '# Main');
        mkdirSync(join(second, '.clowdy', 'docs', 'api'), { recursive: true });
        writeFileSync(join(second, '.clowdy', 'docs', 'api', 'plan.md'), '# Plan');

        expect(docsTree(project)).toEqual([
            { folderId: 'fld_first', nodes: [{ path: 'main.md', name: 'main.md', kind: 'file' }] },
            { folderId: 'fld_second', nodes: [{ path: 'api', name: 'api', kind: 'dir', children: [{ path: 'api/plan.md', name: 'plan.md', kind: 'file' }] }] },
        ]);
    });

    test('a missing folder other than the main one is left out', () => {
        const second = join(tempDir('parent'), 'gone');
        const project = projectOf([{ id: 'fld_first', path: fx.project.folders[0].path }, { id: 'fld_gone', path: second }]);

        expect(docsTree(project)).toEqual([{ folderId: 'fld_first', nodes: [] }]);
        expect(existsSync(second)).toBe(false);
    });

    symlinks('symbolic links are not listed', () => {
        mkdirSync(fx.root, { recursive: true });
        writeFileSync(join(fx.root, 'real.md'), 'x');
        symlinkSync(fx.outside, join(fx.root, 'linked-dir'));
        symlinkSync(join(fx.root, 'real.md'), join(fx.root, 'alias.md'));

        expect(docsTree(fx.project)[0]?.nodes.map(node => node.path)).toEqual(['real.md']);
    });

    symlinks('a docs folder that is a link out of its folder is refused, and nothing is read through it', () => {
        mkdirSync(join(fx.project.folders[0].path, '.clowdy'), { recursive: true });
        symlinkSync(fx.outside, fx.root);

        fails(() => docsTree(fx.project), 'invalid');
        expect(readdirSync(fx.outside)).toEqual(['secret.md']);
    });

    symlinks('a .clowdy that is a link out of its folder is refused, though the docs folder is in what it leads to', () => {
        mkdirSync(join(fx.outside, 'docs'));
        writeFileSync(join(fx.outside, 'docs', 'secret.md'), 'top secret');
        symlinkSync(fx.outside, join(fx.project.folders[0].path, '.clowdy'));

        fails(() => docsTree(fx.project), 'invalid');
    });

    symlinks('a docs folder that is a dangling link is not followed to make its target', () => {
        const target = join(fx.outside, 'made-here');

        mkdirSync(join(fx.project.folders[0].path, '.clowdy'));
        symlinkSync(target, fx.root);

        expect(docsTree(fx.project)).toEqual([{ folderId: 'fld_docs', nodes: [] }]);
        expect(existsSync(target)).toBe(false);
    });

    symlinks('another folder whose docs folder leads out of it is left out', () => {
        const second = tempDir('second');
        const project = projectOf([{ id: 'fld_first', path: fx.project.folders[0].path }, { id: 'fld_out', path: second }]);

        mkdirSync(join(second, '.clowdy'));
        symlinkSync(fx.outside, join(second, '.clowdy', 'docs'));

        expect(docsTree(project)).toEqual([{ folderId: 'fld_first', nodes: [] }]);
    });
});

describe('document files', () => {
    test('are the Markdown ones, by extension and in any case', () => {
        expect(['a.md', 'A.MD', 'b.markdown', 'c.Markdown'].every(isDocFile)).toBe(true);
        expect(['a.txt', 'md', 'a.md.png', 'a.mdx'].some(isDocFile)).toBe(false);
    });
});

describe('over the API', () => {
    test('GET docs serves the tree and needs a project', async () => {
        const h = await startHarness();

        try {
            const { id, path: folder } = h.openRepo();

            mkdirSync(join(folder, '.clowdy', 'docs', 'plan'), { recursive: true });
            writeFileSync(join(folder, '.clowdy', 'docs', 'plan', 'mvp.md'), '# MVP');

            const [entry] = await (await h.fetch(`/v1/projects/${ id }/docs`)).json() as { folderId: string; nodes: DocNode[] }[];

            expect(entry?.nodes).toEqual([{ path: 'plan', name: 'plan', kind: 'dir', children: [{ path: 'plan/mvp.md', name: 'mvp.md', kind: 'file' }] }]);
            expect((await h.fetch('/v1/projects/prj_nope/docs')).status).toBe(404);
            expect((await h.fetch(`/v1/projects/${ id }/docs/file?path=plan/mvp.md`)).status).toBe(404);
        }
        finally {
            await h.stop();
        }
    });
});
