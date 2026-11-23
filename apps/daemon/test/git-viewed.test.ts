import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MAX_GIT_REVISION_LENGTH, MAX_GIT_VIEWED_MARKS, MAX_GIT_VIEWED_PATH_LENGTH, turnScope } from '@clowdy/protocol';

import { openDatabase } from '../src/db/connection';
import {
    clearViewed,
    countViewed,
    deleteViewedOfProject,
    deleteViewedOfWorkspace,
    deleteViewedOutsideFolders,
    listViewed,
    setViewed,
} from '../src/db/viewed';
import { snapshotTree } from '../src/git/snapshot';
import { checkRevision, viewedScopeKey } from '../src/git/viewed';
import { cleanTempDirs, git, makeRepo, startHarness, tempDir } from './helpers';

import type { GitChangedFile, GitChanges, GitScope, GitViewedMark } from '@clowdy/protocol';
import type { Place } from '../src/domain/places';
import type { Harness } from './helpers';

afterAll(cleanTempDirs);

const lines = (...text: string[]) => `${text.join('\n')}\n`;

/** Writes files (and the folders above them) under `root`. */
function put(root: string, files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }
}

/** Stages everything and commits it. */
function commit(path: string, message: string): string {
    git(path, 'add', '-A');
    git(path, 'commit', '-q', '-m', message);

    return git(path, 'rev-parse', 'HEAD');
}

const ORIGINAL = lines('a', 'b', 'c');

/**
 * A clone of a bare `origin` that has `main` and `dev`, on a branch `feature` that is one commit ahead of `origin/main` (it adds `feature.ts`), with `lib.ts` edited and
 * `scratch.txt` new: `all` lists `feature.ts`, `lib.ts` and `scratch.txt`, `branch` lists `feature.ts`, `uncommitted` lists `lib.ts` and `scratch.txt`.
 */
function work(): { root: string; work: string; featureCommit: string } {
    const root = tempDir('git-viewed');
    const origin = join(root, 'origin.git');
    const seed = makeRepo(root, 'seed');

    put(seed, { 'lib.ts': ORIGINAL, 'docs/readme.md': lines('# Readme') });
    commit(seed, 'Add the base files');
    git(root, 'init', '--bare', '-q', '-b', 'main', origin);
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-q', 'origin', 'main', 'main:dev');
    git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(root, 'clone', '-q', origin, 'work');

    const checkout = join(root, 'work');

    git(checkout, 'checkout', '-q', '-b', 'feature');
    put(checkout, { 'feature.ts': lines('export const feature = 1;') });

    const featureCommit = commit(checkout, 'Add the feature');

    put(checkout, { 'lib.ts': lines('a', 'B', 'c'), 'scratch.txt': lines('scratch') });

    return { root, work: checkout, featureCommit };
}

/** A worktree of `repo` on a new branch from `from`, with one commit of its own (`tree.ts`) and `lib.ts` edited. */
function worktree(repo: string, name = 'chat-tree', from = 'origin/main'): string {
    const tree = join(tempDir('git-viewed'), name);

    git(repo, 'worktree', 'add', '-q', '-b', name, tree, from);
    put(tree, { 'tree.ts': lines('export const tree = 1;'), 'lib.ts': lines('a', 'tree edit', 'c') });
    commit(tree, 'Work in the tree');
    put(tree, { 'lib.ts': lines('a', 'tree edit again', 'c') });

    return tree;
}

/** What the table holds, sorted. */
type Row = { workspace_id: string; scope_key: string; path: string; revision: string };

describe('over HTTP', () => {
    let h: Harness;

    beforeEach(async () => {
        h = await startHarness();
    });

    afterEach(async () => {
        await h.stop();
    });

    const json = async <T>(response: Response) => (await response.json()) as T;

    /** A project of the folders `paths`, and what a test asks of its places. */
    function open(...paths: string[]) {
        const { project } = h.ok('project.add', { name: 'Shop', folders: paths });
        const folderId = project.folders[0].id as string;
        const route = `/v1/projects/${project.id}/git`;
        const at = (extra: string, workspaceId?: string, folder = folderId) =>
            `?folderId=${folder}${workspaceId ? `&workspaceId=${workspaceId}` : ''}${extra}`;
        const changes = async (scope: string, workspaceId?: string): Promise<GitChangedFile[]> => {
            const answer = await json<Extract<GitChanges, { isRepository: true }>>(
                await h.fetch(`${route}/changes${at(`&scope=${scope}`, workspaceId)}`)
            );

            return answer.files;
        };
        const fileOf = async (scope: string, path: string, workspaceId?: string): Promise<GitChangedFile> => {
            const found = (await changes(scope, workspaceId)).find(file => file.path === path);

            if (!found) throw new Error(`${path} is not changed in ${scope}`);

            return found;
        };
        const marks = async (scope: string, workspaceId?: string, folder = folderId) =>
            json<GitViewedMark[]>(await h.fetch(`${route}/viewed${at(`&scope=${scope}`, workspaceId, folder)}`));
        const mark = (scope: string, path: string, revision: string, workspaceId?: string, folder = folderId) =>
            h.fetch(`${route}/viewed`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ folderId: folder, ...(workspaceId && { workspaceId }), scope, path, revision }),
            });
        const clear = (scope: string, path: string, workspaceId?: string) =>
            h.fetch(`${route}/viewed${at(`&scope=${scope}&path=${encodeURIComponent(path)}`, workspaceId)}`, {
                method: 'DELETE',
            });
        const rows = () =>
            h.store.db
                .query(
                    'SELECT workspace_id, scope_key, path, revision FROM viewed_files ORDER BY workspace_id, scope_key, path'
                )
                .all() as Row[];
        /** What the client does with a list and the marks: a file is viewed while its own revision is the one stored. */
        const viewed = (file: GitChangedFile, kept: GitViewedMark[]) =>
            kept.find(entry => entry.path === file.path)?.revision === file.revision;

        return { project, folderId, route, at, changes, fileOf, marks, mark, clear, rows, viewed };
    }

    test("keeps the revision a file was marked at, which holds across reads and is not the file's once it is edited, and is the file's again when the edit is undone", async () => {
        const { work: repo } = work();
        const { fileOf, marks, mark, rows, viewed, changes } = open(repo);
        const first = await fileOf('all', 'lib.ts');
        const answer = await mark('all', 'lib.ts', first.revision);

        expect(answer.status).toBe(200);
        expect(await json<GitViewedMark>(answer)).toEqual({ path: 'lib.ts', revision: first.revision });
        expect(await marks('all')).toEqual([{ path: 'lib.ts', revision: first.revision }]);

        // Two more reads of the list: the revision is the same, so the file is still viewed.
        for (let read = 0; read < 2; read++) {
            const again = await fileOf('all', 'lib.ts');

            expect(again.revision).toBe(first.revision);
            expect(viewed(again, await marks('all'))).toBe(true);
        }

        // The other files of the list were never marked.
        expect(
            (await changes('all'))
                .filter(file => viewed(file, [{ path: 'lib.ts', revision: first.revision }]))
                .map(file => file.path)
        ).toEqual(['lib.ts']);

        // An edit makes another revision; the daemon still holds what it was sent, and the comparison is false.
        put(repo, { 'lib.ts': lines('a', 'B', 'c', 'd') });

        const edited = await fileOf('all', 'lib.ts');

        expect(edited.revision).not.toBe(first.revision);
        expect(await marks('all')).toEqual([{ path: 'lib.ts', revision: first.revision }]);
        expect(viewed(edited, await marks('all'))).toBe(false);

        // The revision is the content's: putting the text back makes the mark hold again.
        put(repo, { 'lib.ts': lines('a', 'B', 'c') });
        expect((await fileOf('all', 'lib.ts')).revision).toBe(first.revision);
        expect(viewed(await fileOf('all', 'lib.ts'), await marks('all'))).toBe(true);

        // Marking it again at the new revision replaces the mark, in the same row.
        put(repo, { 'lib.ts': lines('a', 'B', 'c', 'd') });
        await mark('all', 'lib.ts', edited.revision);
        expect(await marks('all')).toEqual([{ path: 'lib.ts', revision: edited.revision }]);
        expect(rows()).toHaveLength(1);
    });

    test("holds a mark of a new, a renamed and a binary file while it is left alone and loses it when the file changes, and a commit's mark holds as the branch moves on", async () => {
        const { work: repo, featureCommit } = work();
        const { fileOf, marks, mark, viewed } = open(repo);

        git(repo, 'mv', 'docs/readme.md', 'docs/guide.md');
        writeFileSync(join(repo, 'logo.bin'), Buffer.from([0, 1, 2, 3]));

        const edits: Record<string, () => void> = {
            'scratch.txt': () => put(repo, { 'scratch.txt': lines('scratch', 'more') }),
            'docs/guide.md': () => put(repo, { 'docs/guide.md': lines('# Readme', 'more') }),
            'logo.bin': () => writeFileSync(join(repo, 'logo.bin'), Buffer.from([0, 1, 2, 4])),
        };

        expect(await fileOf('all', 'scratch.txt')).toMatchObject({ untracked: true });
        expect(await fileOf('all', 'docs/guide.md')).toMatchObject({ kind: 'renamed', oldPath: 'docs/readme.md' });
        expect(await fileOf('all', 'logo.bin')).toMatchObject({ untracked: true, binary: true });

        for (const [path, edit] of Object.entries(edits)) {
            const first = await fileOf('all', path);

            expect((await mark('all', path, first.revision)).status).toBe(200);
            // Read again with nothing touched: the same revision, so still viewed.
            expect(viewed(await fileOf('all', path), await marks('all'))).toBe(true);

            edit();

            const edited = await fileOf('all', path);

            expect(edited.revision).not.toBe(first.revision);
            expect(viewed(edited, await marks('all'))).toBe(false);
        }

        // A commit's files never change, so its mark holds when the branch gets another commit and the files of the work move on.
        const inCommit = await fileOf(`commit:${featureCommit}`, 'feature.ts');

        await mark(`commit:${featureCommit}`, 'feature.ts', inCommit.revision);
        put(repo, { 'lib.ts': lines('a', 'B', 'c', 'later') });
        commit(repo, 'Move on');
        expect(
            viewed(await fileOf(`commit:${featureCommit}`, 'feature.ts'), await marks(`commit:${featureCommit}`))
        ).toBe(true);
    });

    test("clears one file's mark and nothing else, and clearing a file that has none is not an error", async () => {
        const { work: repo } = work();
        const { fileOf, marks, mark, clear } = open(repo);
        const lib = await fileOf('all', 'lib.ts');
        const feature = await fileOf('all', 'feature.ts');

        await mark('all', 'lib.ts', lib.revision);
        await mark('all', 'feature.ts', feature.revision);
        // In path order, whatever order they were marked in.
        expect((await marks('all')).map(entry => entry.path)).toEqual(['feature.ts', 'lib.ts']);

        const cleared = await clear('all', 'lib.ts');

        expect(cleared.status).toBe(200);
        expect(await json<{ ok: true }>(cleared)).toEqual({ ok: true });
        expect(await marks('all')).toEqual([{ path: 'feature.ts', revision: feature.revision }]);
        expect((await clear('all', 'lib.ts')).status).toBe(200);
        expect((await clear('all', 'never-marked.ts')).status).toBe(200);
        expect(await marks('all')).toEqual([{ path: 'feature.ts', revision: feature.revision }]);
    });

    test('keeps the marks of each scope apart, under a key the daemon makes of the scope and the base, and a commit by its whole hash', async () => {
        const { work: repo, featureCommit } = work();
        const { folderId, route, fileOf, marks, mark, rows } = open(repo);
        const libAll = await fileOf('all', 'lib.ts');
        const featureBranch = await fileOf('branch', 'feature.ts');
        const libUncommitted = await fileOf('uncommitted', 'lib.ts');
        const featureInCommit = await fileOf(`commit:${featureCommit}`, 'feature.ts');

        await mark('all', 'lib.ts', libAll.revision);
        await mark('branch', 'feature.ts', featureBranch.revision);
        await mark('uncommitted', 'lib.ts', libUncommitted.revision);
        // A short hash names the same commit as the whole one.
        await mark(`commit:${featureCommit.slice(0, 9)}`, 'feature.ts', featureInCommit.revision);

        expect(rows().map(row => `${row.scope_key} ${row.path}`)).toEqual([
            'all:origin/main lib.ts',
            'branch:origin/main feature.ts',
            `commit:${featureCommit} feature.ts`,
            'uncommitted lib.ts',
        ]);
        expect(rows().every(row => row.workspace_id === '')).toBe(true);

        expect(await marks('all')).toEqual([{ path: 'lib.ts', revision: libAll.revision }]);
        expect(await marks('branch')).toEqual([{ path: 'feature.ts', revision: featureBranch.revision }]);
        expect(await marks('uncommitted')).toEqual([{ path: 'lib.ts', revision: libUncommitted.revision }]);
        expect(await marks(`commit:${featureCommit}`)).toEqual([
            { path: 'feature.ts', revision: featureInCommit.revision },
        ]);
        expect(await marks(`commit:${featureCommit.slice(0, 7)}`)).toEqual(await marks(`commit:${featureCommit}`));
        // The scope that is left out is `all`, as it is for the changes.
        expect(await json<GitViewedMark[]>(await h.fetch(`${route}/viewed?folderId=${folderId}`))).toEqual(
            await marks('all')
        );
    });

    test('holds a mark in the scope of a run for good: its key is the scope itself, its files never change, and another run has its own', async () => {
        const { work: repo } = work();
        const { fileOf, marks, mark, rows, viewed, clear } = open(repo);
        const first = await snapshotTree(repo);

        put(repo, { 'lib.ts': lines('a', 'edited by the first run', 'c') });

        const second = await snapshotTree(repo);

        put(repo, { 'lib.ts': lines('a', 'edited by the second run', 'c') });

        const third = await snapshotTree(repo);
        const run = turnScope(first as string, second as string);
        const other = turnScope(second as string, third as string);
        const lib = await fileOf(run, 'lib.ts');

        expect((await mark(run, 'lib.ts', lib.revision)).status).toBe(200);
        expect(rows()).toEqual([{ workspace_id: '', scope_key: run, path: 'lib.ts', revision: lib.revision }]);
        expect(viewed(lib, await marks(run))).toBe(true);
        // Another run has its own list and its own marks, and the same file there is not viewed.
        expect(await marks(other)).toEqual([]);
        expect(viewed(await fileOf(other, 'lib.ts'), await marks(other))).toBe(false);

        // The file is edited, committed and edited again: the run's list, and so the mark, is what it was.
        git(repo, 'add', '-A');
        git(repo, 'commit', '-q', '-m', 'Later work');
        put(repo, { 'lib.ts': lines('later') });
        expect(viewed(await fileOf(run, 'lib.ts'), await marks(run))).toBe(true);

        expect((await clear(run, 'lib.ts')).status).toBe(200);
        expect(await marks(run)).toEqual([]);
    });

    test("keeps a place's marks apart from another worktree's, another folder's and the checkout's of the same folder", async () => {
        const { root, work: repo } = work();
        const tree = worktree(repo);
        const other = makeRepo(root, 'other');
        const { project, folderId, marks, mark, fileOf, rows } = open(repo, other);
        const otherId = project.folders[1].id as string;
        const workspaceId = (
            h.ok('chat.create', { projectId: project.id, folderId, workspace: { mode: 'existing', path: tree } }).chat
                .workspace as { id: string }
        ).id;
        const libInCheckout = await fileOf('all', 'lib.ts');
        const libInTree = await fileOf('all', 'lib.ts', workspaceId);

        expect(libInTree.revision).not.toBe(libInCheckout.revision);
        await mark('all', 'lib.ts', libInCheckout.revision);
        await mark('all', 'lib.ts', libInTree.revision, workspaceId);
        await mark('all', 'lib.ts', 'a-revision', undefined, otherId);

        expect(await marks('all')).toEqual([{ path: 'lib.ts', revision: libInCheckout.revision }]);
        expect(await marks('all', workspaceId)).toEqual([{ path: 'lib.ts', revision: libInTree.revision }]);
        expect(await marks('all', undefined, otherId)).toEqual([{ path: 'lib.ts', revision: 'a-revision' }]);
        // The worktree has a mark of its own where the checkout has none.
        expect(await marks('branch', workspaceId)).toEqual([]);
        // The other folder has no remote: its base is its own `main`.
        expect(
            rows().map(row => `${row.workspace_id === '' ? 'checkout' : 'worktree'} ${row.scope_key} ${row.path}`)
        ).toEqual(['checkout all:main lib.ts', 'checkout all:origin/main lib.ts', 'worktree all:origin/main lib.ts']);
    });

    test('makes the key of the base the place is compared with, so a place that is compared with another base has its own marks, and gets them back with the first', async () => {
        const { work: repo } = work();
        const tree = worktree(repo);
        const { project, folderId, marks, mark, rows } = open(repo);
        const workspaceId = (
            h.ok('chat.create', { projectId: project.id, folderId, workspace: { mode: 'existing', path: tree } }).chat
                .workspace as { id: string }
        ).id;

        await mark('all', 'lib.ts', 'rev-on-main', workspaceId);
        await mark('branch', 'tree.ts', 'rev-branch-on-main', workspaceId);
        expect(rows().map(row => row.scope_key)).toEqual(['all:origin/main', 'branch:origin/main']);

        // The worktree's recorded base is another branch now (the repository has `origin/dev`).
        h.store.db.query('UPDATE workspaces SET base = ? WHERE id = ?').run('dev', workspaceId);
        expect(await marks('all', workspaceId)).toEqual([]);
        expect(await marks('branch', workspaceId)).toEqual([]);
        await mark('all', 'lib.ts', 'rev-on-dev', workspaceId);
        expect(await marks('all', workspaceId)).toEqual([{ path: 'lib.ts', revision: 'rev-on-dev' }]);
        expect(rows().map(row => row.scope_key)).toEqual(['all:origin/dev', 'all:origin/main', 'branch:origin/main']);

        // Back on the first base, the first marks are there as they were; `uncommitted` and a commit never had a base in their key.
        h.store.db.query('UPDATE workspaces SET base = ? WHERE id = ?').run('origin/main', workspaceId);
        expect(await marks('all', workspaceId)).toEqual([{ path: 'lib.ts', revision: 'rev-on-main' }]);
    });

    test('keeps the newest marks of a place, over its scopes, and no other place loses any', async () => {
        const { work: repo } = work();
        const tree = worktree(repo);
        const { project, folderId, marks, mark, rows } = open(repo);
        const workspaceId = (
            h.ok('chat.create', { projectId: project.id, folderId, workspace: { mode: 'existing', path: tree } }).chat
                .workspace as { id: string }
        ).id;
        const { db } = h.store;
        const insert = db.query(
            'INSERT INTO viewed_files (project_id, folder_id, workspace_id, scope_key, path, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );

        db.transaction(() => {
            // The checkout's place is full: half in one scope, half in another, the oldest first.
            for (let at = 1; at <= MAX_GIT_VIEWED_MARKS; at++) {
                insert.run(
                    project.id,
                    folderId,
                    '',
                    at % 2 === 0 ? 'uncommitted' : 'all:origin/main',
                    `old/file-${at}.ts`,
                    `rev-${at}`,
                    at
                );
            }

            for (let at = 1; at <= 10; at++) {
                insert.run(project.id, folderId, workspaceId, 'uncommitted', `old/file-${at}.ts`, `rev-${at}`, at);
            }
        })();

        expect(rows()).toHaveLength(MAX_GIT_VIEWED_MARKS + 10);

        const answer = await mark('uncommitted', 'lib.ts', 'rev-new');

        expect(answer.status).toBe(200);
        expect(rows().filter(row => row.workspace_id === '')).toHaveLength(MAX_GIT_VIEWED_MARKS);
        expect(rows().filter(row => row.workspace_id === workspaceId)).toHaveLength(10);

        const kept = await marks('uncommitted');

        expect(kept.find(entry => entry.path === 'lib.ts')).toEqual({ path: 'lib.ts', revision: 'rev-new' });
        // The one with the oldest time went (it was the first of `all`), the next oldest stays.
        expect((await marks('all')).some(entry => entry.path === 'old/file-1.ts')).toBe(false);
        expect(kept.some(entry => entry.path === 'old/file-2.ts')).toBe(true);
    });

    test("drops the marks of a worktree that is removed, with its row, and of a chat's worktree when its last chat is deleted, and leaves the checkout's", async () => {
        const { work: repo } = work();
        const tree = worktree(repo, 'removed-tree');
        const second = worktree(repo, 'chat-tree');
        const { project, folderId, marks, mark, rows, route, at } = open(repo);
        const opened = (
            h.ok('workspace.open', { projectId: project.id, folderId, path: tree }) as { workspace: { id: string } }
        ).workspace.id;
        const { chat } = h.ok('chat.create', {
            projectId: project.id,
            folderId,
            workspace: { mode: 'existing', path: second },
        });
        const chatsWorkspace = chat.workspace.id as string;

        await mark('uncommitted', 'lib.ts', 'rev-checkout');
        await mark('uncommitted', 'lib.ts', 'rev-removed', opened);
        await mark('branch', 'tree.ts', 'rev-removed-branch', opened);
        await mark('uncommitted', 'lib.ts', 'rev-chat', chatsWorkspace);
        expect(rows()).toHaveLength(4);

        // The tree is clean but for `lib.ts`, which the person may throw away; its commit stays on its branch.
        const result = await h.sendAsync('workspace.remove', {
            projectId: project.id,
            folderId,
            path: tree,
            discard: true,
        });

        expect(result.ok).toBe(true);
        expect(rows().map(row => `${row.workspace_id || 'checkout'} ${row.scope_key} ${row.path}`)).toEqual([
            'checkout uncommitted lib.ts',
            `${chatsWorkspace} uncommitted lib.ts`,
        ]);
        expect((await h.fetch(`${route}/viewed${at('&scope=branch', opened)}`)).status).toBe(404);

        h.ok('chat.delete', { chatId: chat.id });
        expect(rows().map(row => `${row.workspace_id || 'checkout'} ${row.scope_key} ${row.path}`)).toEqual([
            'checkout uncommitted lib.ts',
        ]);
        expect(await marks('uncommitted')).toEqual([{ path: 'lib.ts', revision: 'rev-checkout' }]);
    });

    test("drops the marks of a folder that leaves the project, with its worktrees', and of a project that is deleted", async () => {
        const { root, work: repo } = work();
        const other = makeRepo(root, 'other');
        const tree = worktree(other, 'other-tree', 'main');
        const { project, folderId, mark, rows } = open(repo, other);
        const otherId = project.folders[1].id as string;
        const workspaceId = (
            h.ok('chat.create', {
                projectId: project.id,
                folderId: otherId,
                workspace: { mode: 'existing', path: tree },
            }).chat.workspace as { id: string }
        ).id;

        await mark('uncommitted', 'lib.ts', 'rev-main');
        await mark('uncommitted', 'lib.ts', 'rev-other', undefined, otherId);
        await mark('uncommitted', 'lib.ts', 'rev-other-tree', workspaceId, otherId);
        expect(rows()).toHaveLength(3);

        h.ok('project.update', { projectId: project.id, folders: [{ id: folderId }] });
        expect(rows().map(row => row.revision)).toEqual(['rev-main']);

        h.ok('project.delete', { projectId: project.id });
        expect(rows()).toEqual([]);
    });

    test('refuses a scope that is none, a path or a revision that cannot be one, and writes nothing', async () => {
        const { work: repo } = work();
        const { fileOf, marks, mark, clear, rows, at, route } = open(repo);
        const { revision } = await fileOf('all', 'lib.ts');
        const statusOf = async (response: Promise<Response>) => (await response).status;

        // A scope that is none, or a commit that is not a hash: invalid; a commit the repository has not: not found.
        for (const scope of ['sideways', 'commit:abc', 'commit:main', 'All', '']) {
            expect(await statusOf(mark(scope, 'lib.ts', revision))).toBe(400);
        }

        expect(await statusOf(mark('commit:0123456789abcdef', 'lib.ts', revision))).toBe(404);
        expect((await h.fetch(`${route}/viewed${at('&scope=sideways')}`)).status).toBe(400);
        expect((await h.fetch(`${route}/viewed${at('&scope=commit:0123456789abcdef')}`)).status).toBe(404);
        expect((await clear('commit:0123456789abcdef', 'lib.ts')).status).toBe(404);

        // A path the file route would not take, and one too long.
        for (const path of [
            '',
            '/etc/passwd',
            '../lib.ts',
            'a/../b',
            'a//b',
            './lib.ts',
            'docs/',
            'a\u0000b',
            'x'.repeat(MAX_GIT_VIEWED_PATH_LENGTH + 1),
        ]) {
            expect(await statusOf(mark('all', path, revision))).toBe(400);
        }

        for (const path of ['', '..', 'docs/']) {
            expect((await clear('all', path)).status).toBe(400);
        }

        // A revision that is empty, long, or has a character a revision never has.
        for (const text of [
            '',
            'x'.repeat(MAX_GIT_REVISION_LENGTH + 1),
            'ABCDEF',
            'a b',
            'a;b',
            'a\nb',
            '$(id)',
            '../x',
            'é',
        ]) {
            expect(await statusOf(mark('all', 'lib.ts', text))).toBe(400);
        }

        // A body that is not the one asked for.
        const post = (body: string) => h.fetch(`${route}/viewed`, { method: 'POST', body });

        expect((await post('not json')).status).toBe(400);
        expect((await post('{}')).status).toBe(400);
        expect((await post(JSON.stringify({ folderId: 'x', scope: 'all', path: 'lib.ts', revision: 5 }))).status).toBe(
            400
        );
        expect(
            (
                await h.fetch(`${route}/viewed`, {
                    method: 'POST',
                    body: JSON.stringify({ scope: 'all', path: 'lib.ts', revision }),
                })
            ).status
        ).toBe(400);
        expect(
            (await h.fetch(`${route}/viewed${at('&scope=all')}`.replace(/folderId=[^&]*/, 'folderId='))).status
        ).toBe(400);

        expect(rows()).toEqual([]);
        expect(await marks('all')).toEqual([]);

        // The longest a path and a revision may be are taken.
        expect(await statusOf(mark('all', `${'a/'.repeat(MAX_GIT_VIEWED_PATH_LENGTH / 2 - 1)}b`, revision))).toBe(200);
        expect(await statusOf(mark('all', 'lib.ts', 'a'.repeat(MAX_GIT_REVISION_LENGTH)))).toBe(200);
        expect(await statusOf(mark('all', 'docs/readme.md', `100644:${'0'.repeat(64)}:100644:${'f'.repeat(64)}`))).toBe(
            200
        );
        expect(await statusOf(mark('all', 'docs/other.md', 'stat-120-1764000000000'))).toBe(200);
    });

    test('refuses a place that is not a repository, a folder, a worktree or a project that is not there, a worktree not made, and a request with no token', async () => {
        const { work: repo } = work();
        const plain = tempDir('git-viewed');
        const { project, folderId, mark, rows, route, at } = open(repo);
        const { project: plainProject } = h.ok('project.add', { name: 'Notes', folders: [plain] });
        const plainRoute = `/v1/projects/${plainProject.id}/git/viewed`;
        const plainAt = `?folderId=${plainProject.folders[0].id}&scope=all`;
        const body = (extra: Record<string, unknown> = {}) =>
            JSON.stringify({ folderId, scope: 'all', path: 'lib.ts', revision: 'abc', ...extra });
        const post = (path: string, payload: string) => h.fetch(path, { method: 'POST', body: payload });

        expect((await h.fetch(`${plainRoute}${plainAt}`)).status).toBe(400);
        expect(
            (
                await post(
                    plainRoute,
                    JSON.stringify({
                        folderId: plainProject.folders[0].id,
                        scope: 'all',
                        path: 'lib.ts',
                        revision: 'abc',
                    })
                )
            ).status
        ).toBe(400);
        expect((await h.fetch(`${plainRoute}${plainAt}&path=lib.ts`, { method: 'DELETE' })).status).toBe(400);

        expect((await h.fetch(`${route}/viewed`)).status).toBe(400);
        expect((await h.fetch(`${route}/viewed?folderId=fld_unknown&scope=all`)).status).toBe(404);
        expect((await post(`${route}/viewed`, body({ folderId: 'fld_unknown' }))).status).toBe(404);
        expect((await post(`${route}/viewed`, body({ workspaceId: 'wks_unknown' }))).status).toBe(404);
        expect((await h.fetch(`/v1/projects/prj_unknown/git/viewed${at('&scope=all')}`)).status).toBe(404);
        expect((await post('/v1/projects/prj_unknown/git/viewed', body())).status).toBe(404);
        expect(
            (await h.fetch(`/v1/projects/prj_unknown/git/viewed${at('&scope=all&path=lib.ts')}`, { method: 'DELETE' }))
                .status
        ).toBe(404);

        // A worktree of another project's folder is not this folder's place.
        const stranger = makeRepo(tempDir('git-viewed'), 'stranger');
        const strangerTree = join(tempDir('git-viewed'), 'stranger-tree');

        git(stranger, 'worktree', 'add', '-q', '-b', 'theirs', strangerTree);

        const { project: other } = h.ok('project.add', { name: 'Other', folders: [stranger] });
        const strangerId = (
            h.ok('chat.create', { projectId: other.id, workspace: { mode: 'existing', path: strangerTree } }).chat
                .workspace as { id: string }
        ).id;

        expect((await post(`${route}/viewed`, body({ workspaceId: strangerId }))).status).toBe(404);

        // A worktree that is not made yet or is gone from the disk is unavailable, as for the other reads.
        const tree = worktree(repo);
        const workspaceId = (
            h.ok('chat.create', { projectId: project.id, folderId, workspace: { mode: 'existing', path: tree } }).chat
                .workspace as { id: string }
        ).id;

        h.store.db.query('UPDATE workspaces SET ready = 0 WHERE id = ?').run(workspaceId);
        expect((await mark('all', 'lib.ts', 'abc', workspaceId)).status).toBe(503);
        h.store.db.query('UPDATE workspaces SET ready = 1 WHERE id = ?').run(workspaceId);
        rmSync(tree, { recursive: true });
        expect((await mark('all', 'lib.ts', 'abc', workspaceId)).status).toBe(503);
        expect((await h.fetch(`${route}/viewed${at('&scope=all', workspaceId)}`)).status).toBe(503);

        for (const method of ['GET', 'POST', 'DELETE']) {
            expect(
                (
                    await fetch(`${h.url}${route}/viewed${at('&scope=all&path=lib.ts')}`, {
                        method,
                        ...(method === 'POST' && { body: body() }),
                    })
                ).status
            ).toBe(401);
        }

        expect(rows()).toEqual([]);
    });
});

describe('the scope key', () => {
    /** A place at a checkout, as `resolvePlace` makes one for a folder. */
    const placeAt = (path: string, base?: string): Place => ({
        folder: { id: 'fld_test', path },
        path,
        ...(base !== undefined && {
            workspace: {
                id: 'wks_test',
                projectId: 'prj_test',
                folderId: 'fld_test',
                path,
                base,
                managed: false,
                ready: true,
                createdAt: 1,
            },
        }),
    });

    test('is the name of the base the compare picked for `all` and `branch`, so `main` that is ahead of `origin/main` is its own base, and nothing for `uncommitted`', async () => {
        const { work: repo, featureCommit } = work();

        expect(await viewedScopeKey(placeAt(repo), 'all')).toBe('all:origin/main');
        expect(await viewedScopeKey(placeAt(repo), 'branch')).toBe('branch:origin/main');
        expect(await viewedScopeKey(placeAt(repo), 'uncommitted')).toBe('uncommitted');
        expect(await viewedScopeKey(placeAt(repo), `commit:${featureCommit.slice(0, 8)}`)).toBe(
            `commit:${featureCommit}`
        );
        expect(await viewedScopeKey(placeAt(repo), 'all', { base: 'dev' })).toBe('all:origin/dev');
        expect(await viewedScopeKey(placeAt(repo, 'dev'), 'all')).toBe('all:origin/dev');

        // A run's scope is its own key, whatever the base is, with no git read of the trees: a place that has not got them still has a name for the marks.
        const run = turnScope('a'.repeat(40), 'b'.repeat(40));

        expect(await viewedScopeKey(placeAt(repo), run)).toBe(run);
        expect(await viewedScopeKey(placeAt(repo, 'dev'), run, { base: 'dev' })).toBe(run);

        // The local `main` has a commit `origin/main` has not: the compare takes it, as the changes read does.
        git(repo, 'branch', '-q', '-f', 'main', 'HEAD');
        expect(await viewedScopeKey(placeAt(repo, 'main'), 'all')).toBe('all:main');
    });

    test('is empty of a base when there is none to name (a branch with no commit), and is the branch itself in a repository that has no other', async () => {
        const unborn = tempDir('git-viewed');

        git(unborn, 'init', '-q', '-b', 'main');
        expect(await viewedScopeKey(placeAt(unborn), 'all')).toBe('all:');
        expect(await viewedScopeKey(placeAt(unborn), 'branch')).toBe('branch:');
        // Nothing is committed, so no commit scope has a commit to name.
        await expect(viewedScopeKey(placeAt(unborn), `commit:${'a'.repeat(40)}`)).rejects.toMatchObject({
            code: 'not_found',
        });

        const alone = makeRepo(tempDir('git-viewed'), 'alone');

        git(alone, 'checkout', '-q', '-b', 'topic');
        git(alone, 'branch', '-q', '-D', 'main');
        // The folder's base falls back to the branch that is checked out, and the work is compared with itself.
        expect(await viewedScopeKey(placeAt(alone), 'all')).toBe('all:topic');
    });

    test('checks a revision for the alphabet and the length of one', () => {
        expect(() => checkRevision('100644:' + 'a'.repeat(40) + ':100755:' + '0'.repeat(40))).not.toThrow();
        expect(() => checkRevision('stat-12-1764000000000')).not.toThrow();
        expect(() => checkRevision('')).toThrow();
        expect(() => checkRevision('A')).toThrow();
        expect(() => checkRevision('a'.repeat(MAX_GIT_REVISION_LENGTH + 1))).toThrow();
    });
});

describe('the table', () => {
    const place = { projectId: 'prj_1', folderId: 'fld_1', workspaceId: '' };

    test('replaces a mark, lists a scope in the order of the bytes of the paths, and clears one file', () => {
        const db = openDatabase(':memory:');

        setViewed(db, place, 'uncommitted', { path: 'b.ts', revision: 'r1' }, 1);
        setViewed(db, place, 'uncommitted', { path: 'B.ts', revision: 'r2' }, 2);
        setViewed(db, place, 'uncommitted', { path: 'a.ts', revision: 'r3' }, 3);
        setViewed(db, place, 'branch:origin/main', { path: 'a.ts', revision: 'r4' }, 4);
        setViewed(db, place, 'uncommitted', { path: 'b.ts', revision: 'r5' }, 5);

        expect(listViewed(db, place, 'uncommitted')).toEqual([
            { path: 'B.ts', revision: 'r2' },
            { path: 'a.ts', revision: 'r3' },
            { path: 'b.ts', revision: 'r5' },
        ]);
        expect(listViewed(db, place, 'branch:origin/main')).toEqual([{ path: 'a.ts', revision: 'r4' }]);
        expect(listViewed(db, place, 'all:origin/main')).toEqual([]);
        expect(countViewed(db, place)).toBe(4);

        clearViewed(db, place, 'uncommitted', 'a.ts');
        expect(listViewed(db, place, 'uncommitted').map(mark => mark.path)).toEqual(['B.ts', 'b.ts']);
        expect(listViewed(db, place, 'branch:origin/main')).toHaveLength(1);
        db.close();
    });

    test('keeps the newest marks of a place at the limit, a mark made again counts as new, and another place is not counted', () => {
        const db = openDatabase(':memory:');
        const worktree = { ...place, workspaceId: 'wks_1' };

        setViewed(db, worktree, 'uncommitted', { path: 'tree.ts', revision: 'rt' }, 1, 3);

        for (const [at, path] of ['one.ts', 'two.ts', 'three.ts'].entries())
            setViewed(db, place, 'uncommitted', { path, revision: `r${at}` }, 10 + at, 3);

        // Marked again, `one.ts` is the newest, so `two.ts` is the oldest when a fourth comes.
        setViewed(db, place, 'uncommitted', { path: 'one.ts', revision: 'r-again' }, 20, 3);
        setViewed(db, place, 'all:origin/main', { path: 'four.ts', revision: 'r4' }, 21, 3);

        expect(countViewed(db, place)).toBe(3);
        expect(listViewed(db, place, 'uncommitted').map(mark => mark.path)).toEqual(['one.ts', 'three.ts']);
        expect(listViewed(db, place, 'all:origin/main').map(mark => mark.path)).toEqual(['four.ts']);
        expect(countViewed(db, worktree)).toBe(1);
        db.close();
    });

    test('drops the marks of a worktree, of a project, and of the folders a project no longer has', () => {
        const db = openDatabase(':memory:');
        const tree = { ...place, workspaceId: 'wks_1' };
        const other = { ...place, folderId: 'fld_2' };
        const otherProject = { ...place, projectId: 'prj_2' };

        for (const target of [place, tree, other, otherProject])
            setViewed(db, target, 'uncommitted', { path: 'a.ts', revision: 'r' }, 1);

        deleteViewedOfWorkspace(db, 'wks_1');
        expect([place, tree, other, otherProject].map(target => countViewed(db, target))).toEqual([1, 0, 1, 1]);

        setViewed(db, { ...other, workspaceId: 'wks_2' }, 'uncommitted', { path: 'a.ts', revision: 'r' }, 1);
        deleteViewedOutsideFolders(db, 'prj_1', ['fld_1']);
        expect(
            [place, other, { ...other, workspaceId: 'wks_2' }, otherProject].map(target => countViewed(db, target))
        ).toEqual([1, 0, 0, 1]);

        deleteViewedOfProject(db, 'prj_1');
        expect([place, otherProject].map(target => countViewed(db, target))).toEqual([0, 1]);
        db.close();
    });

    test("never takes the checkout's marks for a worktree's: an empty worktree id drops nothing", () => {
        const db = openDatabase(':memory:');
        const tree = { ...place, workspaceId: 'wks_1' };

        setViewed(db, place, 'uncommitted', { path: 'a.ts', revision: 'r' }, 1);
        setViewed(db, tree, 'uncommitted', { path: 'a.ts', revision: 'r' }, 1);

        deleteViewedOfWorkspace(db, '');
        expect([place, tree].map(target => countViewed(db, target))).toEqual([1, 1]);
        deleteViewedOfWorkspace(db, 'wks_1');
        expect([place, tree].map(target => countViewed(db, target))).toEqual([1, 0]);
        db.close();
    });
});
