import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isDocFile } from '../src/docs/paths';
import { docsTree, listDocs } from '../src/docs/tree';
import { cleanTempDirs, startHarness, tempDir } from './helpers';

import type { DocNode, Project } from '@clowdy/protocol';

afterAll(cleanTempDirs);

const symlinks = process.platform === 'win32' ? test.skip : test;
// A folder that is made unreadable stays readable for the super-user and has no such mode on Windows.
const unreadable = process.platform === 'win32' || process.getuid?.() === 0 ? test.skip : test;

interface Fixture {
    project: Project;
    /** The project's folder. */
    path: string;
    outside: string;
}

let fx: Fixture;

/** A project over the folders given, in the order given. */
const projectOf = (folders: Project['folders']): Project => ({ id: 'prj_docs', name: 'docs', folders, taskPrefix: 'DOC', settings: {}, createdAt: 1, position: 1 });

/** Writes files (and the folders above them) below a folder. */
function put(folder: string, files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) {
        const absolute = join(folder, path);

        mkdirSync(join(absolute, '..'), { recursive: true });
        writeFileSync(absolute, content);
    }
}

/** A tree as nested paths, for a short expectation: a file is its path, a folder is `{ path: children }`. */
const compact = (nodes: DocNode[]): unknown[] => nodes.map(node => (node.children ? { [node.path]: compact(node.children) } : node.path));

/** The ids of a folder's sources, in order. */
const idsOf = (project: Project, index = 0) => docsTree(project)[index]?.sources.map(source => source.id);

beforeEach(() => {
    const path = tempDir('project');
    const outside = tempDir('outside');

    writeFileSync(join(outside, 'secret.md'), 'top secret');
    fx = { project: projectOf([{ id: 'fld_docs', path }]), path, outside };
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

describe('document sources', () => {
    test('a folder with none of the roots has an entry and no sources, and a read makes nothing', () => {
        put(fx.path, { 'README.md': '# Readme', 'docs/guide.md': '# Guide', 'src/a.ts': '' });

        expect(docsTree(fx.project)).toEqual([{ folderId: 'fld_docs', sources: [] }]);
        expect(readdirSync(fx.path).toSorted()).toEqual(['README.md', 'docs', 'src']);
    });

    test('are the roots of the registry that have a Markdown file, in its order, each with its tree and the label of the tool', () => {
        put(fx.path, {
            '.kiro/steering/product.md': '# Product',
            '.clowdy/docs/decisions/pricing.md': '# Pricing',
            '.briefback/docs-sources/plan.md': '# Plan',
            '.briefback/docs-sources/research/spec-formats.md': '# Formats',
            'openspec/specs/booking/spec.md': '# Spec',
        });

        const [folder] = docsTree(fx.project);

        expect(folder?.sources.map(({ id, label, root }) => [id, label, root])).toEqual([
            ['briefback', 'Briefback', '.briefback'],
            ['documents', 'Documents', '.clowdy/docs'],
            ['openspec-specs', 'OpenSpec specs', 'openspec/specs'],
            ['kiro-steering', 'Kiro steering', '.kiro/steering'],
        ]);
        expect(compact(folder?.sources[0]?.nodes ?? [])).toEqual([{ 'docs-sources': [{ 'docs-sources/research': ['docs-sources/research/spec-formats.md'] }, 'docs-sources/plan.md'] }]);
        expect(compact(folder?.sources[1]?.nodes ?? [])).toEqual([{ decisions: ['decisions/pricing.md'] }]);
    });

    test('keep a path relative to the root, so the project path of a document is the root and the path', () => {
        put(fx.path, { '.briefback/acp/plan.md': '# Plan' });

        const [source] = docsTree(fx.project)[0]?.sources ?? [];

        expect(source?.root).toBe('.briefback');
        expect(source?.nodes).toEqual([{ path: 'acp', name: 'acp', kind: 'dir', children: [{ path: 'acp/plan.md', name: 'plan.md', kind: 'file' }] }]);
    });

    test('hide a root that has no Markdown file in it, however many folders and other files', () => {
        put(fx.path, { '.briefback/config.json': '{}', '.briefback/x/probe.ts.txt': '', '.clowdy/docs/notes.txt': '', '.kiro/specs/feature/.config.kiro': '{}' });
        mkdirSync(join(fx.path, 'openspec', 'specs'), { recursive: true });

        expect(idsOf(fx.project)).toEqual([]);

        put(fx.path, { '.briefback/x/plan.md': '# Plan' });

        expect(idsOf(fx.project)).toEqual(['briefback']);
    });

    test('count Spec Kit\'s specs only beside .specify, and none of the rest of .specify: its templates and scripts are tool files', () => {
        put(fx.path, { 'specs/001-chat/spec.md': '# Chat' });

        // A bare specs folder is anybody's.
        expect(idsOf(fx.project)).toEqual([]);

        put(fx.path, { '.specify/templates/spec-template.md': '# T', '.specify/scripts/bash/x.md': '# S' });

        // With .specify beside it the specs are Spec Kit's, and the templates and scripts of the tool are still no source.
        expect(docsTree(fx.project)[0]?.sources.map(source => source.root)).toEqual(['specs']);

        put(fx.path, { '.specify/memory/constitution.md': '# Constitution', '.specify/bugs/b1/fix.md': '# Fix' });

        expect(docsTree(fx.project)[0]?.sources.map(source => source.root)).toEqual(['specs', '.specify/memory', '.specify/bugs']);
    });

    test('lists Markdown files and folders only, folders first, in natural order', () => {
        for (const dir of ['zeta', 'notes/deep']) {
            mkdirSync(join(fx.path, '.clowdy', 'docs', dir), { recursive: true });
        }

        put(fx.path, Object.fromEntries(['doc10.md', 'doc2.md', 'Alpha.md', 'readme.markdown', 'image.png', 'todo.txt', 'notes/b.md', 'notes/deep/c.md', 'notes/a.txt'].map(file => [`.clowdy/docs/${ file }`, 'x'])));

        expect(compact(docsTree(fx.project)[0]?.sources[0]?.nodes ?? [])).toEqual([
            { notes: [{ 'notes/deep': ['notes/deep/c.md'] }, 'notes/b.md'] },
            { zeta: [] },
            'Alpha.md',
            'doc2.md',
            'doc10.md',
            'readme.markdown',
        ]);
    });

    test('a missing main folder is unavailable and is not recreated', () => {
        rmSync(fx.path, { recursive: true });
        fails(() => docsTree(fx.project), 'unavailable');
        expect(existsSync(fx.path)).toBe(false);
    });

    test('a root that is a file is not a source', () => {
        mkdirSync(join(fx.path, '.clowdy'));
        writeFileSync(join(fx.path, '.clowdy', 'docs'), 'not a folder');
        put(fx.path, { '.briefback/plan.md': '# Plan' });

        expect(idsOf(fx.project)).toEqual(['briefback']);
    });

    test('has one entry per folder in the project\'s order, an empty folder too', () => {
        const second = tempDir('second');
        const project = projectOf([{ id: 'fld_first', path: fx.path }, { id: 'fld_second', path: second }]);

        put(fx.path, { '.briefback/main/plan.md': '# Main' });
        put(second, { '.clowdy/docs/api/plan.md': '# Plan' });

        expect(docsTree(project).map(folder => [folder.folderId, folder.sources.map(source => source.id)])).toEqual([['fld_first', ['briefback']], ['fld_second', ['documents']]]);

        const third = projectOf([{ id: 'fld_first', path: fx.path }, { id: 'fld_empty', path: tempDir('empty') }]);

        expect(docsTree(third)[1]).toEqual({ folderId: 'fld_empty', sources: [] });
    });

    test('a missing folder other than the main one is left out', () => {
        const second = join(tempDir('parent'), 'gone');
        const project = projectOf([{ id: 'fld_first', path: fx.path }, { id: 'fld_gone', path: second }]);

        expect(docsTree(project)).toEqual([{ folderId: 'fld_first', sources: [] }]);
        expect(existsSync(second)).toBe(false);
    });

    symlinks('symbolic links are not listed', () => {
        put(fx.path, { '.clowdy/docs/real.md': 'x' });
        symlinkSync(fx.outside, join(fx.path, '.clowdy', 'docs', 'linked-dir'));
        symlinkSync(join(fx.path, '.clowdy', 'docs', 'real.md'), join(fx.path, '.clowdy', 'docs', 'alias.md'));

        expect(docsTree(fx.project)[0]?.sources[0]?.nodes.map(node => node.path)).toEqual(['real.md']);
    });

    symlinks('a root that is a link out of the folder is left out, and nothing is read through it, while the other roots stay', () => {
        put(fx.path, { '.briefback/plan.md': '# Plan' });
        mkdirSync(join(fx.path, '.clowdy'), { recursive: true });
        symlinkSync(fx.outside, join(fx.path, '.clowdy', 'docs'));

        expect(idsOf(fx.project)).toEqual(['briefback']);
        expect(readdirSync(fx.outside)).toEqual(['secret.md']);
    });

    symlinks('a .briefback that is a link out of its folder is left out, and so is a .clowdy that is one whose docs folder is in what it leads to', () => {
        mkdirSync(join(fx.outside, 'docs'));
        writeFileSync(join(fx.outside, 'docs', 'secret.md'), 'top secret');
        symlinkSync(fx.outside, join(fx.path, '.clowdy'));
        symlinkSync(fx.outside, join(fx.path, '.briefback'));

        expect(docsTree(fx.project)).toEqual([{ folderId: 'fld_docs', sources: [] }]);
    });

    symlinks('a specs folder that is a link to a folder inside the project is a source', () => {
        put(fx.path, { '.specify/memory/c.md': '# C', 'shared/001/spec.md': '# Spec' });
        symlinkSync(join(fx.path, 'shared'), join(fx.path, 'specs'));

        expect(docsTree(fx.project)[0]?.sources.map(source => [source.root, source.nodes.length])).toEqual([['specs', 1], ['.specify/memory', 1]]);
    });

    symlinks('a root that is a dangling link is no source, and nothing is made to follow it', () => {
        const target = join(fx.outside, 'made-here');

        mkdirSync(join(fx.path, '.clowdy'));
        symlinkSync(target, join(fx.path, '.clowdy', 'docs'));

        expect(docsTree(fx.project)).toEqual([{ folderId: 'fld_docs', sources: [] }]);
        expect(existsSync(target)).toBe(false);
    });

    symlinks('another folder\'s roots that lead out of it are left out of its sources', () => {
        const second = tempDir('second');
        const project = projectOf([{ id: 'fld_first', path: fx.path }, { id: 'fld_out', path: second }]);

        mkdirSync(join(second, '.clowdy'));
        symlinkSync(fx.outside, join(second, '.clowdy', 'docs'));

        expect(docsTree(project)).toEqual([{ folderId: 'fld_first', sources: [] }, { folderId: 'fld_out', sources: [] }]);
    });

    unreadable('a folder that cannot be read lists nothing and does not take the others with it', () => {
        put(fx.path, { '.briefback/open/plan.md': '# Plan', '.briefback/shut/hidden.md': '# Hidden' });

        const shut = join(fx.path, '.briefback', 'shut');

        chmodSync(shut, 0o000);

        try {
            expect(compact(docsTree(fx.project)[0]?.sources[0]?.nodes ?? [])).toEqual([{ open: ['open/plan.md'] }, { shut: [] }]);
        }
        finally {
            chmodSync(shut, 0o755);
        }
    });
});

describe('the size of a listing', () => {
    test('skips .git and node_modules, which no document is in, wherever they are put', () => {
        const root = tempDir('listing');

        for (const dir of ['plans', 'plans/node_modules/pkg', '.git/refs', 'clone/.git']) mkdirSync(join(root, dir), { recursive: true });

        for (const file of ['plans/a.md', 'plans/node_modules/pkg/README.md', '.git/refs/b.md', 'clone/.git/c.md', 'clone/d.md']) writeFileSync(join(root, file), 'x');

        const paths = (nodes: DocNode[]): string[] => nodes.flatMap(node => [node.path, ...paths(node.children ?? [])]);

        expect(paths(listDocs(root))).toEqual(['clone', 'clone/d.md', 'plans', 'plans/a.md']);
    });

    test('stops at its budget of entries and keeps what it listed (which ones is the file system\'s order)', () => {
        const root = tempDir('budget');

        for (const name of ['a', 'b', 'c', 'd', 'e']) writeFileSync(join(root, `${ name }.md`), 'x');

        const listed = listDocs(root, '', { left: 3 }).map(node => node.path);

        expect(listed).toHaveLength(3);
        expect(listed).toEqual(listed.toSorted());
        expect(listDocs(root)).toHaveLength(5);
    });
});

describe('document files', () => {
    test('are the Markdown ones, by extension and in any case', () => {
        expect(['a.md', 'A.MD', 'b.markdown', 'c.Markdown'].every(isDocFile)).toBe(true);
        expect(['a.txt', 'md', 'a.md.png', 'a.mdx'].some(isDocFile)).toBe(false);
    });
});

describe('over the API', () => {
    test('GET docs serves the sources of each folder and needs a project', async () => {
        const h = await startHarness();

        try {
            const { id, path: folder } = h.openRepo();

            put(folder, { '.clowdy/docs/plan/mvp.md': '# MVP', '.briefback/acp/plan.md': '# Plan' });

            const [entry] = await (await h.fetch(`/v1/projects/${ id }/docs`)).json() as Array<{ folderId: string; sources: Array<{ id: string; label: string; root: string; nodes: DocNode[] }> }>;

            expect(entry?.sources.map(source => [source.id, source.label, source.root])).toEqual([['briefback', 'Briefback', '.briefback'], ['documents', 'Documents', '.clowdy/docs']]);
            expect(entry?.sources[1]?.nodes).toEqual([{ path: 'plan', name: 'plan', kind: 'dir', children: [{ path: 'plan/mvp.md', name: 'mvp.md', kind: 'file' }] }]);
            expect((await h.fetch('/v1/projects/prj_nope/docs')).status).toBe(404);
            expect((await h.fetch(`/v1/projects/${ id }/docs/file?path=plan/mvp.md`)).status).toBe(404);
        }
        finally {
            await h.stop();
        }
    });
});
