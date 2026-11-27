import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { executeCommandAsync } from '../src/commands';
import { listChats } from '../src/db/chats';
import { commitFile, hook, isolated, left, neighbour, refsOf, repository } from './gitRepos';
import { cleanTempDirs, command, GateEngine, gateEngines, git, startHarness, tempDir, waitFor } from './helpers';

import type { CommandResult } from '@clowdy/protocol';
import type { Harness } from './helpers';

afterAll(cleanTempDirs);

const posix = process.platform !== 'win32';
/** Hooks are POSIX shell scripts: on Windows these cases are skipped, not run against another program. */
const withScripts = posix ? describe : describe.skip;

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

/** A `git` ahead of the real one on the PATH of the daemon's writes that logs what it is asked, so a test can see that no switch ran. */
function recording() {
    const dir = tempDir('chat-main-branch');
    const bin = join(dir, 'bin');
    const log = join(dir, 'argv.log');

    mkdirSync(bin);
    writeFileSync(
        join(bin, 'git'),
        ['#!/bin/sh', `echo "$@" >> '${log}'`, `exec '${Bun.which('git') as string}' "$@"`].join('\n')
    );
    chmodSync(join(bin, 'git'), 0o755);

    return {
        environment: isolated({ PATH: `${bin}:${process.env.PATH}` }),
        switches: () =>
            (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []).filter(line =>
                line.startsWith('switch')
            ),
    };
}

async function start(options: Parameters<typeof startHarness>[1] = {}): Promise<Harness> {
    const h = await startHarness({}, { gitEnvironment: isolated(), ...options });

    harnesses.push(h);

    return h;
}

/** A repository on `main` with a branch `other` that has a file of its own. */
function withOther() {
    const found = repository();

    git(found.path, 'switch', '-q', '-c', 'other');
    commitFile(found.path, 'on-other.txt');
    git(found.path, 'switch', '-q', 'main');

    return found;
}

/** The branch the place is on. */
const branchOf = (path: string) => git(path, 'branch', '--show-current');

/** Everything a refused chat must leave as it was: the refs and where HEAD is, the reflog (a switch writes a line), the index, the files and what is untracked. */
function snapshot(path: string) {
    return {
        refs: refsOf(path),
        head: git(path, 'rev-parse', 'HEAD'),
        reflog: git(path, 'reflog', 'show', 'HEAD'),
        index: git(path, 'ls-files', '-s'),
        status: left(path),
        diff: git(path, 'diff', 'HEAD'),
    };
}

/** The project of a repository and the `chat.create` of a chat that works in its checkout on a branch. */
async function open(path: string, h: Harness) {
    const { project } = h.ok('project.add', { folders: [path] });
    const chats = () => listChats(h.store.db, project.id);
    const create = (workspace: unknown, extra: Record<string, unknown> = {}): Promise<CommandResult> =>
        h.sendAsync('chat.create', { projectId: project.id, workspace, ...extra });
    const made = async (branch: string, extra: Record<string, unknown> = {}) => {
        const result = await create({ mode: 'main', branch }, extra);

        if (!result.ok) throw new Error(`chat.create failed: ${result.error.code} ${result.error.message}`);

        return result.data as { chat: { id: string; folderId?: string; workspace?: unknown }; warning?: string };
    };
    const refused = async (branch: string, extra: Record<string, unknown> = {}) => {
        const result = await create({ mode: 'main', branch }, extra);

        if (result.ok) throw new Error('chat.create was expected to be refused');

        return result.error;
    };

    return { project, folderId: project.folders[0].id as string, chats, create, made, refused };
}

describe('chat.create in the checkout on a branch: switching', () => {
    test('switches the checkout to the branch and makes the chat after it, in the folder as it is: no worktree, no folder', async () => {
        const h = await start();
        const { path } = withOther();
        const { made, chats } = await open(path, h);

        expect(existsSync(join(path, 'on-other.txt'))).toBe(false);

        const { chat, warning } = await made('other');

        expect(branchOf(path)).toBe('other');
        expect(existsSync(join(path, 'on-other.txt'))).toBe(true);
        expect(left(path)).toEqual([]);
        expect(chat.workspace).toBeUndefined();
        expect(chat.folderId).toBeUndefined();
        expect(warning).toBeUndefined();
        expect(chats().map(candidate => candidate.id)).toEqual([chat.id]);
    });

    test('makes no chat while the switch is running: the chat exists once git has finished, and not before', async () => {
        const h = await start();
        const { path } = withOther();
        const ran = join(tempDir('chat-main-branch'), 'hook-ran');
        const { create, chats } = await open(path, h);

        // A `post-checkout` hook that takes a while: git has moved the files and HEAD, and the command is still waiting for it.
        hook(path, 'post-checkout', `touch '${ran}'`, 'sleep 0.6');

        const pending = create({ mode: 'main', branch: 'other' });

        await waitFor(() => existsSync(ran) || undefined, 'the switch to start');
        expect(chats()).toEqual([]);

        const result = await pending;

        expect(result.ok).toBe(true);
        expect(chats()).toHaveLength(1);
        expect(branchOf(path)).toBe('other');
    });

    test('takes a branch that only origin has, making the local one that tracks it', async () => {
        const h = await start();
        const { path, origin } = repository();
        const other = neighbour(origin);

        git(other, 'switch', '-q', '-c', 'feature/search');
        commitFile(other, 'search.txt');
        git(other, 'push', '-q', 'origin', 'feature/search');
        git(path, 'fetch', '-q', 'origin');

        const { made } = await open(path, h);
        const { chat } = await made('feature/search');

        expect(chat).toBeDefined();
        expect(branchOf(path)).toBe('feature/search');
        expect(git(path, 'rev-parse', '--abbrev-ref', 'feature/search@{upstream}')).toBe('origin/feature/search');
        expect(existsSync(join(path, 'search.txt'))).toBe(true);
    });

    test('is the branch the checkout is on already: no switch runs, and a tree with changes does not stop the chat', async () => {
        const recorded = recording();
        const h = await start({ gitEnvironment: recorded.environment });
        const { path } = withOther();
        const { made, chats } = await open(path, h);

        writeFileSync(join(path, 'untracked.txt'), 'mine\n');

        const before = snapshot(path);
        const { chat } = await made('main');

        expect(chat.id).toBeDefined();
        expect(chats()).toHaveLength(1);
        expect(recorded.switches()).toEqual([]);
        expect(snapshot(path)).toEqual(before);
        expect(left(path)).toEqual(['?? untracked.txt']);
    });

    test('switches the folder the chat is for, not the main one', async () => {
        const h = await start();
        const main = withOther();
        const second = withOther();
        const { project } = h.ok('project.add', { folders: [main.path, second.path] });
        const secondId = project.folders[1].id as string;
        const result = await h.sendAsync('chat.create', {
            projectId: project.id,
            folderId: secondId,
            workspace: { mode: 'main', branch: 'other' },
        });

        expect(result.ok).toBe(true);
        expect(branchOf(second.path)).toBe('other');
        expect(branchOf(main.path)).toBe('main');
        expect(result.ok && (result.data as { chat: { folderId?: string } }).chat.folderId).toBe(secondId);
    });

    test('is answered through the HTTP route of the commands, which waits for git', async () => {
        const h = await start();
        const { path } = withOther();
        const { project } = h.ok('project.add', { folders: [path] });
        const response = await h.fetch('/v1/commands', {
            method: 'POST',
            body: JSON.stringify(
                command('chat.create', { projectId: project.id, workspace: { mode: 'main', branch: 'other' } })
            ),
        });
        const body = (await response.json()) as CommandResult;

        expect(response.status).toBe(200);
        expect(body.ok).toBe(true);
        expect(branchOf(path)).toBe('other');
    });

    test('answers a repeat of the same request with the first answer, and switches once', async () => {
        const recorded = recording();
        const h = await start({ gitEnvironment: recorded.environment });
        const { path } = withOther();
        const { project } = h.ok('project.add', { folders: [path] });
        const same = command('chat.create', { projectId: project.id, workspace: { mode: 'main', branch: 'other' } });
        const [first, second] = await Promise.all([
            executeCommandAsync(h.daemon.services, same),
            executeCommandAsync(h.daemon.services, same),
        ]);
        const third = await executeCommandAsync(h.daemon.services, same);

        expect(first).toEqual(second);
        expect(third).toEqual(first);
        expect(listChats(h.store.db, project.id)).toHaveLength(1);
        expect(recorded.switches()).toEqual(['switch --no-guess -- other']);
    });
});

withScripts('chat.create in the checkout on a branch: what the switch has to tell', () => {
    test('makes the chat and gives the warning of a post-checkout hook that failed after the branch changed', async () => {
        const h = await start();
        const { path } = withOther();
        const { made, chats } = await open(path, h);

        hook(path, 'post-checkout', 'echo "post-checkout: the install failed" >&2', 'exit 3');

        const { chat, warning } = await made('other');

        expect(warning).toBe('post-checkout: the install failed');
        expect(branchOf(path)).toBe('other');
        expect(chats().map(candidate => candidate.id)).toEqual([chat.id]);
    });

    test('tells the commits a detached HEAD leaves on no branch', async () => {
        const h = await start();
        const { path } = withOther();

        git(path, 'switch', '-q', '--detach');

        const lost = commitFile(path, 'lost.txt');
        const { made } = await open(path, h);
        const { warning } = await made('other');

        expect(warning).toBe(`The commit ${lost.slice(0, 7)} is on no branch now`);
        expect(branchOf(path)).toBe('other');
    });
});

describe('chat.create in the checkout on a branch: refusals make no chat and change nothing', () => {
    test('a tree with a change of any kind', async () => {
        const changes: Record<string, (path: string) => void> = {
            'a modified file': path => writeFileSync(join(path, 'README.md'), 'edited\n'),
            'a staged file': path => {
                writeFileSync(join(path, 'staged.txt'), 'staged\n');
                git(path, 'add', 'staged.txt');
            },
            'an untracked file': path => writeFileSync(join(path, 'untracked.txt'), 'new\n'),
        };

        for (const [what, change] of Object.entries(changes)) {
            const h = await start();
            const { path } = withOther();
            const { refused, chats } = await open(path, h);

            change(path);

            const before = snapshot(path);
            const error = await refused('other');

            expect({ what, code: error.code, message: error.message }).toEqual({
                what,
                code: 'conflict',
                message: 'Commit or discard the changes first',
            });
            expect((error.details as { hint?: string } | undefined)?.hint).toBe('1 file changed');
            expect({ what, ...snapshot(path) }).toEqual({ what, ...before });
            expect({ what, branch: branchOf(path), chats: chats() }).toEqual({ what, branch: 'main', chats: [] });
        }
    });

    test('a merge under way, before it looks at the tree', async () => {
        const h = await start();
        const { path } = withOther();
        const { refused, chats } = await open(path, h);

        git(path, 'switch', '-q', '-c', 'side');
        commitFile(path, 'side.txt');
        git(path, 'switch', '-q', 'main');
        git(path, 'merge', '-q', '--no-commit', '--no-ff', 'side');

        const before = snapshot(path);

        expect(await refused('other')).toMatchObject({
            code: 'conflict',
            message: 'A merge is in progress',
            details: { hint: 'Finish or abort it first' },
        });
        expect(snapshot(path)).toEqual(before);
        expect(chats()).toEqual([]);
    });

    test('a branch that another worktree has checked out, naming where', async () => {
        const recorded = recording();
        const h = await start({ gitEnvironment: recorded.environment });
        const { path } = withOther();
        const tree = join(realpathSync(tempDir('chat-main-branch')), 'tree');

        git(path, 'worktree', 'add', '-q', '-b', 'held', tree);

        const { refused, chats } = await open(path, h);
        const before = snapshot(path);

        expect(await refused('held')).toMatchObject({ code: 'conflict', message: `Checked out in ${tree}` });
        expect(snapshot(path)).toEqual(before);
        expect(recorded.switches()).toEqual([]);
        expect(chats()).toEqual([]);
    });

    test('a branch that does not exist, a name that is none and an empty one: invalid', async () => {
        const h = await start();
        const { path } = withOther();
        const { refused, chats } = await open(path, h);
        const before = snapshot(path);

        expect(await refused('nowhere')).toMatchObject({
            code: 'invalid',
            message: 'There is no branch called nowhere',
        });
        expect(await refused('-f')).toMatchObject({
            code: 'invalid',
            message: 'A branch name cannot start with a dash',
        });
        expect(await refused('@{-1}')).toMatchObject({ code: 'invalid', message: '@{-1} is not a branch name' });
        expect(await refused('  ')).toMatchObject({ code: 'invalid', message: 'Name the branch' });
        expect(snapshot(path)).toEqual(before);
        expect(chats()).toEqual([]);
    });

    test('a folder that is no repository, a folder the project does not have and an agent that does not exist, all before git runs', async () => {
        const recorded = recording();
        const h = await start({ gitEnvironment: recorded.environment });
        const plain = tempDir('chat-main-branch');
        const { project } = h.ok('project.add', { folders: [plain] });
        const noRepository = await h.sendAsync('chat.create', {
            projectId: project.id,
            workspace: { mode: 'main', branch: 'main' },
        });

        expect(noRepository).toMatchObject({
            ok: false,
            error: { code: 'invalid', message: 'The folder is not the root of a git repository' },
        });

        const { path } = withOther();
        const { refused, chats, folderId } = await open(path, h);

        expect(await refused('other', { folderId: 'fld_nobody' })).toMatchObject({
            code: 'invalid',
            message: expect.stringContaining('does not belong to project'),
        });
        expect(await refused('other', { engine: 'nobody' })).toMatchObject({ code: 'unavailable' });
        expect(folderId).toBeDefined();
        expect(branchOf(path)).toBe('main');
        expect(recorded.switches()).toEqual([]);
        expect(chats()).toEqual([]);
    });
});

describe('chat.create in the checkout on a branch: a chat that works there', () => {
    test('refuses while a chat of the folder has a run, and goes through once it is over', async () => {
        const gate = new GateEngine();
        const h = await start({ engines: gateEngines(gate) });
        const { path } = withOther();
        const { made, refused, chats, project } = await open(path, h);
        const busy = h.ok('chat.create', { projectId: project.id }).chat.id as string;
        const { runId } = h.ok('chat.send', { chatId: busy, text: 'first job' });

        await waitFor(() => gate.isStarted('first job'), 'the run');

        const before = snapshot(path);

        expect(await refused('other')).toMatchObject({
            code: 'conflict',
            message: '1 chat is working here',
            details: { hint: 'Stop them or wait until they finish' },
        });
        expect(snapshot(path)).toEqual(before);
        // Only the chat that was working is there: the refused one was not made.
        expect(chats().map(candidate => candidate.id)).toEqual([busy]);

        gate.release('first job');
        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to end');

        const { chat } = await made('other');

        expect(branchOf(path)).toBe('other');
        expect(chats().map(candidate => candidate.id)).toContain(chat.id);
    });

    test('starts its first turn on the branch it chose, after the switch ended', async () => {
        const gate = new GateEngine();
        const h = await start({ engines: gateEngines(gate) });
        const { path } = withOther();
        const { made } = await open(path, h);
        const { chat } = await made('other');

        h.ok('chat.send', { chatId: chat.id, text: 'on the branch' });
        await waitFor(() => gate.isStarted('on the branch'), 'the first turn');
        expect(branchOf(path)).toBe('other');
        expect(existsSync(join(path, 'on-other.txt'))).toBe(true);
        gate.release('on the branch');
    });
});

describe('chat.create: every other choice is as it was', () => {
    test('a chat with no choice is made at once by the plain command, and no git switch runs', async () => {
        const recorded = recording();
        const h = await start({ gitEnvironment: recorded.environment });
        const { path } = withOther();
        const { project } = h.ok('project.add', { folders: [path] });
        const { chat } = h.ok('chat.create', { projectId: project.id });

        expect(chat.workspace).toBeUndefined();
        expect(branchOf(path)).toBe('main');
        expect(recorded.switches()).toEqual([]);
    });

    test('a new worktree ignores the branch of the checkout: the checkout stays where it is and the chat gets its worktree row', async () => {
        const recorded = recording();
        const h = await start({ gitEnvironment: recorded.environment });
        const { path } = withOther();
        const { project } = h.ok('project.add', { folders: [path] });
        const { chat } = await h.okAsync('chat.create', {
            projectId: project.id,
            workspace: { mode: 'new', base: 'other' },
        });

        expect(chat.workspace).toMatchObject({ ready: false, managed: true });
        expect(branchOf(path)).toBe('main');
        expect(recorded.switches()).toEqual([]);
    });

    test('a worktree that exists is shared as it was, and the checkout is not switched', async () => {
        const recorded = recording();
        const h = await start({ gitEnvironment: recorded.environment });
        const { path } = withOther();
        const tree = join(tempDir('chat-main-branch'), 'tree');

        git(path, 'worktree', 'add', '-q', '-b', 'held', tree);

        const { project } = h.ok('project.add', { folders: [path] });
        const { chat } = await h.okAsync('chat.create', {
            projectId: project.id,
            workspace: { mode: 'existing', path: tree },
        });

        expect(chat.workspace).toMatchObject({ path: realpathSync(tree), ready: true });
        expect(branchOf(path)).toBe('main');
        expect(recorded.switches()).toEqual([]);
    });

    test('the plain command refuses a choice of a branch: it waits for git, which only executeCommandAsync does', async () => {
        const h = await start();
        const { path } = withOther();
        const { project } = h.ok('project.add', { folders: [path] });
        const result = h.send('chat.create', { projectId: project.id, workspace: { mode: 'main', branch: 'other' } });

        expect(result).toMatchObject({ ok: false, error: { code: 'internal' } });
        expect(branchOf(path)).toBe('main');
        expect(listChats(h.store.db, project.id)).toEqual([]);
    });
});
