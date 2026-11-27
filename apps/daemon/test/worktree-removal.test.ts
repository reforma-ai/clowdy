import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { getChat } from '../src/db/chats';
import { chatsOfWorkspace, listWorkspacesOfProject } from '../src/db/workspaces';
import { createChat } from '../src/domain/chats';
import { isBeingRemoved } from '../src/domain/workspaceRemoval';
import { exclusive, pathKey } from '../src/domain/workspaces';
import {
    cleanTempDirs,
    git,
    latch,
    makeRepo,
    ScriptEngine,
    scriptEngines,
    startHarness,
    tempDir,
    waitFor,
} from './helpers';

import type { Chat, ChatWorkspace, CommandResult, FolderWorktrees, Project, Run } from '@clowdy/protocol';
import type { Config } from '../src/config';
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

/** What a person could lose in the folder's own checkout, as it is: its commit, branch, status, branches and every tracked file. */
function mainState(repo: string): Record<string, string> {
    const files = git(repo, 'ls-files').split('\n').filter(Boolean);

    return {
        head: git(repo, 'rev-parse', 'HEAD'),
        branch: git(repo, 'branch', '--show-current'),
        // The names only: `git branch` marks a branch another worktree has checked out with a `+`, which comes and goes with the worktrees.
        branches: git(repo, 'branch', '--format=%(refname:short)'),
        status: git(repo, 'status', '--porcelain'),
        ...Object.fromEntries(files.map(file => [`file:${file}`, readFileSync(join(repo, file), 'utf8')])),
    };
}

/** Commits a file in a worktree and answers the commit. */
function commit(path: string, file = 'work.txt', message = 'Work'): string {
    writeFileSync(join(path, file), `${message}\n`);
    git(path, 'add', file);
    git(path, 'commit', '-q', '-m', message);

    return git(path, 'rev-parse', 'HEAD');
}

/**
 * A daemon with a project of one repository, `shop-web`, or of the folders `folders` builds (it is given the root and the repository to build them from). Chats are made with a
 * script engine that finishes at once, so a chat on a new worktree has made it once `start` has run. `remove` is `workspace.remove` as the app sends it.
 */
async function setup(
    options: { folders?: (root: string, repo: string) => string[]; script?: Script; config?: Partial<Config> } = {}
) {
    const engine = new ScriptEngine(options.script ?? finishing);
    const h = await startHarness(options.config, { engines: scriptEngines(engine) });

    harnesses.push(h);

    const root = tempDir('worktree-removal');
    const repo = makeRepo(root, 'shop-web');
    const { project } = h.ok('project.add', { name: 'Shop', folders: options.folders?.(root, repo) ?? [repo] }) as {
        project: Project;
    };
    const { store } = h;
    const folder = project.folders[0];
    const chatOf = (chatId: string) => getChat(store.db, chatId) as Chat;
    const runOf = (chatId: string) => h.run(chatOf(chatId).orchestratorRunId as string);
    const make = async (workspace: unknown): Promise<Chat> =>
        ((await h.okAsync('chat.create', { projectId: project.id, folderId: folder.id, workspace })) as { chat: Chat })
            .chat;
    const send = async (chat: Chat, text: string, until: Run['status'] = 'succeeded') => {
        const before = chatOf(chat.id).orchestratorRunId === undefined ? undefined : runOf(chat.id).finishedAt;

        h.ok('chat.send', { chatId: chat.id, text });
        await waitFor(() => {
            const run = chatOf(chat.id).orchestratorRunId ? runOf(chat.id) : undefined;

            return run?.status === until && run.finishedAt !== before;
        }, `the turn on "${text}" to end as ${until}`);

        return runOf(chat.id);
    };
    /** A chat on a new worktree whose first turn has made it. */
    const start = async (): Promise<Chat> => {
        const chat = await make({ mode: 'new' });

        await send(chat, 'Start');

        return chatOf(chat.id);
    };
    /** A worktree made by hand, as a person or another tool does: `git worktree add` on a branch of its own (or on a detached HEAD), outside Clowdy's folder. */
    const found = (name: string, detach = false): string => {
        const path = join(root, name);

        git(repo, 'worktree', 'add', '-q', ...(detach ? ['--detach', path, 'main'] : ['-b', name, path]));

        return path;
    };
    const remove = (
        path: string,
        fields: {
            discard?: boolean;
            deleteBranch?: boolean;
            expectedBranch?: { name: string; commit: string };
            chatDisposition?: 'archive' | 'delete';
            expectedChatIds?: string[];
            tidy?: boolean;
        } = {},
        folderId = folder.id
    ): Promise<CommandResult> => h.sendAsync('workspace.remove', { projectId: project.id, folderId, path, ...fields });
    const refusal = (result: CommandResult): { code: string; message: string } | undefined =>
        result.ok ? undefined : result.error;
    const hasBranch = (name: string) => git(repo, 'branch', '--list', name) !== '';
    const listed = (path: string) =>
        git(repo, 'worktree', 'list', '--porcelain').includes(
            `worktree ${realpathSync(dirname(path))}/${basename(path)}`
        );
    const rows = () => listWorkspacesOfProject(store.db, project.id);
    const worktrees = async (): Promise<FolderWorktrees[]> => {
        const response = await h.fetch(`/v1/projects/${project.id}/worktrees`);

        expect(response.status).toBe(200);

        return (await response.json()) as FolderWorktrees[];
    };

    return {
        h,
        engine,
        root,
        repo,
        project,
        folder,
        store,
        chatOf,
        runOf,
        make,
        send,
        start,
        found,
        remove,
        refusal,
        hasBranch,
        listed,
        rows,
        worktrees,
    };
}

describe('workspace.remove', () => {
    test('removes an unchanged merged worktree and its confirmed branch', async () => {
        const { repo, found, remove, hasBranch } = await setup();
        const path = found('confirmed');
        const tip = git(path, 'rev-parse', 'HEAD');
        const result = await remove(path, { deleteBranch: true, expectedBranch: { name: 'confirmed', commit: tip } });
        expect([result.ok, existsSync(path), hasBranch('confirmed'), git(repo, 'rev-parse', 'main')]).toEqual([
            true,
            false,
            false,
            tip,
        ]);
    });

    test('keeps a branch advanced after the worktree was removed', async () => {
        if (process.platform === 'win32') return;
        const { root, repo, found, remove } = await setup();
        const path = found('late');
        const tip = git(path, 'rev-parse', 'HEAD');
        const next = commit(repo, 'later.txt', 'Later');
        const bin = join(root, 'bin');
        mkdirSync(bin);
        writeFileSync(
            join(bin, 'git'),
            [
                '#!/bin/sh',
                'if [ "$1" = update-ref ] && [ "$2" = --no-deref ]; then',
                '  touch "$REMOVAL_TEST_GATE/ready"',
                '  while [ ! -f "$REMOVAL_TEST_GATE/go" ]; do sleep 0.02; done',
                'fi',
                'exec "$REMOVAL_TEST_GIT" "$@"',
            ].join('\n'),
            { mode: 0o755 }
        );
        const previousPath = process.env.PATH;
        process.env.REMOVAL_TEST_GIT = Bun.which('git')!;
        process.env.REMOVAL_TEST_GATE = bin;
        process.env.PATH = `${bin}:${previousPath}`;
        const removing = remove(path, { deleteBranch: true, expectedBranch: { name: 'late', commit: tip } });
        try {
            await waitFor(() => existsSync(join(bin, 'ready')), 'branch deletion to start');
            git(repo, 'update-ref', 'refs/heads/late', next, tip);
        } finally {
            writeFileSync(join(bin, 'go'), '');
            await removing;
            process.env.PATH = previousPath;
            delete process.env.REMOVAL_TEST_GIT;
            delete process.env.REMOVAL_TEST_GATE;
        }
        expect(await removing).toMatchObject({
            ok: false,
            error: {
                code: 'conflict',
                message: 'The worktree was removed, but the branch changed. The branch was kept',
            },
        });
        expect([existsSync(path), git(repo, 'rev-parse', 'late')]).toEqual([false, next]);
    });

    test('refuses a different checked-out branch after preview', async () => {
        const { repo, found, remove, hasBranch } = await setup();
        const path = found('original');
        const tip = git(path, 'rev-parse', 'HEAD');
        git(path, 'switch', '-q', '-c', 'other');
        const result = await remove(path, { deleteBranch: true, expectedBranch: { name: 'original', commit: tip } });
        expect([
            result.ok,
            existsSync(path),
            hasBranch('original'),
            hasBranch('other'),
            git(repo, 'rev-parse', 'other'),
        ]).toEqual([false, true, true, true, tip]);
    });

    test('refuses a symbolic branch without deleting its target', async () => {
        const { repo, found, remove, hasBranch } = await setup();
        const path = found('alias');
        const tip = git(path, 'rev-parse', 'HEAD');
        git(repo, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/main');
        const result = await remove(path, { deleteBranch: true, expectedBranch: { name: 'alias', commit: tip } });
        expect([result.ok, existsSync(path), hasBranch('alias'), git(repo, 'rev-parse', 'main')]).toEqual([
            false,
            true,
            true,
            tip,
        ]);
    });

    test('refuses a branch advanced after preview', async () => {
        const { repo, found, remove, hasBranch } = await setup();
        const path = found('advanced');
        const tip = git(path, 'rev-parse', 'HEAD');
        const advanced = commit(path);
        const result = await remove(path, { deleteBranch: true, expectedBranch: { name: 'advanced', commit: tip } });
        expect([
            result.ok,
            existsSync(path),
            hasBranch('advanced'),
            git(repo, 'rev-parse', 'advanced'),
            readFileSync(join(path, 'work.txt'), 'utf8'),
        ]).toEqual([false, true, true, advanced, 'Work\n']);
    });

    test("removes a clean worktree somebody else made, keeps its branch and its commits, and leaves the folder's own checkout as it was", async () => {
        const { repo, found, remove, listed, hasBranch, rows } = await setup();
        const path = found('feature');
        const tip = commit(path);
        const place = realpathSync(path);
        const before = mainState(repo);
        const result = await remove(path);

        expect(result).toMatchObject({ ok: true, data: { path: place, branchDeleted: false } });
        expect(existsSync(path)).toBe(false);
        expect(listed(path)).toBe(false);
        // The branch still names the commit, so nothing is lost.
        expect(hasBranch('feature')).toBe(true);
        expect(git(repo, 'rev-parse', 'feature')).toBe(tip);
        expect(mainState(repo)).toEqual(before);
        expect(rows()).toEqual([]);
    });

    test('deletes the branch too with deleteBranch, whether its work is merged or not, and only that branch', async () => {
        const { repo, found, remove, hasBranch } = await setup();
        const merged = found('merged');
        const unmerged = found('unmerged');
        const spare = found('spare');

        commit(merged, 'merged.txt');
        git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge the work', 'merged');
        commit(unmerged, 'unmerged.txt');

        const before = mainState(repo);

        expect(await remove(merged, { deleteBranch: true })).toMatchObject({ ok: true, data: { branchDeleted: true } });
        expect(hasBranch('merged')).toBe(false);
        expect(await remove(unmerged, { deleteBranch: true })).toMatchObject({
            ok: true,
            data: { branchDeleted: true },
        });
        expect(hasBranch('unmerged')).toBe(false);
        expect(existsSync(merged)).toBe(false);
        expect(existsSync(unmerged)).toBe(false);

        // The one that was not asked about keeps its tree and its branch, and the folder's checkout is as it was.
        expect(existsSync(spare)).toBe(true);
        expect(hasBranch('spare')).toBe(true);
        expect(mainState(repo)).toEqual({ ...before, branches: git(repo, 'branch', '--format=%(refname:short)') });
        expect(hasBranch('main')).toBe(true);
    });

    test('removes a worktree on a detached HEAD, and has no branch to delete', async () => {
        const { repo, found, remove, hasBranch } = await setup();
        const path = found('detached', true);

        expect(await remove(path, { deleteBranch: true })).toMatchObject({ ok: true, data: { branchDeleted: false } });
        expect(existsSync(path)).toBe(false);
        expect(hasBranch('main')).toBe(true);
        expect(git(repo, 'branch', '--show-current')).toBe('main');
    });

    test('says no to deleting a branch that another worktree has checked out, before anything is removed, and removes the worktree when the branch stays', async () => {
        const { repo, root, found, remove, refusal, hasBranch } = await setup();
        const first = found('shared');
        const second = join(root, 'shared-again');

        // Git allows the same branch in two worktrees only when it is forced.
        git(repo, 'worktree', 'add', '-q', '-f', second, 'shared');

        const result = await remove(first, { deleteBranch: true });

        expect(refusal(result)).toEqual({
            code: 'conflict',
            message: 'The branch shared is checked out in another worktree',
        });
        expect(existsSync(first)).toBe(true);
        expect(existsSync(second)).toBe(true);
        expect(hasBranch('shared')).toBe(true);
        expect((await remove(first)).ok).toBe(true);
        expect(existsSync(first)).toBe(false);
        expect(existsSync(second)).toBe(true);
        expect(hasBranch('shared')).toBe(true);
    });

    test('says that the worktree was removed when the branch cannot be deleted, leaves no row behind, and a repeat finds nothing to remove', async () => {
        const { repo, found, remove, refusal, hasBranch, rows } = await setup();
        const path = found('stuck');

        // A leftover lock of the branch's ref: git cannot take it to delete it.
        writeFileSync(join(repo, '.git', 'refs', 'heads', 'stuck.lock'), '');

        const result = await remove(path, { deleteBranch: true });

        expect(refusal(result)?.code).toBe('conflict');
        expect(refusal(result)?.message).toStartWith("The worktree was removed. Couldn't delete the branch:");
        expect(existsSync(path)).toBe(false);
        expect(hasBranch('stuck')).toBe(true);
        expect(rows()).toEqual([]);
        expect(refusal(await remove(path, { deleteBranch: true }))).toEqual({
            code: 'conflict',
            message: 'Git does not list it as a worktree of the folder',
        });
    });

    describe('what is changed in the tree', () => {
        test('is not thrown away without discard: a new file, a changed one, a staged one, a deleted one', async () => {
            const { repo, found, remove, refusal } = await setup();
            const path = found('busy');
            const changed = { code: 'conflict', message: 'The worktree has changes that are not committed' };

            commit(path, 'tracked.txt');

            const before = mainState(repo);

            writeFileSync(join(path, 'draft.txt'), 'new\n');
            expect(refusal(await remove(path))).toEqual(changed);
            rmSync(join(path, 'draft.txt'));

            writeFileSync(join(path, 'tracked.txt'), 'edited\n');
            expect(refusal(await remove(path))).toEqual(changed);
            git(path, 'add', 'tracked.txt');
            expect(refusal(await remove(path))).toEqual(changed);
            git(path, 'reset', '-q', '--hard');

            rmSync(join(path, 'tracked.txt'));
            expect(refusal(await remove(path))).toEqual(changed);
            expect(existsSync(path)).toBe(true);
            expect(mainState(repo)).toEqual(before);
        });

        test('goes with the tree when discard says so, and the branch stays with its commit', async () => {
            const { repo, found, remove, hasBranch } = await setup();
            const path = found('busy');
            const tip = commit(path);

            writeFileSync(join(path, 'draft.txt'), 'new\n');
            writeFileSync(join(path, 'work.txt'), 'edited\n');

            expect(await remove(path, { discard: true })).toMatchObject({ ok: true, data: { branchDeleted: false } });
            expect(existsSync(path)).toBe(false);
            expect(git(repo, 'rev-parse', 'busy')).toBe(tip);
            expect(hasBranch('busy')).toBe(true);
        });

        test('is not asked about when it is clean: discard on a clean tree removes it as it would without, and what .gitignore hides goes with the tree', async () => {
            const { found, remove } = await setup();
            const ignored = found('built');
            const clean = found('clean');

            writeFileSync(join(ignored, '.gitignore'), 'dist/\n');
            git(ignored, 'add', '.gitignore');
            git(ignored, 'commit', '-q', '-m', 'Ignore the build');
            mkdirSync(join(ignored, 'dist'));
            writeFileSync(join(ignored, 'dist', 'bundle.js'), 'built\n');
            expect(git(ignored, 'status', '--porcelain')).toBe('');
            expect((await remove(ignored)).ok).toBe(true);
            expect(existsSync(ignored)).toBe(false);
            expect((await remove(clean, { discard: true })).ok).toBe(true);
            expect(existsSync(clean)).toBe(false);
        });

        test('counts an initialised submodule, which git would refuse to remove, and removes it with discard', async () => {
            const { root, found, remove, refusal } = await setup();
            const library = makeRepo(root, 'library');
            const path = found('with-library');

            git(path, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'vendor/library');
            git(path, 'commit', '-q', '-m', 'Add the library');
            expect(git(path, 'status', '--porcelain')).toBe('');
            expect(refusal(await remove(path))).toEqual({
                code: 'conflict',
                message: 'The worktree has submodules checked out',
            });
            expect(existsSync(path)).toBe(true);
            expect(await remove(path, { discard: true })).toMatchObject({ ok: true });
            expect(existsSync(path)).toBe(false);
        });
    });

    test('does not take a status git cannot read for a clean tree: it is a change that only discard throws away', async () => {
        const { repo, found, remove, refusal } = await setup();
        const path = found('unreadable');

        // The worktree's own index is damaged: `git status` and `git worktree remove` both fail, `--force` does not read it.
        writeFileSync(join(repo, '.git', 'worktrees', 'unreadable', 'index'), 'garbage');
        expect(refusal(await remove(path))).toEqual({
            code: 'conflict',
            message: "Couldn't tell what is changed in the worktree",
        });
        expect(existsSync(path)).toBe(true);
        expect(await remove(path, { discard: true })).toMatchObject({ ok: true });
        expect(existsSync(path)).toBe(false);
    });

    describe('what is never removed', () => {
        test("the folder's own checkout, whatever discard and deleteBranch say, and what is in it", async () => {
            const { repo, folder, remove, refusal, hasBranch } = await setup();
            const own = { code: 'conflict', message: "That is the folder's own checkout" };

            writeFileSync(join(repo, 'wip.txt'), 'not committed\n');

            const before = mainState(repo);

            expect(refusal(await remove(folder.path))).toEqual(own);
            expect(refusal(await remove(folder.path, { discard: true, deleteBranch: true }))).toEqual(own);
            // The path as the test made it (`/var` where the project holds `/private/var` on a Mac) is the same place.
            expect(refusal(await remove(repo, { discard: true }))).toEqual(own);
            expect(readFileSync(join(repo, 'wip.txt'), 'utf8')).toBe('not committed\n');
            expect(hasBranch('main')).toBe(true);
            expect(mainState(repo)).toEqual(before);
        });

        test("the repository's primary working tree when the folder is a linked worktree of it, while a sibling worktree goes", async () => {
            const main = "That is the repository's main working tree";
            const { repo, root, folder, found, remove, refusal, hasBranch } = await setup({
                folders: (base, primary) => {
                    git(primary, 'worktree', 'add', '-q', '-b', 'linked', join(base, 'linked'));

                    return [join(base, 'linked')];
                },
            });
            const sibling = found('sibling');

            expect(folder.path).toBe(realpathSync(join(root, 'linked')));
            expect(refusal(await remove(repo))).toEqual({ code: 'conflict', message: main });
            expect(refusal(await remove(repo, { discard: true, deleteBranch: true }))).toEqual({
                code: 'conflict',
                message: main,
            });
            expect(refusal(await remove(join(root, 'linked')))).toEqual({
                code: 'conflict',
                message: "That is the folder's own checkout",
            });
            expect(existsSync(repo)).toBe(true);
            expect(hasBranch('main')).toBe(true);
            expect(await remove(sibling, { deleteBranch: true })).toMatchObject({
                ok: true,
                data: { branchDeleted: true },
            });
            expect(existsSync(sibling)).toBe(false);
        });

        test("another folder of the project, even when it is a worktree of the folder's own repository", async () => {
            const { root, remove, refusal, hasBranch } = await setup({
                folders: (base, primary) => {
                    git(primary, 'worktree', 'add', '-q', '-b', 'second-folder', join(base, 'second-folder'));

                    return [primary, join(base, 'second-folder')];
                },
            });
            const second = join(root, 'second-folder');

            expect(refusal(await remove(second, { discard: true, deleteBranch: true }))).toEqual({
                code: 'conflict',
                message: 'That is another folder of the project',
            });
            expect(existsSync(second)).toBe(true);
            expect(hasBranch('second-folder')).toBe(true);
        });

        test('a worktree that holds another worktree, which .gitignore keeps out of its status and git would delete with it, until the inner one is gone', async () => {
            const { found, remove, refusal, hasBranch } = await setup();
            const outer = found('outer');
            const inner = join(outer, 'inner');
            const nested = {
                code: 'conflict',
                message: 'Another worktree or a folder of the project is inside this one',
            };

            writeFileSync(join(outer, '.gitignore'), 'inner/\n');
            git(outer, 'add', '.gitignore');
            git(outer, 'commit', '-q', '-m', 'Ignore the inner worktree');
            git(outer, 'worktree', 'add', '-q', '-b', 'inner', inner);
            writeFileSync(join(inner, 'wip.txt'), 'not committed\n');
            // The outer tree looks clean, so nothing but this check stands between the removal and the inner one's work.
            expect(git(outer, 'status', '--porcelain')).toBe('');

            expect(refusal(await remove(outer))).toEqual(nested);
            expect(refusal(await remove(outer, { discard: true, deleteBranch: true }))).toEqual(nested);
            expect(readFileSync(join(inner, 'wip.txt'), 'utf8')).toBe('not committed\n');
            expect(hasBranch('outer')).toBe(true);

            expect((await remove(inner, { discard: true })).ok).toBe(true);
            expect((await remove(outer, { deleteBranch: true })).ok).toBe(true);
            expect(existsSync(outer)).toBe(false);
            expect(hasBranch('outer')).toBe(false);
        });

        test('a worktree that holds another folder of the project', async () => {
            const { root, remove, refusal } = await setup({
                folders: (base, primary) => {
                    const outer = join(base, 'outer');

                    git(primary, 'worktree', 'add', '-q', '-b', 'outer', outer);
                    writeFileSync(join(outer, '.gitignore'), 'vendor/\n');
                    git(outer, 'add', '.gitignore');
                    git(outer, 'commit', '-q', '-m', 'Ignore the vendored repository');

                    return [primary, makeRepo(join(outer, 'vendor'), 'library')];
                },
            });
            const outer = join(root, 'outer');

            expect(git(outer, 'status', '--porcelain')).toBe('');
            expect(refusal(await remove(outer, { discard: true }))).toEqual({
                code: 'conflict',
                message: 'Another worktree or a folder of the project is inside this one',
            });
            expect(existsSync(join(outer, 'vendor', 'library', 'README.md'))).toBe(true);
        });

        test('a locked worktree, discard or not, until it is unlocked', async () => {
            const { repo, found, remove, refusal, hasBranch } = await setup();
            const path = found('locked');
            const locked = { code: 'conflict', message: 'The worktree is locked' };

            git(repo, 'worktree', 'lock', '--reason', 'on a removable disk', path);
            writeFileSync(join(path, 'wip.txt'), 'not committed\n');
            expect(refusal(await remove(path))).toEqual(locked);
            expect(refusal(await remove(path, { discard: true, deleteBranch: true }))).toEqual(locked);
            expect(readFileSync(join(path, 'wip.txt'), 'utf8')).toBe('not committed\n');
            expect(hasBranch('locked')).toBe(true);

            git(repo, 'worktree', 'unlock', path);
            expect(await remove(path, { discard: true })).toMatchObject({ ok: true });
            expect(existsSync(path)).toBe(false);
        });

        test('a worktree is blocked by unarchived chats but can be removed with archived chats still linked', async () => {
            const { h, store, found, make, remove, refusal, rows } = await setup();
            const path = found('in-use');
            const chat = await make({ mode: 'existing', path });
            const second = await make({ mode: 'existing', path });
            const works = { code: 'conflict', message: 'The chat "Fix the cart" works in this worktree' };

            h.ok('chat.rename', { chatId: chat.id, title: 'Fix the cart' });
            expect(refusal(await remove(path, { discard: true }))).toEqual(works);

            h.ok('chat.setArchived', { chatId: chat.id, archived: true });
            expect(refusal(await remove(path))).toEqual({
                code: 'conflict',
                message: `The chat "${second.title}" works in this worktree`,
            });
            expect(existsSync(path)).toBe(true);

            h.ok('chat.setArchived', { chatId: second.id, archived: true });
            expect((await remove(path)).ok).toBe(true);
            expect(existsSync(path)).toBe(false);
            expect(chatsOfWorkspace(store.db, chat.workspace!.id)).toEqual([chat.id, second.id]);
            expect(isBeingRemoved(store, chat.workspace!.id)).toBe(false);
            h.ok('chat.delete', { chatId: chat.id });
            h.ok('chat.delete', { chatId: second.id });
            expect(rows()).toEqual([]);
        });

        test('a path git does not list for the folder, and what that path holds is left alone', async () => {
            const { root, repo, found, remove, refusal, rows } = await setup();
            const path = found('listed');
            const stranger = makeRepo(root, 'stranger');
            const elsewhere = join(root, 'elsewhere');
            const notListed = { code: 'conflict', message: 'Git does not list it as a worktree of the folder' };

            git(stranger, 'worktree', 'add', '-q', '-b', 'other', elsewhere);
            writeFileSync(join(elsewhere, 'wip.txt'), 'not committed\n');

            expect(refusal(await remove(elsewhere, { discard: true }))).toEqual(notListed);
            expect(refusal(await remove(stranger, { discard: true }))).toEqual(notListed);
            expect(refusal(await remove(join(path, 'nested'), { discard: true }))).toEqual(notListed);
            expect(refusal(await remove(join(root, 'nothing-here'), { discard: true }))).toEqual(notListed);
            expect(readFileSync(join(elsewhere, 'wip.txt'), 'utf8')).toBe('not committed\n');
            expect(existsSync(path)).toBe(true);
            expect(existsSync(repo)).toBe(true);
            expect(rows()).toEqual([]);
        });

        test('agrees with the route: what it blocks is refused and the rest is removed', async () => {
            const { repo, found, make, remove, worktrees } = await setup();
            const free = found('free');
            const locked = found('locked');
            const used = found('used');

            git(repo, 'worktree', 'lock', locked);
            await make({ mode: 'existing', path: used });

            const [group] = await worktrees();
            const verdicts = await Promise.all(
                group.worktrees.map(async row => ({
                    name: basename(row.path),
                    blocked: row.blocked,
                    ok: (await remove(row.path)).ok,
                }))
            );

            expect(Object.fromEntries(verdicts.map(({ name, blocked }) => [name, blocked ?? null]))).toEqual({
                'shop-web': 'main',
                free: null,
                locked: 'locked',
                used: 'chats',
            });

            for (const { blocked, ok } of verdicts) {
                expect(ok).toBe(blocked === undefined);
            }

            expect(existsSync(free)).toBe(false);
            expect(existsSync(locked)).toBe(true);
            expect(existsSync(used)).toBe(true);
        });
    });

    describe('what is asked', () => {
        test('is refused for a path that is not absolute, a folder the project does not have, a folder that is no repository or is gone, and no row is made', async () => {
            const { h, project, root, found, remove, refusal, rows } = await setup();
            const path = found('feature');
            const plain = join(root, 'plain');

            expect(refusal(await remove('feature'))).toEqual({
                code: 'invalid',
                message: 'The path of a worktree must be absolute',
            });
            expect(refusal(await remove(path, {}, 'fld_nowhere'))).toEqual({
                code: 'invalid',
                message: `Folder fld_nowhere does not belong to project ${project.id}`,
            });
            expect(
                refusal(await h.sendAsync('workspace.remove', { projectId: 'prj_missing', folderId: 'f', path }))?.code
            ).toBe('not_found');

            mkdirSync(plain);

            const { project: other } = h.ok('project.add', { name: 'Plain', folders: [plain] }) as { project: Project };
            const ask = () =>
                h.sendAsync('workspace.remove', { projectId: other.id, folderId: other.folders[0].id, path });

            expect(refusal(await ask())).toEqual({
                code: 'invalid',
                message: 'A worktree needs the root of a git repository, and this folder is not one',
            });
            rmSync(plain, { recursive: true });
            expect(refusal(await ask())?.code).toBe('invalid');
            expect(existsSync(path)).toBe(true);
            expect(rows()).toEqual([]);
        });

        test("is a command that waits for git: run without waiting it refuses rather than act, and over HTTP the answer is the removal's", async () => {
            const { h, project, folder, found } = await setup();
            const path = found('over-http');
            const sync = h.send('workspace.remove', { projectId: project.id, folderId: folder.id, path });

            expect(sync).toMatchObject({
                ok: false,
                error: { code: 'internal', message: expect.stringContaining('executeCommandAsync') },
            });
            expect(existsSync(path)).toBe(true);

            const response = await h.fetch('/v1/commands', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    requestId: 'http-remove',
                    type: 'workspace.remove',
                    projectId: project.id,
                    folderId: folder.id,
                    path,
                    deleteBranch: true,
                }),
            });

            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({
                ok: true,
                data: { path: join(realpathSync(dirname(path)), 'over-http'), branchDeleted: true },
            });
            expect(existsSync(path)).toBe(false);
        });

        test('answers a repeat of a request it has answered with the same answer, and does not act twice', async () => {
            const { h, project, folder, found } = await setup();
            const path = found('twice');
            const { executeCommandAsync } = await import('../src/commands');
            const asked = {
                requestId: 'remove-twice',
                type: 'workspace.remove' as const,
                projectId: project.id,
                folderId: folder.id,
                path,
            };
            const first = await executeCommandAsync(h.daemon.services, asked);
            const again = await executeCommandAsync(h.daemon.services, asked);

            expect(first).toMatchObject({ ok: true });
            expect(again).toEqual(first);
        });

        test('goes one at a time for one worktree: two removals of it at once, one removes it and the other says git does not list it, and none stays marked', async () => {
            const { h, store, project, found, remove, hasBranch } = await setup();
            const path = found('contended');
            const { workspace } = h.ok('workspace.open', { projectId: project.id, path }) as {
                workspace: ChatWorkspace;
            };
            const results = await Promise.all([
                remove(path, { deleteBranch: true }),
                remove(path, { deleteBranch: true }),
            ]);

            expect(results.filter(result => result.ok)).toHaveLength(1);
            expect(results.find(result => !result.ok)).toMatchObject({
                error: { code: 'conflict', message: 'Git does not list it as a worktree of the folder' },
            });
            expect(hasBranch('contended')).toBe(false);
            expect(existsSync(path)).toBe(false);
            expect(isBeingRemoved(store, workspace.id)).toBe(false);
        });
    });

    describe('a worktree whose folder is gone', () => {
        test('has its own record removed and no other stale record of the repository, and the branch stays unless it is asked to go', async () => {
            const { repo, root, found, remove, hasBranch, worktrees } = await setup();
            const first = found('stale-one');
            const second = found('stale-two');
            const third = found('stale-three');

            rmSync(first, { recursive: true });
            rmSync(second, { recursive: true });
            rmSync(third, { recursive: true });

            const records = () => readdirSync(join(repo, '.git', 'worktrees')).sort();
            const listing = () => git(repo, 'worktree', 'list', '--porcelain');
            const place = realpathSync(root);

            expect(records()).toEqual(['stale-one', 'stale-three', 'stale-two']);
            expect((await worktrees())[0].worktrees.filter(row => row.missing)).toHaveLength(3);

            expect(await remove(first)).toMatchObject({ ok: true, data: { branchDeleted: false } });
            // `git worktree prune` would have forgotten all three.
            expect(records()).toEqual(['stale-three', 'stale-two']);
            expect(listing()).toContain(`worktree ${place}/stale-two`);
            expect(listing()).toContain(`worktree ${place}/stale-three`);
            expect(listing()).not.toContain('stale-one');
            expect(hasBranch('stale-one')).toBe(true);

            expect(await remove(second, { deleteBranch: true })).toMatchObject({
                ok: true,
                data: { branchDeleted: true },
            });
            expect(records()).toEqual(['stale-three']);
            expect(hasBranch('stale-two')).toBe(false);
            expect(hasBranch('stale-three')).toBe(true);
            expect((await worktrees())[0].worktrees.filter(row => row.missing).map(row => basename(row.path))).toEqual([
                'stale-three',
            ]);
        });

        test('is still refused when it is locked or a chat points at it, and a path git never listed is not one', async () => {
            const { repo, root, found, make, remove, refusal } = await setup();
            const locked = found('gone-locked');
            const used = found('gone-used');

            await make({ mode: 'existing', path: used });
            git(repo, 'worktree', 'lock', locked);
            rmSync(locked, { recursive: true });
            rmSync(used, { recursive: true });

            expect(refusal(await remove(locked))).toEqual({ code: 'conflict', message: 'The worktree is locked' });
            expect(refusal(await remove(used))?.message).toContain('works in this worktree');
            expect(refusal(await remove(join(root, 'never-existed')))).toEqual({
                code: 'conflict',
                message: 'Git does not list it as a worktree of the folder',
            });
            expect(readdirSync(join(repo, '.git', 'worktrees')).sort()).toEqual(['gone-locked', 'gone-used']);
        });

        test('takes the row of a worktree the new-chat page opened with it', async () => {
            const { h, project, found, remove, rows } = await setup();
            const path = found('opened');

            h.ok('workspace.open', { projectId: project.id, path });
            expect(rows()).toHaveLength(1);
            rmSync(path, { recursive: true });
            expect((await remove(path)).ok).toBe(true);
            expect(rows()).toEqual([]);
        });
    });

    describe('a worktree Clowdy made', () => {
        test('is removed by its path once no chat has it, with its branch, and the folders it leaves empty go with it', async () => {
            const { h, repo, start, remove, refusal, hasBranch, rows } = await setup();
            const chat = await start();
            const { path, branch } = chat.workspace!;
            const slug = join(h.config.workspacesDir, 'shop');

            expect(refusal(await remove(path, { deleteBranch: true }))?.message).toContain('works in this worktree');
            expect(existsSync(path)).toBe(true);

            // A plain delete leaves the worktree and its branch: the removal by path is what takes them now.
            h.ok('chat.delete', { chatId: chat.id });
            expect(rows()).toEqual([]);
            expect(existsSync(path)).toBe(true);
            expect(hasBranch(branch!)).toBe(true);

            const before = mainState(repo);

            expect(await remove(path, { deleteBranch: true })).toMatchObject({
                ok: true,
                data: { branchDeleted: true },
            });
            expect(existsSync(path)).toBe(false);
            expect(hasBranch(branch!)).toBe(false);
            expect(existsSync(slug)).toBe(false);
            expect(existsSync(h.config.workspacesDir)).toBe(true);
            expect(mainState(repo)).toEqual({ ...before, branches: git(repo, 'branch', '--format=%(refname:short)') });
        });

        test('removes an archived chat’s managed worktree and branch without deleting the chat', async () => {
            const { h, start, remove, hasBranch, chatOf, worktrees } = await setup();
            const chat = await start();
            const { path, branch } = chat.workspace!;

            h.ok('chat.setArchived', { chatId: chat.id, archived: true });
            const [group] = await worktrees();
            expect(group.worktrees.find(row => row.workspaceId === chat.workspace!.id)?.blocked).toBeUndefined();
            expect(await remove(path, { deleteBranch: true })).toMatchObject({
                ok: true,
                data: { branchDeleted: true },
            });
            expect(existsSync(path)).toBe(false);
            expect(hasBranch(branch!)).toBe(false);
            expect(chatOf(chat.id).archivedAt).toBeDefined();
        });

        test('is removed by the real path the list shows when the workspaces folder is written through a link, and the folders it leaves empty go all the same', async () => {
            const target = tempDir('workspaces-target');
            const link = join(tempDir('workspaces-link'), 'workspaces');

            symlinkSync(target, link);

            const { h, start, remove, hasBranch } = await setup({ config: { workspacesDir: link } });
            const chat = await start();
            const { path, branch } = chat.workspace!;

            // The list writes the place git does, not the link the row was made through.
            const place = realpathSync(path);

            h.ok('chat.delete', { chatId: chat.id });
            expect(path.startsWith(link)).toBe(true);
            expect(place.startsWith(realpathSync(target))).toBe(true);
            expect(await remove(place, { deleteBranch: true })).toMatchObject({
                ok: true,
                data: { path: place, branchDeleted: true },
            });
            expect(existsSync(path)).toBe(false);
            expect(hasBranch(branch!)).toBe(false);
            expect(readdirSync(target)).toEqual([]);
        });

        test('keeps what is committed and not merged when only the tree goes: the branch names it', async () => {
            const { h, repo, start, remove, hasBranch } = await setup();
            const chat = await start();
            const { path, branch } = chat.workspace!;
            const tip = commit(path, 'unmerged.txt');

            h.ok('chat.delete', { chatId: chat.id });
            expect(await remove(path)).toMatchObject({ ok: true, data: { branchDeleted: false } });
            expect(existsSync(path)).toBe(false);
            expect(hasBranch(branch!)).toBe(true);
            expect(git(repo, 'rev-parse', branch!)).toBe(tip);
        });
    });

    describe('with a turn', () => {
        test('keeps a turn out of the tree while the removal waits for its place, and the removal says no once a chat works there: the worktree and the branch stay and the turn goes on in it', async () => {
            const { h, engine, store, project, repo, found, remove, refusal, send, make, runOf, hasBranch } =
                await setup();
            const path = found('contested');
            const { workspace } = h.ok('workspace.open', { projectId: project.id, path }) as {
                workspace: ChatWorkspace;
            };
            const gate = latch();
            const before = mainState(repo);
            // Something else holds the line the removal and the turn's own `Prepare workspace` share, as another turn making the worktree would.
            const holding = exclusive(store, pathKey(workspace.path), undefined, () => gate.wait());
            const turns = engine.turns.length;
            const removing = remove(path, { discard: true, deleteBranch: true });

            // The row is marked before anything is waited for.
            expect(isBeingRemoved(store, workspace.id)).toBe(true);

            // The removal takes its place on the line before the chat that picks the worktree starts its turn.
            await new Promise(resolve => setTimeout(resolve, 100));

            const chat = await make({ mode: 'existing', path });

            expect(chat.workspace!.id).toBe(workspace.id);

            const turn = send(chat, 'Go on');

            // The turn waits behind the removal and does not open its session.
            await new Promise(resolve => setTimeout(resolve, 100));
            expect(engine.turns).toHaveLength(turns);
            expect(isBeingRemoved(store, workspace.id)).toBe(true);

            gate.release();
            await holding;

            const result = await removing;

            await turn;
            expect(refusal(result)?.code).toBe('conflict');
            expect(refusal(result)?.message).toContain('works in this worktree');
            expect(isBeingRemoved(store, workspace.id)).toBe(false);
            expect(existsSync(path)).toBe(true);
            expect(hasBranch('contested')).toBe(true);
            expect(engine.turns).toHaveLength(turns + 1);
            expect(realpathSync(engine.turns.at(-1)!.cwd!)).toBe(realpathSync(path));
            expect(runOf(chat.id).status).toBe('succeeded');
            expect(mainState(repo)).toEqual(before);
        });

        test('removes a worktree no chat picked while it waited, and a chat made after it finds the worktree gone', async () => {
            const { h, store, project, found, remove, make } = await setup();
            const path = found('quiet');
            const { workspace } = h.ok('workspace.open', { projectId: project.id, path }) as {
                workspace: ChatWorkspace;
            };
            const gate = latch();
            const holding = exclusive(store, pathKey(workspace.path), undefined, () => gate.wait());
            const removing = remove(path, { deleteBranch: true });

            expect(isBeingRemoved(store, workspace.id)).toBe(true);
            gate.release();
            await holding;
            expect(await removing).toMatchObject({ ok: true, data: { branchDeleted: true } });
            expect(isBeingRemoved(store, workspace.id)).toBe(false);
            expect(existsSync(path)).toBe(false);
            await expect(make({ mode: 'existing', path })).rejects.toThrow('is not a worktree of this repository');
        });
    });
});

describe('explicit worktree disposition', () => {
    test.each(['archive', 'delete'] as const)(
        '%s affects linked chats and their descendants once, preserving unrelated chats and branches',
        async disposition => {
            const { h, store, project, repo, start, make, found, send, remove, chatOf, hasBranch } = await setup();
            const root = await start();
            const path = root.workspace!.path;
            const shared = await make({ mode: 'existing', path });
            const descendant = createChat(store, {
                projectId: project.id,
                parentChatId: root.id,
                workspaceId: root.workspace!.id,
            });
            const otherPath = found('other-tree');
            const unrelated = await make({ mode: 'existing', path: otherPath });
            const remoteThread = createChat(store, {
                projectId: project.id,
                parentChatId: descendant.id,
                workspaceId: unrelated.workspace!.id,
            });
            await send(shared, 'Shared history');
            h.ok('chat.setArchived', { chatId: root.id, archived: true });
            const originalArchive = chatOf(root.id).archivedAt;
            h.ok('chat.setArchived', { chatId: remoteThread.id, archived: false });
            const before = mainState(repo);
            const result = await remove(path, {
                chatDisposition: disposition,
                expectedChatIds: [remoteThread.id, root.id, shared.id, descendant.id],
            });

            expect(result).toMatchObject({ ok: true, data: { branchDeleted: false } });
            expect(existsSync(path)).toBe(false);
            expect(existsSync(otherPath)).toBe(true);
            expect(hasBranch(root.workspace!.branch!)).toBe(true);
            expect(mainState(repo)).toEqual(before);
            const affected = [root, shared, descendant, remoteThread].map(chat => getChat(store.db, chat.id));
            if (disposition === 'archive') {
                expect(affected).toEqual([
                    expect.objectContaining({ archivedAt: originalArchive, orchestratorRunId: root.orchestratorRunId }),
                    expect.objectContaining({
                        archivedAt: expect.any(Number),
                        orchestratorRunId: chatOf(shared.id).orchestratorRunId,
                    }),
                    expect.objectContaining({ archivedAt: expect.any(Number) }),
                    expect.objectContaining({ archivedAt: expect.any(Number) }),
                ]);
                expect(h.run(root.orchestratorRunId!).status).toBe('succeeded');
            } else {
                expect(affected).toEqual([undefined, undefined, undefined, undefined]);
            }
            expect(chatOf(unrelated.id).archivedAt).toBeUndefined();
        }
    );

    test.each(['archive', 'delete'] as const)(
        '%s refuses dirty or locked trees with chat history intact',
        async disposition => {
            const { h, repo, start, remove, chatOf } = await setup();
            const chat = await start();
            const path = chat.workspace!.path;
            const before = chatOf(chat.id);
            writeFileSync(join(path, 'unsaved.txt'), 'unsaved');
            expect(await remove(path, { chatDisposition: disposition })).toMatchObject({
                ok: false,
                error: { code: 'conflict' },
            });
            expect(chatOf(chat.id)).toEqual(before);
            expect(readFileSync(join(path, 'unsaved.txt'), 'utf8')).toBe('unsaved');
            git(repo, 'worktree', 'lock', path);
            expect(await remove(path, { chatDisposition: disposition, discard: true })).toMatchObject({
                ok: false,
                error: { code: 'conflict' },
            });
            expect(chatOf(chat.id)).toEqual(before);
            expect(h.run(chat.orchestratorRunId!).status).toBe('succeeded');
            expect(existsSync(path)).toBe(true);
        }
    );

    test.each(['archive', 'delete'] as const)(
        '%s refuses an active descendant in a different workspace',
        async disposition => {
            const gate = latch();
            const script: Script = async function* ({ number, signal }) {
                yield { type: 'session', sessionId: `s${number}` };
                if (number === 2) await gate.wait(signal);
                yield { type: 'done', result: 'Done' };
            };
            const { h, store, project, start, found, make, runOf, remove, chatOf } = await setup({ script });
            const chat = await start();
            const otherPath = found('active-other');
            const other = await make({ mode: 'existing', path: otherPath });
            const thread = createChat(store, {
                projectId: project.id,
                parentChatId: chat.id,
                workspaceId: other.workspace!.id,
            });
            h.ok('chat.send', { chatId: thread.id, text: 'Working' });
            try {
                await waitFor(() => runOf(thread.id).status === 'running', 'the descendant to run');
                expect(await remove(chat.workspace!.path, { chatDisposition: disposition })).toMatchObject({
                    ok: false,
                    error: { code: 'conflict' },
                });
                expect([
                    chatOf(chat.id).archivedAt,
                    chatOf(thread.id).archivedAt,
                    existsSync(chat.workspace!.path),
                    existsSync(otherPath),
                ]).toEqual([undefined, undefined, true, true]);
            } finally {
                gate.release();
            }
        }
    );

    test.each(['archive', 'delete'] as const)(
        '%s keeps history if Git fails during tree removal',
        async disposition => {
            if (process.platform === 'win32' || process.getuid?.() === 0) return;
            const { h, start, remove, chatOf, hasBranch } = await setup();
            const chat = await start();
            const { path, branch } = chat.workspace!;
            const folder = join(path, 'locked');
            mkdirSync(folder);
            writeFileSync(join(folder, 'file.txt'), 'x');
            git(path, 'add', 'locked');
            git(path, 'commit', '-qm', 'A folder');
            chmodSync(folder, 0o555);
            try {
                expect(await remove(path, { chatDisposition: disposition, deleteBranch: true })).toMatchObject({
                    ok: false,
                    error: { code: 'conflict' },
                });
                expect([chatOf(chat.id).archivedAt, h.run(chat.orchestratorRunId!).status, hasBranch(branch!)]).toEqual(
                    [undefined, 'succeeded', true]
                );
            } finally {
                chmodSync(folder, 0o755);
            }
        }
    );

    test('delete includes archived-only linked chats', async () => {
        const { h, store, start, remove } = await setup();
        const chat = await start();
        h.ok('chat.setArchived', { chatId: chat.id, archived: true });
        expect(await remove(chat.workspace!.path, { chatDisposition: 'delete' })).toMatchObject({ ok: true });
        expect(getChat(store.db, chat.id)).toBeUndefined();
    });

    test('blocks restore, delete, new attachments and turns while Git is removing an explicitly disposed tree', async () => {
        if (process.platform === 'win32') return;
        const activeParent = latch();
        const script: Script = async function* ({ number, signal }) {
            yield { type: 'session', sessionId: `s${number}` };
            if (number > 1) await activeParent.wait(signal);
            yield { type: 'done', result: 'Done' };
        };
        const { h, root, project, start, remove, chatOf, runOf } = await setup({ script });
        const chat = await start();
        const path = chat.workspace!.path;
        h.ok('chat.setArchived', { chatId: chat.id, archived: true });
        const before = chatOf(chat.id);
        const { chat: parent } = h.ok('chat.create', { projectId: project.id }) as { chat: Chat };
        h.ok('chat.send', { chatId: parent.id, text: 'Parent in main checkout' });
        const bin = join(root, 'bin');
        mkdirSync(bin);
        // Pause only the real Git mutation, not the preflight reads. All other Git calls pass through.
        writeFileSync(
            join(bin, 'git'),
            [
                '#!/bin/sh',
                'if [ "$3" = worktree ] && [ "$4" = remove ]; then',
                '  touch "$REMOVAL_TEST_GATE/ready"',
                '  while [ ! -f "$REMOVAL_TEST_GATE/go" ]; do sleep 0.02; done',
                'fi',
                'exec "$REMOVAL_TEST_GIT" "$@"',
            ].join('\n'),
            { mode: 0o755 }
        );
        const environment = { ...process.env };
        process.env.REMOVAL_TEST_GIT = Bun.which('git')!;
        process.env.REMOVAL_TEST_GATE = bin;
        process.env.PATH = `${bin}:${environment.PATH}`;

        const removing = remove(path, { chatDisposition: 'archive' });
        try {
            await waitFor(() => existsSync(join(bin, 'ready')), 'Git removal to start');
            await waitFor(() => runOf(parent.id).status === 'running', 'the other parent to run');
            await expect(
                h.daemon.services.threads.spawn(runOf(parent.id), { prompt: 'Work in removed tree', cwd: path })
            ).rejects.toThrow('The worktree is being removed');
            expect(h.send('chat.setArchived', { chatId: chat.id, archived: false })).toMatchObject({
                ok: false,
                error: { code: 'conflict' },
            });
            expect(h.send('chat.delete', { chatId: chat.id })).toMatchObject({
                ok: false,
                error: { code: 'conflict' },
            });
            expect(h.send('chat.send', { chatId: chat.id, text: 'Start again' })).toMatchObject({
                ok: false,
                error: { code: 'conflict' },
            });
            expect(
                await h.sendAsync('chat.create', { projectId: project.id, workspace: { mode: 'existing', path } })
            ).toMatchObject({ ok: false, error: { code: 'conflict' } });
        } finally {
            writeFileSync(join(bin, 'go'), '');
            await removing;
            process.env.PATH = environment.PATH;
            delete process.env.REMOVAL_TEST_GIT;
            delete process.env.REMOVAL_TEST_GATE;
            activeParent.release();
        }
        expect(await removing).toMatchObject({ ok: true });
        expect([chatOf(chat.id), existsSync(path)]).toEqual([before, false]);
    });

    test('refuses stale preview IDs, including descendants, without disposing of any chat', async () => {
        const { store, project, found, make, remove, chatOf } = await setup();
        const path = found('stale-preview');
        const original = await make({ mode: 'existing', path });
        const late = createChat(store, { projectId: project.id, parentChatId: original.id });
        expect(await remove(path, { chatDisposition: 'delete', expectedChatIds: [original.id] })).toMatchObject({
            ok: false,
            error: { code: 'conflict' },
        });
        expect([chatOf(original.id), chatOf(late.id)].map(chat => chat.id)).toEqual([original.id, late.id]);
        expect(existsSync(path)).toBe(true);
    });

    test('refuses a worktree shared with a different project even if its chat is archived', async () => {
        const { h, root, repo, project, start, remove, chatOf } = await setup();
        const first = await start();
        const path = first.workspace!.path;
        const secondFolder = join(root, 'second-project-folder');
        mkdirSync(secondFolder);
        const { project: other } = h.ok('project.add', { name: 'Other', folders: [repo, secondFolder] }) as {
            project: Project;
        };
        const { chat } = (await h.okAsync('chat.create', {
            projectId: other.id,
            workspace: { mode: 'existing', path },
        })) as {
            chat: Chat;
        };
        h.ok('chat.setArchived', { chatId: chat.id, archived: true });
        expect(other.id).not.toBe(project.id);
        expect(await remove(path, { chatDisposition: 'delete', expectedChatIds: [first.id] })).toMatchObject({
            ok: false,
            error: { code: 'conflict' },
        });
        expect(await h.sendAsync('chat.delete', { chatId: first.id, removeWorkspace: true })).toMatchObject({
            ok: false,
            error: { code: 'conflict' },
        });
        expect([chatOf(first.id).archivedAt, chatOf(chat.id).archivedAt, existsSync(path)]).toEqual([
            undefined,
            expect.any(Number),
            true,
        ]);
    });

    test('refuses an active explicit-cwd thread in a worktree with no linked chat', async () => {
        const gate = latch();
        const script: Script = async function* ({ number, signal }) {
            yield { type: 'session', sessionId: `s${number}` };
            await gate.wait(signal);
            yield { type: 'done', result: 'Done' };
        };
        const { h, project, found, runOf, remove, engine } = await setup({ script });
        const path = found('explicit-cwd');
        const { chat } = h.ok('chat.create', { projectId: project.id }) as { chat: Chat };
        h.ok('chat.send', { chatId: chat.id, text: 'Parent' });
        try {
            await waitFor(() => runOf(chat.id).status === 'running', 'the parent to run');
            const thread = await h.daemon.services.threads.spawn(runOf(chat.id), { prompt: 'Work here', cwd: path });
            await waitFor(
                () => engine.turns.some(turn => turn.cwd === path) && runOf(thread.threadId).status === 'running',
                'the thread to run in the external worktree'
            );
            expect(await remove(path, { tidy: true })).toMatchObject({ ok: false, error: { code: 'conflict' } });
            expect(await remove(path, { chatDisposition: 'delete', expectedChatIds: [] })).toMatchObject({
                ok: false,
                error: { code: 'conflict' },
            });
            expect([existsSync(path), runOf(thread.threadId).status]).toEqual([true, 'running']);
        } finally {
            gate.release();
        }
    });

    test('a chat attached after disposition starts is not silently archived or deleted', async () => {
        const { store, found, make, remove, chatOf } = await setup();
        const path = found('contested-disposition');
        const original = await make({ mode: 'existing', path });
        const gate = latch();
        const holding = exclusive(store, pathKey(original.workspace!.path), undefined, () => gate.wait());
        const removing = remove(path, { chatDisposition: 'delete' });
        const late = await make({ mode: 'existing', path });
        gate.release();
        await holding;
        expect(await removing).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect([chatOf(original.id).archivedAt, chatOf(late.id).archivedAt, existsSync(path)]).toEqual([
            undefined,
            undefined,
            true,
        ]);
    });
});

describe('tidy removal', () => {
    test('removes only a merged clean unused tree and keeps archived history', async () => {
        const { h, found, make, remove, chatOf, hasBranch } = await setup();
        const path = found('tidy');
        const chat = await make({ mode: 'existing', path });
        h.ok('chat.setArchived', { chatId: chat.id, archived: true });
        const before = chatOf(chat.id);
        expect(await remove(path, { tidy: true, deleteBranch: true })).toMatchObject({
            ok: true,
            data: { branchDeleted: true },
        });
        expect([existsSync(path), hasBranch('tidy'), chatOf(chat.id)]).toEqual([false, false, before]);
    });

    test('rechecks merged state after a change to the branch', async () => {
        const { found, remove, hasBranch } = await setup();
        const path = found('not-merged');
        commit(path);
        expect(await remove(path, { tidy: true, deleteBranch: true })).toMatchObject({
            ok: false,
            error: { code: 'conflict' },
        });
        expect([existsSync(path), hasBranch('not-merged')]).toEqual([true, true]);
    });

    test('protects a base branch and rechecks current base settings', async () => {
        const { h, project, folder, repo, found, remove, hasBranch } = await setup();
        const path = found('selected-base');
        h.ok('project.updateFolder', {
            projectId: project.id,
            folderId: folder.id,
            settings: { baseBranch: 'selected-base' },
        });
        expect(await remove(path, { tidy: true, deleteBranch: true })).toMatchObject({
            ok: false,
            error: { code: 'conflict' },
        });
        expect([existsSync(path), hasBranch('selected-base')]).toEqual([true, true]);
        git(repo, 'branch', 'different-base');
        commit(path);
        h.ok('project.updateFolder', {
            projectId: project.id,
            folderId: folder.id,
            settings: { baseBranch: 'different-base' },
        });
        expect(await remove(path, { tidy: true })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect([existsSync(path), hasBranch('selected-base')]).toEqual([true, true]);
    });

    test('refuses a newly used tree after waiting for Git', async () => {
        const { h, store, project, found, make, remove } = await setup();
        const path = found('tidy-contested');
        const { workspace } = h.ok('workspace.open', { projectId: project.id, path }) as { workspace: ChatWorkspace };
        const gate = latch();
        const holding = exclusive(store, pathKey(workspace.path), undefined, () => gate.wait());
        const removing = remove(path, { tidy: true });
        const chat = await make({ mode: 'existing', path });
        gate.release();
        await holding;
        expect(await removing).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect([existsSync(path), getChat(store.db, chat.id)?.archivedAt]).toEqual([true, undefined]);
    });

    test('refuses discard, disposition, dirty, locked, missing and in-use worktrees', async () => {
        const { repo, found, make, remove } = await setup();
        const path = found('tidy-invalid');
        expect(await remove(path, { tidy: true, discard: true })).toMatchObject({
            ok: false,
            error: { code: 'invalid' },
        });
        expect(await remove(path, { tidy: true, chatDisposition: 'archive' })).toMatchObject({
            ok: false,
            error: { code: 'invalid' },
        });
        writeFileSync(join(path, 'unsaved.txt'), 'work');
        expect(await remove(path, { tidy: true })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        rmSync(join(path, 'unsaved.txt'));
        git(repo, 'worktree', 'lock', path);
        expect(await remove(path, { tidy: true })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        git(repo, 'worktree', 'unlock', path);
        await make({ mode: 'existing', path });
        expect(await remove(path, { tidy: true })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        const missing = found('tidy-missing');
        rmSync(missing, { recursive: true });
        expect(await remove(missing, { tidy: true })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(existsSync(path)).toBe(true);
    });
});
