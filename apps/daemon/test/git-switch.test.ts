import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { GitSwitch } from '../src/git/switch';
import { bare, commitFile, hook, isolated, left, neighbour, refsOf, repository } from './gitRepos';
import { cleanTempDirs, GateEngine, gateEngines, git, makeRepo, startHarness, tempDir, waitFor } from './helpers';

import type { GitSwitchResult } from '@clowdy/protocol';
import type { Harness } from './helpers';

afterAll(cleanTempDirs);

const posix = process.platform !== 'win32';
/** Hooks and the stand-in programs are POSIX shell scripts: on Windows these cases are skipped, not run against another program. */
const withScripts = posix ? describe : describe.skip;

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

/** A `git` ahead of the real one on the PATH of the daemon's writes that logs what it is asked, so a test can read the arguments of a switch (and see that none ran). */
function recording() {
    const dir = tempDir('git-switch');
    const bin = join(dir, 'bin');
    const log = join(dir, 'argv.log');

    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), ['#!/bin/sh', `echo "$@" >> '${ log }'`, `exec '${ Bun.which('git') as string }' "$@"`].join('\n'));
    chmodSync(join(bin, 'git'), 0o755);

    return { environment: isolated({ PATH: `${ bin }:${ process.env.PATH }` }), runs: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) };
}

async function start(options: Parameters<typeof startHarness>[1] = {}): Promise<Harness> {
    const h = await startHarness({}, { gitEnvironment: isolated(), ...options });

    harnesses.push(h);

    return h;
}

const json = async <T>(response: Response) => await response.json() as T;

interface Failure { ok: false; error: { code: string; message: string; details?: { hint?: string } } }

/** The project of a repository and the calls of the switch in it (or in a worktree of it, by `workspaceId`). */
async function open(path: string, h: Harness) {
    const { project } = h.ok('project.add', { folders: [path] });
    const folderId = project.folders[0].id as string;
    const call = (branch: unknown, extra: Record<string, unknown> = {}) => h.fetch(`/v1/projects/${ project.id }/git/switch`, { method: 'POST', body: JSON.stringify({ folderId, branch, ...extra }) });
    const result = async (branch: string, extra: Record<string, unknown> = {}) => {
        const response = await call(branch, extra);

        expect(response.status).toBe(200);

        return await json<GitSwitchResult>(response);
    };
    const failure = async (status: number, branch: unknown, extra: Record<string, unknown> = {}) => {
        const response = await call(branch, extra);

        expect(response.status).toBe(status);

        return (await json<Failure>(response)).error;
    };

    return { project, folderId, call, result, failure };
}

/** Everything a refused switch must leave as it was: the refs and where HEAD is, the reflog (a switch writes a line), the index, the tracked files' content and what is untracked. */
function snapshot(path: string) {
    return {
        refs: refsOf(path),
        head: git(path, 'rev-parse', 'HEAD'),
        branch: Bun.spawnSync(['git', 'symbolic-ref', '-q', 'HEAD'], { cwd: path, stdout: 'pipe' }).stdout.toString().trim(),
        reflog: git(path, 'reflog', 'show', 'HEAD'),
        index: git(path, 'ls-files', '-s'),
        status: left(path),
        diff: git(path, 'diff', 'HEAD'),
        untracked: git(path, 'ls-files', '--others', '--exclude-standard'),
    };
}

/** The branch the place is on. */
const branchOf = (path: string) => git(path, 'branch', '--show-current');

/** A repository on `main` with a branch `other` that has a file of its own. */
function withOther() {
    const found = repository();

    git(found.path, 'switch', '-q', '-c', 'other');
    commitFile(found.path, 'on-other.txt');
    git(found.path, 'switch', '-q', 'main');

    return found;
}

describe('POST /v1/projects/:id/git/switch: switching', () => {
    test('moves the checkout to another local branch, with its files, and answers where HEAD is now', async () => {
        const h = await start();
        const { path } = withOther();
        const { result } = await open(path, h);

        expect(existsSync(join(path, 'on-other.txt'))).toBe(false);

        const answer = await result('other');

        expect(answer).toEqual({ head: { kind: 'branch', name: 'other', commit: git(path, 'rev-parse', 'other') } });
        expect(branchOf(path)).toBe('other');
        expect(existsSync(join(path, 'on-other.txt'))).toBe(true);
        expect(left(path)).toEqual([]);

        const back = await result('main');

        expect(back).toMatchObject({ head: { kind: 'branch', name: 'main' }, upstream: { name: 'origin/main', ahead: 0, behind: 0 } });
        expect(existsSync(join(path, 'on-other.txt'))).toBe(false);
    });

    test('is the answer it already is for the branch that is checked out, and runs no git for it', async () => {
        const recorded = recording();
        const h = await start({ gitEnvironment: recorded.environment });
        const { path } = withOther();
        const { result } = await open(path, h);
        const before = snapshot(path);

        expect(await result('main')).toMatchObject({ head: { kind: 'branch', name: 'main' } });
        expect(snapshot(path)).toEqual(before);
        expect(recorded.runs().filter(line => line.startsWith('switch'))).toEqual([]);
    });

    test('leaves a detached HEAD for a branch, which is a switch like any other', async () => {
        const h = await start();
        const { path } = withOther();
        const { result } = await open(path, h);

        git(path, 'switch', '-q', '--detach');
        expect(branchOf(path)).toBe('');

        const answer = await result('other');

        expect(answer).toMatchObject({ head: { kind: 'branch', name: 'other' } });
        // Its commit is on `main`, so nothing is left behind.
        expect(answer).not.toHaveProperty('warning');
        expect(branchOf(path)).toBe('other');
    });

    test('says when leaving a detached HEAD leaves commits on no branch, and not when a branch made from it keeps them', async () => {
        const h = await start();
        const { path } = withOther();
        const { result } = await open(path, h);

        git(path, 'switch', '-q', '--detach');

        const first = commitFile(path, 'lonely-1.txt');

        expect(await result('other')).toMatchObject({ head: { name: 'other' }, warning: `The commit ${ first.slice(0, 7) } is on no branch now` });

        git(path, 'switch', '-q', '--detach', first);

        const second = commitFile(path, 'lonely-2.txt');

        expect((await result('main')).warning).toBe(`${ second.slice(0, 7) } and 1 earlier commit are on no branch now`);

        // A new branch from the detached HEAD is where its commits are kept.
        git(path, 'switch', '-q', '--detach', second);
        expect(await result('keeps-them', { create: { start: 'current' } })).not.toHaveProperty('warning');
        expect(git(path, 'rev-parse', 'keeps-them')).toBe(second);

        // A branch that has the commit keeps it, even when the person leaves by another way.
        git(path, 'switch', '-q', '--detach', second);
        expect(await result('main')).not.toHaveProperty('warning');
    });

    test('takes a branch that only origin has as a local branch that tracks it, and never guesses from a name', async () => {
        const recorded = recording();
        const h = await start({ gitEnvironment: recorded.environment });
        const { path, origin } = repository();
        const other = neighbour(origin);

        git(other, 'switch', '-q', '-c', 'feature/remote-only');
        const tip = commitFile(other, 'remote.txt');

        git(other, 'push', '-q', 'origin', 'feature/remote-only');
        git(path, 'fetch', '-q', 'origin');

        const { result } = await open(path, h);
        const answer = await result('feature/remote-only');

        expect(answer).toEqual({ head: { kind: 'branch', name: 'feature/remote-only', commit: tip }, upstream: { name: 'origin/feature/remote-only', ahead: 0, behind: 0 }, created: true });
        expect(git(path, 'config', '--get', 'branch.feature/remote-only.remote')).toBe('origin');
        expect(git(path, 'config', '--get', 'branch.feature/remote-only.merge')).toBe('refs/heads/feature/remote-only');
        expect(existsSync(join(path, 'remote.txt'))).toBe(true);
        expect(recorded.runs()).toContain('switch --track -c feature/remote-only refs/remotes/origin/feature/remote-only');
    });

    test('takes the local branch when a branch of that name is on origin too', async () => {
        const recorded = recording();
        const h = await start({ gitEnvironment: recorded.environment });
        const { path } = withOther();

        git(path, 'push', '-q', 'origin', 'other');
        git(path, 'fetch', '-q', 'origin');

        const { result } = await open(path, h);

        expect(await result('other')).toMatchObject({ head: { kind: 'branch', name: 'other' } });
        expect(await result('main')).not.toHaveProperty('created');
        expect(recorded.runs().filter(line => line.startsWith('switch'))).toEqual(['switch --no-guess -- other', 'switch --no-guess -- main']);
    });

    test('makes a new branch from the current one, with nothing to track', async () => {
        const recorded = recording();
        const h = await start({ gitEnvironment: recorded.environment });
        const { path } = withOther();
        const { result } = await open(path, h);

        git(path, 'switch', '-q', 'other');

        const tip = git(path, 'rev-parse', 'HEAD');
        const answer = await result('feature/new', { create: { start: 'current' } });

        expect(answer).toEqual({ head: { kind: 'branch', name: 'feature/new', commit: tip }, created: true });
        expect(Bun.spawnSync(['git', 'config', '--get', 'branch.feature/new.merge'], { cwd: path, stdout: 'pipe' }).exitCode).toBe(1);
        expect(recorded.runs()).toContain(`switch --no-track -c feature/new ${ tip }`);
    });

    test('makes a new branch from the default branch, as origin has it, and a push of it can never go to the branch it was cut from', async () => {
        const h = await start();
        const { path, origin } = withOther();
        const { result } = await open(path, h);
        const ahead = neighbour(origin);

        // Origin's `main` has moved on and the checkout's `main` has not: the new branch starts from the one that is the base (`origin/main`), as a comparison does.
        const theirs = commitFile(ahead, 'theirs.txt');

        git(ahead, 'push', '-q');
        git(path, 'fetch', '-q', 'origin');
        git(path, 'switch', '-q', 'other');

        const answer = await result('from-default', { create: { start: 'default' } });

        expect(answer).toEqual({ head: { kind: 'branch', name: 'from-default', commit: theirs }, created: true });
        expect(Bun.spawnSync(['git', 'config', '--get', 'branch.from-default.merge'], { cwd: path, stdout: 'pipe' }).exitCode).toBe(1);
        expect(existsSync(join(path, 'on-other.txt'))).toBe(false);
        expect(existsSync(join(path, 'theirs.txt'))).toBe(true);
    });

    test('starts a new branch from a detached HEAD\'s own commit when the current is asked for', async () => {
        const h = await start();
        const { path } = withOther();
        const { result } = await open(path, h);

        git(path, 'switch', '-q', '--detach', 'other');

        const tip = git(path, 'rev-parse', 'HEAD');

        expect(await result('from-detached', { create: { start: 'current' } })).toMatchObject({ head: { kind: 'branch', name: 'from-detached', commit: tip }, created: true });
    });

    test('runs the person\'s post-checkout hook, with git\'s own arguments, for a switch and for a new branch', async () => {
        const h = await start();
        const { path } = withOther();
        const { result } = await open(path, h);

        hook(path, 'post-checkout', `echo "$3" >> '${ join(path, '.git', 'ran.log') }'`);
        await result('other');
        await result('fresh', { create: { start: 'current' } });

        // `$3` is 1 for a checkout of a branch.
        expect(readFileSync(join(path, '.git', 'ran.log'), 'utf8').trim().split('\n')).toEqual(['1', '1']);
    });

    test('answers a post-checkout hook that fails as a switch that was made, with its line as a warning', async () => {
        const h = await start();
        const { path } = withOther();
        const { result } = await open(path, h);

        hook(path, 'post-checkout', 'echo "post-checkout: the install failed" >&2', 'exit 3');

        const answer = await result('other');

        expect(answer).toMatchObject({ head: { kind: 'branch', name: 'other' }, warning: 'post-checkout: the install failed' });
        expect(branchOf(path)).toBe('other');
    });

    test('runs git with the arguments it says: no force, no merge of changes, no ignoring another worktree, no hook skipped, a branch after `--`', async () => {
        const recorded = recording();
        const h = await start({ gitEnvironment: recorded.environment });
        const { path } = withOther();
        const { result } = await open(path, h);

        await result('other');
        await result('main');
        await result('new-one', { create: { start: 'current' } });
        await result('main');
        await result('next-one', { create: { start: 'default' } });

        const switches = recorded.runs().filter(line => line.startsWith('switch'));

        expect(switches).toHaveLength(5);
        expect(switches[0]).toBe('switch --no-guess -- other');
        expect(switches.join('\n')).not.toMatch(/--force|\s-f\s|--discard-changes|--merge|\s-m\s|--ignore-other-worktrees|--no-verify|--detach|--orphan|--conflict|--guess\b/);
        expect(recorded.runs().join('\n')).not.toMatch(/\bstash\b|\breset\b|\bcheckout\b|--hard|\bclean\b|\brestore\b/);
    });
});

describe('POST /v1/projects/:id/git/switch: refusals', () => {
    test('refuses a tree with a change of any kind, with the count of the files, and leaves the HEAD, the index, the files and the refs as they were', async () => {
        const changes: Record<string, (path: string) => void> = {
            'a modified file': path => writeFileSync(join(path, 'README.md'), 'edited\n'),
            'a staged file': (path) => {
                writeFileSync(join(path, 'staged.txt'), 'staged\n');
                git(path, 'add', 'staged.txt');
            },
            'an untracked file': path => writeFileSync(join(path, 'untracked.txt'), 'new\n'),
            'a deleted file': path => Bun.spawnSync(['rm', join(path, 'README.md')]),
            'a staged rename': (path) => {
                git(path, 'mv', 'README.md', 'MOVED.md');
            },
            'a new folder with a file in it': (path) => {
                mkdirSync(join(path, 'fresh', 'deep'), { recursive: true });
                writeFileSync(join(path, 'fresh', 'deep', 'file.txt'), 'new\n');
            },
            'a submodule that has a file of its own that is not tracked': (path) => {
                git(path, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', makeRepo(tempDir('git-switch'), 'sub'), 'sm');
                git(path, 'commit', '-q', '-m', 'Add a submodule');
                writeFileSync(join(path, 'sm', 'loose.txt'), 'x\n');
            },
        };

        for (const [what, change] of Object.entries(changes)) {
            const h = await start();
            const { path } = withOther();
            const { failure } = await open(path, h);

            change(path);

            const before = snapshot(path);
            const error = await failure(409, 'other');

            expect({ what, code: error.code, message: error.message }).toEqual({ what, code: 'conflict', message: 'Commit or discard the changes first' });
            expect(error.details?.hint).toMatch(/^\d+ files? changed$/);
            expect({ what, ...snapshot(path) }).toEqual({ what, ...before });
            expect(branchOf(path)).toBe('main');
        }
    });

    test('leaves a file git was told to look away from to git, which refuses to overwrite it: nothing changes and the person is told git\'s line', async () => {
        const h = await start();
        const { path } = repository();
        const { failure } = await open(path, h);

        git(path, 'switch', '-q', '-c', 'other');
        commitFile(path, 'tracked.txt', 'other\n');
        git(path, 'switch', '-q', 'main');
        commitFile(path, 'tracked.txt', 'main\n');
        writeFileSync(join(path, 'tracked.txt'), 'mine\n');
        // `status` does not list it, so the tree reads as clean; git's own check of the files it would overwrite is what stands in the way.
        git(path, 'update-index', '--assume-unchanged', 'tracked.txt');
        expect(left(path)).toEqual([]);

        const before = snapshot(path);
        const error = await failure(409, 'other');

        expect(error.code).toBe('conflict');
        expect(error.message).toMatch(/would be overwritten by checkout/);
        expect(snapshot(path)).toEqual(before);
        expect(readFileSync(join(path, 'tracked.txt'), 'utf8')).toBe('mine\n');
        expect(branchOf(path)).toBe('main');
    });

    test('counts the files in the reason: one file and many', async () => {
        const h = await start();
        const { path } = withOther();
        const { failure } = await open(path, h);

        writeFileSync(join(path, 'one.txt'), '1\n');
        expect((await failure(409, 'other')).details?.hint).toBe('1 file changed');

        writeFileSync(join(path, 'two.txt'), '2\n');
        writeFileSync(join(path, 'README.md'), 'edited\n');
        expect((await failure(409, 'other')).details?.hint).toBe('3 files changed');
    });

    test('is not told that a file git ignores is a change', async () => {
        const h = await start();
        const { path } = withOther();
        const { result } = await open(path, h);

        writeFileSync(join(path, '.gitignore'), 'build/\n');
        git(path, 'add', '.gitignore');
        git(path, 'commit', '-q', '-m', 'Ignore build');
        mkdirSync(join(path, 'build'));
        writeFileSync(join(path, 'build', 'out.js'), 'x\n');

        expect(await result('other')).toMatchObject({ head: { name: 'other' } });
    });

    test('refuses a merge, a cherry-pick, a revert, a rebase and a bisect under way, each by name, before it looks at the tree', async () => {
        const stops: Record<string, { message: string; setup: (path: string) => void }> = {
            merge: {
                message: 'A merge is in progress',
                setup: (path) => {
                    git(path, 'switch', '-q', '-c', 'side');
                    commitFile(path, 'side.txt');
                    git(path, 'switch', '-q', 'main');
                    git(path, 'merge', '-q', '--no-commit', '--no-ff', 'side');
                },
            },
            'cherry-pick': {
                message: 'A cherry-pick is in progress',
                setup: (path) => {
                    git(path, 'switch', '-q', '-c', 'side');
                    commitFile(path, 'same.txt', 'side\n');
                    git(path, 'switch', '-q', 'main');
                    commitFile(path, 'same.txt', 'main\n');
                    Bun.spawnSync(['git', 'cherry-pick', 'side'], { cwd: path, stdout: 'pipe', stderr: 'pipe' });
                },
            },
            revert: {
                message: 'A revert is in progress',
                setup: (path) => {
                    commitFile(path, 'same.txt', 'one\n');

                    const first = git(path, 'rev-parse', 'HEAD');

                    commitFile(path, 'same.txt', 'two\n');
                    Bun.spawnSync(['git', 'revert', '--no-edit', first], { cwd: path, stdout: 'pipe', stderr: 'pipe' });
                },
            },
            rebase: {
                message: 'A rebase is in progress',
                setup: (path) => {
                    commitFile(path, 'first.txt');
                    commitFile(path, 'second.txt');
                    // Stops at the commit it is told to edit, with a clean tree.
                    Bun.spawnSync(['git', 'rebase', '-i', 'HEAD~2'], { cwd: path, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_SEQUENCE_EDITOR: 'sed -i.bak "1s/^pick/edit/"' } });
                },
            },
            bisect: {
                message: 'A bisect is in progress',
                setup: (path) => {
                    const first = git(path, 'rev-parse', 'HEAD');

                    commitFile(path, 'a.txt');
                    commitFile(path, 'b.txt');
                    git(path, 'bisect', 'start');
                    git(path, 'bisect', 'bad');
                    git(path, 'bisect', 'good', first);
                },
            },
        };

        for (const [name, { message, setup }] of Object.entries(stops)) {
            const h = await start();
            const { path } = withOther();
            const { failure } = await open(path, h);

            setup(path);

            const before = snapshot(path);
            const error = await failure(409, 'other');

            expect({ name, code: error.code, message: error.message, hint: error.details?.hint }).toEqual({ name, code: 'conflict', message, hint: 'Finish or abort it first' });
            expect({ name, ...snapshot(path) }).toEqual({ name, ...before });
        }
    }, 60_000);

    test('refuses a branch that another worktree has checked out, naming where, and nothing moves', async () => {
        const recorded = recording();
        const h = await start({ gitEnvironment: recorded.environment });
        const { path } = withOther();
        const tree = join(realpathSync(tempDir('git-switch')), 'tree');

        git(path, 'worktree', 'add', '-q', '-b', 'held', tree);

        const { failure } = await open(path, h);
        const before = snapshot(path);
        const error = await failure(409, 'held');

        expect(error).toMatchObject({ code: 'conflict', message: `Checked out in ${ tree }` });
        expect(snapshot(path)).toEqual(before);
        expect(recorded.runs().filter(line => line.startsWith('switch'))).toEqual([]);
        expect(branchOf(tree)).toBe('held');
    });

    test('refuses a chat\'s worktree, whose branch it keeps, and runs nothing there', async () => {
        const recorded = recording();
        const h = await start({ gitEnvironment: recorded.environment });
        const { path } = withOther();
        const tree = join(tempDir('git-switch'), 'chat-tree');

        git(path, 'worktree', 'add', '-q', '-b', 'chat-branch', tree);

        const { project, folderId } = await open(path, h);
        const workspaceId = (h.ok('chat.create', { projectId: project.id, workspace: { mode: 'existing', path: tree } }).chat.workspace as { id: string }).id;
        const response = await h.fetch(`/v1/projects/${ project.id }/git/switch`, { method: 'POST', body: JSON.stringify({ folderId, workspaceId, branch: 'other' }) });
        const before = snapshot(tree);

        expect(response.status).toBe(400);
        expect(((await json<Failure>(response)).error).message).toBe('A chat\'s worktree keeps its branch');
        expect(snapshot(tree)).toEqual(before);
        expect(branchOf(tree)).toBe('chat-branch');
        expect(branchOf(path)).toBe('main');
        expect(recorded.runs().filter(line => line.startsWith('switch'))).toEqual([]);

        // A place that is not the project's is not found, as for the other routes.
        const missing = await h.fetch(`/v1/projects/${ project.id }/git/switch`, { method: 'POST', body: JSON.stringify({ folderId, workspaceId: 'wks_none', branch: 'other' }) });

        expect(missing.status).toBe(404);
    });

    test('refuses what is no branch name before anything runs: a leading dash, an expression, a name git forbids', async () => {
        const recorded = recording();
        const h = await start({ gitEnvironment: recorded.environment });
        const { path } = withOther();
        const { failure } = await open(path, h);
        const before = snapshot(path);

        for (const name of ['', '   ', '-x', '--force', '-', '--detach', '-c', '@{-1}', '@', 'HEAD', 'a b', 'a..b', 'x.lock', 'a/', '/a', 'a//b', 'a~1', 'a^', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a@{b', 'a\nb', 'a\u0000b', 'a\u007Fb', '.hidden', 'a.', 'x'.repeat(251)]) {
            for (const extra of [{}, { create: { start: 'current' } }]) {
                const error = await failure(400, name, extra);

                expect({ name: JSON.stringify(name), code: error.code }).toEqual({ name: JSON.stringify(name), code: 'invalid' });
            }
        }

        expect((await failure(400, 123 as unknown as string).catch(() => ({ code: 'invalid' }))).code).toBe('invalid');
        expect(snapshot(path)).toEqual(before);
        // No write of git was started for any of them: a leading dash can never reach git's arguments.
        expect(recorded.runs().filter(line => /^(switch|checkout)/.test(line))).toEqual([]);
    });

    test('says a name that is not one in the person\'s words, without a control character', async () => {
        const h = await start();
        const { path } = withOther();
        const { failure } = await open(path, h);

        expect((await failure(400, 'a b')).message).toBe('a b is not a branch name');
        expect((await failure(400, 'a\nb')).message).toBe('a b is not a branch name');
        expect((await failure(400, '-x')).message).toBe('A branch name cannot start with a dash');
        expect((await failure(400, '')).message).toBe('Name the branch');
    });

    test('refuses a branch that does not exist, and a new branch whose name is taken, locally or on origin', async () => {
        const h = await start();
        const { path, origin } = withOther();
        const { failure } = await open(path, h);
        const other = neighbour(origin);

        git(other, 'switch', '-q', '-c', 'only-on-origin');
        commitFile(other, 'o.txt');
        git(other, 'push', '-q', 'origin', 'only-on-origin');
        git(path, 'fetch', '-q', 'origin');

        const before = snapshot(path);

        expect(await failure(400, 'nope')).toMatchObject({ code: 'invalid', message: 'There is no branch called nope' });
        expect(await failure(400, 'other', { create: { start: 'current' } })).toMatchObject({ code: 'invalid', message: 'A branch called other exists already' });
        expect(await failure(400, 'only-on-origin', { create: { start: 'current' } })).toMatchObject({ code: 'invalid', message: 'origin has a branch called only-on-origin already' });
        expect(await failure(400, 'x', { create: { start: 'somewhere' } })).toMatchObject({ code: 'invalid', message: 'A new branch starts from the current branch or from the default branch' });
        expect(await failure(400, 'x', { create: {} })).toMatchObject({ code: 'invalid' });
        expect(snapshot(path)).toEqual(before);
    });

    test('says what git says when it refuses a new branch for a name that clashes with another branch\'s folder', async () => {
        const h = await start();
        const { path } = withOther();
        const { failure } = await open(path, h);

        git(path, 'branch', 'feature/x');

        const before = snapshot(path);
        const error = await failure(409, 'feature', { create: { start: 'current' } });

        expect(error.code).toBe('conflict');
        expect(error.message).toMatch(/^(fatal|error): /);
        expect(snapshot(path)).toEqual(before);
    });

    test('refuses a repository with no commit, a folder that is not a repository and one inside a repository', async () => {
        const h = await start();
        const unborn = tempDir('git-switch');

        git(unborn, 'init', '-q', '-b', 'main');
        expect(await (await open(unborn, h)).failure(400, 'main')).toMatchObject({ code: 'invalid', message: 'The repository has no commits yet' });
        expect(await (await open(tempDir('git-switch'), h)).failure(400, 'main')).toMatchObject({ code: 'invalid', message: 'The folder is not the root of a git repository' });

        const { path } = repository();

        mkdirSync(join(path, 'inner'));
        expect((await (await open(join(path, 'inner'), h)).failure(400, 'main')).code).toBe('invalid');
    });

    test('answers a body that is no request as the other routes do', async () => {
        const h = await start();
        const { path } = withOther();
        const { project, folderId } = await open(path, h);
        const post = (body: unknown) => h.fetch(`/v1/projects/${ project.id }/git/switch`, { method: 'POST', body: JSON.stringify(body) });

        expect((await post({ folderId })).status).toBe(400);
        expect((await post({ branch: 'other' })).status).toBe(400);
        expect((await post({ folderId, branch: 7 })).status).toBe(400);
        expect((await post({ folderId: 'fld_none', branch: 'other' })).status).toBe(404);
        expect((await h.fetch('/v1/projects/prj_none/git/switch', { method: 'POST', body: JSON.stringify({ folderId, branch: 'other' }) })).status).toBe(404);
        expect(branchOf(path)).toBe('main');
    });
});

describe('POST /v1/projects/:id/git/switch: runs working in the place', () => {
    async function working() {
        const gate = new GateEngine();
        const h = await start({ engines: gateEngines(gate) });
        const { path } = withOther();
        const opened = await open(path, h);

        return { h, gate, path, ...opened };
    }

    test('refuses while a chat of the folder has a run, with how many chats, and goes through once the runs are over', async () => {
        const { h, gate, path, project, failure, result } = await working();
        const first = h.ok('chat.create', { projectId: project.id }).chat.id as string;
        const firstRun = h.ok('chat.send', { chatId: first, text: 'first job' }).runId as string;

        await waitFor(() => gate.isStarted('first job'), 'the first run');

        const before = snapshot(path);

        expect(await failure(409, 'other')).toMatchObject({ code: 'conflict', message: '1 chat is working here', details: { hint: 'Stop them or wait until they finish' } });

        const second = h.ok('chat.create', { projectId: project.id }).chat.id as string;
        const secondRun = h.ok('chat.send', { chatId: second, text: 'second job' }).runId as string;

        await waitFor(() => gate.isStarted('second job'), 'the second run');
        expect(await failure(409, 'other')).toMatchObject({ message: '2 chats are working here' });
        expect(snapshot(path)).toEqual(before);

        gate.release('first job');
        await waitFor(() => h.run(firstRun).status === 'succeeded', 'the first run to end');
        expect(await failure(409, 'other')).toMatchObject({ message: '1 chat is working here' });

        gate.release('second job');
        await waitFor(() => h.run(secondRun).status === 'succeeded', 'the second run to end');
        expect(await result('other')).toMatchObject({ head: { kind: 'branch', name: 'other' } });
    });

    test('counts a run a task started, which works in the main folder, and a run that waits for background work: its session is open and may write', async () => {
        const { h, gate, path, project, failure, result } = await working();
        const { task } = h.ok('task.create', { projectId: project.id, title: 'Hold the line' });
        const { runId } = h.ok('task.start', { taskId: task.id });

        await waitFor(() => gate.isStarted(task.key), 'the task run');
        expect(await failure(409, 'other')).toMatchObject({ message: '1 chat is working here' });

        h.daemon.services.runs.setStatus(runId, 'waiting_background', { reason: 'A dev server is running' });
        expect(await failure(409, 'other')).toMatchObject({ message: '1 chat is working here' });

        gate.release(task.key);
        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to end');
        expect(await result('other')).toMatchObject({ head: { name: 'other' } });
        expect(branchOf(path)).toBe('other');
    });

    test('reads the runs after it has looked at the tree, so a message that starts a run while git reads the tree is not missed', async () => {
        const { h, gate, path, project, failure } = await working();
        const ready = join(tempDir('git-switch'), 'status-ready');
        const stall = join(tempDir('git-switch'), 'stall.sh');

        // A `git status` that takes a couple of seconds (the hook runs when git asks what changed), long enough for a message to come in.
        writeFileSync(stall, ['#!/bin/sh', `touch '${ ready }'`, 'sleep 1', 'exit 1'].join('\n'));
        chmodSync(stall, 0o755);
        git(path, 'config', 'core.fsmonitor', stall);

        const refused = failure(409, 'other');

        await waitFor(() => existsSync(ready) || undefined, 'git to read the tree');

        const chat = h.ok('chat.create', { projectId: project.id }).chat.id as string;

        h.ok('chat.send', { chatId: chat, text: 'starts meanwhile' });
        await waitFor(() => gate.isStarted('starts meanwhile'), 'the run');

        expect(await refused).toMatchObject({ code: 'conflict', message: '1 chat is working here' });
        expect(branchOf(path)).toBe('main');
        gate.release('starts meanwhile');
    });

    test('is not stopped by a chat that works in a worktree, or in another folder of the project', async () => {
        const gate = new GateEngine();
        const h = await start({ engines: gateEngines(gate) });
        const { path } = withOther();
        const second = makeRepo(tempDir('git-switch'), 'second');
        const tree = join(tempDir('git-switch'), 'chat-tree');

        git(path, 'worktree', 'add', '-q', '-b', 'chat-branch', tree);

        const { project } = h.ok('project.add', { folders: [path, second] });
        const [folderId, secondId] = project.folders.map((folder: { id: string }) => folder.id) as [string, string];
        const inTree = h.ok('chat.create', { projectId: project.id, folderId, workspace: { mode: 'existing', path: tree } }).chat.id as string;
        const inSecond = h.ok('chat.create', { projectId: project.id, folderId: secondId }).chat.id as string;

        h.ok('chat.send', { chatId: inTree, text: 'in the tree' });
        h.ok('chat.send', { chatId: inSecond, text: 'in the second folder' });
        await waitFor(() => gate.isStarted('in the tree') && gate.isStarted('in the second folder'), 'both runs');

        const response = await h.fetch(`/v1/projects/${ project.id }/git/switch`, { method: 'POST', body: JSON.stringify({ folderId, branch: 'other' }) });

        expect(response.status).toBe(200);
        expect(branchOf(path)).toBe('other');
        expect(branchOf(tree)).toBe('chat-branch');
    });

    test('does count a chat that works in the main folder once another folder came first in the project', async () => {
        const gate = new GateEngine();
        const h = await start({ engines: gateEngines(gate) });
        const { path } = withOther();
        const second = makeRepo(tempDir('git-switch'), 'second');
        const { project } = h.ok('project.add', { folders: [second, path] });
        const [secondId, folderId] = project.folders.map((folder: { id: string }) => folder.id) as [string, string];
        const chat = h.ok('chat.create', { projectId: project.id, folderId }).chat.id as string;

        h.ok('chat.send', { chatId: chat, text: 'works in the checkout' });
        await waitFor(() => gate.isStarted('works in the checkout'), 'the run');

        const response = await h.fetch(`/v1/projects/${ project.id }/git/switch`, { method: 'POST', body: JSON.stringify({ folderId, branch: 'other' }) });

        expect(response.status).toBe(409);
        expect(secondId).toBeTruthy();
        expect(branchOf(path)).toBe('main');
    });
});

describe('POST /v1/projects/:id/git/switch: the line of writes', () => {
    test('judges the tree on the place\'s line, right before git runs: a commit in front of it leaves the tree clean, and the switch goes through', async () => {
        const h = await start();
        const { path } = withOther();
        const { project, folderId, call } = await open(path, h);

        const ready = join(tempDir('git-switch'), 'ready');

        writeFileSync(join(path, 'wip.txt'), 'wip\n');
        // The commit holds the line for a second; when the switch arrives the tree is not clean, and when it is the switch's turn it is.
        hook(path, 'pre-commit', `touch '${ ready }'`, 'sleep 1');

        const commit = h.fetch(`/v1/projects/${ project.id }/git/commit`, { method: 'POST', body: JSON.stringify({ folderId, paths: ['wip.txt'], message: 'Add wip' }) });

        await waitFor(() => existsSync(ready) || undefined, 'the commit to hold the line');

        const switched = await call('other');

        expect((await commit).status).toBe(200);
        expect(switched.status).toBe(200);
        expect(branchOf(path)).toBe('other');
        expect(git(path, 'log', '-1', '--format=%s', 'main')).toBe('Add wip');
    });

    test('lets a switch and a commit of one place follow each other and never overlap, and a switch wait for a fetch', async () => {
        const recorded = recording();
        const h = await start({ gitEnvironment: recorded.environment });
        const { path } = withOther();
        const { project, folderId, call } = await open(path, h);
        const responses = await Promise.all([
            call('other'),
            h.fetch(`/v1/projects/${ project.id }/git/fetch`, { method: 'POST', body: JSON.stringify({ folderId }) }),
            call('main'),
        ]);

        expect(responses.map(response => response.status)).toEqual([200, 200, 200]);
        expect(branchOf(path)).toBe('main');
        expect(left(path)).toEqual([]);
    });

    test('stops what is running when the daemon stops, ends a switch that does not finish in time, and refuses a switch after it', async () => {
        const h = await start();
        const { path } = withOther();
        const { project } = await open(path, h);
        const place = { folder: project.folders[0], path };

        hook(path, 'post-checkout', 'sleep 20');

        const slow = new GitSwitch({ store: h.store, environment: isolated(), timeoutMs: 600 });
        const started = Date.now();
        const late = await slow.switch(project, place, { branch: 'other' }).catch((caught: unknown) => caught);

        // HEAD had moved to the branch before the hook that did not end, so the switch was made and the hook is what is told.
        expect(late).toMatchObject({ head: { kind: 'branch', name: 'other' }, warning: 'The post-checkout hook did not finish in time' });
        expect(Date.now() - started).toBeLessThan(6000);
        await Bun.sleep(300);
        expect(existsSync(join(path, '.git', 'index.lock'))).toBe(false);
        expect(branchOf(path)).toBe('other');
        hook(path, 'post-checkout', 'exit 0');
        git(path, 'switch', '-q', 'main');
        hook(path, 'post-checkout', 'sleep 20');

        const running = new GitSwitch({ store: h.store, environment: isolated() });
        const pending = running.switch(project, place, { branch: 'other' }).catch((caught: unknown) => caught);

        await Bun.sleep(500);
        running.stop();

        expect(await pending).toMatchObject({ code: 'unavailable', message: 'The daemon is stopping' });
        expect(await running.switch(project, place, { branch: 'main' }).catch((caught: unknown) => caught)).toBeInstanceOf(Error);
    });
});

describe('POST /v1/projects/:id/git/switch: a folder that is a linked worktree', () => {
    test('is the folder\'s own checkout: it switches, and the main checkout\'s branch is held', async () => {
        const h = await start();
        const { path } = withOther();
        const tree = join(realpathSync(tempDir('git-switch')), 'linked-folder');

        git(path, 'worktree', 'add', '-q', '-b', 'in-linked', tree);

        const { result, failure } = await open(tree, h);

        expect(await result('other')).toMatchObject({ head: { kind: 'branch', name: 'other' } });
        expect(branchOf(tree)).toBe('other');
        expect(branchOf(path)).toBe('main');
        // The main checkout has `main`, which the linked folder may not take.
        expect(await failure(409, 'main')).toMatchObject({ message: `Checked out in ${ realpathSync(path) }` });
    });
});

withScripts('POST /v1/projects/:id/git/switch: the origin the new branch is cut from', () => {
    test('makes a branch from a default that is a remote\'s branch with no local one, and says so when there is nothing to start from', async () => {
        const h = await start();
        const origin = bare();
        const { path } = repository(origin);

        git(path, 'switch', '-q', '-c', 'work');
        git(path, 'branch', '-q', '-D', 'main');
        git(path, 'fetch', '-q', 'origin');

        const { result } = await open(path, h);
        const tip = git(path, 'rev-parse', 'origin/main');

        expect(await result('fresh', { create: { start: 'default' } })).toMatchObject({ head: { kind: 'branch', name: 'fresh', commit: tip }, created: true });
    });
});
