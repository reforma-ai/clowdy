import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { executeCommandAsync } from '../src/commands';
import { getChat } from '../src/db/chats';
import { getWorkspace, insertWorkspace } from '../src/db/workspaces';
import { cleanTempDirs, git, makeRepo, ScriptEngine, scriptEngines, startHarness, tempDir, waitFor } from './helpers';

import type {
    Chat,
    ChatWorkspace,
    CommandResult,
    CreatedWorktree,
    FolderWorktrees,
    Project,
    Run,
    WorktreeInfo,
} from '@clowdy/protocol';
import type { Harness, Script } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

const finishing: Script = async function* ({ number }) {
    yield { type: 'session', sessionId: `s${number}` };
    yield { type: 'text', delta: 'Done', done: false };
    yield { type: 'text', delta: '', done: true, messageId: `m${number}` };
    yield { type: 'done', result: 'Done' };
};

/** The place git writes for a path: the real one (`/var` is `/private/var` on a Mac), which is how `GET worktrees` writes a worktree's path; for a folder that is gone, its parent's. */
function real(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return join(realpathSync(dirname(path)), basename(path));
    }
}

/**
 * A daemon with a project of one repository, `shop-web` (a commit on `main`), and whatever folders a test adds. `worktrees` reads the route as the app does. Chats are made with a
 * script engine that finishes at once, so a chat on a new worktree has made it once `start` has run.
 */
async function setup(folders: string[] = []) {
    const engine = new ScriptEngine(finishing);
    const h = await startHarness({}, { engines: scriptEngines(engine) });

    harnesses.push(h);

    const root = tempDir('worktrees');
    const repo = makeRepo(root, 'shop-web');
    const { project } = h.ok('project.add', { name: 'Shop', folders: [repo, ...folders] }) as { project: Project };
    // The project keeps the real place of a folder (`/private/var/...` for `/var/...` on a Mac), which is the path of its own checkout's row.
    const folder = project.folders[0].path;
    const chatOf = (chatId: string) => getChat(h.store.db, chatId) as Chat;
    const make = async (workspace: unknown): Promise<Chat> =>
        ((await h.okAsync('chat.create', { projectId: project.id, workspace })) as { chat: Chat }).chat;
    const start = async (workspace: unknown = { mode: 'new' }): Promise<Chat> => {
        const chat = await make(workspace);

        h.ok('chat.send', { chatId: chat.id, text: 'Start' });
        await waitFor(() => {
            const run = chatOf(chat.id).orchestratorRunId
                ? h.run(chatOf(chat.id).orchestratorRunId as string)
                : undefined;

            return run?.status === 'succeeded' && (run as Run).finishedAt !== undefined;
        }, 'the turn to end');

        return chatOf(chat.id);
    };
    const worktrees = async (id = project.id): Promise<FolderWorktrees[]> => {
        const response = await h.fetch(`/v1/projects/${id}/worktrees`);

        expect(response.status).toBe(200);

        return (await response.json()) as FolderWorktrees[];
    };
    /** The rows of the first folder, which `shop-web` is. */
    const rows = async (): Promise<WorktreeInfo[]> => (await worktrees())[0].worktrees;
    const at = async (path: string): Promise<WorktreeInfo> => {
        const row = (await rows()).find(candidate => candidate.path === real(path));

        if (!row) throw new Error(`No row for ${path}`);

        return row;
    };
    /** A worktree made by hand, as a person or another tool does: `git worktree add` on a branch of its own (or on a detached HEAD), outside Clowdy's folder. */
    const found = (name: string, detach = false): string => {
        const path = join(root, name);

        git(repo, 'worktree', 'add', '-q', ...(detach ? ['--detach', path, 'main'] : ['-b', name, path]));

        return path;
    };

    /** `git worktree lock`, with the reason when there is one. */
    const lock = (path: string, reason?: string): void => {
        git(repo, 'worktree', 'lock', ...(reason === undefined ? [] : ['--reason', reason]), path);
    };

    return { h, root, repo, folder, project, chatOf, make, start, worktrees, rows, at, found, lock };
}

/** Commits a file in a worktree. */
function commit(path: string, file = 'work.txt', message = 'Work'): void {
    writeFileSync(join(path, file), `${message}\n`);
    git(path, 'add', file);
    git(path, 'commit', '-q', '-m', message);
}

test('creates a named checkout over HTTP, using the configured base and sharing it with a later chat', async () => {
    const { h, repo, project, at, rows, start } = await setup();
    const folderId = project.folders[0].id;

    git(repo, 'checkout', '-b', 'next');
    commit(repo, 'next-only');
    writeFileSync(join(repo, '.env'), 'LOCAL_TEST=1\n');
    h.ok('project.updateFolder', {
        projectId: project.id,
        folderId,
        settings: { baseBranch: 'next', setup: { files: ['.env'], command: 'git hash-object .env > ready.txt' } },
    });

    const create = async (requestId: string, branchName: string, folder = folderId) => {
        const response = await h.fetch('/v1/commands', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                requestId,
                type: 'workspace.create',
                projectId: project.id,
                folderId: folder,
                branchName,
            }),
        });

        return (await response.json()) as CommandResult<CreatedWorktree>;
    };

    const [first, second] = await Promise.all([create('create-next-1', 'next'), create('create-next-2', 'next')]);
    const created = first.ok ? first : second;
    const duplicate = first.ok ? second : first;

    expect(duplicate).toMatchObject({ ok: false, error: { code: 'conflict' } });
    if (!created.ok) throw new Error(created.error.message);

    const { path, branch } = created.data;

    expect(branch).toBe('clowdy/next');
    expect(await create(created.requestId, 'next')).toEqual(created);
    expect(await create('bad-name', '../next')).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await create('bad-folder', 'next', 'another-folder')).toMatchObject({
        ok: false,
        error: { code: 'invalid' },
    });
    expect(await rows()).toHaveLength(2);
    expect(git(repo, 'branch', '--show-current')).toBe('next');
    expect(git(path, 'branch', '--show-current')).toBe(branch);
    expect(git(path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(readFileSync(join(path, '.env'), 'utf8')).toBe('LOCAL_TEST=1\n');
    expect(readFileSync(join(path, 'ready.txt'), 'utf8').trim()).toBe(git(repo, 'hash-object', '.env'));
    expect(await at(path)).toMatchObject({ branch, chats: [], managed: true });
    expect(created.data.warning).toBeUndefined();
    const { workspace } = h.ok('workspace.open', { projectId: project.id, folderId, path }) as {
        workspace: ChatWorkspace;
    };

    const chat = await start({ mode: 'existing', path });

    expect(chat.workspace).toMatchObject({ id: workspace.id, path: real(path), branch, managed: true, ready: true });
    expect((await at(path)).chats.map(chat => chat.id)).toEqual([chat.id]);
});

test('keeps the checkout after a setup failure and retries setup in that same worktree on the first turn', async () => {
    const { h, repo, project, make, start } = await setup();
    const folderId = project.folders[0].id;
    const configure = (command: string) =>
        h.ok('project.updateFolder', { projectId: project.id, folderId, settings: { setup: { files: [], command } } });

    configure('exit 7');
    const result = (await executeCommandAsync(h.daemon.services, {
        requestId: 'standalone-failed-setup',
        type: 'workspace.create',
        projectId: project.id,
        folderId,
        branchName: 'retry-setup',
    })) as CommandResult<CreatedWorktree>;

    if (!result.ok) throw new Error(result.error.message);

    const { path, warning } = result.data;
    expect(warning).toContain('The setup command failed with exit code 7');
    const { workspace } = h.ok('workspace.open', { projectId: project.id, folderId, path }) as {
        workspace: ChatWorkspace;
    };
    expect(workspace).toMatchObject({ managed: true, ready: false });

    const abandoned = await make({ mode: 'existing', path });
    h.ok('chat.delete', { chatId: abandoned.id });

    configure('echo ready > ready.txt');
    const chat = await start({ mode: 'existing', path });

    expect(chat.workspace).toMatchObject({ id: workspace.id, managed: true, ready: true });
    expect(readFileSync(join(path, 'ready.txt'), 'utf8').trim()).toBe('ready');
    expect(git(repo, 'branch', '--show-current')).toBe('main');
    rmSync(join(path, 'ready.txt'));
    const removal = await h.fetch(`/v1/chats/${chat.id}/workspace`);
    expect(await removal.json()).toMatchObject({ removable: false, path });
});

test.skipIf(process.platform === 'win32')(
    'reports a completed checkout with a warning when its hook fails',
    async () => {
        const { h, repo, project, rows } = await setup();
        const hook = join(repo, '.git', 'hooks', 'post-checkout');

        writeFileSync(hook, '#!/bin/sh\necho "Setup hook failed" >&2\nexit 3\n');
        chmodSync(hook, 0o755);

        const result = await executeCommandAsync(h.daemon.services, {
            requestId: 'create-with-failing-hook',
            type: 'workspace.create',
            projectId: project.id,
            folderId: project.folders[0].id,
            branchName: 'hook',
            branchPrefix: 'team',
        });

        expect(result).toMatchObject({
            ok: true,
            data: { branch: 'team/hook', warning: expect.stringContaining('Setup hook failed') },
        });
        expect(await rows()).toContainEqual(expect.objectContaining({ branch: 'team/hook', missing: false }));
    }
);

test('can reuse a name reserved by an interrupted standalone checkout that never appeared on disk', async () => {
    const { h, root, project, rows } = await setup();
    const folderId = project.folders[0].id;
    const id = 'wks_interrupted';
    const branch = 'clowdy/retry';

    h.store.tx(() =>
        insertWorkspace(h.store.db, {
            id,
            projectId: project.id,
            folderId,
            branch,
            path: join(root, id.slice(-8), 'shop-web'),
            base: 'main',
            managed: true,
            ready: false,
            createdAt: Date.now(),
        })
    );

    expect(
        await executeCommandAsync(h.daemon.services, {
            requestId: 'retry-interrupted-create',
            type: 'workspace.create',
            projectId: project.id,
            folderId,
            branchName: 'retry',
        })
    ).toMatchObject({ ok: true, data: { branch } });
    expect(getWorkspace(h.store.db, id)).toBeUndefined();
    expect(await rows()).toContainEqual(expect.objectContaining({ branch, managed: true }));
});

describe('GET /v1/projects/:id/worktrees', () => {
    test("lists the folder's own checkout first, with its branch, clean, and nothing to remove or to compare with a base", async () => {
        const { rows, folder } = await setup();
        const [main, ...others] = await rows();

        expect(main).toEqual({
            path: folder,
            branch: 'main',
            head: git(folder, 'rev-parse', '--short=7', 'HEAD'),
            headOid: git(folder, 'rev-parse', 'HEAD'),
            main: true,
            missing: false,
            changes: 0,
            submodules: false,
            managed: false,
            chats: [],
            blocked: 'main',
        });
        expect(others).toEqual([]);
    });

    test('keeps the checkout first and counts its changes, a new file included', async () => {
        const { rows, folder } = await setup();

        writeFileSync(join(folder, 'README.md'), '# Changed\n');
        writeFileSync(join(folder, 'new.txt'), 'new\n');

        expect((await rows())[0]).toMatchObject({ main: true, changes: 2, blocked: 'main' });
    });

    test('lists a worktree somebody made by hand, with no record and no chats, and not blocked', async () => {
        const { at, found, project, h } = await setup();
        const path = found('by-hand');
        const row = await at(path);

        expect(row).toEqual({
            path: real(path),
            branch: 'by-hand',
            head: git(path, 'rev-parse', '--short=7', 'HEAD'),
            headOid: git(path, 'rev-parse', 'HEAD'),
            main: false,
            missing: false,
            changes: 0,
            submodules: false,
            // It starts from the commit `main` is on, so its work is in the base; a repository with no remote has its own `main` as the base.
            merged: true,
            base: 'main',
            managed: false,
            chats: [],
        });
        // Asking leaves no record behind: the dialog only reads.
        expect(h.store.db.query('SELECT COUNT(*) AS n FROM workspaces WHERE project_id = ?').get(project.id)).toEqual({
            n: 0,
        });
    });

    test('lists a worktree with its chats but blocks Remove only for unarchived chats', async () => {
        const { at, start, h, folder } = await setup();
        const first = await start();
        const record = first.workspace!;
        const second = await start({ mode: 'existing', path: record.path });
        const archived = await start({ mode: 'existing', path: record.path });

        h.ok('chat.setArchived', { chatId: archived.id, archived: true });

        const row = await at(record.path);

        expect(row).toMatchObject({
            branch: record.branch,
            managed: true,
            workspaceId: record.id,
            missing: false,
            changes: 0,
            merged: true,
            base: 'main',
            blocked: 'chats',
        });
        expect(row.chats).toEqual([
            { id: first.id, title: first.title, archived: false },
            { id: second.id, title: second.title, archived: false },
            { id: archived.id, title: archived.title, archived: true },
        ]);
        expect(await at(folder)).toMatchObject({ main: true, chats: [] });
        h.ok('chat.setArchived', { chatId: first.id, archived: true });
        h.ok('chat.setArchived', { chatId: second.id, archived: true });
        const archivedOnly = await at(record.path);

        expect(archivedOnly.blocked).toBeUndefined();
        expect(archivedOnly.chats).toEqual(row.chats.map(chat => ({ ...chat, archived: true })));
        h.ok('chat.setArchived', { chatId: archived.id, archived: false });
        expect((await at(record.path)).blocked).toBe('chats');
    });

    test('lists a Clowdy-made worktree nobody works in with its record and no block', async () => {
        const { at, start, h } = await setup();
        const chat = await start();

        h.store.db.query('UPDATE chats SET workspace_id = NULL WHERE id = ?').run(chat.id);

        const row = await at(chat.workspace!.path);

        expect(row).toMatchObject({ managed: true, workspaceId: chat.workspace!.id, chats: [] });
        expect(row.blocked).toBeUndefined();
    });

    test('says a locked worktree is locked, with the reason, and blocks it before its chats', async () => {
        const { at, found, start, h, lock } = await setup();
        const withReason = found('on-usb');
        const without = found('no-reason');

        lock(withReason, 'on a usb drive');
        lock(without);

        expect(await at(withReason)).toMatchObject({ locked: 'on a usb drive', blocked: 'locked', missing: false });
        expect(await at(without)).toMatchObject({ locked: '', blocked: 'locked' });

        // A lock outranks the chats that work in the worktree.
        const chat = await start();

        lock(chat.workspace!.path);
        h.ok('chat.setArchived', { chatId: chat.id, archived: true });

        expect(await at(chat.workspace!.path)).toMatchObject({
            locked: '',
            blocked: 'locked',
            chats: [{ id: chat.id, archived: true }],
        });
    });

    test('keeps a worktree whose folder was deleted, missing on disk, with the work it had', async () => {
        const { at, found, folder, rows } = await setup();
        const gone = found('gone');
        const kept = found('kept');

        commit(gone, 'lost.txt', 'Work that was not merged');
        rmSync(gone, { recursive: true, force: true });

        // It is still a worktree of the repository until git prunes it, so it is listed, with no files to read, and its branch is still judged.
        expect(await at(gone)).toMatchObject({
            branch: 'gone',
            missing: true,
            changes: 0,
            submodules: false,
            merged: false,
            base: 'main',
        });
        expect(await at(kept)).toMatchObject({ missing: false });
        expect((await rows()).map(row => row.path).sort()).toEqual([folder, real(gone), real(kept)].sort());
    });

    test('keeps a locked worktree whose folder is gone, both marks on it', async () => {
        const { at, found, lock } = await setup();
        const path = found('locked-gone');

        lock(path, 'moved');
        rmSync(path, { recursive: true, force: true });

        expect(await at(path)).toMatchObject({ missing: true, locked: 'moved', blocked: 'locked' });
    });

    test("counts the changed files of a dirty worktree, a new file and an untracked folder's file included", async () => {
        const { at, found } = await setup();
        const path = found('dirty');
        const clean = found('clean');

        writeFileSync(join(path, 'README.md'), '# Edited\n');
        writeFileSync(join(path, 'new.txt'), 'new\n');
        mkdirSync(join(path, 'docs'));
        writeFileSync(join(path, 'docs', 'a.md'), 'a\n');
        writeFileSync(join(path, 'docs', 'b.md'), 'b\n');

        // `--untracked-files=normal` shows a new folder as one entry, so the count is of what `git status` lists.
        expect(await at(path)).toMatchObject({ changes: 3 });
        expect(await at(clean)).toMatchObject({ changes: 0 });
    });

    test('does not count what .gitignore hides, and counts a staged change once', async () => {
        const { at, found } = await setup();
        const path = found('ignored');

        writeFileSync(join(path, '.gitignore'), 'build/\n');
        git(path, 'add', '.gitignore');
        git(path, 'commit', '-q', '-m', 'Ignore build output');
        mkdirSync(join(path, 'build'));
        writeFileSync(join(path, 'build', 'out.js'), 'x\n');
        writeFileSync(join(path, 'README.md'), '# Staged and changed again\n');
        git(path, 'add', 'README.md');
        writeFileSync(join(path, 'README.md'), '# Changed after staging\n');

        expect(await at(path)).toMatchObject({ changes: 1 });
    });

    test('keeps the record and the chats of a Clowdy-made worktree whose folder was deleted, though the record names its path through a link', async () => {
        const { at, start, rows, root, h } = await setup();
        const chat = await start();
        const record = chat.workspace!;
        // The record keeps the path as it was configured and git writes the real one: a link in the way (`/var` and `/private/var` on a Mac) must not part a gone worktree from its chats.
        const alias = join(root, 'alias');

        symlinkSync(realpathSync(dirname(record.path)), alias);
        h.store.db
            .query('UPDATE workspaces SET path = ? WHERE id = ?')
            .run(join(alias, basename(record.path)), record.id);
        rmSync(record.path, { recursive: true, force: true });

        const row = (await rows()).find(candidate => candidate.branch === record.branch);

        expect(row).toMatchObject({
            missing: true,
            managed: true,
            workspaceId: record.id,
            chats: [{ id: chat.id }],
            blocked: 'chats',
        });
        expect(row?.path).toBe(real(record.path));
        expect(await at(record.path)).toMatchObject({ workspaceId: record.id });
    });

    test('leaves out the git directory git names as the main entry when the repository keeps it apart from its checkout', async () => {
        const root = tempDir('worktrees-apart');
        const repo = join(root, 'apart');

        mkdirSync(repo);
        git(repo, 'init', '-q', '-b', 'main', '--separate-git-dir', join(root, 'apart.git'));
        writeFileSync(join(repo, 'a.txt'), 'a\n');
        git(repo, 'add', '.');
        git(repo, 'commit', '-q', '-m', 'Initial commit');
        git(repo, 'worktree', 'add', '-q', '-b', 'side', join(root, 'side'));

        const { worktrees } = await setup([repo]);
        const group = (await worktrees())[1];

        expect(group.isRepository).toBe(true);
        expect(group.worktrees.map(row => [row.path, row.main, row.missing])).toEqual([
            [real(repo), true, false],
            [real(join(root, 'side')), false, false],
        ]);
    });

    test('says nothing of merging for a worktree on a branch with no commit yet', async () => {
        const { at, repo, root } = await setup();
        const path = join(root, 'fresh');

        git(repo, 'worktree', 'add', '-q', '--orphan', '-b', 'fresh', path);

        const row = await at(path);

        expect(row).toMatchObject({ branch: 'fresh', head: '', missing: false, changes: 0 });
        expect(row.merged).toBeUndefined();
        expect(row.base).toBeUndefined();
    });

    test("compares with a remote branch as last fetched when that is the folder's default", async () => {
        const root = tempDir('worktrees-remote');
        const origin = makeRepo(root, 'origin');
        const clone = join(root, 'clone');
        const feat = join(root, 'feat');

        git(root, 'clone', '-q', origin, clone);
        git(clone, 'worktree', 'add', '-q', '-b', 'feat', feat, 'origin/main');

        const { worktrees } = await setup([clone]);
        const featRow = async () => (await worktrees())[1].worktrees.find(row => row.path === real(feat));

        expect(await featRow()).toMatchObject({ merged: true, base: 'origin/main' });

        commit(feat);

        expect(await featRow()).toMatchObject({ merged: false, base: 'origin/main' });
    });

    test('says whether the work of a worktree is in the base: not before it is merged, yes after', async () => {
        const { at, found, folder } = await setup();
        const path = found('feature');

        expect(await at(path)).toMatchObject({ merged: true });

        commit(path);

        expect(await at(path)).toMatchObject({ merged: false, base: 'main' });

        git(folder, 'merge', '-q', '--no-ff', '-m', 'Merge the work', 'feature');

        expect(await at(path)).toMatchObject({ merged: true });
    });

    test('reads a detached HEAD by its commit alone: merged at the base, not once it has commits of its own', async () => {
        const { at, found } = await setup();
        const path = found('detached', true);
        const row = await at(path);

        expect(row.branch).toBeUndefined();
        expect(row).toMatchObject({ merged: true, base: 'main', head: git(path, 'rev-parse', '--short=7', 'HEAD') });

        commit(path, 'detached.txt', 'Work on no branch');

        const after = await at(path);

        expect(after.branch).toBeUndefined();
        expect(after).toMatchObject({ merged: false, head: git(path, 'rev-parse', '--short=7', 'HEAD') });
    });

    test('compares with the base the worktree was made from, not the default one', async () => {
        const { at, start, folder, h } = await setup();

        git(folder, 'branch', 'dev');
        git(folder, 'checkout', '-q', 'dev');
        commit(folder, 'dev.txt', 'Work on dev');
        git(folder, 'checkout', '-q', 'main');

        const chat = await start({ mode: 'new', base: 'dev' });
        const row = await at(chat.workspace!.path);

        // Made from `dev`, so its work is in `dev` and not in `main`, the default.
        expect(row).toMatchObject({ merged: true, base: 'dev' });

        h.store.db.query('UPDATE workspaces SET base = ? WHERE id = ?').run('main', chat.workspace!.id);

        expect(await at(chat.workspace!.path)).toMatchObject({ merged: false, base: 'main' });
    });

    test('uses the folder base when the recorded base was deleted', async () => {
        const { at, start, h } = await setup();
        const chat = await start();

        h.store.db.query('UPDATE workspaces SET base = ? WHERE id = ?').run('deleted-branch', chat.workspace!.id);

        const row = await at(chat.workspace!.path);

        expect(row).toMatchObject({ merged: true, base: 'main' });
    });

    test('says an initialised submodule is checked out, so a plain removal would be refused', async () => {
        const { at, found } = await setup();
        const library = makeRepo(tempDir('worktrees-library'), 'library');
        const path = found('with-submodule');
        const plain = found('without');

        git(path, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'vendor/library');

        expect(await at(path)).toMatchObject({ submodules: true });
        expect(await at(plain)).toMatchObject({ submodules: false });
    });

    test("names a project's folders in its order: a repository, a plain folder, a folder that is gone, one a file replaced and one inside a repository", async () => {
        const root = tempDir('worktrees-folders');
        const plain = join(root, 'notes');
        const inside = join(makeRepo(root, 'other'), 'packages');
        const gone = join(root, 'gone');
        const replaced = join(root, 'replaced');

        mkdirSync(plain);
        mkdirSync(inside);
        mkdirSync(gone);
        mkdirSync(replaced);

        const { worktrees, project } = await setup([plain, inside, gone, replaced]);

        // Folders the project holds and the disk lost: one is gone, one is a file now. Neither stops the read of the others.
        rmSync(gone, { recursive: true });
        rmSync(replaced, { recursive: true });
        writeFileSync(replaced, 'now a file\n');

        const groups = await worktrees();

        expect(groups.map(group => [group.folderId, group.name, group.isRepository])).toEqual([
            [project.folders[0].id, 'shop-web', true],
            [project.folders[1].id, 'notes', false],
            [project.folders[2].id, 'packages', false],
            [project.folders[3].id, 'gone', false],
            [project.folders[4].id, 'replaced', false],
        ]);
        expect(groups.slice(1).every(group => group.worktrees.length === 0)).toBe(true);
    });

    test('lists every repository of the project, each with its own worktrees and its own base', async () => {
        const root = tempDir('worktrees-two');
        const api = makeRepo(root, 'shop-api');
        const { worktrees, found } = await setup([api]);
        const path = found('web-feature');

        git(api, 'branch', 'api-feature');
        git(api, 'worktree', 'add', '-q', join(root, 'api-feature'), 'api-feature');

        const [web, second] = await worktrees();

        expect(web.worktrees.map(row => row.path)).toContain(real(path));
        expect(second.worktrees.map(row => [row.main, row.branch])).toEqual([
            [true, 'main'],
            [false, 'api-feature'],
        ]);
        expect(second.worktrees.some(row => row.path === real(path))).toBe(false);
    });

    test("flags the repository's primary working tree, which git never removes, when the folder is a linked worktree", async () => {
        const root = tempDir('worktrees-linked');
        const primary = makeRepo(root, 'primary');
        const linked = join(root, 'linked');

        git(primary, 'worktree', 'add', '-q', '-b', 'linked', linked);

        const { worktrees } = await setup([linked]);
        const group = (await worktrees())[1];

        expect(group.isRepository).toBe(true);
        expect(group.worktrees[0]).toMatchObject({ path: real(linked), branch: 'linked', main: true, blocked: 'main' });
        expect(group.worktrees[1]).toMatchObject({ path: real(primary), branch: 'main', main: false, blocked: 'main' });
    });

    test("blocks the checkout of another folder of the project like the folder's own, though it is only a worktree of the same repository, and leaves a spare one free", async () => {
        const root = tempDir('worktrees-folders');
        const primary = makeRepo(root, 'primary');
        const second = join(root, 'second');
        const third = join(root, 'third');
        const spare = join(root, 'spare');

        for (const [name, path] of [
            ['second', second],
            ['third', third],
            ['spare', spare],
        ]) {
            git(primary, 'worktree', 'add', '-q', '-b', name, path);
        }

        const { worktrees } = await setup([second, third]);
        const [, group, other] = await worktrees();
        const blocked = (rows: WorktreeInfo[]) =>
            Object.fromEntries(rows.map(row => [basename(row.path), row.blocked ?? null]));

        expect(blocked(group.worktrees)).toEqual({ second: 'main', primary: 'main', third: 'main', spare: null });
        expect(blocked(other.worktrees)).toEqual({ third: 'main', primary: 'main', second: 'main', spare: null });
        expect(group.worktrees.find(row => row.path === real(third))?.main).toBe(false);
    });

    test("lists the worktrees that are ours above the others: Clowdy-made, with a chat, the repository's own tree; and one gone from the disk last", async () => {
        const { rows, start, found, repo } = await setup();
        const first = found('agent-first');
        const made = (await start()).workspace!;
        const withChat = found('worked-in');
        const gone = (await start()).workspace!;
        const last = found('agent-last');

        await start({ mode: 'existing', path: withChat });
        rmSync(gone.path, { recursive: true, force: true });

        const listed = git(repo, 'worktree', 'list', '--porcelain')
            .split('\n')
            .filter(line => line.startsWith('worktree '))
            .map(line => real(line.slice('worktree '.length)));
        const kind = (paths: string[]) => listed.filter(path => paths.map(real).includes(path));

        // The checkout of the folder, then ours (one Clowdy made, one a chat works in), then the ones nobody here made, and the one that is gone last; git's order within a kind.
        expect((await rows()).map(row => row.path)).toEqual([
            listed[0],
            ...kind([made.path, withChat]),
            ...kind([first, last]),
            real(gone.path),
        ]);
    });

    test('lists every worktree of a repository with many, in the order git lists them, though they are read a few at a time', async () => {
        const { rows, found, repo } = await setup();
        const names = Array.from({ length: 9 }, (_, index) => `many-${index}`);

        for (const name of names) found(name);

        const listed = git(repo, 'worktree', 'list', '--porcelain')
            .split('\n')
            .filter(line => line.startsWith('worktree '))
            .map(line => real(line.slice('worktree '.length)));

        expect(listed).toHaveLength(10);
        expect((await rows()).map(row => row.path)).toEqual(listed);
        expect(
            (await rows())
                .slice(1)
                .map(row => row.branch)
                .sort()
        ).toEqual([...names].sort());
    });

    test('is unavailable, not an empty answer, when git cannot be run', async () => {
        const { h, project } = await setup();
        const path = process.env.PATH;

        process.env.PATH = tempDir('worktrees-no-git');

        try {
            const response = await h.fetch(`/v1/projects/${project.id}/worktrees`);

            expect(response.status).toBe(503);
        } finally {
            process.env.PATH = path;
        }
    });

    test('answers not_found for a project that does not exist', async () => {
        const { h } = await setup();
        const response = await h.fetch('/v1/projects/prj_none/worktrees');

        expect(response.status).toBe(404);
    });
});
