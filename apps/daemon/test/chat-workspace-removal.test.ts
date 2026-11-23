import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getChat } from '../src/db/chats';
import { chatsOfWorkspace, listWorkspacesOfProject } from '../src/db/workspaces';
import { createChat } from '../src/domain/chats';
import { isBeingRemoved } from '../src/domain/workspaceRemoval';
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

import type { Chat, ChatWorkspaceRemoval, CommandResult, Project, Run } from '@clowdy/protocol';
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

/** A clone of a bare `origin` with `main` (the clone's folder is `shop-web`), so a worktree's base is `origin/main`. */
function cloneOfOrigin(root: string): { work: string; seed: string } {
    const origin = join(root, 'origin.git');
    const seed = makeRepo(root, 'seed');

    git(root, 'init', '--bare', '-q', '-b', 'main', origin);
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-q', 'origin', 'main');
    git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(root, 'clone', '-q', origin, 'shop-web');

    return { work: join(root, 'shop-web'), seed };
}

/** What a person could lose in the folder's own checkout, as it is: its commit, branch, status, branches and every tracked file. */
function mainState(repo: string): Record<string, string> {
    const files = git(repo, 'ls-files').split('\n').filter(Boolean);

    return {
        head: git(repo, 'rev-parse', 'HEAD'),
        branch: git(repo, 'branch', '--show-current'),
        branches: git(repo, 'branch', '--list'),
        status: git(repo, 'status', '--porcelain'),
        ...Object.fromEntries(files.map(file => [`file:${file}`, readFileSync(join(repo, file), 'utf8')])),
    };
}

/** A daemon with a project of one repository (`Shop`, the folder `shop-web`) whose chats work in worktrees; a chat has made its worktree once `start` has run. */
async function setup(options: { origin?: boolean; script?: Script } = {}) {
    const engine = new ScriptEngine(options.script ?? finishing);
    const h = await startHarness({}, { engines: scriptEngines(engine) });

    harnesses.push(h);

    const root = tempDir('workspace-removal');
    const remote = options.origin ? cloneOfOrigin(root) : undefined;
    const repo = remote?.work ?? makeRepo(root, 'shop-web');
    const { project } = h.ok('project.add', { name: 'Shop', folders: [repo] }) as { project: Project };
    const { store } = h;
    const chatOf = (chatId: string) => getChat(store.db, chatId) as Chat;
    const runOf = (chatId: string) => h.run(chatOf(chatId).orchestratorRunId as string);
    const make = (workspace: unknown): Chat =>
        (h.ok('chat.create', { projectId: project.id, workspace }) as { chat: Chat }).chat;
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
        const chat = make({ mode: 'new' });

        await send(chat, 'Start');

        return chatOf(chat.id);
    };
    const removal = async (chat: Chat): Promise<ChatWorkspaceRemoval> => {
        const response = await h.fetch(`/v1/chats/${chat.id}/workspace`);

        expect(response.status).toBe(200);

        return (await response.json()) as ChatWorkspaceRemoval;
    };
    const remove = (chat: Chat, removeWorkspace = true): Promise<CommandResult> =>
        h.sendAsync('chat.delete', { chatId: chat.id, ...(removeWorkspace && { removeWorkspace }) });
    const refusal = (result: CommandResult) => (result.ok ? undefined : result.error);
    const exists = (chatId: string) => getChat(store.db, chatId) !== undefined;

    return {
        h,
        engine,
        repo,
        remote,
        project,
        store,
        root,
        chatOf,
        runOf,
        make,
        send,
        start,
        removal,
        remove,
        refusal,
        exists,
    };
}

/** Commits a file in the worktree and merges the branch into `main` of the folder, as a person would when the work is done. */
function commitAndMerge(repo: string, path: string, branch: string, file = 'done.txt'): void {
    writeFileSync(join(path, file), 'finished work\n');
    git(path, 'add', file);
    git(path, 'commit', '-q', '-m', 'Work');
    git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge the work', branch);
}

describe('what GET /v1/chats/:id/workspace says', () => {
    test('is removable for a clean worktree Clowdy made whose branch has no work, and gives its path and branch', async () => {
        const { start, removal } = await setup();
        const chat = await start();

        expect(await removal(chat)).toEqual({
            removable: true,
            path: chat.workspace!.path,
            branch: chat.workspace!.branch,
        });
    });

    test('is removable once the branch was merged into the base, and not while it holds a commit the base lacks', async () => {
        const { repo, start, removal } = await setup();
        const chat = await start();
        const { path, branch } = chat.workspace!;

        writeFileSync(join(path, 'done.txt'), 'finished work\n');
        git(path, 'add', 'done.txt');
        git(path, 'commit', '-q', '-m', 'Work');
        expect(await removal(chat)).toMatchObject({ removable: false, path, branch });

        git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge the work', branch!);
        expect(await removal(chat)).toMatchObject({ removable: true, path, branch });
    });

    test('says no for a chat with no worktree, with no path, and 404 for no chat', async () => {
        const { h, project, removal } = await setup();
        const { chat } = h.ok('chat.create', { projectId: project.id }) as { chat: Chat };

        expect(await removal(chat)).toEqual({ removable: false });
        expect((await h.fetch('/v1/chats/cht_missing/workspace')).status).toBe(404);
    });

    test('says no while anything in the tree is not committed: a changed file, a staged one, a new one, a deleted one', async () => {
        const { start, removal } = await setup();
        const chat = await start();
        const { path } = chat.workspace!;

        expect((await removal(chat)).removable).toBe(true);

        writeFileSync(join(path, 'README.md'), '# Edited\n');
        expect((await removal(chat)).removable).toBe(false);
        git(path, 'checkout', '--', 'README.md');
        expect((await removal(chat)).removable).toBe(true);

        writeFileSync(join(path, 'staged.txt'), 'staged\n');
        git(path, 'add', 'staged.txt');
        expect((await removal(chat)).removable).toBe(false);
        git(path, 'reset', '-q', 'staged.txt');

        // Untracked, and the person's own `status.showUntrackedFiles=no` does not hide it.
        git(path, 'config', 'status.showUntrackedFiles', 'no');
        expect((await removal(chat)).removable).toBe(false);
        rmSync(join(path, 'staged.txt'));
        expect((await removal(chat)).removable).toBe(true);

        rmSync(join(path, 'README.md'));
        expect((await removal(chat)).removable).toBe(false);
    });

    test('does not count what .gitignore hides, which goes with the tree', async () => {
        const { repo, h, project, make, send, removal, remove, exists } = await setup();

        writeFileSync(join(repo, '.gitignore'), '.env\nbuild/\n');
        git(repo, 'add', '.gitignore');
        git(repo, 'commit', '-q', '-m', 'Ignore');

        const chat = make({ mode: 'new' });

        await send(chat, 'Start');

        const { path } = chat.workspace!;

        writeFileSync(join(path, '.env'), 'SECRET=1\n');
        mkdirSync(join(path, 'build'));
        writeFileSync(join(path, 'build', 'out.js'), 'out\n');
        expect((await removal(chat)).removable).toBe(true);

        expect((await remove(chat)).ok).toBe(true);
        expect(existsSync(path)).toBe(false);
        expect(exists(chat.id)).toBe(false);
        expect(listWorkspacesOfProject(h.store.db, project.id)).toEqual([]);
    });

    test("says no for a worktree on a base that was not fetched yet: the remote's branch as last fetched is what the work is compared with", async () => {
        const { repo, start, removal } = await setup({ origin: true });
        const chat = await start();
        const { path, branch } = chat.workspace!;

        commitAndMerge(repo, path, branch!);

        // Merged into the local main, but the base is `origin/main`, which has not got the merge: there is no fetch to find out.
        expect(await removal(chat)).toMatchObject({ removable: false });

        git(repo, 'push', '-q', 'origin', 'main');
        expect(git(repo, 'rev-parse', 'origin/main')).toBe(git(repo, 'rev-parse', 'main'));
        expect(await removal(chat)).toMatchObject({ removable: true });
    });

    test("says no for a worktree that is not Clowdy's: one an agent or a person made, which a chat picked from the list", async () => {
        const { repo, root, make, removal } = await setup();
        const tree = join(root, 'feature-tree');

        git(repo, 'worktree', 'add', '-q', '-b', 'feature', tree);

        const chat = make({ mode: 'existing', path: tree });

        expect(chat.workspace).toMatchObject({ managed: false });
        expect(await removal(chat)).toMatchObject({ removable: false, branch: 'feature' });
    });

    test('says no for a worktree that is gone from the disk, one git does not list, and one that is locked', async () => {
        const { repo, start, removal } = await setup();
        const chat = await start();
        const { path } = chat.workspace!;

        git(repo, 'worktree', 'lock', path);
        expect((await removal(chat)).removable).toBe(false);
        git(repo, 'worktree', 'unlock', path);
        expect((await removal(chat)).removable).toBe(true);

        rmSync(path, { recursive: true, force: true });
        expect((await removal(chat)).removable).toBe(false);
        git(repo, 'worktree', 'prune');
        expect((await removal(chat)).removable).toBe(false);
    });

    test('says no while another chat works in the worktree, an archived one too, and not for the threads below the chat', async () => {
        const { h, store, project, make, start, removal } = await setup();
        const chat = await start();
        const { path } = chat.workspace!;
        const thread = createChat(store, {
            projectId: project.id,
            parentChatId: chat.id,
            folderId: chat.folderId,
            workspaceId: chat.workspace!.id,
        });
        const deeper = createChat(store, {
            projectId: project.id,
            parentChatId: thread.id,
            folderId: chat.folderId,
            workspaceId: chat.workspace!.id,
        });

        // The threads go with the chat, so they are not sharing.
        expect(chatsOfWorkspace(store.db, chat.workspace!.id)).toEqual([chat.id, thread.id, deeper.id]);
        expect((await removal(chat)).removable).toBe(true);

        const other = make({ mode: 'existing', path });

        expect(other.workspace!.id).toBe(chat.workspace!.id);
        expect((await removal(chat)).removable).toBe(false);
        expect((await removal(other)).removable).toBe(false);

        // The other one set aside is still somebody's, and a thread of the other one counts as the other's.
        h.ok('chat.setArchived', { chatId: other.id, archived: true });
        expect((await removal(chat)).removable).toBe(false);
    });

    test('says no while the branch is checked out in another worktree, and for a tree that was moved to a commit the base lacks', async () => {
        const { repo, root, start, removal } = await setup();
        const chat = await start();
        const { path, branch } = chat.workspace!;

        // The agent moved off its branch, which another worktree took: deleting the branch would fail after the tree was gone.
        git(path, 'checkout', '-q', '--detach');
        git(repo, 'worktree', 'add', '-q', join(root, 'elsewhere'), branch!);
        expect((await removal(chat)).removable).toBe(false);
        git(repo, 'worktree', 'remove', join(root, 'elsewhere'));
        expect((await removal(chat)).removable).toBe(true);

        // A commit made on the detached HEAD belongs to no branch: removing the tree would leave nothing to find it by.
        writeFileSync(join(path, 'lost.txt'), 'only here\n');
        git(path, 'add', 'lost.txt');
        git(path, 'commit', '-q', '-m', 'Detached work');
        expect((await removal(chat)).removable).toBe(false);
    });
});

describe('chat.delete with removeWorkspace', () => {
    test('removes the worktree and its branch, then the chat and the workspace row, and the folders it leaves empty up to the workspaces folder', async () => {
        const { h, repo, store, project, start, remove, exists } = await setup();
        const chat = await start();
        const { path, branch } = chat.workspace!;
        const id8 = chat.id.slice(-8);

        commitAndMerge(repo, path, branch!);

        const merged = mainState(repo);

        expect(existsSync(join(h.config.workspacesDir, 'shop', id8, 'shop-web'))).toBe(true);

        const result = await remove(chat);

        expect(result).toMatchObject({ ok: true, data: { chatId: chat.id } });
        expect(existsSync(path)).toBe(false);
        expect(existsSync(join(h.config.workspacesDir, 'shop'))).toBe(false);
        expect(existsSync(h.config.workspacesDir)).toBe(true);
        expect(git(repo, 'branch', '--list', branch!)).toBe('');
        expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(branch!);
        expect(exists(chat.id)).toBe(false);
        expect(listWorkspacesOfProject(store.db, project.id)).toEqual([]);

        // The folder's own checkout is as the merge left it, apart from the branch that went.
        expect(mainState(repo)).toEqual({ ...merged, branches: '* main' });
    });

    test('removes a worktree that has nothing in it but what the base has, whatever it was named, and the threads below the chat go with it', async () => {
        const { repo, store, project, start, remove, exists } = await setup();
        const chat = await start();
        const { path, branch } = chat.workspace!;
        const thread = createChat(store, {
            projectId: project.id,
            parentChatId: chat.id,
            folderId: chat.folderId,
            workspaceId: chat.workspace!.id,
        });

        expect((await remove(chat)).ok).toBe(true);
        expect(existsSync(path)).toBe(false);
        expect(git(repo, 'branch', '--list', branch!)).toBe('');
        expect(exists(chat.id)).toBe(false);
        expect(exists(thread.id)).toBe(false);
        expect(listWorkspacesOfProject(store.db, project.id)).toEqual([]);
    });

    test("keeps the folders of other chats' worktrees while it prunes its own", async () => {
        const { h, start, remove } = await setup();
        const first = await start();
        const second = await start();
        const slug = join(h.config.workspacesDir, 'shop');

        expect((await remove(first)).ok).toBe(true);
        expect(existsSync(first.workspace!.path)).toBe(false);
        expect(existsSync(join(slug, first.id.slice(-8)))).toBe(false);
        expect(existsSync(second.workspace!.path)).toBe(true);
        expect(existsSync(slug)).toBe(true);
    });

    test('takes only the branch the row names: a tree that moved to another merged branch is removed, and that branch stays', async () => {
        const { repo, start, remove } = await setup();
        const chat = await start();
        const { path, branch } = chat.workspace!;

        git(path, 'checkout', '-q', '-b', 'feature/side');
        expect((await remove(chat)).ok).toBe(true);
        expect(existsSync(path)).toBe(false);
        expect(git(repo, 'branch', '--list', branch!)).toBe('');
        expect(git(repo, 'branch', '--list', 'feature/side')).toContain('feature/side');
    });

    test('is refused with the reason and deletes nothing when a condition fails: a change made after the dialog read the answer', async () => {
        const { repo, store, project, start, removal, remove, refusal, exists } = await setup();
        const chat = await start();
        const { path, branch } = chat.workspace!;

        expect((await removal(chat)).removable).toBe(true);
        writeFileSync(join(path, 'draft.txt'), 'not committed\n');

        const result = await remove(chat);

        expect(refusal(result)).toEqual({
            code: 'conflict',
            message: 'The worktree has changes that are not committed',
        });
        expect(readFileSync(join(path, 'draft.txt'), 'utf8')).toBe('not committed\n');
        expect(git(repo, 'branch', '--list', branch!)).toContain(branch!);
        expect(exists(chat.id)).toBe(true);
        expect(listWorkspacesOfProject(store.db, project.id)).toHaveLength(1);
    });

    test('is refused with its own reason for each other condition, and the chat, the worktree and the branch stay', async () => {
        const { h, repo, root, store, project, make, start, remove, refusal, exists } = await setup();
        const chat = await start();
        const { path, branch } = chat.workspace!;

        // Unmerged.
        writeFileSync(join(path, 'done.txt'), 'finished work\n');
        git(path, 'add', 'done.txt');
        git(path, 'commit', '-q', '-m', 'Work');
        expect(refusal(await remove(chat))).toEqual({
            code: 'conflict',
            message: 'The worktree has commits that are not in main',
        });

        // Shared with another chat.
        git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge the work', branch!);

        const other = make({ mode: 'existing', path });

        expect(refusal(await remove(chat))).toEqual({
            code: 'conflict',
            message: expect.stringContaining('works in this worktree too') as unknown as string,
        });
        h.ok('chat.delete', { chatId: other.id });

        // Locked.
        git(repo, 'worktree', 'lock', path);
        expect(refusal(await remove(chat))).toEqual({ code: 'conflict', message: 'The worktree is locked' });
        git(repo, 'worktree', 'unlock', path);

        // Not Clowdy's.
        const tree = join(root, 'feature-tree');

        git(repo, 'worktree', 'add', '-q', '-b', 'feature', tree);

        const found = make({ mode: 'existing', path: tree });

        expect(refusal(await remove(found))).toEqual({
            code: 'conflict',
            message: 'Clowdy did not make this worktree',
        });

        // A chat with no worktree.
        const { chat: bare } = h.ok('chat.create', { projectId: project.id }) as { chat: Chat };

        expect(refusal(await remove(bare))).toEqual({
            code: 'conflict',
            message: 'This chat has no worktree to remove',
        });
        expect(refusal(await h.sendAsync('chat.delete', { chatId: 'cht_missing', removeWorkspace: true }))?.code).toBe(
            'not_found'
        );

        for (const kept of [chat, found, bare]) {
            expect(exists(kept.id)).toBe(true);
        }

        expect(existsSync(path)).toBe(true);
        expect(existsSync(tree)).toBe(true);
        expect(git(repo, 'branch', '--list', branch!)).toContain(branch!);
        expect(listWorkspacesOfProject(store.db, project.id)).toHaveLength(2);
    });

    test('is refused while the chat is working, before anything is removed', async () => {
        const gate = latch();
        const script: Script = async function* ({ number, signal }) {
            yield { type: 'session', sessionId: `s${number}` };

            if (number === 2) {
                await gate.wait(signal);
            }

            yield { type: 'done', result: 'Done' };
        };
        const { repo, start, send, runOf, remove, refusal, exists } = await setup({ script });
        const chat = await start();
        const { path, branch } = chat.workspace!;
        const mainBefore = mainState(repo);

        void send(chat, 'Work on it');
        await waitFor(() => runOf(chat.id).status === 'running', 'the second turn to hold');

        const result = await remove(chat);

        expect(refusal(result)?.code).toBe('conflict');
        expect(refusal(result)?.message).toContain('still working');
        expect(existsSync(path)).toBe(true);
        expect(git(repo, 'branch', '--list', branch!)).toContain(branch!);
        expect(exists(chat.id)).toBe(true);
        expect(mainState(repo)).toEqual(mainBefore);

        gate.release();
        await waitFor(() => runOf(chat.id).status === 'succeeded', 'the turn to end');
        expect((await remove(chat)).ok).toBe(true);
        expect(existsSync(path)).toBe(false);
    });

    test("keeps the chat and the branch when git cannot remove the tree, and the chat's next turn says the folder is no worktree instead of starting in it", async () => {
        if (process.platform === 'win32' || process.getuid?.() === 0) {
            return;
        }

        const { engine, repo, start, send, removal, remove, refusal, exists, chatOf, runOf } = await setup();
        const chat = await start();
        const { path, branch } = chat.workspace!;
        const folder = join(path, 'locked');

        mkdirSync(folder);
        writeFileSync(join(folder, 'file.txt'), 'x\n');
        git(path, 'add', 'locked');
        git(path, 'commit', '-q', '-m', 'A folder');
        git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge the work', branch!);
        expect((await removal(chat)).removable).toBe(true);

        // The files of a folder that cannot be written to cannot be deleted: git has forgotten the worktree by then and stops half way.
        chmodSync(folder, 0o555);

        try {
            const result = await remove(chat);

            expect(refusal(result)?.code).toBe('conflict');
            expect(refusal(result)?.message).toStartWith("Couldn't remove the worktree:");
            expect(refusal(result)?.message).toContain(
                `Git no longer lists ${path}, so what is left of the folder has to be deleted by hand`
            );
            expect(exists(chat.id)).toBe(true);
            expect(git(repo, 'branch', '--list', branch!)).toContain(branch!);
            expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(path);
            expect(existsSync(path)).toBe(true);
            expect(chatOf(chat.id).workspace?.ready).toBe(false);
            expect(await removal(chat)).toMatchObject({ removable: false });

            // The agent is not started in the dead tree: the step refuses a folder that is no worktree, and leaves it alone.
            const turns = engine.turns.length;
            const failed = await send(chat, 'Go on', 'failed');

            expect(failed.error).toStartWith(`${path} exists and is not a worktree of `);
            expect(engine.turns).toHaveLength(turns);
            expect(runOf(chat.id).status).toBe('failed');
        } finally {
            chmodSync(folder, 0o755);
        }

        // Once the folder is gone, the turn makes the worktree again from the branch the chat kept.
        rmSync(path, { recursive: true, force: true });
        await send(chat, 'Again');
        expect(engine.turns.at(-1)?.cwd).toBe(path);
        expect(git(path, 'branch', '--show-current')).toBe(branch!);
        expect(existsSync(join(path, 'locked', 'file.txt'))).toBe(true);
    });

    test('is refused while a turn starts meanwhile, the worktree and the branch stay, and the turn goes on in it', async () => {
        const { engine, repo, store, start, send, remove, refusal, exists, runOf } = await setup();
        const chat = await start();
        const { id, path, branch } = chat.workspace!;
        const turns = engine.turns.length;
        const removing = remove(chat);

        // The removal has taken its place on the line the turn's own `Prepare workspace` waits on.
        expect(isBeingRemoved(store, id)).toBe(true);

        const turn = send(chat, 'Go on');
        const result = await removing;

        await turn;
        expect(refusal(result)?.code).toBe('conflict');
        expect(refusal(result)?.message).toContain('still working');
        expect(isBeingRemoved(store, id)).toBe(false);
        expect(exists(chat.id)).toBe(true);
        expect(existsSync(path)).toBe(true);
        expect(git(repo, 'branch', '--list', branch!)).toContain(branch!);
        expect(engine.turns).toHaveLength(turns + 1);
        expect(engine.turns.at(-1)?.cwd).toBe(path);
        expect(runOf(chat.id).status).toBe('succeeded');
    });

    test('is not offered for a worktree with a submodule checked out, which git would refuse to remove, and is for one whose submodule is not', async () => {
        const { repo, root, start, removal, remove } = await setup();
        const library = makeRepo(root, 'library');
        const chat = await start();
        const { path, branch } = chat.workspace!;

        git(path, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'vendor/library');
        git(path, 'commit', '-q', '-m', 'Add the library');
        git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge the work', branch!);
        expect(git(path, 'status', '--porcelain')).toBe('');
        expect(await removal(chat)).toMatchObject({ removable: false });
        expect((await remove(chat)).ok).toBe(false);
        expect(existsSync(path)).toBe(true);

        // Another chat's worktree is made from the merged base: the submodule is in it, not checked out.
        const second = await start();

        expect(existsSync(join(second.workspace!.path, 'vendor', 'library', 'README.md'))).toBe(false);
        expect(await removal(second)).toMatchObject({ removable: true });
        expect((await remove(second)).ok).toBe(true);
        expect(existsSync(second.workspace!.path)).toBe(false);
    });

    test('removes a worktree whose branch was deleted by hand and has nothing left to delete there', async () => {
        const { repo, start, removal, remove, exists } = await setup();
        const chat = await start();
        const { path, branch } = chat.workspace!;

        git(path, 'checkout', '-q', '--detach');
        git(repo, 'branch', '-D', branch!);
        expect(await removal(chat)).toMatchObject({ removable: true });
        expect((await remove(chat)).ok).toBe(true);
        expect(existsSync(path)).toBe(false);
        expect(exists(chat.id)).toBe(false);
    });

    test('says so when the worktree is gone and the branch cannot be deleted, keeps the chat, and a retry says the worktree is gone', async () => {
        const { repo, start, remove, refusal, exists } = await setup();
        const chat = await start();
        const { path, branch } = chat.workspace!;

        // A leftover lock of the branch's ref: git cannot take it to delete it.
        writeFileSync(join(repo, '.git', 'refs', 'heads', `${branch!}.lock`), '');

        const result = await remove(chat);

        expect(refusal(result)?.code).toBe('conflict');
        expect(refusal(result)?.message).toStartWith("The worktree was removed. Couldn't delete the branch:");
        expect(existsSync(path)).toBe(false);
        expect(git(repo, 'branch', '--list', branch!)).toContain(branch!);
        expect(exists(chat.id)).toBe(true);
        expect(refusal(await remove(chat))).toEqual({
            code: 'conflict',
            message: 'The worktree is gone from the disk',
        });
        expect((await remove(chat, false)).ok).toBe(true);
        expect(exists(chat.id)).toBe(false);
    });

    test('is not run by a plain delete, which leaves the worktree and the branch, and drops the row only with the last chat that points at it', async () => {
        const { h, repo, store, project, make, start, remove, exists } = await setup();
        const chat = await start();
        const { path, branch } = chat.workspace!;
        const other = make({ mode: 'existing', path });
        const mainBefore = mainState(repo);

        expect((await remove(chat, false)).ok).toBe(true);
        expect(exists(chat.id)).toBe(false);
        expect(existsSync(path)).toBe(true);
        expect(git(repo, 'branch', '--list', branch!)).toContain(branch!);
        expect(listWorkspacesOfProject(store.db, project.id)).toHaveLength(1);
        expect(chatsOfWorkspace(store.db, chat.workspace!.id)).toEqual([other.id]);

        h.ok('chat.delete', { chatId: other.id });
        expect(exists(other.id)).toBe(false);
        expect(listWorkspacesOfProject(store.db, project.id)).toEqual([]);
        expect(existsSync(path)).toBe(true);
        expect(git(repo, 'branch', '--list', branch!)).toContain(branch!);
        // Git still lists it, so a new chat can pick it from the folder's existing worktrees, as one that is not Clowdy's now.
        expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(`branch refs/heads/${branch}`);

        const again = make({ mode: 'existing', path });

        expect(again.workspace).toMatchObject({ path: realpathSync(path), managed: false, ready: true });
        expect(mainState(repo)).toEqual(mainBefore);
    });

    test('is not done by archiving, which changes nothing about the worktree, its branch or its row', async () => {
        const { h, repo, store, project, start, removal, chatOf } = await setup();
        const chat = await start();
        const { path, branch } = chat.workspace!;
        const mainBefore = mainState(repo);

        h.ok('chat.setArchived', { chatId: chat.id, archived: true });

        expect(chatOf(chat.id).archivedAt).toBeDefined();
        expect(existsSync(path)).toBe(true);
        expect(git(repo, 'branch', '--list', branch!)).toContain(branch!);
        expect(listWorkspacesOfProject(store.db, project.id)).toHaveLength(1);
        expect(chatOf(chat.id).workspace).toEqual(chat.workspace);
        expect(await removal(chatOf(chat.id))).toMatchObject({ removable: true });
        expect(mainState(repo)).toEqual(mainBefore);

        h.ok('chat.setArchived', { chatId: chat.id, archived: false });
        expect(existsSync(path)).toBe(true);
    });

    test('is a command for the async path only when it asks for the removal, and a repeat of one that was answered gives the same answer', async () => {
        const { h, start } = await setup();
        const chat = await start();
        const asked = {
            requestId: 'delete-with-worktree',
            type: 'chat.delete' as const,
            chatId: chat.id,
            removeWorkspace: true,
        };
        const sync = h.send('chat.delete', { chatId: chat.id, removeWorkspace: true });

        // Run without waiting, it would not know what to do with the removal: it refuses rather than delete the chat and leave the worktree behind.
        expect(sync).toMatchObject({
            ok: false,
            error: { code: 'internal', message: expect.stringContaining('executeCommandAsync') },
        });

        const { executeCommandAsync } = await import('../src/commands');
        const first = await executeCommandAsync(h.daemon.services, asked);
        const again = await executeCommandAsync(h.daemon.services, asked);

        expect(first).toMatchObject({ ok: true, data: { chatId: chat.id } });
        expect(again).toEqual(first);
    });

    test('works over HTTP, and the answer waits for git', async () => {
        const { h, start, exists } = await setup();
        const chat = await start();
        const response = await h.fetch('/v1/commands', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                requestId: 'http-delete',
                type: 'chat.delete',
                chatId: chat.id,
                removeWorkspace: true,
            }),
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ ok: true, data: { chatId: chat.id } });
        expect(existsSync(chat.workspace!.path)).toBe(false);
        expect(exists(chat.id)).toBe(false);
    });
});
