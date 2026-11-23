import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolvePlace } from '../src/domain/places';
import { TerminalService } from '../src/terminals/service';
import { EventReader } from './fs-helpers';
import { cleanTempDirs, git, makeRepo, startHarness, tempDir } from './helpers';

import type { DocNode, DocsTree, FsEntry, ProjectFileMatch, ProjectInfo, TerminalInfo } from '@clowdy/protocol';
import type { PtySpec } from '../src/terminals/pty';
import type { Harness } from './helpers';

afterAll(cleanTempDirs);

const symlinks = process.platform === 'win32' ? test.skip : test;

const harnesses: Harness[] = [];
const readers: EventReader[] = [];

afterEach(async () => {
    await Promise.all(readers.splice(0).map(reader => reader.close()));
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

/** Writes files (and the folders above them) under `root`. */
function put(root: string, files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }
}

/** A terminal that starts no program: the directory it was asked to start in is what a test looks at. */
function recordingTerminals(started: PtySpec[]): TerminalService {
    return new TerminalService({
        shell: () => ({ file: 'sh', args: [], name: 'sh' }),
        env: () => ({}),
        spawn: (spec) => {
            started.push(spec);

            return { pid: 1, write: () => undefined, resize: () => undefined, kill: () => undefined };
        },
    });
}

/**
 * A project `Shop` of two repositories (`shop`, the main folder, and `infra`), each with a worktree that a chat works in: the worktree of `shop` has a plan, a file and a
 * commit that the main checkout lacks, and the main checkout has a plan and a file of its own that the worktree lacks. A second project holds a worktree of its own.
 */
async function setup() {
    const started: PtySpec[] = [];
    const h = await startHarness({}, { terminals: recordingTerminals(started) });

    harnesses.push(h);

    const root = tempDir('places');
    const shop = makeRepo(root, 'shop');
    const infra = makeRepo(root, 'infra');
    const other = makeRepo(root, 'other');

    put(shop, { 'shared.txt': 'shared in the checkout\n', 'src/app.ts': 'export {};\n', '.briefback/shared/plan.md': '# Shared plan\n' });
    git(shop, 'add', '.');
    git(shop, 'commit', '-q', '-m', 'Add the shared files');
    put(infra, { '.briefback/infra/plan.md': '# Infra plan\n' });
    git(infra, 'add', '.');
    git(infra, 'commit', '-q', '-m', 'Add the infra plan');

    const tree = join(root, 'shop-feature');
    const infraTree = join(root, 'infra-feature');
    const otherTree = join(root, 'other-feature');

    git(shop, 'worktree', 'add', '-q', '-b', 'feature', tree);
    git(infra, 'worktree', 'add', '-q', '-b', 'tuning', infraTree);
    git(other, 'worktree', 'add', '-q', '-b', 'theirs', otherTree);
    put(tree, { 'only-here.txt': 'only in the worktree\n', '.briefback/feature/plan.md': '# Feature plan\n' });
    git(tree, 'add', 'only-here.txt');
    git(tree, 'commit', '-q', '-m', 'Add only-here');
    put(shop, { 'main-only.txt': 'only in the checkout\n', '.briefback/main/notes.md': '# Main notes\n' });

    const { project } = h.ok('project.add', { name: 'Shop', folders: [shop, infra] });
    const { project: stranger } = h.ok('project.add', { name: 'Other', folders: [other] });
    const [folder, infraFolder] = project.folders as Array<{ id: string; path: string }>;
    const workspace = (projectId: string, path: string, folderId?: string) => (h.ok('chat.create', { projectId, workspace: { mode: 'existing', path }, ...(folderId && { folderId }) }).chat.workspace as { id: string });
    const feature = workspace(project.id, tree);
    const tuning = workspace(project.id, infraTree, infraFolder.id);
    const theirs = workspace(stranger.id, otherTree);
    const base = `/v1/projects/${ project.id }`;
    const fsUrl = (route: string, params: Record<string, string | undefined>) => `${ base }/fs/${ route }?${ new URLSearchParams(Object.entries(params).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]]))).toString() }`;
    const post = (route: string, body: unknown) => h.fetch(`${ base }/fs/${ route }`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const failure = async (response: Response) => (await response.json() as { ok: false; error: { code: string; message: string; details?: { reason?: string } } }).error;

    return { h, started, root, shop, infra, tree, infraTree, otherTree, project, stranger, folder, infraFolder, feature, tuning, theirs, base, fsUrl, post, failure };
}

describe('the file system in a worktree', () => {
    test('lists, finds, reads and writes the worktree\'s own files, and the checkout\'s stay as they were', async () => {
        const { h, shop, tree, folder, feature, fsUrl } = await setup();
        const names = async (workspaceId?: string) => ((await (await h.fetch(fsUrl('list', { folderId: folder.id, workspaceId }))).json()) as FsEntry[]).map(entry => entry.path);
        const main = await names();
        const there = await names(feature.id);

        expect(main).toContain('main-only.txt');
        expect(main).not.toContain('only-here.txt');
        expect(there).toContain('only-here.txt');
        expect(there).not.toContain('main-only.txt');
        expect(await (await h.fetch(fsUrl('find', { folderId: folder.id, workspaceId: feature.id, query: 'here' }))).json()).toEqual(['only-here.txt']);
        expect(await (await h.fetch(fsUrl('find', { folderId: folder.id, query: 'here' }))).json()).toEqual([]);
        expect(await (await h.fetch(fsUrl('file', { folderId: folder.id, workspaceId: feature.id, path: 'only-here.txt' }))).text()).toBe('only in the worktree\n');
        expect((await h.fetch(fsUrl('file', { folderId: folder.id, path: 'only-here.txt' }))).status).toBe(404);

        const written = await h.fetch(fsUrl('file', { folderId: folder.id, workspaceId: feature.id, path: 'shared.txt' }), { method: 'PUT', body: 'changed in the worktree\n' });

        expect(written.status).toBe(200);
        expect(readFileSync(join(tree, 'shared.txt'), 'utf8')).toBe('changed in the worktree\n');
        expect(readFileSync(join(shop, 'shared.txt'), 'utf8')).toBe('shared in the checkout\n');
        expect(await (await h.fetch(fsUrl('file', { folderId: folder.id, path: 'shared.txt' }))).text()).toBe('shared in the checkout\n');
    });

    test('makes folders, moves, copies, deletes and searches in the worktree through the body\'s workspaceId', async () => {
        const { shop, tree, folder, feature, post } = await setup();
        const at = { folderId: folder.id, workspaceId: feature.id };

        expect((await post('folder', { ...at, path: 'made/deep' })).status).toBe(200);
        expect(existsSync(join(tree, 'made', 'deep'))).toBe(true);
        expect(existsSync(join(shop, 'made'))).toBe(false);

        expect((await post('copy', { ...at, copies: [{ from: 'only-here.txt', to: 'made/copy.txt' }] })).status).toBe(200);
        expect(readFileSync(join(tree, 'made', 'copy.txt'), 'utf8')).toBe('only in the worktree\n');

        expect((await post('move', { ...at, moves: [{ from: 'made/copy.txt', to: 'made/moved.txt' }] })).status).toBe(200);
        expect(existsSync(join(tree, 'made', 'moved.txt'))).toBe(true);
        expect(existsSync(join(tree, 'made', 'copy.txt'))).toBe(false);

        const found = await (await post('search', { ...at, query: 'only in the' })).json() as { files: Array<{ path: string }> };

        expect(found.files.map(file => file.path).sort()).toEqual(['made/moved.txt', 'only-here.txt']);

        const inCheckout = await (await post('search', { folderId: folder.id, query: 'only in the' })).json() as { files: Array<{ path: string }> };

        expect(inCheckout.files.map(file => file.path)).toEqual(['main-only.txt']);

        // A delete in the checkout of a name the worktree has leaves the worktree's file where it is, and the other way round.
        expect((await post('delete', { folderId: folder.id, paths: ['shared.txt'] })).status).toBe(200);
        expect(existsSync(join(shop, 'shared.txt'))).toBe(false);
        expect(existsSync(join(tree, 'shared.txt'))).toBe(true);
        expect((await post('delete', { ...at, paths: ['made', 'only-here.txt'] })).status).toBe(200);
        expect(existsSync(join(tree, 'made'))).toBe(false);
        expect(existsSync(join(tree, 'only-here.txt'))).toBe(false);
        expect(existsSync(join(shop, 'main-only.txt'))).toBe(true);
    });

    test('watches a worktree on its own: its changes reach its watchers and the checkout\'s do not', async () => {
        const { h, shop, tree, folder, feature, fsUrl } = await setup();
        const open = async (workspaceId?: string) => {
            const response = await h.fetch(fsUrl('watch', { folderId: folder.id, workspaceId }));
            const reader = new EventReader(response.body as ReadableStream<Uint8Array>);

            readers.push(reader);

            return reader;
        };
        const inWorktree = await open(feature.id);
        const inCheckout = await open();
        const watches = () => (h.daemon.services.fs as unknown as { watches: Map<string, unknown> }).watches.size;

        // The watcher reads what the folder holds before it tells anything: let it settle.
        await new Promise(resolve => setTimeout(resolve, 400));
        expect(watches()).toBe(2);

        writeFileSync(join(tree, 'fresh-in-worktree.txt'), '1');

        const [event] = await inWorktree.next();

        expect(event).toMatchObject({ type: 'changes' });
        expect(JSON.stringify(event)).toContain('fresh-in-worktree.txt');
        expect(JSON.stringify(await inCheckout.quiet())).not.toContain('fresh-in-worktree.txt');

        writeFileSync(join(shop, 'fresh-in-checkout.txt'), '1');
        expect(JSON.stringify(await inCheckout.next())).toContain('fresh-in-checkout.txt');
        expect(JSON.stringify(await inWorktree.quiet())).not.toContain('fresh-in-checkout.txt');
    });

    symlinks('judges every path against the worktree\'s own real path: a link to the checkout, or out of the project, is refused', async () => {
        const { h, root, tree, folder, feature, fsUrl, post, failure } = await setup();
        const outside = tempDir('outside');

        put(outside, { 'secret.txt': 'secret' });
        symlinkSync(outside, join(tree, 'out'));
        symlinkSync(join(root, 'shop'), join(tree, 'checkout'));

        for (const path of ['out/secret.txt', 'checkout/README.md', '../shop/README.md']) {
            const response = await h.fetch(fsUrl('file', { folderId: folder.id, workspaceId: feature.id, path }));

            expect(response.status).toBe(400);
            expect((await failure(response)).details?.reason).toBe('outside');
        }

        const write = await h.fetch(fsUrl('file', { folderId: folder.id, workspaceId: feature.id, path: 'checkout/planted.txt' }), { method: 'PUT', body: 'x' });

        expect(write.status).toBe(400);
        expect(existsSync(join(root, 'shop', 'planted.txt'))).toBe(false);
        expect(existsSync(join(outside, 'planted.txt'))).toBe(false);

        // The same through the other routes: a link is never entered, whether it is read, written into, copied from or deleted through.
        const at = { folderId: folder.id, workspaceId: feature.id };

        expect((await h.fetch(fsUrl('list', { ...at, path: 'checkout' }))).status).toBe(400);
        expect((await h.fetch(fsUrl('list', { ...at, path: 'out' }))).status).toBe(400);
        expect((await post('folder', { ...at, path: 'out/made' })).status).toBe(400);
        expect((await post('copy', { ...at, copies: [{ from: 'out/secret.txt', to: 'taken.txt' }] })).status).toBe(400);
        expect((await post('move', { ...at, moves: [{ from: 'only-here.txt', to: 'checkout/moved.txt' }] })).status).toBe(400);
        expect((await post('delete', { ...at, paths: ['checkout/README.md', 'out/secret.txt'] })).status).toBe(400);
        expect(existsSync(join(tree, 'taken.txt'))).toBe(false);
        expect(existsSync(join(outside, 'made'))).toBe(false);
        expect(existsSync(join(root, 'shop', 'moved.txt'))).toBe(false);
        expect(existsSync(join(root, 'shop', 'README.md'))).toBe(true);
        expect(existsSync(join(outside, 'secret.txt'))).toBe(true);
    });

    test('a workspace id of another folder, of another project or of nothing is not_found, an empty one is none', async () => {
        const { h, folder, infraFolder, feature, tuning, theirs, project, stranger, base, fsUrl, post, failure } = await setup();

        // `tuning` belongs to the folder `infra`, `theirs` to another project, and `feature` to the folder asked for in no case below.
        const stray: Array<[string, string]> = [[folder.id, tuning.id], [infraFolder.id, feature.id], [folder.id, theirs.id], [folder.id, 'wks_nowhere']];

        for (const [folderId, workspaceId] of stray) {
            for (const [method, route] of [['GET', 'list'], ['GET', 'find'], ['GET', 'file'], ['GET', 'watch'], ['PUT', 'file']] as const) {
                const response = await h.fetch(fsUrl(route, { folderId, workspaceId, path: 'README.md', query: 'x' }), { method, ...(method === 'PUT' && { body: 'x' }) });

                expect(response.status).toBe(404);
                expect((await failure(response)).code).toBe('not_found');
            }

            for (const route of ['folder', 'move', 'copy', 'delete', 'search']) {
                const response = await post(route, { folderId, workspaceId, path: 'x', moves: [], copies: [], paths: [], query: 'x' });

                expect(response.status).toBe(404);
            }
        }

        expect(existsSync(join(project.folders[0].path, 'x'))).toBe(false);

        // The workspace of another project is just as unknown through this project's documents, file names and terminals.
        expect((await h.fetch(`${ base }/docs?workspaceId=${ theirs.id }`)).status).toBe(404);
        expect((await h.fetch(`${ base }/files?query=a&workspaceId=${ theirs.id }`)).status).toBe(404);
        expect((await h.fetch('/v1/terminals', { method: 'POST', body: JSON.stringify({ projectId: project.id, folderId: folder.id, workspaceId: theirs.id, cols: 80, rows: 24 }) })).status).toBe(404);

        // Nor does it help to ask the other project's own route for this project's worktree.
        expect((await h.fetch(`/v1/projects/${ stranger.id }/docs?workspaceId=${ feature.id }`)).status).toBe(404);
        expect((await h.fetch(fsUrl('list', { folderId: folder.id, workspaceId: feature.id }).replace(project.id, stranger.id))).status).toBe(404);

        // An empty `workspaceId` is no workspace, in a query and in a body: the folder's own checkout is read, and a terminal and the lists are the folder's.
        const own = await h.fetch(fsUrl('file', { folderId: folder.id, workspaceId: '', path: 'main-only.txt' }));

        expect(await own.text()).toBe('only in the checkout\n');
        expect(await (await post('search', { folderId: folder.id, workspaceId: '', query: 'only in the' })).json()).toMatchObject({ files: [{ path: 'main-only.txt' }] });
        expect((await post('folder', { folderId: folder.id, workspaceId: '', path: 'made-in-checkout' })).status).toBe(200);
        expect(existsSync(join(project.folders[0].path, 'made-in-checkout'))).toBe(true);
        expect(await (await h.fetch(`${ base }/files?query=main-only&workspaceId=`)).json()).toEqual([{ folderId: folder.id, path: 'main-only.txt' }]);
        expect(JSON.stringify(await (await h.fetch(`${ base }/docs?workspaceId=`)).json())).toContain('main/notes.md');

        const terminal = await (await h.fetch('/v1/terminals', { method: 'POST', body: JSON.stringify({ projectId: project.id, folderId: folder.id, workspaceId: '', cols: 80, rows: 24 }) })).json() as TerminalInfo;

        expect(terminal.workspaceId).toBeUndefined();
        expect(terminal.cwd).toBe(realpathSync(project.folders[0].path));
    });

    test('a workspace that is not made yet, or is gone from the disk, is unavailable in every route', async () => {
        const { h, project, folder, shop, base, fsUrl, post, failure } = await setup();
        const unmade = h.ok('chat.create', { projectId: project.id, workspace: { mode: 'new' } }).chat.workspace as { id: string; ready: boolean; path: string };
        const gone = join(dirname(shop), 'shop-gone');

        git(shop, 'worktree', 'add', '-q', '-b', 'gone', gone);

        const missing = h.ok('chat.create', { projectId: project.id, workspace: { mode: 'existing', path: gone } }).chat.workspace as { id: string };

        rmSync(gone, { recursive: true, force: true });
        expect(unmade.ready).toBe(false);
        expect(existsSync(unmade.path)).toBe(false);

        for (const workspaceId of [unmade.id, missing.id]) {
            for (const [method, route] of [['GET', 'list'], ['GET', 'file'], ['GET', 'watch'], ['PUT', 'file']] as const) {
                const response = await h.fetch(fsUrl(route, { folderId: folder.id, workspaceId, path: 'README.md' }), { method, ...(method === 'PUT' && { body: 'x' }) });

                expect(response.status).toBe(503);
                expect((await failure(response)).code).toBe('unavailable');
            }

            expect((await post('search', { folderId: folder.id, workspaceId, query: 'x' })).status).toBe(503);
            expect((await post('folder', { folderId: folder.id, workspaceId, path: 'x' })).status).toBe(503);
            expect((await h.fetch(`${ base }/docs?workspaceId=${ workspaceId }`)).status).toBe(503);
            expect((await h.fetch(`${ base }/files?query=a&workspaceId=${ workspaceId }`)).status).toBe(503);
            expect((await h.fetch('/v1/terminals', { method: 'POST', body: JSON.stringify({ projectId: project.id, folderId: folder.id, workspaceId, cols: 80, rows: 24 }) })).status).toBe(503);
        }

        // Nothing was made on the way: the folder where the missing worktree was, and the one that was never made, are still not there.
        expect(existsSync(gone)).toBe(false);
        expect(existsSync(unmade.path)).toBe(false);
    });

    test('a worktree removed while it is watched ends no other watch and reads as unavailable afterwards', async () => {
        const { h, shop, project, folder, fsUrl } = await setup();
        const gone = join(dirname(shop), 'shop-watched');

        git(shop, 'worktree', 'add', '-q', '-b', 'watched', gone);

        const { id } = h.ok('chat.create', { projectId: project.id, workspace: { mode: 'existing', path: gone } }).chat.workspace as { id: string };
        const response = await h.fetch(fsUrl('watch', { folderId: folder.id, workspaceId: id }));
        const reader = new EventReader(response.body as ReadableStream<Uint8Array>);
        const inCheckout = new EventReader((await h.fetch(fsUrl('watch', { folderId: folder.id }))).body as ReadableStream<Uint8Array>);

        readers.push(reader, inCheckout);
        await new Promise(resolve => setTimeout(resolve, 400));
        rmSync(gone, { recursive: true, force: true });
        await new Promise(resolve => setTimeout(resolve, 400));

        expect((await h.fetch(fsUrl('list', { folderId: folder.id, workspaceId: id }))).status).toBe(503);
        expect((await h.fetch(fsUrl('list', { folderId: folder.id }))).status).toBe(200);
        writeFileSync(join(shop, 'still-watched.txt'), '1');
        expect(JSON.stringify(await inCheckout.next())).toContain('still-watched.txt');
    });
});

describe('terminals in a worktree', () => {
    test('starts in the worktree, says so, and is told apart from the folder\'s own terminals', async () => {
        const { h, started, project, folder, infraFolder, feature, tuning, tree, infraTree, shop } = await setup();
        const create = async (extra: Record<string, unknown>) => await (await h.fetch('/v1/terminals', { method: 'POST', body: JSON.stringify({ projectId: project.id, cols: 80, rows: 24, ...extra }) })).json() as TerminalInfo;
        const own = await create({ folderId: folder.id });
        const inTree = await create({ folderId: folder.id, workspaceId: feature.id });
        const below = await create({ folderId: folder.id, workspaceId: feature.id, path: 'src' });
        const other = await create({ folderId: infraFolder.id, workspaceId: tuning.id });

        expect(own.workspaceId).toBeUndefined();
        expect(own.cwd).toBe(realpathSync(shop));
        expect(inTree).toMatchObject({ folderId: folder.id, workspaceId: feature.id, cwd: realpathSync(tree) });
        expect(below).toMatchObject({ folderId: folder.id, workspaceId: feature.id, cwd: join(realpathSync(tree), 'src') });
        expect(other).toMatchObject({ folderId: infraFolder.id, workspaceId: tuning.id, cwd: realpathSync(infraTree) });
        expect(started.map(spec => spec.cwd)).toEqual([realpathSync(shop), realpathSync(tree), join(realpathSync(tree), 'src'), realpathSync(infraTree)]);

        const listed = await (await h.fetch(`/v1/terminals?projectId=${ project.id }`)).json() as TerminalInfo[];

        expect(listed.map(info => [info.folderId, info.workspaceId])).toEqual([[folder.id, undefined], [folder.id, feature.id], [folder.id, feature.id], [infraFolder.id, tuning.id]]);
    });

    test('refuses a worktree that is not the folder\'s, a path that leaves the worktree, and starts nothing', async () => {
        const { h, started, project, folder, feature, tuning, tree } = await setup();
        const create = (extra: Record<string, unknown>) => h.fetch('/v1/terminals', { method: 'POST', body: JSON.stringify({ projectId: project.id, cols: 80, rows: 24, ...extra }) });

        expect((await create({ folderId: folder.id, workspaceId: tuning.id })).status).toBe(404);
        expect((await create({ folderId: folder.id, workspaceId: feature.id, path: '../x' })).status).toBe(400);
        expect((await create({ folderId: folder.id, workspaceId: feature.id, path: 'nope' })).status).toBe(404);
        expect(existsSync(join(tree, 'nope'))).toBe(false);
        expect(started).toEqual([]);

        // A request for a worktree that was not judged is refused by the service itself, whoever calls it.
        expect(() => h.daemon.services.terminals.create(project, { projectId: project.id, folderId: folder.id, workspaceId: feature.id, cols: 80, rows: 24 })).toThrow('was not resolved');
        expect(started).toEqual([]);
    });
});

describe('the documents of a worktree', () => {
    test('are the worktree\'s own in place of its folder\'s checkout, and the other folders\' as before', async () => {
        const { h, base, folder, infraFolder, feature } = await setup();
        const docs = async (workspaceId?: string) => await (await h.fetch(`${ base }/docs${ workspaceId ? `?workspaceId=${ workspaceId }` : '' }`)).json() as DocsTree;
        const flat = (node: DocNode): string[] => (node.children ? node.children.flatMap(flat) : [node.path]);
        const pathsOf = (tree: DocsTree, folderId: string) => tree.find(entry => entry.folderId === folderId)?.sources.flatMap(source => source.nodes.flatMap(flat)).sort();
        const main = await docs();
        const there = await docs(feature.id);

        expect(pathsOf(main, folder.id)).toEqual(['main/notes.md', 'shared/plan.md']);
        expect(pathsOf(there, folder.id)).toEqual(['feature/plan.md', 'shared/plan.md']);
        expect(there.map(entry => entry.folderId)).toEqual([folder.id, infraFolder.id]);
        expect(there[1]).toEqual(main[1]);
        expect(pathsOf(there, infraFolder.id)).toEqual(['infra/plan.md']);
    });

    test('are those of the workspace\'s own folder when it is not the main one', async () => {
        const { h, base, folder, infraFolder, tuning, infraTree } = await setup();

        put(infraTree, { '.briefback/tuning/plan.md': '# Tuning\n' });

        const there = await (await h.fetch(`${ base }/docs?workspaceId=${ tuning.id }`)).json() as DocsTree;
        const names = (folderId: string) => JSON.stringify(there.find(entry => entry.folderId === folderId));

        expect(names(infraFolder.id)).toContain('tuning/plan.md');
        expect(names(folder.id)).not.toContain('tuning/plan.md');
        expect(names(folder.id)).toContain('main/notes.md');
    });
});

describe('the file names of a worktree', () => {
    test('are the worktree\'s own: a file only it has is found, one only the checkout has is not, and each list is kept apart', async () => {
        const { h, base, folder, feature } = await setup();
        const search = async (query: string, workspaceId?: string) => await (await h.fetch(`${ base }/files?query=${ query }&limit=50${ workspaceId ? `&workspaceId=${ workspaceId }` : '' }`)).json() as ProjectFileMatch[];
        const paths = (matches: ProjectFileMatch[]) => matches.map(match => `${ match.folderId === folder.id ? '' : 'infra:' }${ match.path }`).sort();

        // The checkout's list first, so that it is the cached one when the worktree's is asked for within the same few seconds.
        expect(paths(await search('main-only'))).toEqual(['main-only.txt']);
        expect(paths(await search('only-here'))).toEqual([]);
        expect(paths(await search('main-only', feature.id))).toEqual([]);
        expect(paths(await search('only-here', feature.id))).toEqual(['only-here.txt']);
        expect(paths(await search('main-only'))).toEqual(['main-only.txt']);
        expect(paths(await search('shared', feature.id))).toEqual(['.briefback/shared/plan.md', 'shared.txt']);

        // With several folders a path is matched under the folder's own name, never under the name of the worktree's directory.
        expect(paths(await search('shop/only-here', feature.id))).toEqual(['only-here.txt']);
        expect(paths(await search('shop-feature/only-here', feature.id))).toEqual([]);

        // The other folder's files are listed as before, and the answers carry the folder's id, never the workspace's.
        expect(paths(await search('plan', feature.id))).toEqual(['.briefback/feature/plan.md', '.briefback/shared/plan.md', 'infra:.briefback/infra/plan.md']);
        expect((await search('only-here', feature.id))[0]).toEqual({ folderId: folder.id, path: 'only-here.txt' });
    });
});

describe('the workspaces in the info of the projects', () => {
    test('reports each worktree of the project with what it has checked out, and of no other project', async () => {
        const { h, project, stranger, feature, tuning, theirs, tree } = await setup();
        const info = await (await h.fetch('/v1/projects/info')).json() as ProjectInfo[];
        const of = (projectId: string) => info.find(candidate => candidate.projectId === projectId)!;

        expect(of(project.id).workspaces).toEqual([
            { workspaceId: feature.id, exists: true, branch: 'feature' },
            { workspaceId: tuning.id, exists: true, branch: 'tuning' },
        ]);
        expect(of(stranger.id).workspaces).toEqual([{ workspaceId: theirs.id, exists: true, branch: 'theirs' }]);
        expect(await (await h.fetch(`/v1/projects/info?project=${ stranger.id }`)).json()).toEqual([of(stranger.id)]);

        // What the agent switched to is what is read, not what the chat was given.
        git(tree, 'switch', '-q', '-c', 'switched');
        expect(((await (await h.fetch(`/v1/projects/info?project=${ project.id }`)).json()) as ProjectInfo[])[0].workspaces?.[0]).toEqual({ workspaceId: feature.id, exists: true, branch: 'switched' });

        // A detached head is the short hash, flagged.
        git(tree, 'switch', '-q', '--detach');

        const detached = ((await (await h.fetch(`/v1/projects/info?project=${ project.id }`)).json()) as ProjectInfo[])[0].workspaces?.[0];

        expect(detached).toEqual({ workspaceId: feature.id, exists: true, branch: git(tree, 'rev-parse', '--short', 'HEAD'), detached: true });
    });

    test('says a worktree is not there while it is not made or when its folder is gone, and leaves `workspaces` out for a project with none', async () => {
        const { h, project, shop } = await setup();
        const { project: plain } = h.ok('project.add', { name: 'Plain', folders: [makeRepo(dirname(shop), 'plain')] });
        const unmade = h.ok('chat.create', { projectId: plain.id, workspace: { mode: 'new' } }).chat.workspace as { id: string };
        const info = async (projectId: string) => ((await (await h.fetch(`/v1/projects/info?project=${ projectId }`)).json()) as ProjectInfo[])[0];

        expect((await info(plain.id)).workspaces).toEqual([{ workspaceId: unmade.id, exists: false }]);

        const gone = join(dirname(shop), 'shop-info-gone');

        git(shop, 'worktree', 'add', '-q', '-b', 'info-gone', gone);

        const { id } = h.ok('chat.create', { projectId: project.id, workspace: { mode: 'existing', path: gone } }).chat.workspace as { id: string };

        rmSync(gone, { recursive: true, force: true });
        expect((await info(project.id)).workspaces).toContainEqual({ workspaceId: id, exists: false });

        const { project: bare } = h.ok('project.add', { name: 'Bare', folders: [makeRepo(dirname(shop), 'bare')] });

        expect('workspaces' in await info(bare.id)).toBe(false);
    });

    test('leaves out a worktree no chat works in any more', async () => {
        const { h, project, feature, tuning } = await setup();
        const infoOf = async () => ((await (await h.fetch(`/v1/projects/info?project=${ project.id }`)).json()) as ProjectInfo[])[0].workspaces?.map(entry => entry.workspaceId);

        expect(await infoOf()).toEqual([feature.id, tuning.id]);

        // Deleting the chat leaves the worktree's row where it is; nobody points at it then, and nobody can ask about it.
        for (const { id } of h.store.db.query('SELECT id FROM chats WHERE workspace_id = ?').all(feature.id) as Array<{ id: string }>) {
            h.ok('chat.delete', { chatId: id });
        }

        expect(await infoOf()).toEqual([tuning.id]);
    });

    test('is one entry for a worktree that several chats work in', async () => {
        const { h, project, tree, feature } = await setup();
        const again = h.ok('chat.create', { projectId: project.id, workspace: { mode: 'existing', path: tree } }).chat.workspace as { id: string };
        const info = (await (await h.fetch(`/v1/projects/info?project=${ project.id }`)).json()) as ProjectInfo[];

        expect(again.id).toBe(feature.id);
        expect(info[0].workspaces?.filter(entry => entry.workspaceId === feature.id)).toHaveLength(1);
    });
});

describe('the seam that takes a place', () => {
    test('refuses a place that is not the project\'s or the folder\'s, and a worktree named in a request that was not judged', async () => {
        const { h, project, stranger, folder, infraFolder, feature, theirs, tree } = await setup();
        const { fs, terminals } = h.daemon.services;
        const place = resolvePlace(h.store, project, folder.id, feature.id);
        const foreign = resolvePlace(h.store, stranger, stranger.folders[0].id, theirs.id);
        const mismatched = { ...place, path: join(tree, '..') };
        const asked = { folderId: folder.id, workspaceId: feature.id, query: 'x' };

        expect(await fs.list(project, place, '')).not.toEqual([]);
        await expect(fs.list(project, foreign, '')).rejects.toMatchObject({ code: 'not_found' });
        await expect(fs.list(stranger, place, '')).rejects.toMatchObject({ code: 'not_found' });
        await expect(fs.list(project, mismatched, '')).rejects.toMatchObject({ code: 'not_found' });
        await expect(fs.search(project, asked)).rejects.toMatchObject({ code: 'invalid' });
        await expect(fs.search(project, asked, undefined, folder.id)).rejects.toMatchObject({ code: 'invalid' });
        await expect(fs.search(project, { ...asked, workspaceId: 'wks_other' }, undefined, place)).rejects.toMatchObject({ code: 'invalid' });
        expect((await fs.search(project, asked, undefined, place)).files).toBeArray();

        const request = { projectId: project.id, folderId: folder.id, workspaceId: feature.id, cols: 80, rows: 24 };

        expect(() => terminals.create(project, request, foreign)).toThrow();
        expect(() => terminals.create(stranger, request, place)).toThrow();
        expect(() => terminals.create(project, { ...request, folderId: infraFolder.id }, place)).toThrow();
        expect(terminals.create(project, request, place)).toMatchObject({ folderId: folder.id, workspaceId: feature.id });
    });
});

describe('a worktree inside the main checkout', () => {
    test('is read as its own tree: its files only, and nothing above it', async () => {
        const { h, shop, folder, project, base, fsUrl, failure } = await setup();
        const nested = join(shop, 'worktrees', 'inner');

        git(shop, 'worktree', 'add', '-q', '-b', 'inner', nested);
        put(nested, { 'inside.txt': 'inside' });

        const { id } = h.ok('chat.create', { projectId: project.id, workspace: { mode: 'existing', path: nested } }).chat.workspace as { id: string };
        const listed = (await (await h.fetch(fsUrl('list', { folderId: folder.id, workspaceId: id }))).json() as FsEntry[]).map(entry => entry.path);

        expect(listed).toContain('inside.txt');
        expect(listed).not.toContain('main-only.txt');
        expect(listed.some(path => path.startsWith('worktrees'))).toBe(false);

        const above = await h.fetch(fsUrl('file', { folderId: folder.id, workspaceId: id, path: '../../main-only.txt' }));

        expect(above.status).toBe(400);
        expect((await failure(above)).details?.reason).toBe('outside');
        expect(await (await h.fetch(`${ base }/files?query=main-only&workspaceId=${ id }`)).json()).toEqual([]);
        expect(await (await h.fetch(`${ base }/files?query=inside&workspaceId=${ id }`)).json()).toEqual([{ folderId: folder.id, path: 'inside.txt' }]);
    });
});
