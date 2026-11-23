import { STOPPED_TOOL } from '@clowdy/protocol';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import { getChat } from '../src/db/chats';
import { listItems } from '../src/db/items';
import { getProject } from '../src/db/projects';
import { chatsOfWorkspace, getWorkspace, listWorkspacesOfProject, updateWorkspace } from '../src/db/workspaces';
import { runLines } from '../src/domain/lines';
import { chatKey, needsPreparing, placeOf, prepareWorkspace, projectSlug, samePlace, WORKSPACE_TOOL, workspaceLayout } from '../src/domain/workspaces';
import { copySetupFiles, setupShell } from '../src/domain/workspaceSetup';
import { baseOf } from '../src/git/state';
import { toolsFor } from '../src/runs/tools';
import { cleanTempDirs, command, git, latch, makeRepo, ScriptEngine, scriptEngines, SHORT_TIMINGS, startHarness, tempDir, waitFor } from './helpers';

import type { Chat, Project, Run, StreamItem } from '@clowdy/protocol';
import type { Timings } from '../src/config';
import type { Harness, Script } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

const finishing: Script = async function* ({ number }) {
    yield { type: 'session', sessionId: `s${ number }` };
    yield { type: 'text', delta: 'Done', done: false };
    yield { type: 'text', delta: '', done: true, messageId: `m${ number }` };
    yield { type: 'done', result: 'Done' };
};

/**
 * A clone of a bare `origin` that has `main` and `dev` (the clone's folder is `work`), so it has `origin/main`, `origin/dev` and an `origin/HEAD`. `seed` is the
 * repository the commits come from: a commit made there and pushed is new to the clone until it fetches.
 */
function cloneOfOrigin(root: string): { work: string; origin: string; seed: string } {
    const origin = join(root, 'origin.git');
    const seed = makeRepo(root, 'seed');

    git(root, 'init', '--bare', '-q', '-b', 'main', origin);
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-q', 'origin', 'main', 'main:dev');
    git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(root, 'clone', '-q', origin, 'shop-web');

    return { work: join(root, 'shop-web'), origin, seed };
}

/** Everything a person could lose in a worktree, as it is: its commit and branch, its changes and every file's bytes. */
function stateOf(path: string): Record<string, string> {
    const files = git(path, 'ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter(Boolean);

    return {
        head: git(path, 'rev-parse', 'HEAD'),
        branch: git(path, 'branch', '--show-current'),
        status: git(path, 'status', '--porcelain'),
        stash: git(path, 'stash', 'list'),
        ...Object.fromEntries(files.map(file => [`file:${ file }`, readFileSync(join(path, file), 'utf8')])),
    };
}

/** A daemon with a project of one repository (`Shop`, the folder `shop-web`, with a bare `origin` when asked) and an engine whose turns end at once. */
async function setup(options: { origin?: boolean; canFork?: boolean; script?: Script; timings?: Timings } = {}) {
    const engine = new ScriptEngine(options.script ?? finishing);

    engine.canFork = options.canFork ?? false;

    const h = await startHarness(options.timings ? { timings: options.timings } : {}, { engines: scriptEngines(engine) });

    harnesses.push(h);

    const root = tempDir('chat-workspaces');
    const remote = options.origin ? cloneOfOrigin(root) : undefined;
    const repo = remote?.work ?? makeRepo(root, 'shop-web');
    const { project } = h.ok('project.add', { name: 'Shop', folders: [repo] }) as { project: Project };
    const folder = project.folders[0];
    const { store } = h;
    const chatOf = (chatId: string) => getChat(store.db, chatId) as Chat;
    const runOf = (chatId: string) => h.run(chatOf(chatId).orchestratorRunId as string);
    const sentOf = (workspace: { path: string }) => engine.turns.filter(turn => turn.cwd === workspace.path);
    /** The folder's settings, as the Workspace dialog of Settings sets them. */
    const configure = (settings: { baseBranch?: string | null; setup?: { files?: string[]; command?: string } | null }) => h.ok('project.updateFolder', { projectId: project.id, folderId: folder.id, settings: settings.setup ? { ...settings, setup: { files: [], ...settings.setup } } : settings });
    const create = (workspace?: unknown, extra: Record<string, unknown> = {}) => h.send('chat.create', { projectId: project.id, ...(workspace !== undefined && { workspace }), ...extra });
    const make = (workspace?: unknown, extra: Record<string, unknown> = {}) => (h.ok('chat.create', { projectId: project.id, ...(workspace !== undefined && { workspace }), ...extra }) as { chat: Chat }).chat;
    /** Sends a message and waits until the chat's run has come to rest again, whatever way. */
    const send = async (chat: Chat, text: string, until: Run['status'] = 'succeeded') => {
        const before = chatOf(chat.id).orchestratorRunId === undefined ? undefined : runOf(chat.id).finishedAt;

        h.ok('chat.send', { chatId: chat.id, text });
        await waitFor(() => {
            const run = chatOf(chat.id).orchestratorRunId ? runOf(chat.id) : undefined;

            return run?.status === until && run.finishedAt !== before;
        }, `the turn on "${ text }" to end as ${ until }`);

        return runOf(chat.id);
    };
    const items = (chat: Chat): StreamItem[] => listItems(store.db, chatOf(chat.id).orchestratorRunId as string, 0);
    const stepOf = (chat: Chat) => items(chat).flatMap(item => (item.body.kind === 'tool' && item.body.name === WORKSPACE_TOOL ? [item.body] : []));

    return { h, engine, remote, repo: folder.path, project, folder, store, chatOf, runOf, sentOf, configure, create, make, send, items, stepOf, root };
}

describe('chat.create with a workspace', () => {
    test('records a new worktree under the workspaces folder on a branch of the chat\'s own, pins the chat to its folder, and makes nothing on the disk', async () => {
        const { h, project, folder, chatOf, make } = await setup();
        const chat = make({ mode: 'new' });
        const id8 = chat.id.slice(-8);
        const path = join(h.config.workspacesDir, 'shop', id8, 'shop-web');

        expect(chat.workspace).toEqual({ id: expect.stringMatching(/^wks_/), folderId: folder.id, path, branch: `clowdy/${ id8 }`, managed: true, ready: false });
        expect(chat.folderId).toBe(folder.id);
        expect(chatOf(chat.id)).toEqual(chat);
        expect(getWorkspace(h.store.db, chat.workspace!.id)).toMatchObject({ projectId: project.id, folderId: folder.id, path, base: 'main', managed: true, ready: false });
        expect(existsSync(h.config.workspacesDir)).toBe(false);
        expect(git(folder.path, 'worktree', 'list')).not.toContain('clowdy/');
        expect(needsPreparing(chat.workspace!)).toBe(true);
        expect(chatsOfWorkspace(h.store.db, chat.workspace!.id)).toEqual([chat.id]);
    });

    test('takes the default branch of the repository as the base, or the one asked for, and keeps it on the row', async () => {
        const { h, make } = await setup({ origin: true });
        const byDefault = make({ mode: 'new' });
        const asked = make({ mode: 'new', base: 'origin/dev' });
        const local = make({ mode: 'new', base: 'main' });

        expect(getWorkspace(h.store.db, byDefault.workspace!.id)?.base).toBe('origin/main');
        expect(getWorkspace(h.store.db, asked.workspace!.id)?.base).toBe('origin/dev');
        expect(getWorkspace(h.store.db, local.workspace!.id)?.base).toBe('main');
    });

    test('starts from the folder\'s own base branch when the repository has it, a remote\'s included, and the base of the choice still wins', async () => {
        const { h, repo, make, send, configure } = await setup({ origin: true });

        // A local branch with a commit of its own, so that the worktree can be told by where it started.
        git(repo, 'switch', '-q', '-c', 'develop');
        writeFileSync(join(repo, 'develop.txt'), 'only on develop\n');
        git(repo, 'add', '.');
        git(repo, 'commit', '-q', '-m', 'Develop');
        git(repo, 'switch', '-q', 'main');

        configure({ baseBranch: 'develop' });

        const local = make({ mode: 'new' });

        expect(getWorkspace(h.store.db, local.workspace!.id)?.base).toBe('develop');
        await send(local, 'Start on develop');
        expect(git(local.workspace!.path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'develop'));
        expect(readFileSync(join(local.workspace!.path, 'develop.txt'), 'utf8')).toBe('only on develop\n');

        configure({ baseBranch: 'origin/dev' });
        expect(getWorkspace(h.store.db, make({ mode: 'new' }).workspace!.id)?.base).toBe('origin/dev');

        // The person's choice in the draft is the base, whatever the folder's setting says.
        expect(getWorkspace(h.store.db, make({ mode: 'new', base: 'main' }).workspace!.id)?.base).toBe('main');
        expect(getWorkspace(h.store.db, make({ mode: 'new', base: 'origin/main' }).workspace!.id)?.base).toBe('origin/main');
    });

    test('skips a base branch the repository does not have, a tag, a deleted branch and a revision included, and takes the default one', async () => {
        const { h, repo, make, configure } = await setup({ origin: true });
        const baseOfNext = () => getWorkspace(h.store.db, make({ mode: 'new' }).workspace!.id)?.base;

        git(repo, 'tag', 'v1');
        git(repo, 'branch', 'later');

        for (const baseBranch of ['nowhere', 'v1', 'refs/heads/main', 'main~1', 'origin/missing', 'dev']) {
            configure({ baseBranch });
            expect(baseOfNext(), baseBranch).toBe('origin/main');
        }

        // A branch that was there and is deleted, and a setting that is cleared.
        configure({ baseBranch: 'later' });
        expect(baseOfNext()).toBe('later');
        git(repo, 'branch', '-D', 'later');
        expect(baseOfNext()).toBe('origin/main');
        configure({ baseBranch: null });
        expect(baseOfNext()).toBe('origin/main');
    });

    test('takes the base by the rule the git endpoint uses: the synchronous read of chat.create and baseOf agree', async () => {
        const { h, repo, project, folder, make, configure } = await setup({ origin: true });

        git(repo, 'tag', 'v1');
        git(repo, 'branch', 'develop');

        for (const baseBranch of ['develop', 'origin/dev', 'main', 'origin/main', 'v1', 'gone', 'dev', 'origin/HEAD']) {
            configure({ baseBranch });

            const current = getProject(h.store.db, project.id)!.folders.find(candidate => candidate.id === folder.id)!;

            expect(getWorkspace(h.store.db, make({ mode: 'new' }).workspace!.id)?.base, baseBranch).toBe(await baseOf(current));
        }
    });

    test('refuses a base that is not a branch of the repository: a tag, a name that exists only on a remote, a missing one', async () => {
        const { h, repo, create } = await setup({ origin: true });

        git(repo, 'tag', 'v1');

        // A base is a branch's own name: not a revision that git would read from it (`main~1`, `main^`, `main@{1}`, the commit of a tag).
        for (const base of ['v1', 'dev', 'nowhere', 'refs/heads/main', '--help', 'main~1', 'main^', 'main@{1}', 'origin/main~0', 'main^{commit}']) {
            expect(create({ mode: 'new', base })).toMatchObject({ ok: false, error: { code: 'invalid', message: `${ base } is not a branch of this repository` } });
        }

        // Not even the commit of a branch, spelled as a hash: only the short hash of a detached HEAD is a base.
        expect(create({ mode: 'new', base: git(repo, 'rev-parse', '--short', 'main') })).toMatchObject({ ok: false, error: { code: 'invalid' } });
        expect(h.store.db.query('SELECT COUNT(*) AS n FROM workspaces').get()).toEqual({ n: 0 });
        expect(h.store.db.query('SELECT COUNT(*) AS n FROM chats').get()).toEqual({ n: 0 });
    });

    test('takes the short hash of a detached HEAD as a commit, and no other hash', async () => {
        const { h, repo, make, create } = await setup();
        const first = git(repo, 'rev-parse', '--short', 'HEAD');

        writeFileSync(join(repo, 'more.txt'), 'more\n');
        git(repo, 'add', '.');
        git(repo, 'commit', '-q', '-m', 'More');
        git(repo, 'checkout', '-q', '--detach');

        const head = git(repo, 'rev-parse', '--short', 'HEAD');

        expect(getWorkspace(h.store.db, make({ mode: 'new', base: head }).workspace!.id)?.base).toBe(head);
        // A commit that is not the one checked out is not a branch either.
        expect(create({ mode: 'new', base: first })).toMatchObject({ ok: false, error: { code: 'invalid' } });
    });

    test('refuses a folder that is not the root of a repository, and a repository with no commit, creating nothing', async () => {
        const { h, project, root, create } = await setup();
        const monorepo = makeRepo(root, 'monorepo');
        const inside = join(monorepo, 'packages');
        const plain = join(root, 'notes');
        const empty = join(root, 'empty');

        mkdirSync(inside);
        mkdirSync(plain);
        mkdirSync(empty);
        git(empty, 'init', '-q', '-b', 'main');

        const folders = (h.ok('project.update', { projectId: project.id, folders: [{ id: project.folders[0].id }, { path: inside }, { path: plain }, { path: empty }] }) as { project: Project }).project.folders;
        const message = 'A worktree needs the root of a git repository, and this folder is not one';

        // A worktree is made of the whole repository: a folder below its root has none of its own.
        expect(create({ mode: 'new' }, { folderId: folders[1].id })).toMatchObject({ ok: false, error: { code: 'invalid', message } });
        expect(create({ mode: 'new' }, { folderId: folders[2].id })).toMatchObject({ ok: false, error: { code: 'invalid', message } });
        expect(create({ mode: 'new' }, { folderId: folders[3].id })).toMatchObject({ ok: false, error: { code: 'invalid', message: 'The repository has no commit to start a worktree from' } });
        expect(h.store.db.query('SELECT COUNT(*) AS n FROM workspaces').get()).toEqual({ n: 0 });
        expect(h.store.db.query('SELECT COUNT(*) AS n FROM chats').get()).toEqual({ n: 0 });
    });

    test('makes the workspace for the folder the chat is made in, not the main one, and refuses a worktree of another folder\'s repository', async () => {
        const { h, project, repo, root, make, create } = await setup();
        const api = makeRepo(root, 'shop-api');
        const folders = (h.ok('project.update', { projectId: project.id, folders: [{ id: project.folders[0].id }, { path: api }] }) as { project: Project }).project.folders;
        const other = join(root, 'shop-api-tree');

        git(api, 'worktree', 'add', '-q', '-b', 'tree', other);

        const chat = make({ mode: 'new' }, { folderId: folders[1].id });

        expect(chat.folderId).toBe(folders[1].id);
        expect(chat.workspace).toMatchObject({ folderId: folders[1].id, path: join(h.config.workspacesDir, 'shop', chat.id.slice(-8), 'shop-api') });
        expect(make({ mode: 'existing', path: other }, { folderId: folders[1].id }).workspace).toMatchObject({ folderId: folders[1].id, path: realpathSync(other), managed: false, ready: true });
        expect(create({ mode: 'existing', path: other })).toMatchObject({ ok: false, error: { code: 'invalid', message: `${ other } is not a worktree of this repository` } });
        expect(create({ mode: 'existing', path: repo }, { folderId: folders[1].id })).toMatchObject({ ok: false, error: { code: 'invalid' } });
    });

    test('records a worktree git lists as found, ready and not Clowdy\'s, and has the chats that pick it share one row', async () => {
        const { h, repo, root, make } = await setup();
        const tree = join(root, 'feature-tree');

        git(repo, 'worktree', 'add', '-q', '-b', 'feature', tree);

        const first = make({ mode: 'existing', path: tree });
        const second = make({ mode: 'existing', path: join(tree, '..', 'feature-tree') });

        expect(first.workspace).toEqual({ id: expect.stringMatching(/^wks_/), folderId: first.folderId!, path: realpathSync(tree), branch: 'feature', managed: false, ready: true });
        expect(second.workspace).toEqual(first.workspace);
        expect(listWorkspacesOfProject(h.store.db, first.projectId)).toHaveLength(1);
        expect(chatsOfWorkspace(h.store.db, first.workspace!.id)).toEqual([first.id, second.id]);
        expect(needsPreparing(first.workspace!)).toBe(false);
    });

    test('refuses a path that git does not list as a worktree of the folder, the folder itself, a relative path and a worktree that is gone', async () => {
        const { h, repo, root, create } = await setup();
        const stray = join(root, 'stray');
        const gone = join(root, 'gone-tree');

        mkdirSync(stray);
        git(repo, 'worktree', 'add', '-q', '-b', 'gone', gone);
        rmSync(gone, { recursive: true });

        expect(create({ mode: 'existing', path: stray })).toMatchObject({ ok: false, error: { code: 'invalid', message: `${ stray } is not a worktree of this repository` } });
        expect(create({ mode: 'existing', path: join(repo, '.git') })).toMatchObject({ ok: false, error: { code: 'invalid' } });
        expect(create({ mode: 'existing', path: repo })).toMatchObject({ ok: false, error: { code: 'invalid', message: 'That is the folder itself, not a worktree of it' } });
        expect(create({ mode: 'existing', path: 'feature-tree' })).toMatchObject({ ok: false, error: { code: 'invalid', message: 'The path of a worktree must be absolute' } });
        expect(create({ mode: 'existing', path: gone })).toMatchObject({ ok: false, error: { code: 'invalid', message: `The worktree ${ gone } is gone from the disk` } });
        expect(h.store.db.query('SELECT COUNT(*) AS n FROM workspaces').get()).toEqual({ n: 0 });
    });

    test('refuses over HTTP a choice that is neither a new worktree nor an existing one', async () => {
        const { h, project } = await setup();
        const post = async (workspace: unknown) => {
            const response = await h.fetch('/v1/commands', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command('chat.create', { projectId: project.id, workspace })) });

            return response.status;
        };

        expect(await post({ mode: 'other' })).toBe(400);
        expect(await post({ mode: 'new', path: '/x' })).toBe(400);
        expect(await post({ mode: 'existing' })).toBe(400);
        expect(await post({ mode: 'new', base: '' })).toBe(400);
        expect(await post({ mode: 'new' })).toBe(200);
    });
});

describe('Prepare workspace', () => {
    test('makes the worktree at the chat\'s first turn from the default branch, and the agent starts in it', async () => {
        const { h, engine, repo, store, chatOf, make, send, stepOf } = await setup();
        const chat = make({ mode: 'new' });
        const { path, branch } = chat.workspace!;
        const cursor = h.store.headCursor();

        await send(chat, 'Fix the page');

        expect(engine.turns.map(turn => turn.cwd)).toEqual([path]);
        expect(existsSync(join(path, 'README.md'))).toBe(true);
        expect(git(path, 'branch', '--show-current')).toBe(branch!);
        expect(git(path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'main'));
        expect(git(repo, 'branch', '--show-current')).toBe('main');
        expect(git(repo, 'status', '--porcelain')).toBe('');
        expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(`branch refs/heads/${ branch }`);
        expect(chatOf(chat.id).workspace).toMatchObject({ path, ready: true });
        expect(getWorkspace(store.db, chat.workspace!.id)?.ready).toBe(true);

        const [step] = stepOf(chat);

        expect(stepOf(chat)).toHaveLength(1);
        expect(step).toMatchObject({ kind: 'tool', toolCallId: `workspace:${ chat.workspace!.id }`, name: 'workspace', state: 'done', input: { path, branch, base: 'main' } });
        expect(step.output).toContain(`Preparing worktree (new branch '${ branch }')`);
        expect(step.output).toContain('HEAD is now at');

        // It comes before everything the agent says, and after the person's message.
        expect(h.run(chatOf(chat.id).orchestratorRunId as string).status).toBe('succeeded');
        expect(listItems(store.db, chatOf(chat.id).orchestratorRunId as string, 0).map(item => item.body.kind)).toEqual(['user', 'tool', 'assistant']);

        // It is published as it runs, and the chat is published once it is ready.
        const events = h.events(cursor);
        const steps = events.flatMap(event => (event.data.type === 'stream.item' && event.data.item.body.kind === 'tool' && event.data.item.body.name === 'workspace' ? [event.data.item.body.state] : []));
        const upserted = events.flatMap(event => (event.data.type === 'chat.upserted' && event.data.chat.id === chat.id ? [event.data.chat] : []));

        expect(steps[0]).toBe('running');
        expect(steps.at(-1)).toBe('done');
        expect(upserted.at(-1)?.workspace?.ready).toBe(true);
    });

    test('starts the branch from the base the chat chose, a remote\'s fetched first', async () => {
        const { remote, engine, repo, make, send } = await setup({ origin: true });
        const { seed } = remote!;

        writeFileSync(join(seed, 'news.txt'), 'new on the remote\n');
        git(seed, 'add', '.');
        git(seed, 'commit', '-q', '-m', 'News');
        git(seed, 'push', '-q', 'origin', 'main');

        const behind = git(repo, 'rev-parse', 'origin/main');
        const chat = make({ mode: 'new' });

        await send(chat, 'Start');

        expect(git(chat.workspace!.path, 'rev-parse', 'HEAD')).toBe(git(seed, 'rev-parse', 'HEAD'));
        expect(git(chat.workspace!.path, 'rev-parse', 'HEAD')).not.toBe(behind);
        expect(readFileSync(join(chat.workspace!.path, 'news.txt'), 'utf8')).toBe('new on the remote\n');
        // The branch has no upstream: a push of it would not go to `main`.
        expect(Bun.spawnSync(['git', 'rev-parse', '--abbrev-ref', `${ chat.workspace!.branch }@{upstream}`], { cwd: repo, stderr: 'pipe' }).exitCode).not.toBe(0);
        expect(engine.turns[0].cwd).toBe(chat.workspace!.path);

        const dev = make({ mode: 'new', base: 'origin/dev' });

        await send(dev, 'Start on dev');
        expect(git(dev.workspace!.path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'origin/dev'));
    });

    test('says in the log that it used the last fetched ref when the fetch fails, and goes on', async () => {
        const { remote, root, repo, make, send, stepOf } = await setup({ origin: true });
        const chat = make({ mode: 'new' });
        const known = git(repo, 'rev-parse', 'origin/main');

        git(repo, 'remote', 'set-url', 'origin', join(root, 'not-there.git'));
        expect(remote).toBeDefined();
        await send(chat, 'Start');

        expect(git(chat.workspace!.path, 'rev-parse', 'HEAD')).toBe(known);

        const [step] = stepOf(chat);

        expect(step.state).toBe('done');
        expect(step.error).toBeUndefined();
        expect(step.output).toContain('Could not fetch, using the last fetched origin/main');
    });

    test('fails the turn with the reason when there is no ref to fall back on, makes nothing, and the next message tries again', async () => {
        const { remote, engine, root, repo, chatOf, make, send, stepOf, items } = await setup({ origin: true });
        const chat = make({ mode: 'new', base: 'origin/dev' });
        const origin = remote!.origin;

        git(repo, 'update-ref', '-d', 'refs/remotes/origin/dev');
        git(repo, 'remote', 'set-url', 'origin', join(root, 'not-there.git'));

        const failed = await send(chat, 'Start', 'failed');

        // The reason is git's first fatal line, not its last line (which is advice for someone at a terminal).
        expect(failed.error).toMatch(/^Couldn't fetch origin\/dev: .* does not appear to be a git repository$/);
        expect(engine.turns).toHaveLength(0);
        expect(existsSync(chat.workspace!.path)).toBe(false);
        expect(chatOf(chat.id).workspace?.ready).toBe(false);
        expect(stepOf(chat)).toEqual([expect.objectContaining({ state: 'error', error: failed.error })]);
        expect(items(chat).map(item => item.body.kind)).toEqual(['user', 'tool', 'error']);

        git(repo, 'remote', 'set-url', 'origin', origin);

        await send(chat, 'Try again');

        expect(engine.turns.map(turn => turn.cwd)).toEqual([chat.workspace!.path]);
        expect(git(chat.workspace!.path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'origin/dev'));
        expect(stepOf(chat).map(body => body.state)).toEqual(['error', 'done']);
        expect(chatOf(chat.id).workspace?.ready).toBe(true);
    });

    test('uses an existing worktree as it is: no step, and the agent starts in it', async () => {
        const { engine, repo, root, make, send, stepOf, chatOf } = await setup();
        const tree = join(root, 'feature-tree');

        git(repo, 'worktree', 'add', '-q', '-b', 'feature', tree);
        writeFileSync(join(tree, 'wip.txt'), 'not committed\n');
        writeFileSync(join(tree, 'README.md'), '# Changed, not committed\n');

        const before = stateOf(tree);
        const chat = make({ mode: 'existing', path: tree });

        await send(chat, 'Carry on');

        expect(engine.turns.map(turn => turn.cwd)).toEqual([realpathSync(tree)]);
        expect(stepOf(chat)).toEqual([]);
        expect(stateOf(tree)).toEqual(before);
        expect(chatOf(chat.id).workspace?.ready).toBe(true);
    });

    test('leaves a worktree with uncommitted and committed work exactly as it is on later turns, and for another chat that works in it', async () => {
        const { engine, repo, make, send, stepOf, sentOf } = await setup();
        const chat = make({ mode: 'new' });
        const { path, branch } = chat.workspace!;

        await send(chat, 'Start');

        // The agent worked: a commit, a change that is not committed, a new file, a stash.
        writeFileSync(join(path, 'done.txt'), 'committed work\n');
        git(path, 'add', 'done.txt');
        git(path, 'commit', '-q', '-m', 'Work');
        writeFileSync(join(path, 'README.md'), '# Edited, not committed\n');
        writeFileSync(join(path, 'draft.txt'), 'untracked\n');
        writeFileSync(join(path, 'stashed.txt'), 'to the stash\n');
        git(path, 'add', 'stashed.txt');
        git(path, 'stash', 'push', '-q', '-m', 'aside');

        const before = stateOf(path);
        const mainBefore = stateOf(repo);

        await send(chat, 'Go on');
        expect(stateOf(path)).toEqual(before);
        expect(stepOf(chat)).toHaveLength(1);

        // Another chat on the same worktree, picked from the list of existing ones.
        const second = make({ mode: 'existing', path });

        expect(second.workspace).toMatchObject({ path, managed: true, ready: true, branch });
        await send(second, 'Join in');
        expect(stateOf(path)).toEqual(before);
        expect(stepOf(second)).toEqual([]);
        expect(sentOf({ path })).toHaveLength(3);
        expect(engine.turns.at(-1)?.cwd).toBe(path);

        expect(stateOf(repo)).toEqual(mainBefore);
    });

    test('leaves a worktree that is there but was never marked ready as it is, and marks it ready', async () => {
        const { store, repo, make, send, stepOf, chatOf } = await setup();
        const chat = make({ mode: 'new' });

        await send(chat, 'Make it');
        writeFileSync(join(chat.workspace!.path, 'draft.txt'), 'work\n');
        git(chat.workspace!.path, 'checkout', '-q', '-b', 'moved-on');

        // The process died after git made the worktree and before the row said so.
        store.tx(() => updateWorkspace(store.db, chat.workspace!.id, { ready: false }));
        expect(needsPreparing(chatOf(chat.id).workspace!)).toBe(true);

        const before = stateOf(chat.workspace!.path);

        await send(chat, 'Again');

        expect(stateOf(chat.workspace!.path)).toEqual(before);
        expect(git(chat.workspace!.path, 'branch', '--show-current')).toBe('moved-on');
        expect(stepOf(chat).map(body => body.state)).toEqual(['done', 'done']);
        expect(stepOf(chat)[1].output).toContain('is there already, left as it is');
        expect(chatOf(chat.id).workspace?.ready).toBe(true);
        expect(git(repo, 'status', '--porcelain')).toBe('');
    });

    test('refuses a path that is there and is no worktree of the repository, leaving it as it is, and makes the worktree once the way is clear', async () => {
        const { engine, repo, root, make, send, stepOf, chatOf } = await setup();
        const chat = make({ mode: 'new' });
        const { path, branch } = chat.workspace!;

        // Somebody's folder with a file in it, and then another repository's worktree, where the chat's worktree should go.
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, 'mine.txt'), 'not yours\n');

        const failed = await send(chat, 'Start', 'failed');

        expect(failed.error).toBe(`${ path } exists and is not a worktree of ${ repo }, so it was left alone`);
        expect(readFileSync(join(path, 'mine.txt'), 'utf8')).toBe('not yours\n');
        expect(git(repo, 'branch', '--list', branch!)).toBe('');
        expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(path);
        expect(engine.turns).toHaveLength(0);
        expect(chatOf(chat.id).workspace?.ready).toBe(false);
        expect(stepOf(chat)).toEqual([expect.objectContaining({ state: 'error', error: failed.error })]);

        rmSync(path, { recursive: true });

        const stranger = makeRepo(root, 'stranger');

        git(stranger, 'worktree', 'add', '-q', '-b', 'theirs', path);
        writeFileSync(join(path, 'theirs.txt'), 'their work\n');

        const before = stateOf(path);
        const refused = await send(chat, 'Start again', 'failed');

        expect(refused.error).toBe(`${ path } exists and is not a worktree of ${ repo }, so it was left alone`);
        expect(stateOf(path)).toEqual(before);
        expect(git(repo, 'branch', '--list', branch!)).toBe('');
        expect(engine.turns).toHaveLength(0);

        git(stranger, 'worktree', 'remove', '--force', path);
        await send(chat, 'Start for good');
        expect(engine.turns.map(turn => turn.cwd)).toEqual([path]);
        expect(stepOf(chat).map(body => body.state)).toEqual(['error', 'error', 'done']);
    });

    test('refuses a branch another worktree has checked out, taking nothing over, and uses the branch as it is when the way is clear', async () => {
        const { engine, repo, root, make, send, stepOf } = await setup();
        const chat = make({ mode: 'new' });
        const { path, branch } = chat.workspace!;
        const elsewhere = join(root, 'by-hand');

        // A person made the branch and has work on it, in a worktree of their own.
        git(repo, 'worktree', 'add', '-q', '-b', branch!, elsewhere);
        writeFileSync(join(elsewhere, 'theirs.txt'), 'their work\n');
        git(elsewhere, 'add', '.');
        git(elsewhere, 'commit', '-q', '-m', 'Theirs');
        writeFileSync(join(elsewhere, 'wip.txt'), 'not committed\n');

        const before = stateOf(elsewhere);
        const failed = await send(chat, 'Start', 'failed');

        expect(failed.error).toBe(`The branch ${ branch } is already checked out in ${ realpathSync(elsewhere) }`);
        expect(existsSync(path)).toBe(false);
        expect(stateOf(elsewhere)).toEqual(before);
        expect(engine.turns).toHaveLength(0);

        git(repo, 'worktree', 'remove', '--force', elsewhere);
        await send(chat, 'Try again');

        // The branch is checked out as it is, with the commit the person made on it.
        expect(engine.turns.map(turn => turn.cwd)).toEqual([path]);
        expect(readFileSync(join(path, 'theirs.txt'), 'utf8')).toBe('their work\n');
        expect(existsSync(join(path, 'wip.txt'))).toBe(false);
        expect(stepOf(chat).map(body => body.state)).toEqual(['error', 'done']);
    });

    test('makes a worktree of its own again when it is gone from the disk, from the branch with its work, and forgets the stale record', async () => {
        const { engine, repo, make, send, stepOf, chatOf } = await setup();
        const chat = make({ mode: 'new' });
        const { path, branch } = chat.workspace!;

        await send(chat, 'Start');
        writeFileSync(join(path, 'done.txt'), 'committed\n');
        git(path, 'add', '.');
        git(path, 'commit', '-q', '-m', 'Work');

        const commit = git(path, 'rev-parse', 'HEAD');

        expect(needsPreparing(chatOf(chat.id).workspace!)).toBe(false);
        rmSync(path, { recursive: true });
        expect(needsPreparing(chatOf(chat.id).workspace!)).toBe(true);
        // Git still thinks the worktree is there.
        expect(git(repo, 'worktree', 'list', '--porcelain')).toContain('prunable');

        await send(chat, 'Come back');

        expect(engine.turns.map(turn => turn.cwd)).toEqual([path, path]);
        expect(git(path, 'rev-parse', 'HEAD')).toBe(commit);
        expect(git(path, 'branch', '--show-current')).toBe(branch!);
        expect(readFileSync(join(path, 'done.txt'), 'utf8')).toBe('committed\n');
        expect(git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree '))).toHaveLength(2);
        expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('prunable');
        expect(stepOf(chat).map(body => body.state)).toEqual(['done', 'done']);
        expect(stepOf(chat)[1].output).toContain('is gone from the disk');
        expect(chatOf(chat.id).workspace?.ready).toBe(true);
    });

    test('never makes again a worktree it found: a turn on one that is gone fails saying so, and nothing is made', async () => {
        const { engine, repo, root, make, send, stepOf } = await setup();
        const tree = join(root, 'feature-tree');

        git(repo, 'worktree', 'add', '-q', '-b', 'feature', tree);

        const chat = make({ mode: 'existing', path: tree });
        const path = chat.workspace!.path;

        rmSync(tree, { recursive: true });

        const failed = await send(chat, 'Carry on', 'failed');

        expect(failed.error).toBe(`The folder ${ path } no longer exists`);
        expect(existsSync(tree)).toBe(false);
        expect(engine.turns).toHaveLength(0);
        expect(stepOf(chat)).toEqual([]);
        expect(git(repo, 'worktree', 'list', '--porcelain')).toContain('prunable');
    });

    test('refuses a worktree git still has locked as being made, which a crash leaves, and leaves it as it is', async () => {
        const { engine, repo, store, make, send, stepOf, chatOf } = await setup();
        const chat = make({ mode: 'new' });
        const { path } = chat.workspace!;

        await send(chat, 'Start');
        writeFileSync(join(path, 'half.txt'), 'who knows\n');
        // What `git worktree add` leaves when the process dies in the middle of the checkout.
        git(repo, 'worktree', 'lock', '--reason', 'initializing', path);
        store.tx(() => updateWorkspace(store.db, chat.workspace!.id, { ready: false }));

        const before = stateOf(path);
        const failed = await send(chat, 'Again', 'failed');

        expect(failed.error).toBe(`A previous attempt to make the worktree ${ path } was cut off, and git still has it locked, so it was left alone`);
        expect(stateOf(path)).toEqual(before);
        expect(git(repo, 'worktree', 'list', '--porcelain')).toContain('locked initializing');
        expect(engine.turns).toHaveLength(1);
        expect(chatOf(chat.id).workspace?.ready).toBe(false);
        expect(stepOf(chat).map(body => body.state)).toEqual(['done', 'error']);
    });

    test('does not force the record of a missing worktree that is locked: the turn fails with git\'s reason and nothing is made', async () => {
        const { repo, make, send, chatOf } = await setup();
        const chat = make({ mode: 'new' });
        const { path, branch } = chat.workspace!;

        await send(chat, 'Start');
        git(repo, 'worktree', 'lock', path);
        rmSync(path, { recursive: true });

        const failed = await send(chat, 'Again', 'failed');

        expect(failed.error).toMatch(/^Couldn't forget the missing worktree: cannot remove a locked working tree/);
        expect(failed.error).not.toContain('-f -f');
        expect(existsSync(path)).toBe(false);
        expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(`branch refs/heads/${ branch }`);
        expect(chatOf(chat.id).workspace?.ready).toBe(true);
    });

    test('is made once when two chats come to one worktree together, and the second finds it ready', async () => {
        const { h, repo, project, store, make } = await setup();
        const chat = make({ mode: 'new' });
        const { path } = chat.workspace!;
        const { runs } = h.daemon.services;
        // Two runs of the chat that were never launched: only their streams are written to.
        const runOf = () => runs.createRun({ project, role: 'orchestrator', chatId: chat.id, summary: 'Race', engine: 'fake', nextPrompt: 'Go' });
        const first = runOf();
        const second = runOf();

        await Promise.all([
            prepareWorkspace(store, chat.workspace!.id, { runId: first.id }),
            prepareWorkspace(store, chat.workspace!.id, { runId: second.id }),
            prepareWorkspace(store, chat.workspace!.id, { runId: second.id }),
        ]);

        const steps = [first, second].map(run => listItems(store.db, run.id, 0).filter(item => item.body.kind === 'tool'));

        expect(existsSync(join(path, 'README.md'))).toBe(true);
        expect(steps.map(list => list.length)).toEqual([1, 0]);
        expect(git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree '))).toHaveLength(2);
        expect(getWorkspace(store.db, chat.workspace!.id)?.ready).toBe(true);
    });

    test('is ended by a stop that came first: nothing is written and nothing is made', async () => {
        const { h, project, store, make } = await setup();
        const chat = make({ mode: 'new' });
        const run = h.daemon.services.runs.createRun({ project, role: 'orchestrator', chatId: chat.id, summary: 'Stop', engine: 'fake', nextPrompt: 'Go' });
        const stop = new AbortController();

        stop.abort();

        await expect(prepareWorkspace(store, chat.workspace!.id, { runId: run.id, signal: stop.signal })).rejects.toThrow();
        expect(listItems(store.db, run.id, 0)).toEqual([]);
        expect(existsSync(chat.workspace!.path)).toBe(false);
        expect(getWorkspace(store.db, chat.workspace!.id)?.ready).toBe(false);
    });

    test.skipIf(process.platform === 'win32')('is ended by a stop in the middle of a fetch that hangs: git and what it started are killed, and the step ends as stopped', async () => {
        const { h, project, repo, remote, store, make } = await setup({ origin: true });
        const chat = make({ mode: 'new' });
        const run = h.daemon.services.runs.createRun({ project, role: 'orchestrator', chatId: chat.id, summary: 'Stop', engine: 'fake', nextPrompt: 'Go' });
        const stop = new AbortController();

        // A remote whose transport never answers (git runs the command as the transport, once it is let to).
        const allowed = process.env.GIT_ALLOW_PROTOCOL;

        process.env.GIT_ALLOW_PROTOCOL = 'ext';
        git(repo, 'remote', 'set-url', 'origin', 'ext::sleep 30');

        const startedAt = Date.now();
        const preparing = prepareWorkspace(store, chat.workspace!.id, { runId: run.id, signal: stop.signal });

        try {
            await waitFor(() => listItems(store.db, run.id, 0).some(item => item.body.kind === 'tool' && String(item.body.output).includes('Fetching origin/main')), 'the fetch to start');
            // The fetch is running: it has had time to start its transport.
            await Bun.sleep(300);
            stop.abort();

            await expect(preparing).rejects.toThrow(STOPPED_TOOL);
        }
        finally {
            if (allowed === undefined) {
                delete process.env.GIT_ALLOW_PROTOCOL;
            }
            else {
                process.env.GIT_ALLOW_PROTOCOL = allowed;
            }
        }

        expect(Date.now() - startedAt).toBeLessThan(8000);
        expect(listItems(store.db, run.id, 0).map(item => item.body)).toEqual([expect.objectContaining({ kind: 'tool', name: 'workspace', state: 'error', error: STOPPED_TOOL })]);
        expect(existsSync(chat.workspace!.path)).toBe(false);
        expect(getWorkspace(store.db, chat.workspace!.id)?.ready).toBe(false);

        // Nobody holds the place any more: a later turn is not kept waiting.
        git(repo, 'remote', 'set-url', 'origin', remote!.origin);
        await prepareWorkspace(store, chat.workspace!.id, { runId: run.id });
        expect(existsSync(join(chat.workspace!.path, 'README.md'))).toBe(true);
    });
});

const posix = process.platform !== 'win32';

describe('the setup of a new worktree', () => {
    /** The text of the step's log, as the person reads it. */
    const logOf = (step: { output?: unknown } | undefined) => String(step?.output ?? '');

    test('copies the files the folder lists that exist in the main checkout, a `*` pattern too, into the same place, and says so in the log', async () => {
        const { repo, make, send, stepOf, chatOf, configure } = await setup();

        writeFileSync(join(repo, '.env'), 'TOKEN=1\n');
        writeFileSync(join(repo, '.env.local'), 'LOCAL=1\n');
        writeFileSync(join(repo, '.envrc'), 'use flake\n');
        writeFileSync(join(repo, 'secret.txt'), 'not listed\n');
        mkdirSync(join(repo, '.env.d'));
        writeFileSync(join(repo, '.env.d', 'inside.txt'), 'in a folder\n');
        mkdirSync(join(repo, 'apps', 'web'), { recursive: true });
        writeFileSync(join(repo, 'apps', 'web', '.env'), 'WEB=1\n');

        if (posix) {
            chmodSync(join(repo, '.env'), 0o600);
        }

        configure({ setup: { files: ['.env*', 'apps/web/.env', 'missing.txt', 'nowhere/.env', 'nowhere/*.env'] } });

        const chat = make({ mode: 'new' });
        const { path } = chat.workspace!;

        await send(chat, 'Start');

        // The worktree has them, in the same places; the folder is as it was; what is not listed, and a folder, stays out.
        expect(readFileSync(join(path, '.env'), 'utf8')).toBe('TOKEN=1\n');
        expect(readFileSync(join(path, '.env.local'), 'utf8')).toBe('LOCAL=1\n');
        expect(readFileSync(join(path, '.envrc'), 'utf8')).toBe('use flake\n');
        expect(readFileSync(join(path, 'apps', 'web', '.env'), 'utf8')).toBe('WEB=1\n');
        expect(existsSync(join(path, 'secret.txt'))).toBe(false);
        expect(existsSync(join(path, '.env.d'))).toBe(false);
        expect(existsSync(join(path, 'nowhere'))).toBe(false);
        expect(readFileSync(join(repo, '.env'), 'utf8')).toBe('TOKEN=1\n');

        if (posix) {
            expect(statSync(join(path, '.env')).mode & 0o777).toBe(0o600);
        }

        // A file the folder has and the worktree has not is worked on in the worktree only: git sees nothing new in the folder.
        expect(git(repo, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(line => line.includes('apps/web'))).toEqual(['?? apps/web/.env']);

        const [step] = stepOf(chat);
        const log = logOf(step);

        expect(step.state).toBe('done');
        expect(log.split('\n').filter(line => line.startsWith('Copied '))).toEqual(['Copied .env', 'Copied .env.local', 'Copied .envrc', 'Copied apps/web/.env']);
        // A file that is not in the folder is not worth a line, and no command is run when there is none.
        expect(log).not.toContain('missing.txt');
        expect(log).not.toContain('nowhere');
        expect(log).not.toContain('Running the setup command');
        expect(chatOf(chat.id).workspace?.ready).toBe(true);
    });

    test('leaves a file the worktree has already as it is, and git\'s own `.git` file of it, when the folder lists them', async () => {
        const { repo, make, send, stepOf, configure } = await setup();

        writeFileSync(join(repo, 'config.json'), 'committed\n');
        writeFileSync(join(repo, 'start.sh'), 'echo start\n');
        git(repo, 'add', '.');
        git(repo, 'commit', '-q', '-m', 'Config');
        // The person's own changes in the folder, which the worktree (a checkout of the commit) does not have.
        writeFileSync(join(repo, 'config.json'), 'changed in the folder, not committed\n');
        writeFileSync(join(repo, '.env'), 'FROM=folder\n');

        configure({ setup: { files: ['config.json', 'start.sh', '.env', '.*'] } });

        const chat = make({ mode: 'new' });
        const { path } = chat.workspace!;

        await send(chat, 'Start');

        expect(readFileSync(join(path, 'config.json'), 'utf8')).toBe('committed\n');
        expect(readFileSync(join(path, '.env'), 'utf8')).toBe('FROM=folder\n');
        // The `.git` of a worktree is the file that points at the repository: the folder's `.git` folder is never copied over it.
        expect(statSync(join(path, '.git')).isFile()).toBe(true);
        expect(readFileSync(join(path, '.git'), 'utf8')).toMatch(/^gitdir: /);
        expect(git(path, 'rev-parse', '--show-toplevel')).toBe(realpathSync(path));

        const log = logOf(stepOf(chat)[0]);

        expect(log).toContain('Kept config.json: the worktree has it already');
        expect(log).toContain('Copied .env');
        expect(log).not.toContain('Copied config.json');
        expect(log).not.toContain('.git/');
        expect(log).not.toContain('Copied .git');
    });

    test.skipIf(!posix)('copies what lies inside the folder and nothing that a path, a link or a pattern would reach outside it or in .git', async () => {
        const root = tempDir('chat-workspaces-copy');
        const main = join(root, 'main');
        const tree = join(root, 'tree');
        const outside = join(root, 'outside');
        const treeOutside = join(root, 'tree-outside');
        const lines: string[] = [];

        for (const dir of [main, tree, outside, treeOutside, join(main, '.git'), join(main, 'dir'), join(main, 'ext'), join(main, 'config'), join(main, 'dang')]) {
            mkdirSync(dir, { recursive: true });
        }

        writeFileSync(join(outside, 'secret.txt'), 'outside the folder\n');
        writeFileSync(join(main, '.git', 'config'), 'the repository\n');
        writeFileSync(join(main, '.git', 'HEAD'), 'ref\n');
        writeFileSync(join(main, 'a.txt'), 'a\n');
        writeFileSync(join(main, 'dir', 'f.txt'), 'in a folder\n');
        writeFileSync(join(main, 'ext', '.env'), 'for the link in the worktree\n');
        writeFileSync(join(root, 'above.txt'), 'above the folder\n');
        // Links of the folder: out of it to a file and to a folder, and one to a file inside it.
        symlinkSync(join(outside, 'secret.txt'), join(main, 'link-out.txt'));
        symlinkSync(outside, join(main, 'linkdir'), 'dir');
        symlinkSync(join(main, '.git', 'config'), join(main, 'link-git.txt'));
        symlinkSync('a.txt', join(main, 'in-link.txt'));
        symlinkSync(join(root, 'gone.txt'), join(main, 'dangling.txt'));
        // A link of the worktree to a place outside it, where `ext/.env` would be written.
        symlinkSync(treeOutside, join(tree, 'ext'), 'dir');
        // What the worktree has on the way or in the place: a file where a folder is wanted, a link with nothing behind it, and a link at the file itself.
        writeFileSync(join(main, 'config', '.env'), 'for a file in the worktree\n');
        writeFileSync(join(main, 'dang', '.env'), 'for a dangling link in the worktree\n');
        writeFileSync(join(main, 'kept.txt'), 'for a link in the worktree\n');
        writeFileSync(join(tree, 'config'), 'a file, tracked\n');
        symlinkSync(join(root, 'nowhere'), join(tree, 'dang'), 'dir');
        symlinkSync(join(root, 'nowhere-file'), join(tree, 'kept.txt'));
        // A link of the folder that loops: only a `*` matches it, and that is no reason to stop.
        symlinkSync('loop-b', join(main, 'loop-a'));
        symlinkSync('loop-a', join(main, 'loop-b'));

        await copySetupFiles({
            root: main,
            workspace: tree,
            files: ['../outside/secret.txt', '../above.txt', join(outside, 'secret.txt'), 'sub/../../outside/secret.txt', '.git/config', '.GIT/HEAD', '.git./HEAD', 'git~1/HEAD', 'a\\b', 'C:/x', 'link-out.txt', 'link-git.txt',
                'linkdir/secret.txt', 'linkdir/*', 'dir', 'dir/*', 'in-link.txt', 'dangling.txt', 'ext/.env', 'config/.env', 'dang/.env', 'kept.txt', 'a.txt', '.*', '*'],
            log: line => lines.push(line),
        });

        // Only what lies inside the folder, as a plain file: a link to a file inside it is copied as the file it leads to.
        expect(readdirSync(tree).sort()).toEqual(['a.txt', 'config', 'dang', 'dir', 'ext', 'in-link.txt', 'kept.txt']);
        expect(readFileSync(join(tree, 'a.txt'), 'utf8')).toBe('a\n');
        expect(readFileSync(join(tree, 'dir', 'f.txt'), 'utf8')).toBe('in a folder\n');
        expect(lstatSync(join(tree, 'in-link.txt')).isFile()).toBe(true);
        expect(readFileSync(join(tree, 'in-link.txt'), 'utf8')).toBe('a\n');
        // Nothing went through the worktree's link, nothing was made outside, and the folder's own files are as they were.
        expect(readdirSync(treeOutside)).toEqual([]);
        expect(readdirSync(outside)).toEqual(['secret.txt']);
        expect(readdirSync(root).sort()).toEqual(['above.txt', 'main', 'outside', 'tree', 'tree-outside']);
        // The worktree's own file, link and dangling link are as they were, and nothing was made through them.
        expect(readFileSync(join(tree, 'config'), 'utf8')).toBe('a file, tracked\n');
        expect(lstatSync(join(tree, 'dang')).isSymbolicLink()).toBe(true);
        expect(lstatSync(join(tree, 'kept.txt')).isSymbolicLink()).toBe(true);
        expect(existsSync(join(root, 'nowhere'))).toBe(false);
        expect(existsSync(join(root, 'nowhere-file'))).toBe(false);
        expect(readFileSync(join(main, '.git', 'config'), 'utf8')).toBe('the repository\n');
        expect(lines.filter(line => line.startsWith('Copied '))).toEqual(['Copied dir/f.txt', 'Copied in-link.txt', 'Copied a.txt']);
        expect(lines.join('\n')).toContain('Skipped ../outside/secret.txt: it is not a path inside the folder');
        expect(lines.join('\n')).toContain('Skipped .git/config: it is in .git');
        expect(lines.join('\n')).toContain('Skipped link-out.txt: it leads out of the folder');
        expect(lines.join('\n')).toContain('Skipped ext/.env: the worktree has a link on its way that leads out of it');
        expect(lines.join('\n')).toContain('Skipped config/.env: the worktree has something else on its way');
        expect(lines.join('\n')).toContain('Skipped dang/.env: the worktree has something else on its way');
        expect(lines.join('\n')).toContain('Kept kept.txt: the worktree has it already');
        expect(lines.join('\n')).toContain('Skipped loop-a: couldn\'t copy it (ELOOP)');
    });

    test.skipIf(!posix)('fails the step with the errno for a file the entry names and cannot be read, and takes a pattern\'s misses as lines; a pattern of many stars is quick', async () => {
        const root = tempDir('chat-workspaces-copy-errors');
        const main = join(root, 'main');
        const tree = join(root, 'tree');
        const lines: string[] = [];

        mkdirSync(main);
        mkdirSync(tree);
        symlinkSync('loop-b', join(main, 'loop-a'));
        symlinkSync('loop-a', join(main, 'loop-b'));
        writeFileSync(join(main, 'a'.repeat(40)), 'a long name\n');

        // An entry that names a link that loops is the person's mistake, which the step says.
        await expect(copySetupFiles({ root: main, workspace: tree, files: ['loop-a'], log: line => lines.push(line) })).rejects.toThrow('Couldn\'t copy loop-a: ELOOP');

        // Backtracking over a long name made a regular expression of the same pattern take about half a second, and more with every star.
        const startedAt = Date.now();

        await copySetupFiles({ root: main, workspace: tree, files: ['*a*a*a*a*a*a*a*a*a*a*b'], log: line => lines.push(line) });
        expect(Date.now() - startedAt).toBeLessThan(200);
        expect(readdirSync(tree)).toEqual([]);

        await copySetupFiles({ root: main, workspace: tree, files: ['a*a*a*', '*aaa', 'a**a'], log: line => lines.push(line) });
        expect(readdirSync(tree)).toEqual(['a'.repeat(40)]);
    });

    test.skipIf(!posix)('runs the command in the worktree after the copy, with the paths and the branch in its environment, and its output in the log', async () => {
        const { h, engine, repo, folder, make, send, stepOf, chatOf, configure } = await setup();
        const marker = 'CLOWDY_SETUP_TEST_LEAK';
        const own = process.env.CLOWDY_ROOT_PATH;

        writeFileSync(join(repo, '.env'), 'TOKEN=1\n');
        configure({ setup: { files: ['.env'], command: 'echo "root=$CLOWDY_ROOT_PATH"\necho "workspace=$CLOWDY_WORKSPACE_PATH"\necho "branch=$CLOWDY_BRANCH"\necho "leak=$CLOWDY_SETUP_TEST_LEAK"\necho "problem" >&2\npwd > cwd.txt\ncat .env > seen-env.txt\ntouch ready' } });

        const chat = make({ mode: 'new' });
        const { path, branch } = chat.workspace!;

        // The daemon's own variables of the same names must not stand in for the three, and its settings are not handed on.
        process.env.CLOWDY_ROOT_PATH = '/the/daemons/own';
        process.env[marker] = 'secret';

        try {
            await send(chat, 'Start');
        }
        finally {
            if (own === undefined) {
                delete process.env.CLOWDY_ROOT_PATH;
            }
            else {
                process.env.CLOWDY_ROOT_PATH = own;
            }

            delete process.env[marker];
        }

        // `ready` is what the command made, in the worktree; the `.env` was copied before it ran, so it saw it.
        expect(existsSync(join(path, 'ready'))).toBe(true);
        expect(readFileSync(join(path, 'seen-env.txt'), 'utf8')).toBe('TOKEN=1\n');
        expect(readFileSync(join(path, 'cwd.txt'), 'utf8').trim()).toBe(realpathSync(path));
        expect(existsSync(join(repo, 'ready'))).toBe(false);

        const [step] = stepOf(chat);
        const lines = logOf(step).split('\n');

        expect(step.state).toBe('done');
        // In order: git's lines, the copy, the command's own lines (what it wrote to stderr too).
        expect(lines.indexOf('Copied .env')).toBeGreaterThan(lines.findIndex(line => line.startsWith('HEAD is now at')));
        expect(lines.indexOf('Running the setup command')).toBeGreaterThan(lines.indexOf('Copied .env'));
        expect(lines.slice(lines.indexOf('Running the setup command') + 1).sort()).toEqual([`branch=${ branch }`, 'leak=', 'problem', `root=${ folder.path }`, `workspace=${ path }`].sort());
        expect(chatOf(chat.id).workspace?.ready).toBe(true);
        expect(engine.turns.map(turn => turn.cwd)).toEqual([path]);
        expect(h.run(chatOf(chat.id).orchestratorRunId as string).status).toBe('succeeded');
    });

    test.skipIf(!posix)('keeps the start of a line that is very long, so the log that is written again and again stays small', async () => {
        const { make, send, stepOf, configure } = await setup();
        const chat = make({ mode: 'new' });

        configure({ setup: { command: 'head -c 5000 /dev/zero | tr "\\0" x; echo\necho after' } });
        await send(chat, 'Start');

        const lines = logOf(stepOf(chat)[0]).split('\n');
        const long = lines.find(line => line.startsWith('xxxx'))!;

        expect(long).toBe(`${ 'x'.repeat(400) }…`);
        expect(lines.at(-1)).toBe('after');
    });

    test.skipIf(!posix)('fails the turn with the reason when the command fails, keeps the worktree and its files, and the next message runs only the setup again', async () => {
        const { engine, repo, root, make, send, stepOf, chatOf, configure } = await setup();
        const flag = join(root, 'flag');

        writeFileSync(join(repo, '.env'), 'FROM=folder\n');
        configure({ setup: { files: ['.env'], command: `echo trying\ntest -f '${ flag }' || { echo "no flag yet"; exit 7; }\ntouch done` } });

        const chat = make({ mode: 'new' });
        const { path } = chat.workspace!;
        const failed = await send(chat, 'Start', 'failed');

        expect(failed.error).toBe('The setup command failed with exit code 7');
        expect(engine.turns).toHaveLength(0);
        expect(chatOf(chat.id).workspace?.ready).toBe(false);
        expect(stepOf(chat)).toEqual([expect.objectContaining({ state: 'error', error: failed.error })]);
        expect(logOf(stepOf(chat)[0])).toContain('no flag yet');
        // The worktree is made, and stays with what was copied.
        expect(git(path, 'rev-parse', '--show-toplevel')).toBe(realpathSync(path));
        expect(readFileSync(join(path, '.env'), 'utf8')).toBe('FROM=folder\n');
        expect(existsSync(join(path, 'done'))).toBe(false);

        // The person worked in the worktree meanwhile, and the cause is gone.
        writeFileSync(join(path, '.env'), 'EDITED=1\n');
        writeFileSync(join(path, 'wip.txt'), 'not committed\n');
        writeFileSync(flag, '');
        await send(chat, 'Again');

        expect(engine.turns.map(turn => turn.cwd)).toEqual([path]);
        expect(chatOf(chat.id).workspace?.ready).toBe(true);
        expect(existsSync(join(path, 'done'))).toBe(true);
        // The worktree was not made again, and a copy never goes over a file.
        expect(readFileSync(join(path, '.env'), 'utf8')).toBe('EDITED=1\n');
        expect(readFileSync(join(path, 'wip.txt'), 'utf8')).toBe('not committed\n');
        expect(stepOf(chat).map(body => body.state)).toEqual(['error', 'done']);

        const log = logOf(stepOf(chat)[1]);

        expect(log).toContain('is there already, left as it is');
        expect(log).toContain('Kept .env: the worktree has it already');
        expect(log).toContain('trying');
        expect(log).not.toContain('Preparing worktree');
    });

    test.skipIf(!posix)('stops a command that runs over the time, with everything it started, and fails the turn; the next message runs it again', async () => {
        const { engine, repo, make, send, stepOf, chatOf, configure } = await setup({ timings: { ...SHORT_TIMINGS, setupMs: 1000 } });
        const survived = join(repo, 'survived');
        const chat = make({ mode: 'new' });
        const { path } = chat.workspace!;

        // A child in the background, which would leave its mark after the command was stopped if the stop reached the command only.
        configure({ setup: { command: `(sleep 2; touch '${ survived }') &\necho started\nsleep 30` } });

        const startedAt = Date.now();
        const failed = await send(chat, 'Start', 'failed');

        expect(failed.error).toBe('The setup command was stopped after 1 second');
        expect(Date.now() - startedAt).toBeLessThan(8000);
        expect(logOf(stepOf(chat)[0])).toContain('started');
        expect(engine.turns).toHaveLength(0);
        expect(chatOf(chat.id).workspace?.ready).toBe(false);
        expect(existsSync(path)).toBe(true);

        await Bun.sleep(2500);
        expect(existsSync(survived)).toBe(false);

        configure({ setup: { command: 'touch done' } });
        await send(chat, 'Again');
        expect(existsSync(join(path, 'done'))).toBe(true);
        expect(chatOf(chat.id).workspace?.ready).toBe(true);
        expect(stepOf(chat).map(body => body.state)).toEqual(['error', 'done']);
    });

    test.skipIf(!posix)('is stopped by the Stop of the turn: the command and what it started are killed, the item ends as stopped and the worktree is not ready', async () => {
        const { h, engine, repo, make, stepOf, chatOf, runOf, configure } = await setup();
        const survived = join(repo, 'survived');
        const chat = make({ mode: 'new' });

        configure({ setup: { command: `(sleep 2; touch '${ survived }') &\necho started\nsleep 30` } });
        h.ok('chat.send', { chatId: chat.id, text: 'Start' });
        await waitFor(() => chatOf(chat.id).orchestratorRunId && logOf(stepOf(chat)[0]).includes('started'), 'the command to start');

        const stoppedAt = Date.now();

        h.ok('run.cancel', { runId: chatOf(chat.id).orchestratorRunId });
        await waitFor(() => runOf(chat.id).status === 'cancelled' && stepOf(chat)[0]?.state === 'error', 'the run to be cancelled and the step to end');
        expect(Date.now() - stoppedAt).toBeLessThan(5000);
        expect(stepOf(chat)).toEqual([expect.objectContaining({ state: 'error', error: STOPPED_TOOL })]);
        expect(engine.turns).toHaveLength(0);
        expect(chatOf(chat.id).workspace?.ready).toBe(false);

        await Bun.sleep(2500);
        expect(existsSync(survived)).toBe(false);

        // The next message finds the worktree there and runs the setup again.
        configure({ setup: { command: 'touch done' } });
        h.ok('chat.send', { chatId: chat.id, text: 'Go on' });
        await waitFor(() => chatOf(chat.id).workspace?.ready, 'the worktree to be set up');
        expect(existsSync(join(chat.workspace!.path, 'done'))).toBe(true);
    });

    test.skipIf(!posix)('is stopped by a Stop that comes while the command runs, whatever it started', async () => {
        const { h, project, store, repo, make, configure } = await setup();
        const chat = make({ mode: 'new' });
        const { path } = chat.workspace!;
        const run = h.daemon.services.runs.createRun({ project, role: 'orchestrator', chatId: chat.id, summary: 'Stop', engine: 'fake', nextPrompt: 'Go' });
        const stop = new AbortController();
        const survived = join(repo, 'survived');

        configure({ setup: { command: `(sleep 2; touch '${ survived }') &\necho started\nsleep 30` } });

        const startedAt = Date.now();
        const preparing = prepareWorkspace(store, chat.workspace!.id, { runId: run.id, signal: stop.signal });

        await waitFor(() => listItems(store.db, run.id, 0).some(item => item.body.kind === 'tool' && String(item.body.output).includes('started')), 'the command to start');
        stop.abort();
        await expect(preparing).rejects.toThrow(STOPPED_TOOL);
        expect(Date.now() - startedAt).toBeLessThan(8000);
        expect(listItems(store.db, run.id, 0).map(item => item.body)).toEqual([expect.objectContaining({ kind: 'tool', name: 'workspace', state: 'error', error: STOPPED_TOOL })]);
        expect(getWorkspace(store.db, chat.workspace!.id)?.ready).toBe(false);

        await Bun.sleep(2500);
        expect(existsSync(survived)).toBe(false);

        // Nobody holds the place any more: the next step finds the worktree there and sets it up.
        configure({ setup: { command: 'touch done' } });
        await prepareWorkspace(store, chat.workspace!.id, { runId: run.id });
        expect(existsSync(join(path, 'done'))).toBe(true);
        expect(getWorkspace(store.db, chat.workspace!.id)?.ready).toBe(true);
    });

    test.skipIf(!posix)('does not wait for a process that a command leaves behind holding its output', async () => {
        const { make, send, stepOf, configure } = await setup();
        const chat = make({ mode: 'new' });

        configure({ setup: { command: 'echo bye\nsleep 8 &' } });

        const startedAt = Date.now();

        await send(chat, 'Start');
        expect(Date.now() - startedAt).toBeLessThan(5000);
        expect(logOf(stepOf(chat)[0])).toContain('bye');
    });

    test.skipIf(!posix)('is not run for a folder that has none, a folder whose settings are only a base branch, nor again for a worktree that is ready', async () => {
        const { repo, root, make, send, stepOf, configure } = await setup();
        const runs = join(root, 'runs.log');
        const plain = make({ mode: 'new' });

        configure({ baseBranch: 'main' });
        await send(plain, 'No setup');
        expect(logOf(stepOf(plain)[0])).not.toContain('Running the setup command');

        writeFileSync(join(repo, '.env'), 'TOKEN=1\n');
        configure({ setup: { files: ['.env'], command: `echo run >> '${ runs }'` } });

        const chat = make({ mode: 'new' });

        await send(chat, 'Set up');
        await send(chat, 'Again');
        await send(chat, 'And again');

        expect(readFileSync(runs, 'utf8')).toBe('run\n');
        expect(stepOf(chat)).toHaveLength(1);
        // A worktree that was made before the setting is not set up by it either.
        expect(existsSync(join(plain.workspace!.path, '.env'))).toBe(false);
        await send(plain, 'Still no setup');
        expect(existsSync(join(plain.workspace!.path, '.env'))).toBe(false);
        expect(readFileSync(runs, 'utf8')).toBe('run\n');
    });

    test.skipIf(!posix)('is not run for a worktree that was found: it is used as it is, with no step', async () => {
        const { repo, root, make, send, stepOf, configure } = await setup();
        const tree = join(root, 'feature-tree');
        const ran = join(root, 'ran');

        git(repo, 'worktree', 'add', '-q', '-b', 'feature', tree);
        writeFileSync(join(repo, '.env'), 'TOKEN=1\n');
        configure({ setup: { files: ['.env'], command: `touch '${ ran }'` } });

        const chat = make({ mode: 'existing', path: tree });

        await send(chat, 'Carry on');

        expect(stepOf(chat)).toEqual([]);
        expect(existsSync(ran)).toBe(false);
        expect(existsSync(join(tree, '.env'))).toBe(false);
    });

    test('reads the settings when the worktree is made, not when the chat is: a setting changed in between counts', async () => {
        const { repo, make, send, stepOf, configure } = await setup();

        writeFileSync(join(repo, '.env'), 'TOKEN=1\n');

        const chat = make({ mode: 'new' });

        configure({ setup: { files: ['.env'] } });
        await send(chat, 'Start');
        expect(existsSync(join(chat.workspace!.path, '.env'))).toBe(true);
        expect(logOf(stepOf(chat)[0])).toContain('Copied .env');
    });

    test('is a command for the system\'s shell: sh -c as written, and on Windows one cmd line with the lines joined and the quotes left alone', () => {
        expect(setupShell('bun install\nbun run build', 'linux')).toEqual({ argv: ['sh', '-c', 'bun install\nbun run build'], verbatim: false });
        expect(setupShell('echo hi', 'darwin')).toEqual({ argv: ['sh', '-c', 'echo hi'], verbatim: false });
        expect(setupShell('bun install\r\n\r\n  bun run "build all"  \n', 'win32', {})).toEqual({ argv: ['cmd.exe', '/d', '/s', '/c', '"bun install & bun run "build all""'], verbatim: true });
        expect(setupShell('echo %CLOWDY_BRANCH%', 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }).argv).toEqual(['C:\\Windows\\System32\\cmd.exe', '/d', '/s', '/c', '"echo %CLOWDY_BRANCH%"']);
    });
});

/** The messages of a conversation the tests hold: the agent's first turn is held by the gate while a thread is made, and the others end at once. */
const holding = (gate: ReturnType<typeof latch>): Script => async function* (turn) {
    if (turn.options.prompt.includes('Hold the line')) {
        yield { type: 'session', sessionId: `s${ turn.number }` };
        await gate.wait(turn.signal);
        yield { type: 'text', delta: 'Done', done: true };
        yield { type: 'done', result: 'Done' };

        return;
    }

    yield* finishing(turn);
};

describe('what a turn works in', () => {
    test('is the worktree: the agent is not handed the main checkout of it, gets the project\'s other folders, and is told where it is', async () => {
        const { h, engine, project, repo, root, make, send } = await setup();
        const notes = join(root, 'notes');

        mkdirSync(notes);

        const folders = (h.ok('project.update', { projectId: project.id, folders: [{ id: project.folders[0].id }, { path: notes }] }) as { project: Project }).project.folders;
        const chat = make({ mode: 'new' });
        const plain = make();
        const { path, branch } = chat.workspace!;

        await send(chat, 'Fix the page');
        await send(plain, 'Fix the page too');

        // The main checkout is left out; its git directory, which a commit in the worktree is written to, is handed over in its place.
        expect(engine.turns[0]).toMatchObject({ cwd: path, additionalDirectories: [folders[1].path, join(repo, '.git')] });
        expect(engine.turns[0].additionalDirectories).not.toContain(repo);
        expect(engine.turns[0].systemPrompt).toContain(`Worktree: you work in a git worktree of ${ repo }, at ${ path }, on the branch ${ branch }.`);
        expect(engine.turns[0].systemPrompt).toContain(`The main checkout at ${ repo } is the person's and other agents' place`);
        expect(engine.turns[0].systemPrompt).toContain(`- ${ repo } (main, you work in a worktree of it)\n- ${ folders[1].path }\n`);

        // A chat of the same project with no worktree is as it was.
        expect(engine.turns[1]).toMatchObject({ cwd: repo, additionalDirectories: [folders[1].path] });
        expect(engine.turns[1].systemPrompt).not.toContain('Worktree:');
        expect(engine.turns[1].systemPrompt).toContain(`- ${ repo } (main, you work here)`);
    });

    test('of a chat of another folder is that folder\'s worktree, and the main folder\'s checkout is among the other folders', async () => {
        const { h, engine, project, repo, root, make, send } = await setup();
        const api = makeRepo(root, 'shop-api');
        const folders = (h.ok('project.update', { projectId: project.id, folders: [{ id: project.folders[0].id }, { path: api }] }) as { project: Project }).project.folders;
        const chat = make({ mode: 'new' }, { folderId: folders[1].id });

        await send(chat, 'Fix the endpoint');

        // The other folder's checkout, and the git directory of the one the worktree belongs to.
        expect(engine.turns[0]).toMatchObject({ cwd: chat.workspace!.path, additionalDirectories: [repo, join(realpathSync(api), '.git')] });
        expect(chat.workspace!.path.endsWith(`${ sep }shop-api`)).toBe(true);
        expect(git(chat.workspace!.path, 'rev-parse', '--show-toplevel')).toBe(realpathSync(chat.workspace!.path));
        expect(git(api, 'worktree', 'list', '--porcelain')).toContain(`branch refs/heads/${ chat.workspace!.branch }`);
    });

    test('is the run\'s own cwd before the worktree, and a thread of a chat in a worktree works in the same one, the same row', async () => {
        const gate = latch();
        const { h, engine, repo, store, make, stepOf, chatOf, runOf } = await setup({ script: holding(gate) });
        const chat = make({ mode: 'new' });
        const { path } = chat.workspace!;

        h.ok('chat.send', { chatId: chat.id, text: 'Hold the line' });
        await waitFor(() => engine.turns.length === 1 && runOf(chat.id).status === 'running', 'the first turn to hold');

        const { runs, threads } = h.daemon.services;
        const exec = (input: Record<string, unknown>) => toolsFor({ store, runs, threads }, runOf(chat.id), 'autopilot').find(tool => tool.name === 'thread_spawn')!.execute(input, new AbortController().signal) as Promise<{ threadId: string }>;
        const thread = await exec({ prompt: 'Look around' });
        const elsewhere = tempDir('chat-workspaces-own');
        const own = await exec({ prompt: 'Look elsewhere', cwd: elsewhere });

        await waitFor(() => engine.turns.length === 3, 'both threads to start');

        const turnOf = (text: string) => engine.turns.find(turn => turn.prompt.endsWith(text));

        // The thread is in the parent's worktree, with its row; the run's own cwd still wins.
        expect(chatOf(thread.threadId).workspace).toEqual(chatOf(chat.id).workspace);
        expect(chatOf(thread.threadId).folderId).toBe(chat.folderId);
        expect(turnOf('Look around')).toMatchObject({ cwd: path });
        expect(turnOf('Look around')?.additionalDirectories).toEqual([join(repo, '.git')]);
        expect(stepOf(chatOf(thread.threadId))).toEqual([]);
        expect(turnOf('Look elsewhere')).toMatchObject({ cwd: elsewhere });
        expect(chatOf(own.threadId).workspace?.id).toBe(chat.workspace!.id);
        expect(chatsOfWorkspace(store.db, chat.workspace!.id)).toEqual([chat.id, thread.threadId, own.threadId]);
        expect(listWorkspacesOfProject(store.db, chat.projectId)).toHaveLength(1);
        expect(turnOf('Look around')?.systemPrompt).toContain(`Worktree: you work in a git worktree of ${ repo }, at ${ path }`);
        expect(turnOf('Look elsewhere')?.systemPrompt).not.toContain('Worktree:');
        expect(turnOf('Look elsewhere')?.additionalDirectories).toEqual([repo]);

        gate.release();
        await waitFor(() => runOf(chat.id).status === 'succeeded', 'the first turn to end');
    });

    test('of a fork is the source\'s worktree, the same row, and its session is opened there', async () => {
        const { h, engine, repo, make, send, stepOf, chatOf } = await setup({ canFork: true });
        const chat = make({ mode: 'new' });
        const { path } = chat.workspace!;

        await send(chat, 'Start');

        const read = async (chatId: string) => await (await h.fetch(`/v1/chats/${ chatId }/items`)).json() as StreamItem[];
        const answer = (await read(chat.id)).find(item => item.body.kind === 'assistant')!;
        const { chat: fork } = await h.okAsync('chat.fork', { chatId: chat.id, itemId: answer.id }) as { chat: Chat };

        expect(engine.forked[0]).toMatchObject({ cwd: path, additionalDirectories: [join(repo, '.git')] });
        expect(engine.forked[0].systemPrompt).toContain('Worktree: you work in a git worktree of');
        expect(fork.workspace).toEqual(chatOf(chat.id).workspace);
        expect(fork.folderId).toBe(chat.folderId);
        expect(chatOf(fork.id).workspace?.id).toBe(chat.workspace!.id);

        const before = stepOf(fork).length;

        await send(fork, 'Go on');
        expect(engine.turns.at(-1)).toMatchObject({ cwd: path });
        // The fork's turn made nothing: the worktree is there and ready.
        expect(stepOf(fork)).toHaveLength(before);
    });

    test('goes back to the folder when the folder of a worktree leaves the project, the worktree staying on the disk', async () => {
        const { h, engine, project, repo, root, store, make, send, chatOf } = await setup();
        const api = makeRepo(root, 'shop-api');
        const folders = (h.ok('project.update', { projectId: project.id, folders: [{ id: project.folders[0].id }, { path: api }] }) as { project: Project }).project.folders;
        const chat = make({ mode: 'new' }, { folderId: folders[1].id });
        const inMain = make({ mode: 'new' });

        await send(chat, 'In the api');
        await send(inMain, 'In the web');

        const cursor = h.store.headCursor();

        h.ok('project.update', { projectId: project.id, folders: [{ id: folders[0].id }] });

        expect(chatOf(chat.id)).not.toHaveProperty('workspace');
        expect(chatOf(chat.id)).not.toHaveProperty('folderId');
        expect(chatOf(inMain.id).workspace?.id).toBe(inMain.workspace!.id);
        expect(h.events(cursor).flatMap(event => (event.data.type === 'chat.upserted' ? [event.data.chat] : [])).map(each => [each.id, each.workspace?.id])).toEqual([[chat.id, undefined]]);
        expect(existsSync(chat.workspace!.path)).toBe(true);
        expect(getWorkspace(store.db, chat.workspace!.id)).toBeDefined();
        await send(chat, 'Again');
        expect(engine.turns.at(-1)?.cwd).toBe(repo);
    });

    test('the rows of a project go with it', async () => {
        const { h, project, store, make } = await setup();

        make({ mode: 'new' });
        make({ mode: 'new' });
        expect(listWorkspacesOfProject(store.db, project.id)).toHaveLength(2);

        h.ok('project.delete', { projectId: project.id });
        expect(store.db.query('SELECT COUNT(*) AS n FROM workspaces').get()).toEqual({ n: 0 });
    });
});

describe('the layout of a worktree', () => {
    test('is <workspaces folder>/<project slug>/<chat id8>/<folder name> on clowdy/<chat id8>', () => {
        const project = { id: 'prj_X', name: 'Shop', folders: [{ id: 'fld_1', path: '/code/shop-web' }, { id: 'fld_2', path: '/other/shop-web' }, { id: 'fld_3', path: '/code/api' }] } as Project;
        const config = { workspacesDir: join(tempDir(), 'ws') };
        const chatId = 'cht_01M82S6FRZH43TGT47XZCBJ2Y7';

        expect(chatKey(chatId)).toBe('XZCBJ2Y7');
        expect(workspaceLayout(config, project, project.folders[0], chatId)).toEqual({ path: join(config.workspacesDir, 'shop', 'XZCBJ2Y7', 'shop-web'), branch: 'clowdy/XZCBJ2Y7' });
        // Two folders of one name are told apart as everywhere else.
        expect(workspaceLayout(config, project, project.folders[1], chatId).path).toBe(join(config.workspacesDir, 'shop', 'XZCBJ2Y7', 'shop-web-2'));
        expect(workspaceLayout(config, project, project.folders[2], chatId).path.endsWith(`${ sep }api`)).toBe(true);
        // A name Windows does not allow for a folder, and characters it does not allow in one.
        const odd = { id: 'prj_X', name: 'Shop', folders: [{ id: 'fld_1', path: '/code/aux' }, { id: 'fld_2', path: '/code/a:b?' }] } as Project;

        expect(workspaceLayout(config, odd, odd.folders[0], chatId).path.endsWith(`${ sep }aux-folder`)).toBe(true);
        expect(workspaceLayout(config, odd, odd.folders[1], chatId).path.endsWith(`${ sep }a-b-`)).toBe(true);
    });

    test('names the project in kebab case, by its id when the name has nothing a folder can take, and not with a name Windows reserves', () => {
        expect(projectSlug({ id: 'prj_1', name: 'Car Rental' })).toBe('car-rental');
        expect(projectSlug({ id: 'prj_1', name: '  Café  Müller / 2024!  ' })).toBe('cafe-muller-2024');
        expect(projectSlug({ id: 'prj_1', name: 'Магазин' })).toBe('prj_1');
        expect(projectSlug({ id: 'prj_1', name: '***' })).toBe('prj_1');
        expect(projectSlug({ id: 'prj_1', name: 'CON' })).toBe('con-project');
        expect(projectSlug({ id: 'prj_1', name: 'a'.repeat(80) })).toBe('a'.repeat(32));
        expect(projectSlug({ id: 'prj_1', name: `${ 'a'.repeat(31) } b` })).toBe('a'.repeat(31));
    });

    test('compares places by what is on the disk, a path that is not there yet included', () => {
        const root = tempDir('chat-workspaces-places');
        const real = join(root, 'real');

        mkdirSync(real);
        symlinkSync(real, join(root, 'link'), 'dir');

        expect(samePlace(join(root, 'link', 'later', 'tree'), join(real, 'later', 'tree'))).toBe(true);
        expect(samePlace(join(real, '.', 'x', '..'), real)).toBe(true);
        expect(samePlace(join(real, 'a'), join(real, 'b'))).toBe(false);
        expect(placeOf(join(real, 'a', 'b'))).toBe(join(realpathSync(real), 'a', 'b'));
    });
});

describe('what a stopped or slow program comes to', () => {
    test('a stop kills it, and so does the time; the lines come as they are printed', async () => {
        const program = [process.execPath, '-e', 'console.log("one"); console.error("two"); setTimeout(() => {}, 30000)'];
        const lines: string[] = [];
        const stop = new AbortController();
        const timer = setTimeout(() => stop.abort(), 300);
        const stopped = await runLines(program, { cwd: tempDir(), onLine: line => lines.push(line), signal: stop.signal });

        clearTimeout(timer);
        expect(stopped).toEqual({ code: null, timedOut: false, aborted: true });
        expect(lines.sort()).toEqual(['one', 'two']);
        expect(await runLines(program, { cwd: tempDir(), onLine: () => undefined, timeoutMs: 300 })).toEqual({ code: null, timedOut: true, aborted: false });
        expect(await runLines([process.execPath, '-e', 'process.exit(3)'], { cwd: tempDir(), onLine: () => undefined })).toEqual({ code: 3, timedOut: false, aborted: false });
    });

    test.skipIf(process.platform === 'win32')('a stop ends what the program started and does not wait for it, and one that is stopped already starts nothing', async () => {
        const root = tempDir('chat-workspaces-lines');
        const stop = new AbortController();
        const timer = setTimeout(() => stop.abort(), 200);
        const startedAt = Date.now();
        // A program that starts another and waits for it, both holding the pipes: the stop has to reach both, or the call would wait the thirty seconds out.
        const stopped = await runLines(['sh', '-c', 'sleep 30 & sleep 30'], { cwd: root, onLine: () => undefined, signal: stop.signal });

        clearTimeout(timer);
        expect(stopped).toEqual({ code: null, timedOut: false, aborted: true });
        expect(Date.now() - startedAt).toBeLessThan(5000);

        const timedAt = Date.now();

        expect(await runLines(['sh', '-c', 'sleep 30 & sleep 30'], { cwd: root, onLine: () => undefined, timeoutMs: 200 })).toEqual({ code: null, timedOut: true, aborted: false });
        expect(Date.now() - timedAt).toBeLessThan(5000);

        // A program that ends and leaves a child holding its pipes: the call waits a moment for the lines, not for the child.
        const leftAt = Date.now();

        expect(await runLines(['sh', '-c', 'echo bye; sleep 4 &'], { cwd: root, onLine: () => undefined })).toEqual({ code: 0, timedOut: false, aborted: false });
        expect(Date.now() - leftAt).toBeLessThan(3500);

        const aborted = new AbortController();

        aborted.abort();
        expect(await runLines(['sh', '-c', 'touch started'], { cwd: root, onLine: () => undefined, signal: aborted.signal })).toEqual({ code: null, timedOut: false, aborted: true });
        expect(existsSync(join(root, 'started'))).toBe(false);
    });

    test.skipIf(process.platform === 'win32')('a line its reader cannot take ends the program and is thrown', async () => {
        const startedAt = Date.now();

        await expect(runLines(['sh', '-c', 'echo first; sleep 30'], {
            cwd: tempDir(),
            onLine() {
                throw new Error('the log is gone');
            },
        })).rejects.toThrow('the log is gone');
        expect(Date.now() - startedAt).toBeLessThan(5000);
    });
});
