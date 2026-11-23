import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getProject } from '../src/db/projects';
import { searchPaths } from '../src/files/rank';
import { FilesService } from '../src/files/service';
import { cleanTempDirs, git, Harness, startHarness, tempDir } from './helpers';

import type { Project } from '@clowdy/protocol';

afterAll(cleanTempDirs);

function put(root: string, files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }
}

describe('searchPaths', () => {
    const paths = [
        'docs/notebook/x.md',
        'src/booking/index.ts',
        'lib/rebook.ts',
        'README.md',
        'src/app/Book.tsx',
        'src/booking/BookingForm.tsx',
    ];

    test('puts a file name that starts with the word first, then one that contains it, then a folder, then the rest', () => {
        expect(searchPaths(paths, 'book', 10)).toEqual([
            'src/app/Book.tsx',
            'src/booking/BookingForm.tsx',
            'lib/rebook.ts',
            'src/booking/index.ts',
            'docs/notebook/x.md',
        ]);
    });

    test('ignores case and wants every word, in any order', () => {
        expect(searchPaths(paths, 'TSX booking', 10)).toEqual(['src/booking/BookingForm.tsx']);
        expect(searchPaths(paths, 'nothing', 10)).toEqual([]);
    });

    test('lists the files nearest the root first when nothing is typed, and stops at the limit', () => {
        expect(searchPaths(paths, '  ', 2)).toEqual(['README.md', 'lib/rebook.ts']);
    });
});

describe('FilesService', () => {
    const service = new FilesService();
    const project = (...paths: string[]): Project => ({
        id: 'prj_files',
        name: 'Files',
        folders: paths.map((path, index) => ({ id: `fld_${index}`, path })),
        taskPrefix: 'FIL',
        settings: {},
        createdAt: 1,
        position: 1,
    });
    const found = async (of: Project, query: string, limit: number) =>
        (await service.search(of, query, limit)).map(match => match.path);

    test('in a repository offers tracked and new files, not ignored or deleted ones, and none of .clowdy', async () => {
        const root = tempDir('repo');

        git(root, 'init', '-q', '-b', 'main');
        put(root, { 'src/kept.ts': '1', 'src/removed.ts': '2', '.gitignore': 'dist/\n' });
        git(root, 'add', '.');
        git(root, 'commit', '-q', '-m', 'Start');
        rmSync(join(root, 'src/removed.ts'));
        put(root, { 'src/fresh.ts': '3', 'dist/out.js': '4', '.clowdy/docs/plan.md': '5' });

        expect((await found(project(root), '', 50)).sort()).toEqual(['.gitignore', 'src/fresh.ts', 'src/kept.ts']);
    });

    test('in a folder of a repository offers its own files, named from that folder', async () => {
        const repo = tempDir('parent');

        git(repo, 'init', '-q', '-b', 'main');
        put(repo, { 'top.ts': '1', 'app/main.ts': '2', 'app/ui/view.tsx': '3' });
        git(repo, 'add', '.');
        git(repo, 'commit', '-q', '-m', 'Start');

        expect((await found(project(join(repo, 'app')), '', 50)).sort()).toEqual(['main.ts', 'ui/view.tsx']);
    });

    test('offers a repository inside the folder as a folder, with no trailing slash', async () => {
        const root = tempDir('outer');

        git(root, 'init', '-q', '-b', 'main');
        put(root, { 'a.ts': '1', 'inner/b.ts': '2' });
        git(join(root, 'inner'), 'init', '-q', '-b', 'main');

        expect((await found(project(root), '', 50)).sort()).toEqual(['a.ts', 'inner']);
    });

    test.skipIf(process.platform === 'win32')(
        'keeps names with accents and spaces and leaves out one a message cannot carry',
        async () => {
            const root = tempDir('names');

            git(root, 'init', '-q', '-b', 'main');
            put(root, { 'ünï cödé.txt': '1', 'plain.txt': '2', 'two\nlines.txt': '3' });

            expect((await found(project(root), '', 50)).sort()).toEqual(['plain.txt', 'ünï cödé.txt']);
        }
    );

    test('outside a repository walks the folder and skips node_modules, .git, .clowdy and links', async () => {
        const root = tempDir('plain');
        const outside = tempDir('outside');

        put(root, {
            'a.txt': '1',
            'deep/er/b.txt': '2',
            'node_modules/x/index.js': '3',
            '.git/HEAD': '4',
            '.clowdy/docs/plan.md': '5',
        });
        put(outside, { 'secret.txt': 'no' });

        if (process.platform !== 'win32') {
            symlinkSync(outside, join(root, 'link'));
        }

        expect((await found(project(root), '', 50)).sort()).toEqual(['a.txt', 'deep/er/b.txt']);
    });

    test('with several folders offers the files of each, matched with the folder name in front, and skips a missing one', async () => {
        const web = tempDir('web');
        const api = tempDir('api');
        const gone = tempDir('gone');

        put(web, { 'src/app.ts': '1' });
        put(api, { 'src/app.ts': '2', 'routes.ts': '3' });
        rmSync(gone, { recursive: true });

        const shop = project(web, api, gone);
        const [webName, apiName] = [web, api].map(path => path.split(/[\\/]/).at(-1) as string);

        expect((await service.search(shop, 'app', 10)).map(match => match.folderId).sort()).toEqual(['fld_0', 'fld_1']);
        expect(await service.search(shop, `${apiName} app`, 10)).toEqual([{ folderId: 'fld_1', path: 'src/app.ts' }]);
        expect(await found(shop, webName, 10)).toEqual(['src/app.ts']);
    });

    test('a missing main folder is unavailable', async () => {
        const root = tempDir('gone');
        const other = tempDir('other');

        rmSync(root, { recursive: true });

        await expect(service.search(project(root), 'a', 5)).rejects.toMatchObject({ code: 'unavailable' });
        await expect(service.search(project(root, other), 'a', 5)).rejects.toMatchObject({ code: 'unavailable' });
    });
});

describe('GET /v1/projects/:id/files', () => {
    let h: Harness;

    beforeEach(async () => {
        h = await startHarness();
    });
    afterEach(() => h.stop());

    test('answers the best matches and honours the limit', async () => {
        const { id, path } = h.openRepo();

        put(path, { 'src/booking/BookingForm.tsx': '1', 'lib/rebook.ts': '2', 'docs/other.md': '3' });

        const folderId = h.store.read(() => getProject(h.store.db, id))?.folders[0].id;

        expect(await (await h.fetch(`/v1/projects/${id}/files?query=book`)).json()).toEqual([
            { folderId, path: 'src/booking/BookingForm.tsx' },
            { folderId, path: 'lib/rebook.ts' },
        ]);
        expect(await (await h.fetch(`/v1/projects/${id}/files?query=book&limit=1`)).json()).toEqual([
            { folderId, path: 'src/booking/BookingForm.tsx' },
        ]);
    });

    test('refuses a limit that is not a number and an unknown project', async () => {
        const { id } = h.openRepo();

        expect((await h.fetch(`/v1/projects/${id}/files?limit=many`)).status).toBe(400);
        expect((await h.fetch('/v1/projects/prj_nope/files')).status).toBe(404);
    });
});
